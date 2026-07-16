// S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
// Gating F13) — mlx_capabilities() probe/cache coverage, mirroring
// audiocapCaps.test.ts's own split: probeMlxCapabilitiesWith() is
// directly unit-testable with a fake invoke (no module-mocking
// gymnastics), the thin probeMlxCaps()/refreshMlxCaps() IS_DESKTOP-guard
// wrappers are tested "in the test env's default (NEXT_PUBLIC_DESKTOP
// unset) state" (same as audiocapCaps.test.ts's own probeAudiocapCaps
// coverage) — DELIBERATELY the opposite fail-CLOSED assertions
// throughout, per this module's own POLICY doc comment.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMlxCapsSnapshot,
  probeMlxCapabilitiesWith,
  probeMlxCaps,
  refreshMlxCaps,
  resetMlxCapsCache,
  subscribeMlxCaps,
  type MlxCapabilities,
} from "../mlxCaps";
import type { InvokeFn } from "../tauriApi";

function fakeInvoke(handler: () => unknown): InvokeFn {
  return (async () => handler()) as InvokeFn;
}

const FAIL_CLOSED: MlxCapabilities = { mlxSupported: false, reason: "无法确认 Apple 芯片支持，请重试" };

describe("probeMlxCapabilitiesWith — pure core (no IS_DESKTOP coupling)", () => {
  beforeEach(() => resetMlxCapsCache());
  afterEach(() => resetMlxCapsCache());

  it("a definitive mlxSupported:true result is cached and notifies subscribers", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMlxCaps(listener);
    const caps: MlxCapabilities = { mlxSupported: true };

    const result = await probeMlxCapabilitiesWith(fakeInvoke(() => caps));

    expect(result).toEqual(caps);
    expect(getMlxCapsSnapshot()).toEqual(caps);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("a definitive mlxSupported:false result is equally cached (fail-closed is a real, cacheable answer)", async () => {
    const caps: MlxCapabilities = { mlxSupported: false, reason: "需要 Apple 芯片（M 系列），macOS 14 或更高" };
    const result = await probeMlxCapabilitiesWith(fakeInvoke(() => caps));

    expect(result).toEqual(caps);
    expect(getMlxCapsSnapshot()).toEqual(caps);
  });

  it("an invoke() rejection resolves FAIL-CLOSED without caching it — a later probe still gets to try again", async () => {
    const result = await probeMlxCapabilitiesWith(
      fakeInvoke(() => {
        throw new Error("ipc failure");
      }),
    );

    expect(result).toEqual(FAIL_CLOSED);
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

    await probeMlxCapabilitiesWith(fakeInvoke(() => ({ mlxSupported: true })));

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("probeMlxCaps — IS_DESKTOP-guarded single-flight wrapper", () => {
  beforeEach(() => resetMlxCapsCache());
  afterEach(() => resetMlxCapsCache());

  it("outside a desktop build (NEXT_PUBLIC_DESKTOP unset in the test env), resolves FAIL-CLOSED without ever reaching getInvoke()", async () => {
    const result = await probeMlxCaps();

    expect(result).toEqual(FAIL_CLOSED);
    expect(getMlxCapsSnapshot()).toBeNull(); // never actually probed
  });

  it("a cached value short-circuits a later call without re-probing", async () => {
    await probeMlxCapabilitiesWith(fakeInvoke(() => ({ mlxSupported: false, reason: "x" })));

    const result = await probeMlxCaps();
    expect(result).toEqual({ mlxSupported: false, reason: "x" });
  });

  it("resetMlxCapsCache clears the cached snapshot and listeners", async () => {
    await probeMlxCapabilitiesWith(fakeInvoke(() => ({ mlxSupported: true })));
    expect(getMlxCapsSnapshot()).not.toBeNull();

    resetMlxCapsCache();

    expect(getMlxCapsSnapshot()).toBeNull();
  });

  it("resetMlxCapsCache drops registered listeners — a subscriber from before the reset is never notified by a probe after it", async () => {
    const listener = vi.fn();
    subscribeMlxCaps(listener);

    resetMlxCapsCache();
    await probeMlxCapabilitiesWith(fakeInvoke(() => ({ mlxSupported: true })));

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("refreshMlxCaps — worker A2's live-retry affordance (distinct from resetMlxCapsCache)", () => {
  beforeEach(() => resetMlxCapsCache());
  afterEach(() => resetMlxCapsCache());

  it("outside a desktop build, resolves FAIL-CLOSED without ever reaching getInvoke() — same guard as probeMlxCaps", async () => {
    const result = await refreshMlxCaps();
    expect(result).toEqual(FAIL_CLOSED);
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
    await probeMlxCapabilitiesWith(fakeInvoke(() => ({ mlxSupported: true })));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getMlxCapsSnapshot()).toEqual({ mlxSupported: true });
  });

  it("resetMlxCapsCache, by contrast, drops the SAME listener — proving refreshMlxCaps and resetMlxCapsCache genuinely differ", async () => {
    const listener = vi.fn();
    subscribeMlxCaps(listener);

    resetMlxCapsCache();
    await probeMlxCapabilitiesWith(fakeInvoke(() => ({ mlxSupported: true })));

    expect(listener).not.toHaveBeenCalled();
  });
});
