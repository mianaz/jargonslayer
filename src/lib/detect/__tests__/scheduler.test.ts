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
  let onDetection: ReturnType<typeof vi.fn<(res: DetectResponse, source: DetectionSource) => void>>;
  let onBusyChange: ReturnType<typeof vi.fn<(busy: boolean) => void>>;
  let onModeChange: ReturnType<typeof vi.fn<(mode: DetectMode) => void>>;
  let onError: ReturnType<typeof vi.fn<(msg: string) => void>>;
  let scheduler: DetectionScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    segIndex = 0;
    settings = makeSettings();
    onDetection = vi.fn<(res: DetectResponse, source: DetectionSource) => void>();
    onBusyChange = vi.fn<(busy: boolean) => void>();
    onModeChange = vi.fn<(mode: DetectMode) => void>();
    onError = vi.fn<(msg: string) => void>();
    mockDetectApi.mockReset();
    mockScanDictionary.mockReset();
    mockScanDictionary.mockReturnValue(emptyRes());
    scheduler = new DetectionScheduler({
      getSettings: () => settings,
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

  it("stale-drop: an older batch's response landing after a newer one was applied does NOT call onDetection", async () => {
    const dOld = deferred<DetectResponse>();
    const dNew = deferred<DetectResponse>();
    mockDetectApi.mockImplementationOnce(() => dOld.promise).mockImplementationOnce(() => dNew.promise);

    // Old batch flushed first (offset advances as text is pushed).
    scheduler.pushSegment(makeSegment("a".repeat(140)));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(1);

    // New batch flushed second (larger endOffset).
    scheduler.pushSegment(makeSegment("b".repeat(140)));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockDetectApi).toHaveBeenCalledTimes(2);

    // Resolve the NEW batch FIRST -> applied, lastAppliedEndOffset advances.
    const newRes: DetectResponse = { expressions: [], terms: [{ term: "NEW", type: "other", gloss_en: "", gloss_zh: "" }] };
    dNew.resolve(newRes);
    await vi.advanceTimersByTimeAsync(0);
    expect(onDetection).toHaveBeenCalledTimes(1);
    expect(onDetection).toHaveBeenLastCalledWith(newRes, "llm");

    // Now resolve the OLD (stale) batch -> its endOffset <=
    // lastAppliedEndOffset, so onDetection must NOT be called again.
    const oldRes: DetectResponse = { expressions: [], terms: [{ term: "OLD", type: "other", gloss_en: "", gloss_zh: "" }] };
    dOld.resolve(oldRes);
    await vi.advanceTimersByTimeAsync(0);
    expect(onDetection).toHaveBeenCalledTimes(1); // still just the one call from the newer batch
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
