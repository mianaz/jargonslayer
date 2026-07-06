import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../types";

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

vi.mock("../../detect/dictionary", () => ({
  scanDictionary: vi.fn(() => ({ expressions: [], terms: [] })),
}));

import { detectApi, RateLimitApiError, NoKeyError } from "../../llm/client";
import { scanDictionary } from "../../detect/dictionary";
import {
  runDetectionPipeline,
  buildSessionFromSegments,
  buildSessionFromCloudSegments,
  type CloudTranscriptSegment,
} from "../upload";

const mockDetectApi = vi.mocked(detectApi);
const mockScanDictionary = vi.mocked(scanDictionary);

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function emptyRes() {
  return { expressions: [], terms: [] };
}

describe("runDetectionPipeline — rate-limit pacing", () => {
  let settings: Settings;

  beforeEach(() => {
    vi.useFakeTimers();
    settings = makeSettings();
    mockDetectApi.mockReset();
    mockScanDictionary.mockReset();
    mockScanDictionary.mockReturnValue(emptyRes());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a RateLimitApiError sleeps 65s then retries the same batch, succeeding without falling back to the dictionary", async () => {
    mockDetectApi.mockRejectedValueOnce(new RateLimitApiError()).mockResolvedValueOnce(emptyRes());

    const onProgress = vi.fn();
    const promise = runDetectionPipeline(
      [{ text: "circle back on this tomorrow" }],
      [],
      settings,
      onProgress,
    );

    // Let the microtask queue run so detectApi's first (rejecting)
    // call resolves and the 65s sleep gets armed.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    // Still waiting just before the 65s boundary.
    await vi.advanceTimersByTimeAsync(64_999);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    // Fires the retry at exactly 65s.
    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(mockDetectApi).toHaveBeenCalledTimes(2);
    expect(mockScanDictionary).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(1, 1);
  });

  it("a lone batch exhausting only its OWN per-batch wait cap (2) falls back to the dictionary for that batch, without latching the run or firing onRateLimitFallback", async () => {
    mockDetectApi.mockRejectedValue(new RateLimitApiError());

    const onRateLimitFallback = vi.fn();
    const promise = runDetectionPipeline(
      [{ text: "one single batch, all attempts rate-limited" }],
      [],
      settings,
      undefined,
      onRateLimitFallback,
    );

    // 3 attempts total: initial + 2 retries (2 waits), each gated by
    // a 65s sleep.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(mockDetectApi).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(mockDetectApi).toHaveBeenCalledTimes(3);

    await promise;

    // Per-batch cap (2 waits) exhausted after the 3rd attempt — no 4th
    // call, and the dictionary took over for this batch. Only 2 of the
    // 5 run-level waits were spent, so the run itself is NOT latched
    // and onRateLimitFallback (a run-exhausted signal) does not fire.
    expect(mockDetectApi).toHaveBeenCalledTimes(3);
    expect(mockScanDictionary).toHaveBeenCalledTimes(1);
    expect(onRateLimitFallback).not.toHaveBeenCalled();
  });

  it("exceeding the run-level wait cap (5) latches dictionary fallback for every remaining batch, calling detectApi no further times", async () => {
    mockDetectApi.mockRejectedValue(new RateLimitApiError());

    const onRateLimitFallback = vi.fn();
    const batches = [
      { text: "batch one text content here" },
      { text: "batch two text content here" },
      { text: "batch three text content here" },
    ];
    // Force separate chunkSegmentTexts batches by exceeding
    // BATCH_CHARS(1200) is unnecessary here — feed 3 pre-split texts,
    // each under the char cap but distinct entries so the chunker's
    // greedy join keeps them together unless we make them long enough
    // to each exceed 1200 on their own. Simpler: just call the
    // pipeline 3 times conceptually via 3 long/separate texts so the
    // chunker can't merge them into a single batch.
    const longBatches = batches.map((b) => ({ text: b.text.repeat(60) }));

    const promise = runDetectionPipeline(longBatches, [], settings, undefined, onRateLimitFallback);

    // Batch 1: initial + 2 waits (uses run-waits 1,2) -> 3 attempts,
    // falls back to dictionary (per-batch cap hit), latches run-level
    // continuation is NOT yet exhausted (2/5 used).
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(65_000);
    await vi.advanceTimersByTimeAsync(65_000);

    // Batch 2: initial + 2 waits (uses run-waits 3,4) -> 3 more
    // attempts, falls back to dictionary too (per-batch cap hit
    // again); run-level total so far = 4/5.
    await vi.advanceTimersByTimeAsync(65_000);
    await vi.advanceTimersByTimeAsync(65_000);

    // Batch 3: initial attempt fails, 1st retry would be run-wait #5
    // (still allowed), 2nd retry would be run-wait #6 (run cap
    // exhausted) -> falls back to dictionary directly without a 3rd
    // detectApi attempt for this batch.
    await vi.advanceTimersByTimeAsync(65_000);

    await promise;

    // 3 (batch1) + 3 (batch2) + 2 (batch3: initial + 1 retry) = 8
    expect(mockDetectApi).toHaveBeenCalledTimes(8);
    expect(mockScanDictionary).toHaveBeenCalledTimes(3);
    expect(onRateLimitFallback).toHaveBeenCalledTimes(1);
  });

  it("NoKeyError falls back to the dictionary for that batch immediately, no wait, no latch", async () => {
    mockDetectApi.mockRejectedValueOnce(new NoKeyError()).mockResolvedValueOnce(emptyRes());

    // Each text is padded past BATCH_CHARS(1200) on its own so the
    // greedy chunker can't join them into a single batch — we need
    // two distinct detectApi calls to observe the "no latch" claim.
    const promise = runDetectionPipeline(
      [
        { text: "first batch, no key configured. ".repeat(40) },
        { text: "second batch, key now present. ".repeat(40) },
      ],
      [],
      settings,
    );

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(mockDetectApi).toHaveBeenCalledTimes(2);
    expect(mockScanDictionary).toHaveBeenCalledTimes(1);
  });

  it("a transient (non-429, non-NoKey) error is retried once after 4s — retry success keeps the LLM result, no dictionary", async () => {
    mockDetectApi
      .mockRejectedValueOnce(new Error("upstream 502"))
      .mockResolvedValueOnce(emptyRes());

    const promise = runDetectionPipeline(
      [{ text: "one batch, brief upstream blip" }],
      [],
      settings,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(mockDetectApi).toHaveBeenCalledTimes(2);
    expect(mockScanDictionary).not.toHaveBeenCalled();
  });

  it("a transient error failing twice falls back to the dictionary for that batch (one retry only)", async () => {
    mockDetectApi.mockRejectedValue(new Error("upstream 502, persistent"));

    const promise = runDetectionPipeline(
      [{ text: "one batch, persistent upstream failure" }],
      [],
      settings,
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_000);
    await promise;

    expect(mockDetectApi).toHaveBeenCalledTimes(2);
    expect(mockScanDictionary).toHaveBeenCalledTimes(1);
  });
});

describe("buildSessionFromSegments — reuse (#43 phase 2a)", () => {
  let settings: Settings;

  beforeEach(() => {
    settings = makeSettings();
    mockDetectApi.mockReset();
    mockDetectApi.mockResolvedValue(emptyRes());
    mockScanDictionary.mockReset();
    mockScanDictionary.mockReturnValue(emptyRes());
  });

  const segments: CloudTranscriptSegment[] = [
    { start: 0, end: 2, text: "circle back on this" },
    { start: 2, end: 4, text: "let's move the needle" },
  ];

  it("honors the passed engine/title rather than hardcoding whisper/导入 <filename>", async () => {
    const session = await buildSessionFromSegments(segments, settings, {
      title: "自定义会话标题",
      engine: "browser-whisper",
    });

    expect(session.engine).toBe("browser-whisper");
    expect(session.title).toBe("自定义会话标题");
    expect(session.segments).toHaveLength(2);
    expect(session.segments[0].engine).toBe("browser-whisper");
    expect(session.segments[0].text).toBe("circle back on this");
  });

  it("buildSessionFromCloudSegments (cloud path, #22) is byte-identical to calling buildSessionFromSegments directly with {title: 导入 <filename>, engine: 'whisper'} — same cards/terms/segment shape", async () => {
    mockDetectApi.mockResolvedValue({
      expressions: [
        {
          expression: "move the needle",
          category: "idiom",
          meaning: "make meaningful progress",
          chinese_explanation: "取得实质性进展",
          plain_english: "make progress",
          tone: "neutral",
          confidence: 0.9,
          source_sentence: "let's move the needle",
        },
      ],
      terms: [],
    });

    const viaCloudHelper = await buildSessionFromCloudSegments(segments, settings, "meeting.wav");
    const viaDirectCall = await buildSessionFromSegments(segments, settings, {
      title: "导入 meeting.wav",
      engine: "whisper",
    });

    expect(viaCloudHelper.engine).toBe("whisper");
    expect(viaCloudHelper.title).toBe("导入 meeting.wav");
    expect(viaCloudHelper.engine).toBe(viaDirectCall.engine);
    expect(viaCloudHelper.title).toBe(viaDirectCall.title);
    // Compare content fields only — id/firstSeenAt/lastSeenAt are
    // freshly generated per call (newId()/Date.now()) by design, not
    // part of the "same behavior" claim.
    const cardContent = (c: (typeof viaCloudHelper.cards)[number]) => ({
      expression: c.expression,
      chinese_explanation: c.chinese_explanation,
      source: c.source,
      count: c.count,
    });
    expect(viaCloudHelper.cards.map(cardContent)).toEqual(viaDirectCall.cards.map(cardContent));
    expect(viaCloudHelper.terms).toEqual(viaDirectCall.terms);
    expect(viaCloudHelper.segments.map((s) => ({ text: s.text, engine: s.engine }))).toEqual(
      viaDirectCall.segments.map((s) => ({ text: s.text, engine: s.engine })),
    );
  });
});
