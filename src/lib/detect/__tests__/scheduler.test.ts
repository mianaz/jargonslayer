import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  type DetectResponse,
  type DetectionSource,
  type Settings,
  type TranscriptSegment,
} from "../../types";

vi.mock("../../llm/client", () => ({
  detectApi: vi.fn(),
  NoKeyError: class NoKeyError extends Error {
    constructor(message = "未配置 API Key") {
      super(message);
      this.name = "NoKeyError";
    }
  },
  RateLimitApiError: class RateLimitApiError extends Error {
    constructor(message = "请求过于频繁，请稍后再试") {
      super(message);
      this.name = "RateLimitApiError";
    }
  },
}));

vi.mock("../dictionary", () => ({
  scanDictionary: vi.fn(() => ({ expressions: [], terms: [] }) satisfies DetectResponse),
}));

import { detectApi, NoKeyError } from "../../llm/client";
import { scanDictionary } from "../dictionary";
import { DetectionScheduler, type DetectMode } from "../scheduler";

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
  let onDetection: ReturnType<typeof vi.fn<(res: DetectResponse, source: DetectionSource) => void>>;
  let onBusyChange: ReturnType<typeof vi.fn<(busy: boolean) => void>>;
  let onModeChange: ReturnType<typeof vi.fn<(mode: DetectMode) => void>>;
  let onError: ReturnType<typeof vi.fn<(msg: string) => void>>;
  let scheduler: DetectionScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    segIndex = 0;
    settings = makeSettings();
    meetingGen = 0;
    onDetection = vi.fn<(res: DetectResponse, source: DetectionSource) => void>();
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
    expect(onDetection).toHaveBeenNthCalledWith(1, res2, "llm");

    // Batch 1 resolves SECOND — must still be applied, not dropped as
    // "stale": mergeDetections is additive/idempotent by normKey, so
    // applying an older batch after a newer one is safe.
    const res1: DetectResponse = { expressions: [], terms: [{ term: "ONE", type: "other", gloss_en: "", gloss_zh: "" }] };
    d1.resolve(res1);
    await vi.advanceTimersByTimeAsync(0);
    expect(onDetection).toHaveBeenCalledTimes(2);
    expect(onDetection).toHaveBeenNthCalledWith(2, res1, "llm");
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

  it("meeting-boundary guard also applies to the dictionary-fallback error path (NoKeyError for a stale-gen batch is dropped)", async () => {
    mockDetectApi.mockRejectedValueOnce(new NoKeyError());

    scheduler.pushSegment(makeSegment("a".repeat(140)));
    meetingGen += 1; // new meeting begins before the rejection is even processed
    await vi.advanceTimersByTimeAsync(0);

    expect(onDetection).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(mockScanDictionary).not.toHaveBeenCalled();
  });

  it("NoKeyError triggers dictionary fallback and a one-time onModeChange('dictionary') toast", async () => {
    mockDetectApi.mockRejectedValueOnce(new NoKeyError());
    const dictRes: DetectResponse = {
      expressions: [{ expression: "circle back", category: "phrase", meaning: "m", chinese_explanation: "z", plain_english: "p", tone: "t", confidence: 0.9, source_sentence: "s" }],
      terms: [],
    };
    mockScanDictionary.mockReturnValue(dictRes);

    scheduler.pushSegment(makeSegment("a".repeat(140)));
    await vi.advanceTimersByTimeAsync(0);

    expect(onDetection).toHaveBeenCalledWith(dictRes, "dictionary");
    expect(onModeChange).toHaveBeenCalledWith("dictionary");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain("未配置 API Key");

    // Subsequent segments now go straight to dictionary mode (fellBack=true)
    // and must NOT fire the toast again.
    onError.mockClear();
    scheduler.pushSegment(makeSegment("More text to scan for dictionary hits."));
    await vi.advanceTimersByTimeAsync(0);
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

  it("dictionaryOnly forced: scans dictionary synchronously per segment, bypasses detectApi entirely", async () => {
    settings = makeSettings({ dictionaryOnly: true });
    const dictRes: DetectResponse = {
      expressions: [],
      terms: [{ term: "ARR", type: "metric", gloss_en: "e", gloss_zh: "z" }],
    };
    mockScanDictionary.mockReturnValue(dictRes);

    scheduler.pushSegment(makeSegment("Our ARR grew."));

    expect(mockDetectApi).not.toHaveBeenCalled();
    expect(onDetection).toHaveBeenCalledWith(dictRes, "dictionary");
    expect(onModeChange).toHaveBeenCalledWith("dictionary");
  });
});
