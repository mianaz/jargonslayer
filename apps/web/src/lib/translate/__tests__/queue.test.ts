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

import { translateApi, NoKeyError, RateLimitApiError } from "../../llm/client";
import { TranslateQueue } from "../queue";
import { LlmTranslationProvider } from "../providers";
import * as diagLogModule from "../../diag/log";

const mockTranslateApi = vi.mocked(translateApi);

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    bilingualTranscript: true,
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

function emptyRes() {
  return { translations: [] };
}

/** A promise you can resolve/reject on demand — same helper shape as
 *  scheduler.test.ts's deferred(). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TranslateQueue", () => {
  let settings: Settings;
  let meetingGen: number;
  let onTranslations: ReturnType<typeof vi.fn<(map: Record<string, string>, gen: number) => void>>;
  let onError: ReturnType<typeof vi.fn<(msg: string) => void>>;
  let queue: TranslateQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    segIndex = 0;
    settings = makeSettings();
    meetingGen = 0;
    onTranslations = vi.fn<(map: Record<string, string>, gen: number) => void>();
    onError = vi.fn<(msg: string) => void>();
    mockTranslateApi.mockReset();
    // v0.5 Wave-1 Feature 6: the queue now takes an injected provider
    // rather than calling translateApi directly — wrapping the SAME
    // mocked translateApi through the real LlmTranslationProvider
    // reproduces 100% of this suite's existing behavior/assertions
    // unchanged (same request body shape, same thrown-error passthrough)
    // while genuinely exercising the injection seam. Provider-specific
    // behavior (Chrome/system, the new SystemTranslatorUnavailableError
    // branch) is covered separately in providers.test.ts /
    // queueProvider.test.ts.
    const provider = new LlmTranslationProvider(() => settings);
    queue = new TranslateQueue({
      getSettings: () => settings,
      getMeetingGen: () => meetingGen,
      provider,
      onTranslations,
      onError,
    });
  });

  afterEach(() => {
    queue.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // S14.1 field fix (item 8b): DEBOUNCE_MS 1500->800, BATCH_MAX 6->3 —
  // see queue.ts's own doc comment above both constants for the "big
  // clump" rationale. Every timing number below is derived from the
  // new values, not the old ones.
  it("debounces 800ms before flushing", async () => {
    mockTranslateApi.mockResolvedValue(emptyRes());
    queue.pushSegment(makeSegment("hello"));
    expect(mockTranslateApi).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(799);
    expect(mockTranslateApi).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
  });

  it("caps a batch at 3 oldest-first (FIFO), leaving the rest pending", async () => {
    const d1 = deferred<{ translations: { id: string; text: string }[] }>();
    mockTranslateApi.mockImplementationOnce(() => d1.promise);

    const segs = Array.from({ length: 5 }, (_, i) => makeSegment(`seg text ${i}`));
    for (const s of segs) queue.pushSegment(s);

    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    const firstCallBody = mockTranslateApi.mock.calls[0][0];
    expect(firstCallBody.segments).toHaveLength(3);
    expect(firstCallBody.segments.map((s) => s.id)).toEqual(segs.slice(0, 3).map((s) => s.id));

    // Resolve the first batch, freeing the in-flight slot -> the
    // remaining 2 items should flush as a second batch.
    mockTranslateApi.mockResolvedValueOnce(emptyRes());
    d1.resolve(emptyRes());
    await vi.advanceTimersByTimeAsync(0);
    // Second batch is armed via the ordinary debounce timer.
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(2);
    const secondCallBody = mockTranslateApi.mock.calls[1][0];
    expect(secondCallBody.segments.map((s) => s.id)).toEqual(segs.slice(3, 5).map((s) => s.id));
  });

  it("single in-flight max: a batch dispatched while one is in-flight is not sent until the first resolves", async () => {
    const d1 = deferred<{ translations: { id: string; text: string }[] }>();
    mockTranslateApi.mockImplementationOnce(() => d1.promise);

    queue.pushSegment(makeSegment("first batch"));
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    // New segment arrives while the first request is still in-flight.
    queue.pushSegment(makeSegment("second batch, queued"));
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    mockTranslateApi.mockResolvedValueOnce(emptyRes());
    d1.resolve(emptyRes());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(2);
  });

  it("toggle off: pushSegment is a silent no-op", async () => {
    settings = makeSettings({ bilingualTranscript: false });
    queue.pushSegment(makeSegment("should be ignored"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockTranslateApi).not.toHaveBeenCalled();
  });

  it("skips (silently) any segment whose text exceeds 1500 chars", async () => {
    mockTranslateApi.mockResolvedValue(emptyRes());
    queue.pushSegment(makeSegment("a".repeat(1501)));
    queue.pushSegment(makeSegment("short one, under the cap"));

    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    const body = mockTranslateApi.mock.calls[0][0];
    expect(body.segments).toHaveLength(1);
    expect(body.segments[0].text).toBe("short one, under the cap");
  });

  it("exactly 1500 chars is NOT skipped (boundary)", async () => {
    mockTranslateApi.mockResolvedValue(emptyRes());
    queue.pushSegment(makeSegment("a".repeat(1500)));
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
  });

  it("NoKeyError pauses for 60s (self-healing, not a permanent latch) and fires onError exactly once for the meeting", async () => {
    mockTranslateApi.mockRejectedValueOnce(new NoKeyError());

    queue.pushSegment(makeSegment("first"));
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(
      "未配置 API Key，双语转录已暂停。前往设置填入 Key 即可自动恢复",
    );

    // A segment pushed during the 60s pause does not trigger a new
    // attempt (still paused), and does NOT re-fire the toast.
    onError.mockClear();
    queue.pushSegment(makeSegment("second, during the pause"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    // Still no key -> the 60s resume attempt throws NoKeyError again,
    // pausing another 60s, but the toast still doesn't repeat.
    mockTranslateApi.mockRejectedValueOnce(new NoKeyError());
    await vi.advanceTimersByTimeAsync(55_000); // total 60_000ms since the first failure
    expect(mockTranslateApi).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("NoKeyError self-heals once a key is configured — the next 60s retry picks up any newly-pushed segment and translates normally", async () => {
    mockTranslateApi.mockRejectedValueOnce(new NoKeyError());

    queue.pushSegment(makeSegment("first, no key yet"));
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // User fills in a key mid-pause; a fresh segment arrives too.
    mockTranslateApi.mockResolvedValueOnce(emptyRes());
    queue.pushSegment(makeSegment("second, key now configured"));

    // The 60s pause lifts on its own (no restart, no new pushSegment
    // needed to re-arm) and the pending segment is translated.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockTranslateApi).toHaveBeenCalledTimes(2);
    const body = mockTranslateApi.mock.calls[1][0];
    expect(body.segments.map((s) => s.text)).toEqual(["second, key now configured"]);

    // Recovery is quiet — no additional toast.
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("RateLimitApiError pauses for 30s then resumes automatically without a new segment arriving", async () => {
    mockTranslateApi.mockRejectedValueOnce(new RateLimitApiError());
    mockTranslateApi.mockResolvedValueOnce(emptyRes());

    queue.pushSegment(makeSegment("gets rate limited"));
    queue.pushSegment(makeSegment("waits in queue during the pause"));
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    // Still paused just before the 30s window elapses.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    // Resumes on its own at the 30s boundary — no new pushSegment call.
    await vi.advanceTimersByTimeAsync(1);
    expect(mockTranslateApi).toHaveBeenCalledTimes(2);
  });

  it("5 consecutive RateLimitApiErrors drop the batch instead of re-queuing it forever, and a new segment pushed afterward still gets translated", async () => {
    // 4 consecutive 429s re-queue the same batch each time (existing
    // behavior); the 5th consecutive 429 drops it instead.
    for (let i = 0; i < 5; i++) {
      mockTranslateApi.mockRejectedValueOnce(new RateLimitApiError());
    }
    mockTranslateApi.mockResolvedValueOnce(emptyRes());

    queue.pushSegment(makeSegment("gets rate limited forever"));
    await vi.advanceTimersByTimeAsync(800); // attempt #1 (consecutiveRateLimits -> 1)
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 4; i++) {
      // Each 30s pause resumes on its own and re-attempts the SAME
      // re-queued batch (consecutiveRateLimits -> 2, 3, 4, then the
      // 5th attempt here hits the >=5 threshold and drops it instead
      // of re-queuing again).
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(mockTranslateApi).toHaveBeenCalledTimes(5);

    // The queue is not stuck after the drop: a brand-new segment
    // pushed now (nothing left in `pending` from the dropped batch)
    // still gets translated — though it has to wait out the drop's
    // OWN pauseFor(30s) first (the same "prevent an immediate re-429"
    // guard the <5 branch already relies on), not just its own 800ms
    // debounce.
    queue.pushSegment(makeSegment("new segment, after the drop"));
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(5); // still paused from the drop
    await vi.advanceTimersByTimeAsync(30_000 - 800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(6);
    const body = mockTranslateApi.mock.calls[5][0];
    expect(body.segments.map((s) => s.text)).toEqual(["new segment, after the drop"]);
  });

  // S14.1 field fix (item 8a): this drop used to be a silent
  // console.warn/no-op — a phone field session has no way to see
  // devtools, so diagLog is the only trail. Pins the tag/content, not
  // just "some log call happened".
  it("dropping a batch after 5 consecutive rate limits diagLogs the drop (used to be silent)", async () => {
    const diagSpy = vi.spyOn(diagLogModule, "diagLog");
    for (let i = 0; i < 5; i++) {
      mockTranslateApi.mockRejectedValueOnce(new RateLimitApiError());
    }

    queue.pushSegment(makeSegment("one"));
    queue.pushSegment(makeSegment("two"));
    await vi.advanceTimersByTimeAsync(800);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    expect(diagSpy).toHaveBeenCalledWith(
      "warn",
      "translate-queue",
      expect.stringContaining("rate-limit"),
      expect.stringContaining("count=2"),
    );
  });

  it("a successful batch resets the consecutive-rate-limit counter — 4 rate limits then a success then 4 more do NOT trigger the drop-batch threshold", async () => {
    for (let i = 0; i < 4; i++) {
      mockTranslateApi.mockRejectedValueOnce(new RateLimitApiError());
    }
    mockTranslateApi.mockResolvedValueOnce(emptyRes()); // resets the counter to 0
    for (let i = 0; i < 4; i++) {
      mockTranslateApi.mockRejectedValueOnce(new RateLimitApiError());
    }
    mockTranslateApi.mockResolvedValueOnce(emptyRes());

    queue.pushSegment(makeSegment("survives interleaved rate limits"));
    await vi.advanceTimersByTimeAsync(800); // attempt #1

    // 3 more retries (consecutiveRateLimits: 2, 3, 4) then the 5th
    // attempt succeeds (resetting the counter) rather than dropping,
    // since the previous run was only 4 consecutive, not 5.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(mockTranslateApi).toHaveBeenCalledTimes(5);

    // Push a fresh segment and run another run of 4 consecutive 429s —
    // if the counter had NOT reset after the success above, this would
    // hit the >=5 threshold on the 4th of these and drop early. It
    // must instead behave exactly like a fresh run: re-queue each time.
    queue.pushSegment(makeSegment("second run of rate limits"));
    await vi.advanceTimersByTimeAsync(800);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(mockTranslateApi).toHaveBeenCalledTimes(9);

    // The 5th attempt of this second run finally succeeds — same
    // segment text still present (i.e. it was re-queued, not dropped).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockTranslateApi).toHaveBeenCalledTimes(10);
    const body = mockTranslateApi.mock.calls[9][0];
    expect(body.segments.map((s) => s.text)).toEqual(["second run of rate limits"]);
  });

  it("a transient (non-NoKey, non-rate-limit) error re-queues the batch for retry after the 5s cooldown", async () => {
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502"));
    mockTranslateApi.mockResolvedValueOnce(emptyRes());

    queue.pushSegment(makeSegment("fails once, then retried"));
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    // A distinct segment arrives during the post-error cooldown — the
    // cooldown still gates everything (no immediate hammering).
    queue.pushSegment(makeSegment("arrives during cooldown"));
    await vi.advanceTimersByTimeAsync(800); // its own debounce elapses…
    expect(mockTranslateApi).toHaveBeenCalledTimes(1); // …but cooldown gates it

    await vi.advanceTimersByTimeAsync(4_199); // total 4999ms since the failure
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1); // 5000ms — cooldown lifts
    expect(mockTranslateApi).toHaveBeenCalledTimes(2);
    // The failed item is retried at the FRONT of the follow-up batch,
    // ahead of the newer segment (transient 5xx must not silently
    // strip translations from a whole batch).
    const body = mockTranslateApi.mock.calls[1][0];
    expect(body.segments.map((s) => s.text)).toEqual([
      "fails once, then retried",
      "arrives during cooldown",
    ]);
  });

  // S14.1 field fix (item 8a): a segment now gets MAX_RETRIES_PER_SEGMENT
  // (3) retries — 4 total attempts — instead of the old one-shot Set's
  // single retry (2 total attempts), specifically so a segment unlucky
  // enough to fail right around a pause/resume-correlated network blip
  // isn't permanently abandoned by its FIRST bad-timing failure. See
  // queue.ts's own MAX_RETRIES_PER_SEGMENT doc for the full field-report
  // rationale.
  it("an item exhausts MAX_RETRIES_PER_SEGMENT (3) retries and is then dropped for good — no infinite retry loop", async () => {
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502"));
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502 again"));
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502 a third time"));
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502 a fourth time"));
    mockTranslateApi.mockResolvedValueOnce(emptyRes());

    queue.pushSegment(makeSegment("fails 4 times, dropped"));
    await vi.advanceTimersByTimeAsync(800); // attempt #1 (original) fails -> retry #1 queued
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 3; i++) {
      // Each 5s cooldown lifts on its own and re-attempts the SAME
      // re-queued segment (retries #1, #2, #3 — the 3rd of these is
      // the segment's 4th and FINAL attempt, exhausting the cap).
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(mockTranslateApi).toHaveBeenCalledTimes(4); // 1 original + 3 retries, all failed

    // After exhausting every retry the item must NOT be re-queued
    // again: a fresh segment pushed after the last cooldown translates
    // alone.
    queue.pushSegment(makeSegment("fresh segment, after the drop"));
    await vi.advanceTimersByTimeAsync(5_000); // final cooldown lifts
    expect(mockTranslateApi).toHaveBeenCalledTimes(5);
    const body = mockTranslateApi.mock.calls[4][0];
    expect(body.segments.map((s) => s.text)).toEqual([
      "fresh segment, after the drop",
    ]);
  });

  // S14.1 field fix (item 8a): same "used to be console.warn only"
  // visibility gap as the rate-limit drop above, for the generic-error
  // exhausted-retries path.
  it("exhausting a segment's retries diagLogs the drop (used to be console.warn only)", async () => {
    const diagSpy = vi.spyOn(diagLogModule, "diagLog");
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502"));
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502 again"));
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502 a third time"));
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502 a fourth time"));

    queue.pushSegment(makeSegment("fails 4 times, dropped"));
    await vi.advanceTimersByTimeAsync(800);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(diagSpy).toHaveBeenCalledWith(
      "warn",
      "translate-queue",
      expect.stringContaining("gave up"),
      expect.stringContaining("count=1"),
    );
  });

  it("meeting-boundary guard: a response whose gen no longer matches the current meetingGen is silently dropped", async () => {
    const d1 = deferred<{ translations: { id: string; text: string }[] }>();
    mockTranslateApi.mockImplementationOnce(() => d1.promise);

    queue.pushSegment(makeSegment("in flight when meeting ends"));
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    meetingGen += 1; // a new meeting begins while this request is in flight

    d1.resolve({ translations: [{ id: "seg-1", text: "过期的翻译" }] });
    await vi.advanceTimersByTimeAsync(0);

    expect(onTranslations).not.toHaveBeenCalled();
  });

  it("meeting-boundary guard also applies to the error path (NoKeyError for a stale-gen batch is dropped, no pause/toast)", async () => {
    const d1 = deferred<{ translations: { id: string; text: string }[] }>();
    mockTranslateApi.mockImplementationOnce(() => d1.promise);

    queue.pushSegment(makeSegment("in flight when meeting ends"));
    await vi.advanceTimersByTimeAsync(800); // dispatches with gen=0 captured
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    meetingGen += 1; // new meeting begins while the request is in flight
    d1.reject(new NoKeyError());
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).not.toHaveBeenCalled();

    // Confirm no 60s pause was armed for the stale-gen error: a fresh
    // segment on the new meeting should still attempt translation
    // immediately, on its own ordinary debounce.
    mockTranslateApi.mockResolvedValueOnce(emptyRes());
    queue.pushSegment(makeSegment("new meeting, should still translate"));
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(2);
  });

  it("backfill enqueues at the FRONT, ahead of already-pending segments", async () => {
    mockTranslateApi.mockResolvedValue(emptyRes());

    const later = makeSegment("pushed first, via pushSegment");
    queue.pushSegment(later);

    const earlier = [makeSegment("backfilled 1"), makeSegment("backfilled 2")];
    queue.backfill(earlier);

    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    const body = mockTranslateApi.mock.calls[0][0];
    expect(body.segments.map((s) => s.id)).toEqual([
      earlier[0].id,
      earlier[1].id,
      later.id,
    ]);
  });

  it("backfill respects the toggle-off no-op and the >1500-char skip, same as pushSegment", async () => {
    settings = makeSettings({ bilingualTranscript: false });
    queue.backfill([makeSegment("ignored while off")]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockTranslateApi).not.toHaveBeenCalled();

    settings = makeSettings();
    mockTranslateApi.mockResolvedValue(emptyRes());
    queue.backfill([makeSegment("a".repeat(1501)), makeSegment("kept")]);
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    const body = mockTranslateApi.mock.calls[0][0];
    expect(body.segments).toHaveLength(1);
    expect(body.segments[0].text).toBe("kept");
  });

  it("flipping the toggle OFF during the debounce window drops pending items — no request fires, and they don't resurrect when the toggle returns", async () => {
    mockTranslateApi.mockResolvedValue(emptyRes());

    queue.pushSegment(makeSegment("enqueued while on"));
    settings = makeSettings({ bilingualTranscript: false }); // user opts out mid-debounce
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockTranslateApi).not.toHaveBeenCalled();

    // Toggle back on: only NEW segments translate — the dropped one
    // does not come back.
    settings = makeSettings();
    const fresh = makeSegment("new segment after re-enable");
    queue.pushSegment(fresh);
    await vi.advanceTimersByTimeAsync(800);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    const body = mockTranslateApi.mock.calls[0][0];
    expect(body.segments.map((s) => s.id)).toEqual([fresh.id]);
  });

  it("stop() clears timers and pending items — nothing flushes afterward", async () => {
    queue.pushSegment(makeSegment("about to be stopped"));
    queue.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockTranslateApi).not.toHaveBeenCalled();
  });
});

// v0.7 wave 2A — onState (additive, optional) + drain(). Own describe/
// beforeEach/afterEach (own queue instance, WITH onState wired) rather
// than reusing the outer describe's shared `queue` (constructed without
// onState in ITS OWN beforeEach) — mirrors queueProvider.test.ts's own
// per-file "own makeQueue helper" pattern for the same reason.
describe("TranslateQueue — onState / drain", () => {
  let settings: Settings;
  let meetingGen: number;
  let onTranslations: ReturnType<typeof vi.fn<(map: Record<string, string>, gen: number) => void>>;
  let onError: ReturnType<typeof vi.fn<(msg: string) => void>>;
  let onState: ReturnType<
    typeof vi.fn<
      (s: { state: "off" | "busy" | "done" | "stalled" | "dead"; pending: number; reason?: string }) => void
    >
  >;
  let queue: TranslateQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    segIndex = 0;
    settings = makeSettings();
    meetingGen = 0;
    onTranslations = vi.fn<(map: Record<string, string>, gen: number) => void>();
    onError = vi.fn<(msg: string) => void>();
    onState = vi.fn();
    mockTranslateApi.mockReset();
    const provider = new LlmTranslationProvider(() => settings);
    queue = new TranslateQueue({
      getSettings: () => settings,
      getMeetingGen: () => meetingGen,
      provider,
      onTranslations,
      onError,
      onState,
    });
  });

  afterEach(() => {
    queue.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("busy -> done: push, dispatch, and a successful landing drains the queue to 'done'", async () => {
    mockTranslateApi.mockResolvedValueOnce({ translations: [{ id: "seg-1", text: "你好" }] });

    queue.pushSegment(makeSegment("hello"));
    await vi.advanceTimersByTimeAsync(800);

    // Finding 5 fix (adversarial review): dispatching a batch moves
    // items from `pending` into "in flight" but doesn't change the
    // REPORTED total (see emitState's own doc) — so tryFlush's own
    // dispatch-time emission is now identical to pushSegment's {busy,1}
    // and gets deduped, rather than firing its own (previously
    // misleading) {busy, pending:0} in between.
    expect(onState.mock.calls.map((c) => c[0])).toEqual([
      { state: "busy", pending: 1, reason: undefined }, // pushSegment: enqueued, still idle otherwise
      { state: "done", pending: 0, reason: undefined }, // batch lands, queue drains to idle
    ]);
  });

  it("Finding 5: a <=batch-size backlog reports its full count while dispatched but still unresolved — in-flight items count towards `pending`, not just queued ones", async () => {
    mockTranslateApi.mockImplementationOnce(() => new Promise(() => {})); // never resolves — stays in flight

    queue.pushSegment(makeSegment("one"));
    queue.pushSegment(makeSegment("two"));
    await vi.advanceTimersByTimeAsync(800); // dispatches both (N=2 <= BATCH_MAX=3); still unresolved

    expect(onState).toHaveBeenLastCalledWith({ state: "busy", pending: 2, reason: undefined });
  });

  it("never emits 'done' before at least one translation has actually landed — a batch that resolves with zero translations reports 'off' (idle, nothing shown) instead of going silent", async () => {
    mockTranslateApi.mockResolvedValue({ translations: [] });

    queue.pushSegment(makeSegment("hello"));
    await vi.advanceTimersByTimeAsync(800);

    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "done" }));
    // Finding 6 fix (adversarial review): the drain that used to be
    // silent now reports "off" so a caller's chip never gets stuck on
    // its last "busy" reading forever.
    expect(onState).toHaveBeenLastCalledWith({ state: "off", pending: 0, reason: undefined });
  });

  it("stalled on pause: a NoKeyError pause emits 'stalled' with the SAME zh reason string as the onError toast", async () => {
    mockTranslateApi.mockRejectedValueOnce(new NoKeyError());

    queue.pushSegment(makeSegment("hello"));
    await vi.advanceTimersByTimeAsync(800);

    expect(onState).toHaveBeenCalledWith({
      state: "stalled",
      pending: 0,
      reason: "未配置 API Key，双语转录已暂停。前往设置填入 Key 即可自动恢复",
    });
    expect(onError).toHaveBeenCalledWith(onState.mock.calls.at(-1)?.[0].reason);
  });

  it("stalled: a rate-limit/generic-error pause has no existing zh toast copy, so reason stays undefined", async () => {
    mockTranslateApi.mockRejectedValueOnce(new RateLimitApiError());

    queue.pushSegment(makeSegment("hello"));
    await vi.advanceTimersByTimeAsync(800);

    // Below MAX_CONSECUTIVE_RATE_LIMITS, the batch is re-queued at the
    // front (see handleError's RateLimitApiError branch) — pending is 1,
    // not 0, once the pause takes effect.
    expect(onState).toHaveBeenCalledWith({ state: "stalled", pending: 1, reason: undefined });
  });

  it("dedupes consecutive identical emissions — a batch-cap leftover re-emitting the SAME {state,pending} does not re-fire onState", async () => {
    // BATCH_MAX (3) caps the first dispatch: 1 item is left over in
    // `pending`, and 3 move to in-flight — with the Finding 5 fix,
    // pending.length + inflightCount (1 + 3 = 4) is UNCHANGED from
    // push4's own {busy,4}, so tryFlush's own dispatch-time emission is
    // deduped. Once that in-flight batch resolves (0 translations, so
    // never "lands"), inflightCount drops back to 0 while the 1
    // leftover is still queued — a genuinely new {busy, pending:1} — so
    // THAT is the one that actually fires.
    mockTranslateApi.mockResolvedValue({ translations: [] }); // never "lands" — irrelevant to this test
    for (let i = 0; i < 4; i++) queue.pushSegment(makeSegment(`seg ${i}`));
    await vi.advanceTimersByTimeAsync(800);

    // 4 pushes (pending 1,2,3,4) + 1 post-resolve emission (busy,1) = 5.
    // The dispatch-time emission itself is deduped (see above).
    expect(onState).toHaveBeenCalledTimes(5);
    expect(onState).toHaveBeenLastCalledWith({ state: "busy", pending: 1, reason: undefined });
  });

  it("drain() resolves true immediately when the queue is already idle", async () => {
    await expect(queue.drain(1000)).resolves.toBe(true);
  });

  it("drain() resolves false once the timeout elapses before the queue empties", async () => {
    mockTranslateApi.mockImplementationOnce(() => new Promise(() => {})); // never resolves
    queue.pushSegment(makeSegment("stuck forever"));
    await vi.advanceTimersByTimeAsync(800); // dispatches — now inflight with no end in sight

    const result = queue.drain(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toBe(false);
  });

  it("drain() resolves false immediately (no waiting at all) when the queue is currently paused/stalled", async () => {
    mockTranslateApi.mockRejectedValueOnce(new NoKeyError());
    queue.pushSegment(makeSegment("hello"));
    await vi.advanceTimersByTimeAsync(800); // fails -> pauses 60s

    await expect(queue.drain(10_000)).resolves.toBe(false);
  });

  // FT-11 fix: "dead" — a lane that has failed every batch this meeting,
  // as opposed to "stalled" (a self-healing pause). Uses a plain generic
  // error (not NoKey/RateLimit/SystemTranslatorUnavailable) so
  // ERROR_COOLDOWN_MS (5s) drives each retry — the counter itself is
  // provider-agnostic (queue.ts's own handleError increments it in every
  // branch), only the wiring here happens to reuse the generic-error path.
  it("3 consecutive failed batches with nothing ever landed emits 'dead'; a later success clears it; 2 failures alone do NOT (hysteresis)", async () => {
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502"));
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502 again"));

    queue.pushSegment(makeSegment("one"));
    await vi.advanceTimersByTimeAsync(800); // attempt #1 fails (1 consecutive)
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "dead" }));

    await vi.advanceTimersByTimeAsync(5_000); // attempt #2 fails (2 consecutive)
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "dead" }));

    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502 a third time"));
    await vi.advanceTimersByTimeAsync(5_000); // attempt #3 fails (3 consecutive) -> dead
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ state: "dead" }));

    // A later success clears it — the queue drains to "done".
    mockTranslateApi.mockResolvedValueOnce({ translations: [{ id: "seg-1", text: "你好" }] });
    await vi.advanceTimersByTimeAsync(5_000); // attempt #4 lands
    expect(onState).toHaveBeenLastCalledWith({ state: "done", pending: 0, reason: undefined });
  });

  it("'dead' is sticky — a later retry (busy) does not flip it back until a translation actually lands", async () => {
    for (let i = 0; i < 3; i++) {
      mockTranslateApi.mockRejectedValueOnce(new Error(`upstream 502 #${i}`));
    }
    // Never resolves — the retry after "dead" stays in flight (busy),
    // proving the chip does not flip back to busy on its own.
    mockTranslateApi.mockImplementationOnce(() => new Promise(() => {}));

    queue.pushSegment(makeSegment("one"));
    await vi.advanceTimersByTimeAsync(800); // #1 fails
    await vi.advanceTimersByTimeAsync(5_000); // #2 fails
    await vi.advanceTimersByTimeAsync(5_000); // #3 fails -> dead
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ state: "dead" }));

    await vi.advanceTimersByTimeAsync(5_000); // #4 dispatches — would read "busy" without the fix
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ state: "dead" }));
  });

  // Long-session hardening item 1: the old "dead" condition also
  // required !hasLandedTranslation — unreachable in production once a
  // lane had landed even a single translation (the v0.7.5 lesson: a
  // unit-tested escape hatch a real session could never actually hit,
  // since it lands at least one translation almost immediately). A
  // 90-minute seminar that translates fine for an hour and then dies
  // for good must still show "dead".
  it("a lane that already landed 5 translations still goes 'dead' after 3 consecutive failures, diagLogs the transition, and a later landing clears it (long-session hardening item 1)", async () => {
    for (let i = 1; i <= 5; i++) {
      mockTranslateApi.mockResolvedValueOnce({ translations: [{ id: `seg-${i}`, text: `第${i}句` }] });
    }
    for (let i = 1; i <= 5; i++) {
      queue.pushSegment(makeSegment(`landed ${i}`));
      await vi.advanceTimersByTimeAsync(800);
    }
    expect(mockTranslateApi).toHaveBeenCalledTimes(5);
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "dead" }));

    const diagSpy = vi.spyOn(diagLogModule, "diagLog");
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502 #1"));
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502 #2"));
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502 #3"));

    queue.pushSegment(makeSegment("starts failing"));
    await vi.advanceTimersByTimeAsync(800); // attempt #1 fails (1 consecutive)
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "dead" }));
    await vi.advanceTimersByTimeAsync(5_000); // attempt #2 fails (2 consecutive)
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "dead" }));
    await vi.advanceTimersByTimeAsync(5_000); // attempt #3 fails (3 consecutive) -> dead, even with 5 already landed
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ state: "dead" }));
    // The visibility fix (queue.ts's own diagLog gate) must also fire
    // here — not just the OLD "never landed" case.
    expect(diagSpy).toHaveBeenCalledWith(
      "error",
      "translate-queue",
      expect.stringContaining("consecutive-failure threshold"),
      "consecutiveFailedBatches=3",
    );

    // A subsequent landing clears it.
    mockTranslateApi.mockResolvedValueOnce({ translations: [{ id: "seg-6", text: "六" }] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onState).toHaveBeenLastCalledWith({ state: "done", pending: 0, reason: undefined });
  });

  // Long-session hardening item 2: attemptTranslate's own empty-response
  // branch is a deliberate no-op (failed-soft — see that comment) that
  // never touches consecutiveFailedBatches at all, so a provider that
  // quietly returns [] forever would never reach "dead" via item 1's fix
  // above either.
  it("8 finals with the provider returning an empty (but successful) response every time also goes 'dead'; a subsequent real landing resets it (long-session hardening item 2)", async () => {
    mockTranslateApi.mockResolvedValue({ translations: [] });

    for (let i = 1; i <= 8; i++) {
      queue.pushSegment(makeSegment(`empty ${i}`));
      await vi.advanceTimersByTimeAsync(800);
      if (i < 8) {
        expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "dead" }));
      }
    }
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ state: "dead" }));
    // Confirms this run alone (no thrown errors, ever) is what tripped
    // it — consecutiveFailedBatches never moved off 0.
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "stalled" }));

    // A real landing resets finalsSinceLastLanding.
    mockTranslateApi.mockResolvedValueOnce({ translations: [{ id: "seg-9", text: "好" }] });
    queue.pushSegment(makeSegment("real landing"));
    await vi.advanceTimersByTimeAsync(800);
    expect(onState).toHaveBeenLastCalledWith({ state: "done", pending: 0, reason: undefined });
  });
});
