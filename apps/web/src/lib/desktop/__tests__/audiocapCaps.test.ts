// S9.4/D6 macOS-floor gating — centralized capabilities module
// (adversarial review finding F9: Header.tsx's ENGINE_OPTIONS had NO
// floor gating at all — appaudio stayed enabled below the 14.4 floor —
// and SettingsDialog.tsx hand-rolled its own separate probe). Mirrors
// bootstrap.test.ts's own "pure core takes an injected InvokeFn, no
// IS_DESKTOP/tauriApi coupling of its own" split (see that file's
// header comment) — probeCapabilitiesWith() is directly unit-testable
// with a fake invoke, no module-mocking gymnastics required; only the
// thin probeAudiocapCaps() IS_DESKTOP-guard wrapper is tested "in the
// test env's default (NEXT_PUBLIC_DESKTOP unset) state" (same as that
// file's initDesktop() coverage).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appAudioLockReason,
  getAudiocapCapsSnapshot,
  isAppAudioFloorLocked,
  probeAudiocapCaps,
  probeCapabilitiesWith,
  resetAudiocapCapsCache,
  subscribeAudiocapCaps,
} from "../audiocapCaps";
import type { InvokeFn } from "../tauriApi";

function fakeInvoke(handler: () => unknown): InvokeFn {
  return (async () => handler()) as InvokeFn;
}

describe("probeCapabilitiesWith — pure core (no IS_DESKTOP coupling)", () => {
  beforeEach(() => resetAudiocapCapsCache());
  afterEach(() => resetAudiocapCapsCache());

  it("a definitive resolved result is cached and notifies subscribers", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAudiocapCaps(listener);
    const caps = { appAudioSupported: false, reason: "需要 macOS 14.4 或更高版本" };

    const result = await probeCapabilitiesWith(fakeInvoke(() => caps));

    expect(result).toEqual(caps);
    expect(getAudiocapCapsSnapshot()).toEqual(caps);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("a definitive appAudioSupported:true result is equally cached", async () => {
    const caps = { appAudioSupported: true, reason: null };
    const result = await probeCapabilitiesWith(fakeInvoke(() => caps));

    expect(result).toEqual(caps);
    expect(getAudiocapCapsSnapshot()).toEqual(caps);
  });

  it("an invoke() rejection resolves fail-open WITHOUT caching it — a later probe can still resolve for real", async () => {
    const result = await probeCapabilitiesWith(
      fakeInvoke(() => {
        throw new Error("ipc failure");
      }),
    );

    expect(result).toEqual({ appAudioSupported: true, reason: null });
    // POLICY: an error is never trusted as a definitive answer — the
    // snapshot stays null (not-yet-resolved), not permanently pinned to
    // the fail-open shape, so a later caller still gets to retry for
    // real instead of being stuck fail-open forever off one hiccup.
    expect(getAudiocapCapsSnapshot()).toBeNull();
  });

  it("an unsubscribed listener is never notified", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAudiocapCaps(listener);
    unsubscribe();

    await probeCapabilitiesWith(fakeInvoke(() => ({ appAudioSupported: true, reason: null })));

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("isAppAudioFloorLocked / appAudioLockReason — F9 gating policy", () => {
  it("a DEFINITIVE appAudioSupported:false locks the appaudio option", () => {
    expect(
      isAppAudioFloorLocked("appaudio", { appAudioSupported: false, reason: "需要 macOS 14.4 或更高版本" }),
    ).toBe(true);
  });

  it("not-yet-resolved (null snapshot) never locks — fail-open", () => {
    expect(isAppAudioFloorLocked("appaudio", null)).toBe(false);
  });

  it("a probe ERROR's fail-open shape (appAudioSupported:true) never locks", () => {
    expect(isAppAudioFloorLocked("appaudio", { appAudioSupported: true, reason: null })).toBe(false);
  });

  it("never locks any OTHER engine value, even given a definitive false caps", () => {
    const definitiveFalse = { appAudioSupported: false, reason: "x" };
    expect(isAppAudioFloorLocked("tabaudio", definitiveFalse)).toBe(false);
    expect(isAppAudioFloorLocked("whisper", definitiveFalse)).toBe(false);
  });

  it("appAudioLockReason falls back to the default 14.4 copy when caps carries no reason", () => {
    expect(appAudioLockReason({ appAudioSupported: false, reason: null })).toContain("14.4");
  });

  it("appAudioLockReason surfaces caps' own reason verbatim when present", () => {
    expect(appAudioLockReason({ appAudioSupported: false, reason: "custom reason" })).toBe("custom reason");
  });

  it("appAudioLockReason falls back to the default copy for a null (not-yet-resolved) snapshot too", () => {
    expect(appAudioLockReason(null)).toContain("14.4");
  });
});

describe("probeAudiocapCaps — IS_DESKTOP-guarded singleton wrapper", () => {
  beforeEach(() => resetAudiocapCapsCache());
  afterEach(() => resetAudiocapCapsCache());

  it("outside a desktop build (NEXT_PUBLIC_DESKTOP unset in the test env), resolves fail-open without ever reaching getInvoke() (which would otherwise throw synchronously — see tauriApi.test.ts)", async () => {
    const result = await probeAudiocapCaps();

    expect(result).toEqual({ appAudioSupported: true, reason: null });
    expect(getAudiocapCapsSnapshot()).toBeNull(); // never actually probed
  });

  it("a cached value short-circuits a later call without re-probing", async () => {
    // Seed the cache the same way a successful probeCapabilitiesWith()
    // would, without needing IS_DESKTOP true.
    await probeCapabilitiesWith(fakeInvoke(() => ({ appAudioSupported: false, reason: "x" })));

    const result = await probeAudiocapCaps();
    expect(result).toEqual({ appAudioSupported: false, reason: "x" });
  });

  it("resetAudiocapCapsCache clears the cached snapshot and listeners", async () => {
    await probeCapabilitiesWith(fakeInvoke(() => ({ appAudioSupported: false, reason: "x" })));
    expect(getAudiocapCapsSnapshot()).not.toBeNull();

    resetAudiocapCapsCache();

    expect(getAudiocapCapsSnapshot()).toBeNull();
  });
});
