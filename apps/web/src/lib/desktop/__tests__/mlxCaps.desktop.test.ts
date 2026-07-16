// S12a fix round (§D F7) — mlxCaps.ts's IS_DESKTOP-guarded singleton
// wrappers (probeMlxCaps/refreshMlxCaps), with IS_DESKTOP genuinely
// TRUE. IS_DESKTOP is a module-scope import-time const (lib/platform/
// desktop.ts) — vi.mock affects this whole file, so this lives in its
// own file rather than a describe block inside mlxCaps.test.ts, which
// needs the REAL (false) value for its own ambient coverage — same
// split engineOptions.desktop.test.ts/SettingsDialog.desktop.test.tsx/
// TaskCenterDrawer.desktop.test.tsx already established for the
// identical constraint (see those files' own header comments).
// tauriApi's own getInvoke is mocked the same "reassignable module-
// level queue" shape osspeechCaps.test.ts's currentInvoke uses for its
// own preinstallOsSpeech coverage — here a QUEUE (not a single
// reassignable slot) since a single test drives TWO overlapping
// getInvoke() calls (one per probeMlxCaps()/refreshMlxCaps()
// invocation) that must resolve to two DIFFERENT gated fakes.
//
// Covers the "clear each other's inFlight" half of §D F7's overlap-
// race fix (the "apply stale snapshots" half is covered directly via
// probeMlxCapabilitiesWith in mlxCaps.test.ts, no IS_DESKTOP needed
// there).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../platform/desktop", () => ({ IS_DESKTOP: true }));

let invokeQueue: import("../tauriApi").InvokeFn[] = [];
vi.mock("../tauriApi", () => ({
  getInvoke: () => {
    const next = invokeQueue.shift();
    if (!next) throw new Error("mlxCaps.desktop.test.ts: getInvoke() called with an empty invokeQueue");
    return Promise.resolve(next);
  },
}));

import { probeMlxCaps, refreshMlxCaps, resetMlxCapsCache, type MlxCapabilities } from "../mlxCaps";
import type { InvokeFn } from "../tauriApi";

/** A fakeInvoke() that resolves only once `resolve()` is called
 *  externally — mirrors mlxCaps.test.ts's own makeGatedInvoke, an
 *  independent copy since that file's own helper isn't exported (kept
 *  test-file-local by design, same posture as this repo's other small
 *  per-file test helpers). */
function makeGatedInvoke(): { invoke: InvokeFn; resolve: (caps: MlxCapabilities) => void } {
  let resolveFn!: (caps: MlxCapabilities) => void;
  const gate = new Promise<MlxCapabilities>((resolve) => {
    resolveFn = resolve;
  });
  const invoke: InvokeFn = (async () => gate) as InvokeFn;
  return { invoke, resolve: resolveFn };
}

describe("probeMlxCaps/refreshMlxCaps — inFlight identity guard (§D F7, IS_DESKTOP=true)", () => {
  beforeEach(() => {
    resetMlxCapsCache();
    invokeQueue = [];
  });
  afterEach(() => {
    resetMlxCapsCache();
    invokeQueue = [];
  });

  it("a concurrent probeMlxCaps() call joins the ALREADY in-flight probe rather than firing a second invoke", async () => {
    const gated = makeGatedInvoke();
    invokeQueue.push(gated.invoke);

    const first = probeMlxCaps();
    const second = probeMlxCaps(); // invokeQueue would throw if this fired its own getInvoke()

    gated.resolve({ mlxSupported: true, reason: null });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual({ status: "ok", caps: { mlxSupported: true, reason: null } });
    expect(secondResult).toBe(firstResult); // same shared promise, not just an equal value
  });

  it("refreshMlxCaps() ALWAYS fires its own fresh invoke, even while a probeMlxCaps() is already in flight", async () => {
    const probeGate = makeGatedInvoke();
    const refreshGate = makeGatedInvoke();
    invokeQueue.push(probeGate.invoke, refreshGate.invoke);

    const probePromise = probeMlxCaps(); // sets inFlight = probeA, consumes queue[0]
    const refreshPromise = refreshMlxCaps(); // takes OVER inFlight = probeB, consumes queue[1] — never joins probeA

    probeGate.resolve({ mlxSupported: false, reason: "stale-probe" });
    refreshGate.resolve({ mlxSupported: true, reason: null });

    const probeResult = await probePromise;
    const refreshResult = await refreshPromise;

    expect(probeResult).toEqual({ status: "ok", caps: { mlxSupported: false, reason: "stale-probe" } });
    expect(refreshResult).toEqual({ status: "ok", caps: { mlxSupported: true, reason: null } });
  });

  it("§D F7's own fix: the OLDER probeMlxCaps() attempt settling AFTER a refreshMlxCaps() has taken over `inFlight` must NOT null out the refresh's still-pending reference — a THIRD probeMlxCaps() call made in between joins the refresh, never firing a third invoke", async () => {
    const probeGate = makeGatedInvoke();
    const refreshGate = makeGatedInvoke();
    invokeQueue.push(probeGate.invoke, refreshGate.invoke);

    const probePromise = probeMlxCaps(); // inFlight = probeA
    const refreshPromise = refreshMlxCaps(); // inFlight = probeB (overwrites probeA's tracking)

    // The OLDER (probeMlxCaps) attempt settles FIRST, while the refresh
    // is still pending.
    probeGate.resolve({ mlxSupported: false, reason: "old" });
    await probePromise;

    // A third probeMlxCaps() call made RIGHT NOW must join the SAME
    // still-in-flight refresh — proven by invokeQueue being EMPTY at
    // this point (both entries already consumed): if the pre-fix bug
    // ("unconditional inFlight = null on settle") had shipped, this
    // call would see inFlight===null (wrongly cleared by probeA's own
    // settle) and call getInvoke() a third time, which would throw
    // against the exhausted queue.
    const joinedPromise = probeMlxCaps();

    refreshGate.resolve({ mlxSupported: true, reason: null });
    const refreshResult = await refreshPromise;
    const joinedResult = await joinedPromise;

    expect(refreshResult).toEqual({ status: "ok", caps: { mlxSupported: true, reason: null } });
    expect(joinedResult).toEqual(refreshResult);
  });
});
