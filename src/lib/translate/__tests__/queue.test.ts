import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings, type TranscriptSegment } from "../../types";

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
    queue = new TranslateQueue({
      getSettings: () => settings,
      getMeetingGen: () => meetingGen,
      onTranslations,
      onError,
    });
  });

  afterEach(() => {
    queue.stop();
    vi.useRealTimers();
  });

  it("debounces 1500ms before flushing", async () => {
    mockTranslateApi.mockResolvedValue(emptyRes());
    queue.pushSegment(makeSegment("hello"));
    expect(mockTranslateApi).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1499);
    expect(mockTranslateApi).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
  });

  it("caps a batch at 6 oldest-first (FIFO), leaving the rest pending", async () => {
    const d1 = deferred<{ translations: { id: string; text: string }[] }>();
    mockTranslateApi.mockImplementationOnce(() => d1.promise);

    const segs = Array.from({ length: 8 }, (_, i) => makeSegment(`seg text ${i}`));
    for (const s of segs) queue.pushSegment(s);

    await vi.advanceTimersByTimeAsync(1500);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    const firstCallBody = mockTranslateApi.mock.calls[0][0];
    expect(firstCallBody.segments).toHaveLength(6);
    expect(firstCallBody.segments.map((s) => s.id)).toEqual(segs.slice(0, 6).map((s) => s.id));

    // Resolve the first batch, freeing the in-flight slot -> the
    // remaining 2 items should flush as a second batch.
    mockTranslateApi.mockResolvedValueOnce(emptyRes());
    d1.resolve(emptyRes());
    await vi.advanceTimersByTimeAsync(0);
    // Second batch is armed via the ordinary debounce timer.
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockTranslateApi).toHaveBeenCalledTimes(2);
    const secondCallBody = mockTranslateApi.mock.calls[1][0];
    expect(secondCallBody.segments.map((s) => s.id)).toEqual(segs.slice(6, 8).map((s) => s.id));
  });

  it("single in-flight max: a batch dispatched while one is in-flight is not sent until the first resolves", async () => {
    const d1 = deferred<{ translations: { id: string; text: string }[] }>();
    mockTranslateApi.mockImplementationOnce(() => d1.promise);

    queue.pushSegment(makeSegment("first batch"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    // New segment arrives while the first request is still in-flight.
    queue.pushSegment(makeSegment("second batch, queued"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    mockTranslateApi.mockResolvedValueOnce(emptyRes());
    d1.resolve(emptyRes());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1500);
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

    await vi.advanceTimersByTimeAsync(1500);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    const body = mockTranslateApi.mock.calls[0][0];
    expect(body.segments).toHaveLength(1);
    expect(body.segments[0].text).toBe("short one, under the cap");
  });

  it("exactly 1500 chars is NOT skipped (boundary)", async () => {
    mockTranslateApi.mockResolvedValue(emptyRes());
    queue.pushSegment(makeSegment("a".repeat(1500)));
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
  });

  it("NoKeyError pauses for 60s (self-healing, not a permanent latch) and fires onError exactly once for the meeting", async () => {
    mockTranslateApi.mockRejectedValueOnce(new NoKeyError());

    queue.pushSegment(makeSegment("first"));
    await vi.advanceTimersByTimeAsync(1500);
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
    await vi.advanceTimersByTimeAsync(1500);
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
    await vi.advanceTimersByTimeAsync(1500);
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
    await vi.advanceTimersByTimeAsync(1500); // attempt #1 (consecutiveRateLimits -> 1)
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
    // guard the <5 branch already relies on), not just its own 1500ms
    // debounce.
    queue.pushSegment(makeSegment("new segment, after the drop"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockTranslateApi).toHaveBeenCalledTimes(5); // still paused from the drop
    await vi.advanceTimersByTimeAsync(30_000 - 1500);
    expect(mockTranslateApi).toHaveBeenCalledTimes(6);
    const body = mockTranslateApi.mock.calls[5][0];
    expect(body.segments.map((s) => s.text)).toEqual(["new segment, after the drop"]);
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
    await vi.advanceTimersByTimeAsync(1500); // attempt #1

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
    await vi.advanceTimersByTimeAsync(1500);
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

  it("a transient (non-NoKey, non-rate-limit) error re-queues the batch for ONE retry after the 5s cooldown", async () => {
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502"));
    mockTranslateApi.mockResolvedValueOnce(emptyRes());

    queue.pushSegment(makeSegment("fails once, then retried"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    // A distinct segment arrives during the post-error cooldown — the
    // cooldown still gates everything (no immediate hammering).
    queue.pushSegment(makeSegment("arrives during cooldown"));
    await vi.advanceTimersByTimeAsync(1500); // its own debounce elapses…
    expect(mockTranslateApi).toHaveBeenCalledTimes(1); // …but cooldown gates it

    await vi.advanceTimersByTimeAsync(3_499); // total 4999ms since the failure
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

  it("an item that fails its retry too is dropped for good — no infinite retry loop", async () => {
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502"));
    mockTranslateApi.mockRejectedValueOnce(new Error("upstream 502 again"));
    mockTranslateApi.mockResolvedValueOnce(emptyRes());

    queue.pushSegment(makeSegment("fails twice, dropped"));
    await vi.advanceTimersByTimeAsync(1500); // attempt #1 fails -> retry queued
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000); // cooldown lifts -> attempt #2 fails
    expect(mockTranslateApi).toHaveBeenCalledTimes(2);

    // After the second failure the item must NOT be re-queued again: a
    // fresh segment pushed after the second cooldown translates alone.
    queue.pushSegment(makeSegment("fresh segment, after the drop"));
    await vi.advanceTimersByTimeAsync(5_000); // second cooldown lifts
    expect(mockTranslateApi).toHaveBeenCalledTimes(3);
    const body = mockTranslateApi.mock.calls[2][0];
    expect(body.segments.map((s) => s.text)).toEqual([
      "fresh segment, after the drop",
    ]);
  });

  it("meeting-boundary guard: a response whose gen no longer matches the current meetingGen is silently dropped", async () => {
    const d1 = deferred<{ translations: { id: string; text: string }[] }>();
    mockTranslateApi.mockImplementationOnce(() => d1.promise);

    queue.pushSegment(makeSegment("in flight when meeting ends"));
    await vi.advanceTimersByTimeAsync(1500);
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
    await vi.advanceTimersByTimeAsync(1500); // dispatches with gen=0 captured
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
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockTranslateApi).toHaveBeenCalledTimes(2);
  });

  it("backfill enqueues at the FRONT, ahead of already-pending segments", async () => {
    mockTranslateApi.mockResolvedValue(emptyRes());

    const later = makeSegment("pushed first, via pushSegment");
    queue.pushSegment(later);

    const earlier = [makeSegment("backfilled 1"), makeSegment("backfilled 2")];
    queue.backfill(earlier);

    await vi.advanceTimersByTimeAsync(1500);
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
    await vi.advanceTimersByTimeAsync(1500);
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
    await vi.advanceTimersByTimeAsync(1500);
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
