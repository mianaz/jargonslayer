import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  type DetectedExpression,
  type DetectResponse,
  type DetectionSource,
  type Settings,
  type TranscriptSegment,
} from "@jargonslayer/core/types";

vi.mock("../../llm/client", () => ({
  detectApi: vi.fn(),
  NoKeyError: class NoKeyError extends Error {
    constructor(message = "未配置 API Key") {
      super(message);
      this.name = "NoKeyError";
    }
  },
  RateLimitApiError: class RateLimitApiError extends Error {
    constructor(message = "请求过于频繁，请稍后重试") {
      super(message);
      this.name = "RateLimitApiError";
    }
  },
}));

vi.mock("@jargonslayer/core/detect/dictionary", () => ({
  scanDictionary: vi.fn(() => ({ expressions: [], terms: [] }) satisfies DetectResponse),
}));

import { detectApi, NoKeyError } from "../../llm/client";
import { scanDictionary } from "@jargonslayer/core/detect/dictionary";
import { DetectionScheduler, type DetectMode } from "../scheduler";
import { clearDiag, getDiagEntries } from "../../diag/log";

const mockDetectApi = vi.mocked(detectApi);
const mockScanDictionary = vi.mocked(scanDictionary);

function emptyRes(): DetectResponse {
  return { expressions: [], terms: [] };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
}

let segIndex = 0;
function makeSegment(text: string): TranscriptSegment {
  segIndex++;
  return {
    id: `seg-${segIndex}`,
    index: segIndex,
    startedAt: Date.now(),
    endedAt: Date.now(),
    text,
    engine: "demo",
  };
}

function makeExpr(expression: string, overrides: Partial<DetectedExpression> = {}): DetectedExpression {
  return {
    expression,
    category: "phrase",
    meaning: "m",
    chinese_explanation: "z",
    plain_english: "p",
    tone: "t",
    confidence: 0.9,
    source_sentence: expression,
    ...overrides,
  };
}

/** A promise you can resolve/reject on demand, for controlling
 *  detectApi's async resolution order in the stale-drop / inflight-cap
 *  tests. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("DetectionScheduler", () => {
  let settings: Settings;
  let meetingGen: number;
  let onDetection: ReturnType<typeof vi.fn<(res: DetectResponse, source: DetectionSource, meta?: { batchWindowStart?: number }) => void>>;
  let onBusyChange: ReturnType<typeof vi.fn<(busy: boolean) => void>>;
  let onModeChange: ReturnType<typeof vi.fn<(mode: DetectMode) => void>>;
  let onError: ReturnType<typeof vi.fn<(msg: string) => void>>;
  let scheduler: DetectionScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    segIndex = 0;
    settings = makeSettings();
    meetingGen = 0;
    onDetection = vi.fn<(res: DetectResponse, source: DetectionSource, meta?: { batchWindowStart?: number }) => void>();
    onBusyChange = vi.fn<(busy: boolean) => void>();
    onModeChange = vi.fn<(mode: DetectMode) => void>();
    onError = vi.fn<(msg: string) => void>();
    mockDetectApi.mockReset();
    mockScanDictionary.mockReset();
    mockScanDictionary.mockReturnValue(emptyRes());
    scheduler = new DetectionScheduler({
      getSettings: () => settings,
      getMeetingGen: () => meetingGen,
      onDetection,
      onBusyChange,
      onModeChange,
      onError,
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it("flushes at >=140 accumulated chars", async () => {
    mockDetectApi.mockResolvedValue(emptyRes());
    const shortText = "a".repeat(139);
    scheduler.pushSegment(makeSegment(shortText));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).not.toHaveBeenCalled();

    scheduler.pushSegment(makeSegment("b")); // pushes total to 140
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);
  });

  it("flushes on sentence-end once accumulated chars reach >=60", async () => {
    mockDetectApi.mockResolvedValue(emptyRes());
    // 59 chars, no sentence end yet, no flush.
    scheduler.pushSegment(makeSegment("a".repeat(59)));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).not.toHaveBeenCalled();

    // Push one more char ending in a period; total is now 60,
    // AND the just-pushed segment ends the sentence -> should flush.
    scheduler.pushSegment(makeSegment("b."));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);
  });

  it("does NOT flush on sentence-end when accumulated chars stay below 60", async () => {
    mockDetectApi.mockResolvedValue(emptyRes());
    scheduler.pushSegment(makeSegment("Hi."));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).not.toHaveBeenCalled();
  });

  it("flushes via the 3.5s idle timer even when under the char thresholds", async () => {
    mockDetectApi.mockResolvedValue(emptyRes());
    scheduler.pushSegment(makeSegment("short text, no sentence end"));
    expect(mockDetectApi).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3499);
    expect(mockDetectApi).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);
  });

  it("caps in-flight requests at 2 — a third batch is queued until one completes", async () => {
    const d1 = deferred<DetectResponse>();
    const d2 = deferred<DetectResponse>();
    const d3 = deferred<DetectResponse>();
    mockDetectApi
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise)
      .mockImplementationOnce(() => d3.promise);

    // Batch 1 (>=140 chars triggers immediate flush).
    scheduler.pushSegment(makeSegment("a".repeat(140)));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    // Batch 2.
    scheduler.pushSegment(makeSegment("b".repeat(140)));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(2);

    // Batch 3 attempted while 2 are still in-flight -> must NOT call
    // detectApi a third time yet; text queues in pendingPieces.
    scheduler.pushSegment(makeSegment("c".repeat(140)));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(2);

    // Resolve the first in-flight request -> frees a slot -> the
    // queued third batch should now flush automatically.
    d1.resolve(emptyRes());
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(3);

    d2.resolve(emptyRes());
    d3.resolve(emptyRes());
    await vi.advanceTimersByTimeAsync(0);
  });

  it("out-of-order batches: batch 2 resolving before batch 1 does NOT drop batch 1 — both get applied (bug fix)", async () => {
    const d1 = deferred<DetectResponse>();
    const d2 = deferred<DetectResponse>();
    mockDetectApi.mockImplementationOnce(() => d1.promise).mockImplementationOnce(() => d2.promise);

    // Batch 1 flushed first (smaller endOffset).
    scheduler.pushSegment(makeSegment("a".repeat(140)));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    // Batch 2 flushed second (larger endOffset).
    scheduler.pushSegment(makeSegment("b".repeat(140)));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(2);

    // Batch 2 resolves FIRST (out of order).
    const res2: DetectResponse = { expressions: [], terms: [{ term: "TWO", type: "other", gloss_en: "", gloss_zh: "" }] };
    d2.resolve(res2);
    await vi.advanceTimersByTimeAsync(0);
    expect(onDetection).toHaveBeenCalledTimes(1);
    expect(onDetection).toHaveBeenNthCalledWith(1, res2, "llm", { batchWindowStart: expect.any(Number) });

    // Batch 1 resolves SECOND — must still be applied, not dropped as
    // "stale": mergeDetections is additive/idempotent by normKey, so
    // applying an older batch after a newer one is safe.
    const res1: DetectResponse = { expressions: [], terms: [{ term: "ONE", type: "other", gloss_en: "", gloss_zh: "" }] };
    d1.resolve(res1);
    await vi.advanceTimersByTimeAsync(0);
    expect(onDetection).toHaveBeenCalledTimes(2);
    expect(onDetection).toHaveBeenNthCalledWith(2, res1, "llm", { batchWindowStart: expect.any(Number) });
  });

  it("meeting-boundary guard: a response whose gen no longer matches the current meetingGen is silently dropped", async () => {
    const d1 = deferred<DetectResponse>();
    mockDetectApi.mockImplementationOnce(() => d1.promise);

    scheduler.pushSegment(makeSegment("a".repeat(140)));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    // A new meeting begins while this request is in flight.
    meetingGen += 1;

    const res: DetectResponse = { expressions: [], terms: [{ term: "STALE", type: "other", gloss_en: "", gloss_zh: "" }] };
    d1.resolve(res);
    await vi.advanceTimersByTimeAsync(0);

    // Dropped silently: no onDetection call, and no onModeChange side
    // effect landing on the new (unrelated) meeting either.
    expect(onDetection).not.toHaveBeenCalled();
    expect(onModeChange).not.toHaveBeenCalledWith("llm");
  });

  it("meeting-boundary guard also applies to the error path (NoKeyError for a stale-gen batch mutates nothing)", async () => {
    mockDetectApi.mockRejectedValueOnce(new NoKeyError());

    scheduler.pushSegment(makeSegment("a".repeat(140)));
    // The floor scan at push time is the only scanDictionary call.
    expect(mockScanDictionary).toHaveBeenCalledTimes(1);

    meetingGen += 1; // new meeting begins before the rejection is even processed
    await vi.advanceTimersByTimeAsync(0);

    expect(onDetection).not.toHaveBeenCalled(); // floor found nothing (empty mock)
    expect(onError).not.toHaveBeenCalled();
    expect(mockScanDictionary).toHaveBeenCalledTimes(1); // no error-path re-scan
  });

  it("NoKeyError: floor result stands (no re-scan/re-emit), one-time toast, mode → dictionary", async () => {
    mockDetectApi.mockRejectedValueOnce(new NoKeyError());
    const dictRes: DetectResponse = {
      expressions: [{ expression: "circle back", category: "phrase", meaning: "m", chinese_explanation: "z", plain_english: "p", tone: "t", confidence: 0.9, source_sentence: "s" }],
      terms: [],
    };
    mockScanDictionary.mockReturnValue(dictRes);

    scheduler.pushSegment(makeSegment("a".repeat(140)));
    // Instant floor: the dictionary hit surfaced synchronously at push
    // time, before the LLM batch even resolved.
    expect(onDetection).toHaveBeenCalledTimes(1);
    expect(onDetection).toHaveBeenCalledWith(dictRes, "dictionary");

    await vi.advanceTimersByTimeAsync(0);

    // The NoKey rejection must NOT re-emit the same text's hits (the
    // floor already counted them) — still exactly one detection.
    expect(onDetection).toHaveBeenCalledTimes(1);
    expect(onModeChange).toHaveBeenCalledWith("dictionary");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain("未配置 API Key");

    // Subsequent segments: floor keeps scanning (fellBack=true), no
    // further detectApi calls, no repeat toast.
    onError.mockClear();
    mockDetectApi.mockClear();
    scheduler.pushSegment(makeSegment("More text to scan for dictionary hits."));
    await vi.advanceTimersByTimeAsync(5000);
    expect(onDetection).toHaveBeenCalledTimes(2); // floor scan of the new segment
    expect(mockDetectApi).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("autoDetect off: mode reports 'off' and no detectApi/scanDictionary calls happen", async () => {
    settings = makeSettings({ autoDetect: false });
    scheduler.pushSegment(makeSegment("Some text that would otherwise flush immediately, over 140 chars long indeed yes it is very long."));
    await vi.advanceTimersByTimeAsync(4000);

    expect(onModeChange).toHaveBeenCalledWith("off");
    expect(mockDetectApi).not.toHaveBeenCalled();
    expect(mockScanDictionary).not.toHaveBeenCalled();
    expect(onDetection).not.toHaveBeenCalled();
  });

  it("aiDetect off: scans dictionary synchronously per segment, bypasses detectApi entirely", async () => {
    settings = makeSettings({ aiDetect: false });
    const dictRes: DetectResponse = {
      expressions: [],
      terms: [{ term: "ARR", type: "metric", gloss_en: "e", gloss_zh: "z" }],
    };
    mockScanDictionary.mockReturnValue(dictRes);

    scheduler.pushSegment(makeSegment("Our ARR grew."));
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockDetectApi).not.toHaveBeenCalled();
    expect(onDetection).toHaveBeenCalledWith(dictRes, "dictionary");
    expect(onModeChange).toHaveBeenCalledWith("dictionary");
  });

  it("instant floor (#54): dictionary hits surface synchronously at push time even when the LLM layer is armed", async () => {
    const d1 = deferred<DetectResponse>();
    mockDetectApi.mockImplementationOnce(() => d1.promise);
    const dictRes: DetectResponse = {
      expressions: [],
      terms: [{ term: "ARR", type: "metric", gloss_en: "e", gloss_zh: "z" }],
    };
    mockScanDictionary.mockReturnValue(dictRes);

    scheduler.pushSegment(makeSegment("a".repeat(140)));

    // Floor hit emitted BEFORE the LLM batch resolves — this is the
    // whole perceived-latency fix.
    expect(onDetection).toHaveBeenCalledTimes(1);
    expect(onDetection).toHaveBeenCalledWith(dictRes, "dictionary");

    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(1); // LLM still dispatched in parallel

    const llmRes: DetectResponse = { expressions: [], terms: [{ term: "TWO", type: "other", gloss_en: "", gloss_zh: "" }] };
    d1.resolve(llmRes);
    await vi.advanceTimersByTimeAsync(0);
    expect(onDetection).toHaveBeenCalledTimes(2);
    expect(onDetection).toHaveBeenNthCalledWith(2, llmRes, "llm", {
      batchWindowStart: expect.any(Number),
    });
    expect(onModeChange).toHaveBeenCalledWith("llm");
  });

  it("llm responses carry batchWindowStart = when the batch began accumulating (for floor count dedup)", async () => {
    mockDetectApi.mockResolvedValue(emptyRes());
    const before = Date.now();

    scheduler.pushSegment(makeSegment("short piece, waits for the idle timer"));
    await vi.advanceTimersByTimeAsync(3500); // idle-timer flush

    expect(mockDetectApi).toHaveBeenCalledTimes(1);
    const meta = onDetection.mock.calls.find((c) => c[1] === "llm")?.[2] as
      | { batchWindowStart?: number }
      | undefined;
    expect(meta?.batchWindowStart).toBeGreaterThanOrEqual(before);
    // Window START, not dispatch time: must be <= before + a little
    // slack, NOT the flush time 3.5s later.
    expect(meta?.batchWindowStart).toBeLessThan(before + 1000);
  });

  // F1 HIGH (codex review round 1): a batch dispatched while aiDetect
  // was on can still be in flight when the user flips aiDetect off —
  // Header/StatusLine's toggle sets aiDetect=false and synchronously
  // echoes detectMode="dictionary" the instant the user clicks. Before
  // this fix, the batch's eventual success still applied its "llm"
  // detections and reported onModeChange("llm"), silently overwriting
  // that echo and leaving the store inconsistent (aiDetect=false,
  // detectMode="llm") — the toggle button then reads as inverted on the
  // next click.
  describe("aiDetect-off race at batch completion (F1 HIGH)", () => {
    it("aiDetect flips off after flush but before the mocked LLM resolves: results are discarded, final mode is dictionary", async () => {
      const d1 = deferred<DetectResponse>();
      mockDetectApi.mockImplementationOnce(() => d1.promise);

      scheduler.pushSegment(makeSegment("a".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetectApi).toHaveBeenCalledTimes(1);

      // The user turns AI detect off while this batch is still on the
      // wire (the real toggle handler also echoes detectMode
      // synchronously — out of scope for this scheduler-only test; what
      // matters here is that getSettings() now returns aiDetect:false).
      settings = makeSettings({ aiDetect: false });

      const llmRes: DetectResponse = {
        expressions: [],
        terms: [{ term: "LATE", type: "other", gloss_en: "", gloss_zh: "" }],
      };
      d1.resolve(llmRes);
      await vi.advanceTimersByTimeAsync(0);

      // Discarded: the late llm result never reaches onDetection at all
      // (the empty-mock dictionary floor produced nothing either).
      expect(onDetection).not.toHaveBeenCalled();
      // The scheduler must report the mode the user actually asked for,
      // not resurrect "llm" behind their back.
      expect(onModeChange).toHaveBeenLastCalledWith("dictionary");
      expect(onModeChange).not.toHaveBeenCalledWith("llm");
    });

    it("aiDetect stays ON through completion: unchanged behavior — llm detections applied, mode reports llm", async () => {
      const d1 = deferred<DetectResponse>();
      mockDetectApi.mockImplementationOnce(() => d1.promise);

      scheduler.pushSegment(makeSegment("a".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetectApi).toHaveBeenCalledTimes(1);

      const llmRes: DetectResponse = {
        expressions: [],
        terms: [{ term: "OK", type: "other", gloss_en: "", gloss_zh: "" }],
      };
      d1.resolve(llmRes);
      await vi.advanceTimersByTimeAsync(0);

      expect(onDetection).toHaveBeenCalledTimes(1);
      expect(onDetection).toHaveBeenCalledWith(llmRes, "llm", { batchWindowStart: expect.any(Number) });
      expect(onModeChange).toHaveBeenCalledWith("llm");
      expect(onModeChange).not.toHaveBeenCalledWith("dictionary");
    });
  });

  // Item 6 (#54 field evidence): the owner reported seeing no
  // dictionary cards while AI detect was on, with nothing in the diag
  // ring buffer to confirm whether the floor was even running. These
  // tests are purely observational — onDetection's own floor-hit
  // behavior (already covered by the "instant floor" tests above) is
  // never changed by this describe block, only the new diag entry.
  describe("dictionary-floor observability (detect-dict-floor diag entry)", () => {
    beforeEach(() => {
      clearDiag();
      // Neutralizes the (unrelated) LLM batching path some of these
      // pushSegment calls can also arm — aiDetect defaults on via
      // makeSettings(), matching the exact "AI detect was on" scenario
      // the owner reported, so a resolved mock here keeps that path
      // quiet rather than switching it off for this describe block.
      mockDetectApi.mockResolvedValue(emptyRes());
    });

    function dictHit(expressions: number, terms: number): DetectResponse {
      return {
        expressions: Array.from({ length: expressions }, (_, i) => ({
          expression: `expr-${i}`,
          category: "phrase",
          meaning: "m",
          chinese_explanation: "z",
          plain_english: "p",
          tone: "t",
          confidence: 0.9,
          source_sentence: "s",
        })),
        terms: Array.from({ length: terms }, (_, i) => ({
          term: `term-${i}`,
          type: "other",
          gloss_en: "e",
          gloss_zh: "z",
        })),
      };
    }

    function dictFloorEntries() {
      return getDiagEntries().filter((e) => e.tag === "detect-dict-floor");
    }

    it("writes an entry on the very FIRST hit, immediately — so a short session still produces evidence", () => {
      mockScanDictionary.mockReturnValue(dictHit(1, 0));
      scheduler.pushSegment(makeSegment("let's circle back"));

      const entries = dictFloorEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe("info");
      expect(entries[0].detail).toBe("segments=1 expressions=1 terms=0");
    });

    it("writes no entry at all when a scan yields no hits", () => {
      mockScanDictionary.mockReturnValue(emptyRes());
      scheduler.pushSegment(makeSegment("nothing dictionary-worthy here"));

      expect(dictFloorEntries()).toHaveLength(0);
    });

    it("accumulates subsequent hits silently — no second entry within 60s of the first write", () => {
      mockScanDictionary.mockReturnValue(dictHit(1, 0));
      scheduler.pushSegment(makeSegment("a")); // first hit -> immediate write

      mockScanDictionary.mockReturnValue(dictHit(0, 2));
      scheduler.pushSegment(makeSegment("b"));
      scheduler.pushSegment(makeSegment("c"));

      expect(dictFloorEntries()).toHaveLength(1); // still just the first-hit entry
    });

    it("writes a second entry once 60s have elapsed since the last write, carrying only the counts accumulated since then", () => {
      mockScanDictionary.mockReturnValue(dictHit(1, 0));
      scheduler.pushSegment(makeSegment("a")); // first hit -> immediate write, resets the accumulator

      mockScanDictionary.mockReturnValue(dictHit(2, 1));
      scheduler.pushSegment(makeSegment("b")); // accumulates silently (< 60s since last write)

      vi.advanceTimersByTime(60_000);

      mockScanDictionary.mockReturnValue(dictHit(0, 3));
      scheduler.pushSegment(makeSegment("c")); // >= 60s since last write -> flush now

      const entries = dictFloorEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].detail).toBe("segments=1 expressions=1 terms=0");
      // segment b (2 expr/1 term) + segment c (0 expr/3 terms), NOT
      // re-including segment a (already flushed+reset by the first entry).
      expect(entries[1].detail).toBe("segments=2 expressions=2 terms=4");
    });

    it("does NOT flush early just because 60s elapsed with no NEW hit in between — the check only runs when a hit actually arrives", () => {
      mockScanDictionary.mockReturnValue(dictHit(1, 0));
      scheduler.pushSegment(makeSegment("a"));
      vi.advanceTimersByTime(120_000);

      expect(dictFloorEntries()).toHaveLength(1); // no autonomous timer, nothing new to flush
    });

    it("counts only — the diag entry never contains the matched expression/term text (privacy)", () => {
      mockScanDictionary.mockReturnValue({
        expressions: [
          {
            expression: "circle back",
            category: "phrase",
            meaning: "m",
            chinese_explanation: "z",
            plain_english: "p",
            tone: "t",
            confidence: 0.9,
            source_sentence: "s",
          },
        ],
        terms: [{ term: "ARR", type: "metric", gloss_en: "e", gloss_zh: "z" }],
      });
      scheduler.pushSegment(makeSegment("let's circle back on ARR"));

      const entries = dictFloorEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].message).not.toContain("circle back");
      expect(entries[0].message).not.toContain("ARR");
      expect(entries[0].detail ?? "").not.toContain("circle back");
      expect(entries[0].detail ?? "").not.toContain("ARR");
    });

    it("a NEW scheduler instance gets its own independent first-hit evidence (instance-scoped, not shared across meetings)", () => {
      mockScanDictionary.mockReturnValue(dictHit(1, 0));
      scheduler.pushSegment(makeSegment("a")); // this scheduler's first hit -> immediate write

      const secondScheduler = new DetectionScheduler({
        getSettings: () => settings,
        getMeetingGen: () => meetingGen,
        onDetection,
        onBusyChange,
        onModeChange,
        onError,
      });
      mockScanDictionary.mockReturnValue(dictHit(0, 1));
      secondScheduler.pushSegment(makeSegment("b")); // a DIFFERENT scheduler's own first hit
      secondScheduler.stop();

      expect(dictFloorEntries()).toHaveLength(2); // both wrote immediately, independently
    });
  });

  // Field-test issue 8b: a generic-failure fallback (2 consecutive
  // non-NoKeyError/non-RateLimitApiError failures) used to permanently
  // downgrade the whole meeting to dictionary-only — recovery required
  // starting a new meeting. It's now a 5-minute COOLDOWN: the next
  // pushSegment batch once it elapses gets exactly ONE silent probe
  // back through the AI path. NoKeyError stays a hard, never-auto-
  // retried latch (retrying with no key is pointless) — only a manual
  // retryAi() clears it.
  describe("field-test issue 8b: generic-fallback cooldown + manual retry", () => {
    const FALLBACK_COOLDOWN_MS = 5 * 60_000; // mirrors scheduler.ts's own (unexported) module const

    /** Drives the scheduler through the ORIGINAL 2-strike generic
     *  fallback (a plain Error — neither NoKeyError nor
     *  RateLimitApiError) so each test below starts from "already
     *  fallen back, cooldown armed", and asserts the existing (pre-8b)
     *  trigger behavior — including the new "5 分钟后自动重试" hint —
     *  still fires exactly once along the way. */
    async function triggerGenericFallback(): Promise<void> {
      mockDetectApi.mockRejectedValueOnce(new Error("upstream boom 1"));
      scheduler.pushSegment(makeSegment("a".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).not.toHaveBeenCalled(); // 1 strike: not fallen back yet

      mockDetectApi.mockRejectedValueOnce(new Error("upstream boom 2"));
      scheduler.pushSegment(makeSegment("b".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);

      expect(onModeChange).toHaveBeenCalledWith("dictionary");
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith("AI 检测暂时不可用，词典检测继续运行，5 分钟后自动重试");

      onError.mockClear();
      onModeChange.mockClear();
      mockDetectApi.mockClear();
    }

    it("no re-probe before the cooldown elapses", async () => {
      await triggerGenericFallback();

      scheduler.pushSegment(makeSegment("c".repeat(140)));
      await vi.advanceTimersByTimeAsync(60_000); // 1 minute — nowhere near 5
      expect(mockDetectApi).not.toHaveBeenCalled();
      expect(onModeChange).toHaveBeenCalledWith("dictionary");

      // Right up to (but not past) the boundary.
      scheduler.pushSegment(makeSegment("d".repeat(140)));
      await vi.advanceTimersByTimeAsync(FALLBACK_COOLDOWN_MS - 60_000 - 1);
      expect(mockDetectApi).not.toHaveBeenCalled();
    });

    it("cooldown re-probe success: mode returns to llm and fires the recovery toast", async () => {
      await triggerGenericFallback();

      await vi.advanceTimersByTimeAsync(FALLBACK_COOLDOWN_MS);
      mockDetectApi.mockResolvedValueOnce(emptyRes());
      scheduler.pushSegment(makeSegment("c".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDetectApi).toHaveBeenCalledTimes(1); // exactly one probe batch
      expect(onModeChange).toHaveBeenCalledWith("llm");
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith("AI 检测已恢复");

      // Latch fully cleared: the NEXT batch behaves like an entirely
      // normal one — no leftover probing restriction.
      onError.mockClear();
      mockDetectApi.mockClear();
      mockDetectApi.mockResolvedValueOnce(emptyRes());
      scheduler.pushSegment(makeSegment("d".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetectApi).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
    });

    it("cooldown re-probe failure: stays in dictionary mode, re-arms the cooldown silently (no toast spam)", async () => {
      await triggerGenericFallback();

      await vi.advanceTimersByTimeAsync(FALLBACK_COOLDOWN_MS);
      mockDetectApi.mockRejectedValueOnce(new Error("still down"));
      scheduler.pushSegment(makeSegment("c".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDetectApi).toHaveBeenCalledTimes(1); // exactly one silent re-probe
      // Mode was already "dictionary" throughout (it only transitions
      // on the fallback's initial trip, already asserted inside
      // triggerGenericFallback) — a failed re-probe re-affirms nothing
      // changed rather than redundantly re-reporting the same mode.
      expect(onModeChange).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled(); // no repeat toast on a failed re-probe

      // Re-armed, not exhausted: pushing again right away (this new
      // cooldown hasn't elapsed yet) must NOT probe a second time.
      mockDetectApi.mockClear();
      scheduler.pushSegment(makeSegment("d".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetectApi).not.toHaveBeenCalled();

      // A full SECOND cooldown window later, another silent probe fires
      // — proving the re-arm genuinely rescheduled the next attempt.
      await vi.advanceTimersByTimeAsync(FALLBACK_COOLDOWN_MS);
      mockDetectApi.mockResolvedValueOnce(emptyRes());
      scheduler.pushSegment(makeSegment("e".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetectApi).toHaveBeenCalledTimes(1);
      expect(onModeChange).toHaveBeenCalledWith("llm");
    });

    it("NoKeyError latch never auto-re-probes, even long after the cooldown window", async () => {
      mockDetectApi.mockRejectedValueOnce(new NoKeyError());
      scheduler.pushSegment(makeSegment("a".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(onModeChange).toHaveBeenCalledWith("dictionary");
      expect(mockDetectApi).toHaveBeenCalledTimes(1);

      mockDetectApi.mockClear();
      onError.mockClear();

      // Well past even several generic-cooldown windows — a NoKeyError
      // latch must stay hard regardless of elapsed time.
      scheduler.pushSegment(makeSegment("b".repeat(140)));
      await vi.advanceTimersByTimeAsync(FALLBACK_COOLDOWN_MS * 3);
      expect(mockDetectApi).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it("retryAi(): clears a generic cooldown latch immediately, bypassing the wait", async () => {
      await triggerGenericFallback();

      scheduler.retryAi();

      mockDetectApi.mockResolvedValueOnce(emptyRes());
      scheduler.pushSegment(makeSegment("c".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);

      // No cooldown wait needed — retryAi() cleared the latch outright.
      expect(mockDetectApi).toHaveBeenCalledTimes(1);
      expect(onModeChange).toHaveBeenCalledWith("llm");
    });

    it("retryAi(): clears a NoKeyError hard latch too (user may have just pasted a key)", async () => {
      mockDetectApi.mockRejectedValueOnce(new NoKeyError());
      scheduler.pushSegment(makeSegment("a".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(onModeChange).toHaveBeenCalledWith("dictionary");

      scheduler.retryAi();

      mockDetectApi.mockClear();
      mockDetectApi.mockResolvedValueOnce(emptyRes());
      scheduler.pushSegment(makeSegment("b".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDetectApi).toHaveBeenCalledTimes(1);
      expect(onModeChange).toHaveBeenCalledWith("llm");
    });
  });

  // F1 (Sol MEDIUM #9, review round): retryAi() clears the latches, but
  // a batch dispatched BEFORE that call (e.g. still carrying the old,
  // bad key) can still be in flight — its late failure landing AFTER
  // the retry used to re-latch the very fallback the user just manually
  // cleared, leaving AI dead until a second retry click. Fixed via a
  // retryEpoch counter (see that field's own doc comment, scheduler.ts).
  describe("F1 (Sol MEDIUM #9): retry-epoch guard — a stale in-flight batch can't re-latch a fallback after retryAi()", () => {
    it("a late NoKeyError from a batch dispatched BEFORE retryAi() does not re-latch the fallback", async () => {
      const d1 = deferred<DetectResponse>();
      mockDetectApi.mockImplementationOnce(() => d1.promise);

      scheduler.pushSegment(makeSegment("a".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetectApi).toHaveBeenCalledTimes(1);

      // The user already fixed their key and clicked retry while this
      // pre-retry batch was still in flight.
      scheduler.retryAi();

      // The stale batch's old-key rejection lands late.
      d1.reject(new NoKeyError());
      await vi.advanceTimersByTimeAsync(0);

      expect(onModeChange).not.toHaveBeenCalledWith("dictionary");
      expect(onError).not.toHaveBeenCalled();

      // Proves the latch genuinely wasn't re-armed: the very next batch
      // dispatches normally, with no fallback gating in the way.
      mockDetectApi.mockClear();
      mockDetectApi.mockResolvedValueOnce(emptyRes());
      scheduler.pushSegment(makeSegment("b".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetectApi).toHaveBeenCalledTimes(1);
      expect(onModeChange).toHaveBeenCalledWith("llm");
    });

    it("a late generic failure from a batch dispatched BEFORE retryAi() adds no strike", async () => {
      const d1 = deferred<DetectResponse>();
      mockDetectApi.mockImplementationOnce(() => d1.promise);

      scheduler.pushSegment(makeSegment("a".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetectApi).toHaveBeenCalledTimes(1);

      scheduler.retryAi();

      d1.reject(new Error("stale upstream boom"));
      await vi.advanceTimersByTimeAsync(0);

      expect(onModeChange).not.toHaveBeenCalledWith("dictionary");
      expect(onError).not.toHaveBeenCalled();

      // Proves no strike was counted: it takes 2 consecutive strikes to
      // trip the fallback (MAX_CONSECUTIVE_FAILURES) — if the stale
      // failure above HAD counted, this single additional real failure
      // would be enough to trip it. It must not.
      mockDetectApi.mockRejectedValueOnce(new Error("real boom"));
      scheduler.pushSegment(makeSegment("b".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(onModeChange).not.toHaveBeenCalledWith("dictionary");
      expect(onError).not.toHaveBeenCalled();
    });
  });

  // F2 (Sol MEDIUM #10, review round): with MAX_INFLIGHT=2, a
  // non-designated-probe concurrent success landing AFTER a fallback
  // trip used to leave fellBack/cooldownUntil stuck for the rest of the
  // 5-minute cooldown despite proving AI connectivity was fine —
  // recovery was gated on `this.probing` (the ONE designated cooldown
  // probe) instead of any success. Fixed by clearing on ANY success
  // while fellBack is set (scheduler.ts's attemptDetect).
  describe("F2 (Sol MEDIUM #10): any success clears fellBack, not only the designated probe", () => {
    it("A fails (1 strike), B in-flight, B fails -> fallback trips, C (queued behind the MAX_INFLIGHT=2 cap, never a designated probe) succeeds -> mode restored immediately", async () => {
      const dA = deferred<DetectResponse>();
      const dB = deferred<DetectResponse>();
      const dC = deferred<DetectResponse>();
      mockDetectApi
        .mockImplementationOnce(() => dA.promise)
        .mockImplementationOnce(() => dB.promise)
        .mockImplementationOnce(() => dC.promise);

      // Batch A dispatches (inflight=1).
      scheduler.pushSegment(makeSegment("a".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetectApi).toHaveBeenCalledTimes(1);

      // Batch B dispatches (inflight=2, at the MAX_INFLIGHT cap).
      scheduler.pushSegment(makeSegment("b".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetectApi).toHaveBeenCalledTimes(2);

      // Batch C's text queues — inflight is already at the cap, so it
      // is NOT dispatched yet (and, crucially, was never routed through
      // pushSegment's fellBack/probing gate either, since fellBack is
      // still false at this point).
      scheduler.pushSegment(makeSegment("c".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetectApi).toHaveBeenCalledTimes(2);

      // A fails — strike 1, not yet fallen back. Freeing a slot
      // auto-flushes the queued text as batch C (inflight back to 2:
      // B + C) — a perfectly ordinary dispatch, NOT a designated probe.
      dA.reject(new Error("boom A"));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetectApi).toHaveBeenCalledTimes(3);
      expect(onModeChange).not.toHaveBeenCalledWith("dictionary");

      // B fails — strike 2 — trips the fallback while C is still
      // in-flight.
      dB.reject(new Error("boom B"));
      await vi.advanceTimersByTimeAsync(0);
      expect(onModeChange).toHaveBeenCalledWith("dictionary");
      expect(onError).toHaveBeenCalledWith("AI 检测暂时不可用，词典检测继续运行，5 分钟后自动重试");

      // C succeeds — this is NOT the designated cooldown probe
      // (`this.probing` was never set true for it) — mode must still
      // be restored immediately, not stuck until the 5-minute cooldown
      // elapses.
      onModeChange.mockClear();
      onError.mockClear();
      dC.resolve(emptyRes());
      await vi.advanceTimersByTimeAsync(0);
      expect(onModeChange).toHaveBeenCalledWith("llm");
      expect(onError).toHaveBeenCalledWith("AI 检测已恢复");

      // Proves the latch is genuinely cleared (not just the toast): the
      // very next batch dispatches immediately, no cooldown wait needed.
      mockDetectApi.mockClear();
      mockDetectApi.mockResolvedValueOnce(emptyRes());
      scheduler.pushSegment(makeSegment("d".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetectApi).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------
// Fix: "ai detection is catching whole sentences rather than phrases"
// (soccer-stream field report). Pure boundary-case coverage for the
// filter itself moved to spanQc.test.ts (v0.4.5 — the filter is now
// shared with the import pipeline and the post-meeting sweep, see that
// module's own header comment); what's left here proves the filter is
// wired ONLY into the scheduler's "llm" success path (dictionary hits
// are untouched) and that the detect-ai-oversize diag counter follows
// the same throttle posture as detect-dict-floor — i.e. the scheduler-
// level integration, "now via the shared function".
// ---------------------------------------------------------------

describe("DetectionScheduler — oversized-AI-expression post-filter wiring", () => {
  let settings: Settings;
  let meetingGen: number;
  let onDetection: ReturnType<typeof vi.fn<(res: DetectResponse, source: DetectionSource, meta?: { batchWindowStart?: number }) => void>>;
  let onBusyChange: ReturnType<typeof vi.fn<(busy: boolean) => void>>;
  let onModeChange: ReturnType<typeof vi.fn<(mode: DetectMode) => void>>;
  let onError: ReturnType<typeof vi.fn<(msg: string) => void>>;
  let scheduler: DetectionScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    segIndex = 0;
    settings = makeSettings();
    meetingGen = 0;
    onDetection = vi.fn();
    onBusyChange = vi.fn();
    onModeChange = vi.fn();
    onError = vi.fn();
    mockDetectApi.mockReset();
    mockScanDictionary.mockReset();
    mockScanDictionary.mockReturnValue(emptyRes());
    clearDiag();
    scheduler = new DetectionScheduler({
      getSettings: () => settings,
      getMeetingGen: () => meetingGen,
      onDetection,
      onBusyChange,
      onModeChange,
      onError,
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it("an oversized expression from the LLM is filtered out before onDetection fires; a normal one in the same batch survives", async () => {
    mockDetectApi.mockResolvedValue({
      expressions: [
        makeExpr("circle back"),
        makeExpr("one two three four five six seven eight nine ten eleven"),
      ],
      terms: [],
    });

    scheduler.pushSegment(makeSegment("a".repeat(140)));
    await vi.advanceTimersByTimeAsync(0);

    expect(onDetection).toHaveBeenCalledTimes(1);
    const [res, source] = onDetection.mock.calls[0];
    expect(source).toBe("llm");
    expect((res as DetectResponse).expressions.map((e) => e.expression)).toEqual(["circle back"]);
  });

  it("dictionary-sourced hits are NEVER filtered, even if artificially oversized — proves the filter is scoped to the llm success path only", () => {
    mockScanDictionary.mockReturnValue({
      expressions: [makeExpr("one two three four five six seven eight nine ten eleven twelve")],
      terms: [],
    });

    scheduler.pushSegment(makeSegment("short text"));

    expect(onDetection).toHaveBeenCalledTimes(1);
    const [res, source] = onDetection.mock.calls[0];
    expect(source).toBe("dictionary");
    expect((res as DetectResponse).expressions).toHaveLength(1); // NOT dropped
  });

  describe("detect-ai-oversize diag counter (same throttle posture as detect-dict-floor)", () => {
    function oversizeEntries() {
      return getDiagEntries().filter((e) => e.tag === "detect-ai-oversize");
    }

    it("writes an entry on the very FIRST drop, immediately", async () => {
      mockDetectApi.mockResolvedValue({
        expressions: [makeExpr("one two three four five six seven eight nine ten")],
        terms: [],
      });
      scheduler.pushSegment(makeSegment("a".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);

      const entries = oversizeEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe("info");
      expect(entries[0].detail).toBe("dropped=1");
    });

    it("writes no entry at all when nothing is dropped", async () => {
      mockDetectApi.mockResolvedValue({ expressions: [makeExpr("circle back")], terms: [] });
      scheduler.pushSegment(makeSegment("a".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);

      expect(oversizeEntries()).toHaveLength(0);
    });

    it("accumulates subsequent drops silently — no second entry within 60s of the first write", async () => {
      mockDetectApi.mockResolvedValue({
        expressions: [makeExpr("one two three four five six seven eight nine ten")],
        terms: [],
      });
      scheduler.pushSegment(makeSegment("a".repeat(140)));
      await vi.advanceTimersByTimeAsync(0); // first drop -> immediate write

      scheduler.pushSegment(makeSegment("b".repeat(140)));
      await vi.advanceTimersByTimeAsync(0); // second drop, within 60s -> silent

      expect(oversizeEntries()).toHaveLength(1);
    });

    it("writes a second entry once 60s have elapsed, carrying only the count accumulated since then", async () => {
      mockDetectApi.mockResolvedValue({
        expressions: [makeExpr("one two three four five six seven eight nine ten")],
        terms: [],
      });
      scheduler.pushSegment(makeSegment("a".repeat(140)));
      await vi.advanceTimersByTimeAsync(0); // first drop -> immediate write, resets accumulator

      await vi.advanceTimersByTimeAsync(60_000);

      mockDetectApi.mockResolvedValue({
        expressions: [
          makeExpr("one two three four five six seven eight nine ten"),
          makeExpr("another one two three four five six seven eight nine"),
        ],
        terms: [],
      });
      scheduler.pushSegment(makeSegment("b".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);

      const entries = oversizeEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].detail).toBe("dropped=1");
      expect(entries[1].detail).toBe("dropped=2");
    });

    it("counts only — the diag entry never contains the dropped expression's text (privacy)", async () => {
      mockDetectApi.mockResolvedValue({
        expressions: [makeExpr("this is a very long sentence about the soccer match today")],
        terms: [],
      });
      scheduler.pushSegment(makeSegment("a".repeat(140)));
      await vi.advanceTimersByTimeAsync(0);

      const entries = oversizeEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].message).not.toContain("soccer");
      expect(entries[0].detail ?? "").not.toContain("soccer");
    });
  });
});
