// S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
// Gating F13) — mlx_capabilities() probe/cache coverage, mirroring
// audiocapCaps.test.ts's own split: probeMlxCapabilitiesWith() is
// directly unit-testable with a fake invoke (no module-mocking
// gymnastics), the thin probeMlxCaps()/refreshMlxCaps() IS_DESKTOP-guard
// wrappers are tested "in the test env's default (NEXT_PUBLIC_DESKTOP
// unset) state" (same as audiocapCaps.test.ts's own probeAudiocapCaps
// coverage) — DELIBERATELY the opposite fail-CLOSED assertions
// throughout, per this module's own POLICY doc comment.
//
// S12a fix round (§D F7) — every probe/refresh now resolves the pinned
// `{status: "ok" | "error", caps}` envelope (not a bare
// `MlxCapabilities`); `reason` is `string | null` (required); a new
// "overlap races" describe block covers the request-generation guard
// (stale-snapshot: an older, slower-resolving attempt must not clobber
// a newer one's cached/notified result) and the inFlight identity
// guard (an older probeMlxCaps() attempt settling after a
// refreshMlxCaps() has already taken over `inFlight` must not null out
// the newer one's still-pending reference).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMlxCapsSnapshot,
  probeMlxCapabilitiesWith,
  probeMlxCaps,
  refreshMlxCaps,
  resetMlxCapsCache,
  subscribeMlxCaps,
  type MlxCapabilities,
  type MlxCapsResult,
} from "../mlxCaps";
import type { InvokeFn } from "../tauriApi";

function fakeInvoke(handler: () => unknown): InvokeFn {
  return (async () => handler()) as InvokeFn;
}

/** A fakeInvoke() that resolves only once `resolve()` is called
 *  externally — for the overlap-race tests below, which need to
 *  control exactly when each competing probe's own round trip
 *  settles. */
function makeGatedInvoke(): { invoke: InvokeFn; resolve: (caps: MlxCapabilities) => void } {
  let resolveFn!: (caps: MlxCapabilities) => void;
  const gate = new Promise<MlxCapabilities>((resolve) => {
    resolveFn = resolve;
  });
  const invoke: InvokeFn = (async () => gate) as InvokeFn;
  return { invoke, resolve: resolveFn };
}

const FAIL_CLOSED: MlxCapabilities = { mlxSupported: false, reason: "无法确认 Apple 芯片支持，请重试" };

describe("probeMlxCapabilitiesWith — pure core (no IS_DESKTOP coupling)", () => {
  beforeEach(() => resetMlxCapsCache());
  afterEach(() => resetMlxCapsCache());

  it("a definitive mlxSupported:true result is cached and notifies subscribers, status:\"ok\"", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMlxCaps(listener);
    const caps: MlxCapabilities = { mlxSupported: true, reason: null };

    const result = await probeMlxCapabilitiesWith(fakeInvoke(() => caps));

    expect(result).toEqual({ status: "ok", caps });
    expect(getMlxCapsSnapshot()).toEqual(caps);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("a definitive mlxSupported:false result is equally cached (fail-closed is a real, cacheable answer), status:\"ok\"", async () => {
    const caps: MlxCapabilities = { mlxSupported: false, reason: "需要 Apple 芯片（M 系列），macOS 14 或更高" };
    const result = await probeMlxCapabilitiesWith(fakeInvoke(() => caps));

    expect(result).toEqual({ status: "ok", caps });
    expect(getMlxCapsSnapshot()).toEqual(caps);
  });

  it("an invoke() rejection resolves status:\"error\"/FAIL-CLOSED without caching it — a later probe still gets to try again", async () => {
    const result = await probeMlxCapabilitiesWith(
      fakeInvoke(() => {
        throw new Error("ipc failure");
      }),
    );

    expect(result).toEqual({ status: "error", caps: FAIL_CLOSED });
    // POLICY (opposite of audiocapCaps.ts's fail-OPEN posture): an error
    // is never trusted as a definitive answer — the snapshot stays null
    // (not-yet-resolved), not permanently pinned to the fail-closed
    // shape either.
    expect(getMlxCapsSnapshot()).toBeNull();
  });

  it("an unsubscribed listener is never notified", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMlxCaps(listener);
    unsubscribe();

    await probeMlxCapabilitiesWith(fakeInvoke(() => ({ mlxSupported: true, reason: null })));

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("probeMlxCaps — IS_DESKTOP-guarded single-flight wrapper", () => {
  beforeEach(() => resetMlxCapsCache());
  afterEach(() => resetMlxCapsCache());

  it("outside a desktop build (NEXT_PUBLIC_DESKTOP unset in the test env), resolves status:\"error\"/FAIL-CLOSED without ever reaching getInvoke()", async () => {
    const result = await probeMlxCaps();

    expect(result).toEqual({ status: "error", caps: FAIL_CLOSED });
    expect(getMlxCapsSnapshot()).toBeNull(); // never actually probed
  });

  it("a cached value short-circuits a later call without re-probing, status:\"ok\"", async () => {
    await probeMlxCapabilitiesWith(fakeInvoke(() => ({ mlxSupported: false, reason: "x" })));

    const result = await probeMlxCaps();
    expect(result).toEqual({ status: "ok", caps: { mlxSupported: false, reason: "x" } });
  });

  it("resetMlxCapsCache clears the cached snapshot and listeners", async () => {
    await probeMlxCapabilitiesWith(fakeInvoke(() => ({ mlxSupported: true, reason: null })));
    expect(getMlxCapsSnapshot()).not.toBeNull();

    resetMlxCapsCache();

    expect(getMlxCapsSnapshot()).toBeNull();
  });

  it("resetMlxCapsCache drops registered listeners — a subscriber from before the reset is never notified by a probe after it", async () => {
    const listener = vi.fn();
    subscribeMlxCaps(listener);

    resetMlxCapsCache();
    await probeMlxCapabilitiesWith(fakeInvoke(() => ({ mlxSupported: true, reason: null })));

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("refreshMlxCaps — worker A2's live-retry affordance (distinct from resetMlxCapsCache)", () => {
  beforeEach(() => resetMlxCapsCache());
  afterEach(() => resetMlxCapsCache());

  it("outside a desktop build, resolves status:\"error\"/FAIL-CLOSED without ever reaching getInvoke() — same guard as probeMlxCaps", async () => {
    const result = await refreshMlxCaps();
    expect(result).toEqual({ status: "error", caps: FAIL_CLOSED });
    expect(getMlxCapsSnapshot()).toBeNull();
  });

  it("KEEPS registered listeners (unlike resetMlxCapsCache) — a subscriber registered before the refresh IS notified once it resolves", async () => {
    // Seed a definitive cached value first (mirrors a real fail-closed
    // UI having something to retry FROM).
    await probeMlxCapabilitiesWith(fakeInvoke(() => ({ mlxSupported: false, reason: "x" })));

    const listener = vi.fn();
    subscribeMlxCaps(listener);

    // refreshMlxCaps() itself is IS_DESKTOP-gated exactly like
    // probeMlxCaps() (see the test above) — this suite proves the
    // listener-preservation contract via probeMlxCapabilitiesWith
    // directly (the same underlying notify() path refreshMlxCaps calls
    // once IS_DESKTOP is true), since IS_DESKTOP can't be flipped true
    // from this test env without module-mocking gymnastics the sibling
    // Caps suites deliberately avoid too.
    await probeMlxCapabilitiesWith(fakeInvoke(() => ({ mlxSupported: true, reason: null })));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getMlxCapsSnapshot()).toEqual({ mlxSupported: true, reason: null });
  });

  it("resetMlxCapsCache, by contrast, drops the SAME listener — proving refreshMlxCaps and resetMlxCapsCache genuinely differ", async () => {
    const listener = vi.fn();
    subscribeMlxCaps(listener);

    resetMlxCapsCache();
    await probeMlxCapabilitiesWith(fakeInvoke(() => ({ mlxSupported: true, reason: null })));

    expect(listener).not.toHaveBeenCalled();
  });
});

// S12a fix round (§D F7) — the "apply stale snapshots" half of the
// overlap-race fix, exercised via probeMlxCapabilitiesWith directly
// (the ONE place `cached`/notify()/the request-generation counter are
// ever touched) — no IS_DESKTOP-forcing needed, matching this suite's
// own established "avoid module-mocking gymnastics" discipline
// elsewhere in this file. The OTHER half ("clear each other's
// inFlight") is only reachable through probeMlxCaps()/refreshMlxCaps()
// themselves (IS_DESKTOP-gated) — see mlxCaps.desktop.test.ts (mirrors
// engineOptions.desktop.test.ts's own "IS_DESKTOP is module-scope
// import-time, needs its own file" precedent) for that half.
describe("overlap races (§D F7) — stale-snapshot guard", () => {
  beforeEach(() => resetMlxCapsCache());
  afterEach(() => resetMlxCapsCache());

  it("an OLDER attempt that resolves AFTER a NEWER one must not clobber the newer one's cached value or fire a stale notify", async () => {
    const older = makeGatedInvoke();
    const newer = makeGatedInvoke();
    const notifications: (MlxCapabilities | null)[] = [];
    subscribeMlxCaps(() => notifications.push(getMlxCapsSnapshot()));

    const olderPromise = probeMlxCapabilitiesWith(older.invoke); // starts first — generation 1
    const newerPromise = probeMlxCapabilitiesWith(newer.invoke); // starts second — generation 2, now "latest"

    // Resolve the NEWER attempt first (it "wins" the race in real
    // time), then the older one settles LATE.
    newer.resolve({ mlxSupported: true, reason: null });
    const newerResult = await newerPromise;
    expect(newerResult).toEqual({ status: "ok", caps: { mlxSupported: true, reason: null } });
    expect(getMlxCapsSnapshot()).toEqual({ mlxSupported: true, reason: null });

    older.resolve({ mlxSupported: false, reason: "stale" });
    const olderResult = await olderPromise;
    // The older call still resolves ITS OWN promise with what IT
    // actually got (never lies to its own caller)...
    expect(olderResult).toEqual({ status: "ok", caps: { mlxSupported: false, reason: "stale" } });
    // ...but the SHARED cache/listeners are untouched by it — still
    // whatever the newer (latest) attempt left behind.
    expect(getMlxCapsSnapshot()).toEqual({ mlxSupported: true, reason: null });
    expect(notifications).toEqual([{ mlxSupported: true, reason: null }]); // exactly one notify — the newer's, never a second stale one
  });

  it("three overlapping attempts: only the LATEST-started one's result ever survives into cached/notify, regardless of resolution order", async () => {
    const first = makeGatedInvoke();
    const second = makeGatedInvoke();
    const third = makeGatedInvoke();

    const p1 = probeMlxCapabilitiesWith(first.invoke);
    const p2 = probeMlxCapabilitiesWith(second.invoke);
    const p3 = probeMlxCapabilitiesWith(third.invoke); // generation 3 — the latest

    // Resolve out of start-order: second, then first, then third.
    second.resolve({ mlxSupported: false, reason: "second" });
    await p2;
    first.resolve({ mlxSupported: false, reason: "first" });
    await p1;
    third.resolve({ mlxSupported: true, reason: null });
    await p3;

    expect(getMlxCapsSnapshot()).toEqual({ mlxSupported: true, reason: null });
  });
});
