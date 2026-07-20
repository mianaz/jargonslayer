// v0.5 Wave-1 Feature 6 (docs/design-explorations/v05-wave1-blueprint.md
// §1 Feature 6 + §5 A6) — TranslateQueue's provider-injection seam and
// the new SystemTranslatorUnavailableError classification. queue.test.ts
// already covers every batching/pause/retry behavior against a real
// LlmTranslationProvider wrapping a mocked translateApi; this file is
// additive-only and focuses on what's NEW: (a) the queue genuinely calls
// provider.translate() rather than reaching for translateApi itself, and
// (b) a non-LLM provider's failures never fall into the NoKeyError/
// RateLimitApiError branches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings, type TranscriptSegment } from "@jargonslayer/core/types";

vi.mock("../../llm/client", () => ({
  translateApi: vi.fn(),
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

import { translateApi } from "../../llm/client";
import { TranslateQueue, type TranslateQueueOptions } from "../queue";
import { SystemTranslatorUnavailableError, type TranslationProvider } from "../providers";

const mockTranslateApi = vi.mocked(translateApi);

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, bilingualTranscript: true, ...overrides };
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

describe("TranslateQueue — provider injection", () => {
  let settings: Settings;
  let meetingGen: number;
  let onTranslations: ReturnType<typeof vi.fn<(map: Record<string, string>, gen: number) => void>>;
  let onError: ReturnType<typeof vi.fn<(msg: string) => void>>;
  let queue: TranslateQueue;

  function makeQueue(provider: TranslationProvider): TranslateQueue {
    const opts: TranslateQueueOptions = {
      getSettings: () => settings,
      getMeetingGen: () => meetingGen,
      provider,
      onTranslations,
      onError,
    };
    return new TranslateQueue(opts);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    segIndex = 0;
    settings = makeSettings();
    meetingGen = 0;
    onTranslations = vi.fn<(map: Record<string, string>, gen: number) => void>();
    onError = vi.fn<(msg: string) => void>();
    mockTranslateApi.mockReset();
  });

  afterEach(() => {
    queue?.stop();
    vi.useRealTimers();
  });

  it("calls provider.translate(items, lang) — never touches translateApi directly, even with a mock provider that never throws NoKey", async () => {
    const translate = vi.fn().mockResolvedValue([{ id: "seg-1", text: "你好" }]);
    const provider: TranslationProvider = { kind: "system", prepare: vi.fn(), translate };
    queue = makeQueue(provider);

    queue.pushSegment(makeSegment("hello"));
    await vi.advanceTimersByTimeAsync(1500);

    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith([{ id: "seg-1", text: "hello" }], settings.explainLanguage);
    expect(mockTranslateApi).not.toHaveBeenCalled();
    expect(onTranslations).toHaveBeenCalledWith({ "seg-1": "你好" }, 0);
  });

  it("provider.prepare() is never called BY the queue — priming is exclusively useMeeting.ts's job (A6)", async () => {
    const translate = vi.fn().mockResolvedValue([]);
    const prepare = vi.fn();
    queue = makeQueue({ kind: "system", prepare, translate });

    queue.pushSegment(makeSegment("hello"));
    await vi.advanceTimersByTimeAsync(1500);

    expect(prepare).not.toHaveBeenCalled();
  });

  it("SystemTranslatorUnavailableError gets its OWN branch: drops the batch (no retry), pauses, and fires a DISTINCT zh toast — never the NoKey toast copy", async () => {
    const translate = vi.fn().mockRejectedValue(new SystemTranslatorUnavailableError("unavailable"));
    queue = makeQueue({ kind: "system", prepare: vi.fn(), translate });

    queue.pushSegment(makeSegment("hello"));
    await vi.advanceTimersByTimeAsync(1500);

    expect(onError).toHaveBeenCalledTimes(1);
    const msg = onError.mock.calls[0][0] as string;
    expect(msg).toContain("系统翻译不可用");
    expect(msg).not.toContain("API Key");

    // Dropped, not retried: a batch that would otherwise re-queue (like
    // the generic-error/rate-limit branches do) leaves `pending` empty,
    // so nothing fires again before the pause lifts.
    await vi.advanceTimersByTimeAsync(1500);
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("SystemTranslatorUnavailableError('downloading') gets the DOWNLOADING-specific toast copy", async () => {
    const translate = vi.fn().mockRejectedValue(new SystemTranslatorUnavailableError("downloading"));
    queue = makeQueue({ kind: "system", prepare: vi.fn(), translate });

    queue.pushSegment(makeSegment("hello"));
    await vi.advanceTimersByTimeAsync(1500);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain("下载中");
  });

  it("self-heals after the pause — a later retry cycle picks back up automatically, same self-healing shape as NoKeyError", async () => {
    const translate = vi
      .fn()
      .mockRejectedValueOnce(new SystemTranslatorUnavailableError("downloading"))
      .mockResolvedValueOnce([{ id: "seg-2", text: "已恢复" }]);
    queue = makeQueue({ kind: "system", prepare: vi.fn(), translate });

    queue.pushSegment(makeSegment("first, still downloading"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(translate).toHaveBeenCalledTimes(1);

    // A segment pushed during the pause waits; the pause itself lifts
    // on its own (no new pushSegment needed) — same 60s self-healing
    // shape as NO_KEY_PAUSE_MS.
    queue.pushSegment(makeSegment("second, arrives during the pause"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(onTranslations).toHaveBeenCalledWith({ "seg-2": "已恢复" }, 0);
  });

  it("the toast fires at most ONCE per meeting, mirroring noKeyToastShown", async () => {
    const translate = vi.fn().mockRejectedValue(new SystemTranslatorUnavailableError("unavailable"));
    queue = makeQueue({ kind: "system", prepare: vi.fn(), translate });

    queue.pushSegment(makeSegment("first"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(onError).toHaveBeenCalledTimes(1);

    onError.mockClear();
    queue.pushSegment(makeSegment("second, after the pause lifts and fails again"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("never increments the rate-limit drop-batch counter — a SystemTranslatorUnavailableError run followed by real RateLimitApiErrors still takes 5 consecutive 429s to drop, not fewer", async () => {
    // This proves the two error taxonomies are fully independent state
    // machines, not sharing consecutiveRateLimits.
    const { RateLimitApiError } = await import("../../llm/client");
    const translate = vi
      .fn()
      .mockRejectedValueOnce(new SystemTranslatorUnavailableError("unavailable"))
      .mockRejectedValueOnce(new RateLimitApiError())
      .mockRejectedValueOnce(new RateLimitApiError())
      .mockRejectedValueOnce(new RateLimitApiError())
      .mockRejectedValueOnce(new RateLimitApiError())
      .mockResolvedValueOnce([{ id: "seg-2", text: "恢复正常" }]);
    queue = makeQueue({ kind: "system", prepare: vi.fn(), translate });

    queue.pushSegment(makeSegment("system failure first"));
    await vi.advanceTimersByTimeAsync(1500); // system error -> pause 60s

    queue.pushSegment(makeSegment("then rate-limited"));
    await vi.advanceTimersByTimeAsync(60_000); // system pause lifts -> attempt #2: RateLimitApiError #1

    // 3 more 30s rate-limit pauses (consecutiveRateLimits: 2, 3, 4) —
    // still below MAX_CONSECUTIVE_RATE_LIMITS (5), proving the earlier
    // system-error attempt never bumped this counter.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(translate).toHaveBeenCalledTimes(5);

    // 5th rate-limit attempt succeeds (not a 5th consecutive failure).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(translate).toHaveBeenCalledTimes(6);
    expect(onTranslations).toHaveBeenCalledWith({ "seg-2": "恢复正常" }, 0);
  });
});
