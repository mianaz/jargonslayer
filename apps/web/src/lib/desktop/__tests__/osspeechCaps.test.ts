// S11 (v0.4.3, docs/design-explorations/s11-osspeech-blueprint.md,
// Worker C) — osspeechCaps.ts, mirroring audiocapCaps.test.ts's own
// coverage shape for the probe/cache/gating half, plus NEW coverage for
// preinstallOsSpeech (§A2). tauriApi is mocked the same way appAudio.
// test.ts/audiocapCaps.test.ts do; "../../stt/osSpeech" (the shared
// OSSPEECH_TERMINAL_STATUS_KINDS constant) and "../jobsBridge"
// (trackOsSpeechAsset) are ALSO mocked — this file only needs to prove
// osspeechCaps.ts forwards to them correctly, not re-verify their own
// internals (osSpeech.test.ts/jobsBridge.test.ts already do that).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvokeFn, ListenFn, TauriEvent, UnlistenFn } from "../tauriApi";

vi.mock("../../stt/osSpeech", () => ({
  OSSPEECH_TERMINAL_STATUS_KINDS: new Set([
    "ended",
    "crashed",
    "permission-denied",
    "unsupported",
    "unsupported-locale",
    "device-changed",
    "asset-failed",
  ]),
}));

interface FakeAssetTracker {
  handle: ReturnType<typeof vi.fn>;
}
let assetTrackers: FakeAssetTracker[] = [];
const mockTrackOsSpeechAsset = vi.fn(() => {
  const tracker: FakeAssetTracker = { handle: vi.fn() };
  assetTrackers.push(tracker);
  return tracker;
});
vi.mock("../jobsBridge", () => ({
  trackOsSpeechAsset: () => mockTrackOsSpeechAsset(),
}));

// Mirrors appAudio.test.ts's own "reference, don't eagerly read" shape
// — only preinstallOsSpeech's own describe block below ever assigns
// these (the probe/gating describe blocks above it either inject a fake
// invoke directly into the pure core, or exercise the IS_DESKTOP-false
// fail-open path, which never reaches getInvoke()/getListen() at all).
let currentInvoke!: InvokeFn;
let currentListen!: ListenFn;
vi.mock("../tauriApi", () => ({
  getInvoke: () => Promise.resolve(currentInvoke),
  getListen: () => Promise.resolve(currentListen),
}));

import {
  getOsSpeechCapsSnapshot,
  isOsSpeechFloorLocked,
  osSpeechLockReason,
  preinstallOsSpeech,
  probeOsSpeechCaps,
  probeOsSpeechCapabilitiesWith,
  resetOsSpeechCapsCache,
  subscribeOsSpeechCaps,
  type OsSpeechCapabilities,
} from "../osspeechCaps";

function fakeInvoke(handler: () => unknown): InvokeFn {
  return (async () => handler()) as InvokeFn;
}

interface FakeInvokeCall {
  cmd: string;
  args?: Record<string, unknown>;
}

/** Local copies of the desktop/__tests__ convention (provisionRunner.
 *  test.ts's own header comment: fakeTauri.ts is stt/__tests__-local,
 *  not cross-imported — every OTHER __tests__ directory keeps its own
 *  same-shaped copy rather than reaching across directories). */
function makeFakeInvoke(handlers: Record<string, (args?: Record<string, unknown>) => unknown>): {
  invoke: InvokeFn;
  calls: FakeInvokeCall[];
} {
  const calls: FakeInvokeCall[] = [];
  const invoke: InvokeFn = (async <T>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (!(cmd in handlers)) throw new Error(`unexpected invoke("${cmd}")`);
    return (await handlers[cmd](args)) as T;
  }) as InvokeFn;
  return { invoke, calls };
}

function makeFakeListen(): {
  listen: ListenFn;
  emit: (event: string, payload: unknown) => void;
  activeCount: (event: string) => number;
} {
  const active = new Map<string, Array<(event: TauriEvent<unknown>) => void>>();
  const listen: ListenFn = (async <T>(event: string, handler: (event: TauriEvent<T>) => void) => {
    const list = active.get(event) ?? [];
    list.push(handler as (event: TauriEvent<unknown>) => void);
    active.set(event, list);
    const unlisten: UnlistenFn = () => {
      const remaining = (active.get(event) ?? []).filter((h) => h !== handler);
      active.set(event, remaining);
    };
    return unlisten;
  }) as ListenFn;
  function emit(event: string, payload: unknown): void {
    for (const handler of active.get(event) ?? []) handler({ event, payload });
  }
  function activeCount(event: string): number {
    return (active.get(event) ?? []).length;
  }
  return { listen, emit, activeCount };
}

describe("probeOsSpeechCapabilitiesWith — pure core (no IS_DESKTOP coupling)", () => {
  beforeEach(() => resetOsSpeechCapsCache());
  afterEach(() => resetOsSpeechCapsCache());

  it("a definitive resolved result is cached and notifies subscribers", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOsSpeechCaps(listener);
    const caps: OsSpeechCapabilities = {
      supported: false,
      reason: "需要 macOS 26 或更高版本",
      locales: [],
      installedLocales: [],
    };

    const result = await probeOsSpeechCapabilitiesWith(fakeInvoke(() => caps));

    expect(result).toEqual(caps);
    expect(getOsSpeechCapsSnapshot()).toEqual(caps);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("a definitive supported:true result (with locales) is equally cached", async () => {
    const caps: OsSpeechCapabilities = {
      supported: true,
      reason: null,
      locales: ["zh_CN", "en_US"],
      installedLocales: ["en_US"],
    };
    const result = await probeOsSpeechCapabilitiesWith(fakeInvoke(() => caps));

    expect(result).toEqual(caps);
    expect(getOsSpeechCapsSnapshot()).toEqual(caps);
  });

  it("an invoke() rejection resolves fail-open WITHOUT caching it", async () => {
    const result = await probeOsSpeechCapabilitiesWith(
      fakeInvoke(() => {
        throw new Error("ipc failure");
      }),
    );

    expect(result).toEqual({ supported: true, reason: null, locales: [], installedLocales: [] });
    expect(getOsSpeechCapsSnapshot()).toBeNull();
  });

  it("an unsubscribed listener is never notified", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOsSpeechCaps(listener);
    unsubscribe();

    await probeOsSpeechCapabilitiesWith(
      fakeInvoke(() => ({ supported: true, reason: null, locales: [], installedLocales: [] })),
    );

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("isOsSpeechFloorLocked / osSpeechLockReason — macOS-26 gating policy", () => {
  it("a DEFINITIVE supported:false locks the osspeech option", () => {
    const caps: OsSpeechCapabilities = {
      supported: false,
      reason: "需要 macOS 26 或更高版本",
      locales: [],
      installedLocales: [],
    };
    expect(isOsSpeechFloorLocked("osspeech", caps)).toBe(true);
  });

  it("not-yet-resolved (null snapshot) never locks — fail-open", () => {
    expect(isOsSpeechFloorLocked("osspeech", null)).toBe(false);
  });

  it("a probe ERROR's fail-open shape (supported:true) never locks", () => {
    expect(isOsSpeechFloorLocked("osspeech", { supported: true, reason: null, locales: [], installedLocales: [] })).toBe(
      false,
    );
  });

  it("never locks any OTHER engine value, even given a definitive false caps", () => {
    const definitiveFalse: OsSpeechCapabilities = { supported: false, reason: "x", locales: [], installedLocales: [] };
    expect(isOsSpeechFloorLocked("appaudio", definitiveFalse)).toBe(false);
    expect(isOsSpeechFloorLocked("whisper", definitiveFalse)).toBe(false);
  });

  it("osSpeechLockReason falls back to the default macOS-26 copy when caps carries no reason", () => {
    expect(osSpeechLockReason({ supported: false, reason: null, locales: [], installedLocales: [] })).toContain("26");
  });

  it("osSpeechLockReason surfaces caps' own reason verbatim when present", () => {
    expect(
      osSpeechLockReason({ supported: false, reason: "custom reason", locales: [], installedLocales: [] }),
    ).toBe("custom reason");
  });

  it("osSpeechLockReason falls back to the default copy for a null (not-yet-resolved) snapshot too", () => {
    expect(osSpeechLockReason(null)).toContain("26");
  });
});

describe("probeOsSpeechCaps — IS_DESKTOP-guarded singleton wrapper", () => {
  beforeEach(() => resetOsSpeechCapsCache());
  afterEach(() => resetOsSpeechCapsCache());

  it("outside a desktop build (NEXT_PUBLIC_DESKTOP unset in the test env), resolves fail-open without ever reaching getInvoke()", async () => {
    const result = await probeOsSpeechCaps();

    expect(result).toEqual({ supported: true, reason: null, locales: [], installedLocales: [] });
    expect(getOsSpeechCapsSnapshot()).toBeNull();
  });

  it("a cached value short-circuits a later call without re-probing", async () => {
    await probeOsSpeechCapabilitiesWith(
      fakeInvoke(() => ({ supported: false, reason: "x", locales: [], installedLocales: [] })),
    );

    const result = await probeOsSpeechCaps();
    expect(result).toEqual({ supported: false, reason: "x", locales: [], installedLocales: [] });
  });

  it("resetOsSpeechCapsCache clears the cached snapshot and listeners", async () => {
    await probeOsSpeechCapabilitiesWith(
      fakeInvoke(() => ({ supported: false, reason: "x", locales: [], installedLocales: [] })),
    );
    expect(getOsSpeechCapsSnapshot()).not.toBeNull();

    resetOsSpeechCapsCache();

    expect(getOsSpeechCapsSnapshot()).toBeNull();
  });
});

describe("preinstallOsSpeech — §A2 6th Rust command, single-flighted", () => {
  beforeEach(() => {
    assetTrackers = [];
    mockTrackOsSpeechAsset.mockClear();
  });

  it("invokes preinstall_os_speech with the given locale, then resolves once asset-installed arrives, unlistening afterward", async () => {
    const { invoke, calls } = makeFakeInvoke({ preinstall_os_speech: () => undefined });
    currentInvoke = invoke;
    const { listen, emit, activeCount } = makeFakeListen();
    currentListen = listen;

    const p = preinstallOsSpeech("zh-CN");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([{ cmd: "preinstall_os_speech", args: { locale: "zh-CN" } }]);
    expect(activeCount("osspeech://status")).toBe(1);

    emit("osspeech://status", { kind: "asset-downloading", progress: 0.5 });
    emit("osspeech://status", { kind: "asset-installed" });

    await p;

    expect(assetTrackers[0].handle).toHaveBeenCalledWith("asset-downloading", 0.5, undefined);
    expect(assetTrackers[0].handle).toHaveBeenCalledWith("asset-installed", undefined, undefined);
    expect(activeCount("osspeech://status")).toBe(0);
  });

  it("a busy/single-flight rejection from the invoke() itself surfaces straight through, and still unlistens", async () => {
    const { invoke } = makeFakeInvoke({
      preinstall_os_speech: () => {
        throw new Error("已有系统识别会话正在运行");
      },
    });
    currentInvoke = invoke;
    const { listen, activeCount } = makeFakeListen();
    currentListen = listen;

    await expect(preinstallOsSpeech("zh-CN")).rejects.toThrow("已有系统识别会话正在运行");

    expect(activeCount("osspeech://status")).toBe(0);
  });

  it("asset-failed rejects the returned promise with the failure message", async () => {
    const { invoke } = makeFakeInvoke({ preinstall_os_speech: () => undefined });
    currentInvoke = invoke;
    const { listen, emit } = makeFakeListen();
    currentListen = listen;

    const p = preinstallOsSpeech("zh-CN");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    emit("osspeech://status", { kind: "asset-failed", message: "network unreachable" });

    await expect(p).rejects.toThrow("network unreachable");
  });

  it("ANY other terminal status kind (not just asset-failed) also rejects, so a non-asset failure can't hang forever", async () => {
    const { invoke } = makeFakeInvoke({ preinstall_os_speech: () => undefined });
    currentInvoke = invoke;
    const { listen, emit } = makeFakeListen();
    currentListen = listen;

    const p = preinstallOsSpeech("zh-Yue");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    emit("osspeech://status", { kind: "unsupported-locale", message: "zh-Yue" });

    await expect(p).rejects.toThrow();
  });

  it("a non-terminal, non-installed status (e.g. asset-checking) neither resolves nor rejects", async () => {
    const { invoke } = makeFakeInvoke({ preinstall_os_speech: () => undefined });
    currentInvoke = invoke;
    const { listen, emit } = makeFakeListen();
    currentListen = listen;

    const p = preinstallOsSpeech("zh-CN");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    emit("osspeech://status", { kind: "asset-checking" });

    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    emit("osspeech://status", { kind: "asset-installed" });
    await p;
  });

  // S11 fix-round J2(a): the preempt handoff — a session start
  // superseding this in-flight preinstall, per osSpeech.ts's own
  // osspeech://status `source` contract — hands the SAME download off
  // to the session, which continues emitting asset events tagged
  // source: "session" rather than "preinstall". This attempt's own
  // tracker forwarding AND its resolve/reject settling must keep
  // reacting regardless — this listener never gates on `source` at all
  // (unlike osSpeech.ts's own engine-side handleStatus, which ignores
  // anything besides "session" — a DIFFERENT lane's own concern, not
  // this one's).
  it("asset events tagged source: 'session' (the preempt handoff) still drive the tracker AND resolve this preinstall attempt (J2a: accepts EITHER source)", async () => {
    const { invoke, calls } = makeFakeInvoke({ preinstall_os_speech: () => undefined });
    currentInvoke = invoke;
    const { listen, emit, activeCount } = makeFakeListen();
    currentListen = listen;

    const p = preinstallOsSpeech("zh-CN");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([{ cmd: "preinstall_os_speech", args: { locale: "zh-CN" } }]);

    // A session preempted this attempt — its OWN asset events continue
    // the SAME download, tagged source: "session" from here on.
    emit("osspeech://status", { kind: "asset-downloading", progress: 0.7, source: "session" });
    emit("osspeech://status", { kind: "asset-installed", source: "session" });

    await p;

    expect(assetTrackers[0].handle).toHaveBeenCalledWith("asset-downloading", 0.7, undefined);
    expect(assetTrackers[0].handle).toHaveBeenCalledWith("asset-installed", undefined, undefined);
    expect(activeCount("osspeech://status")).toBe(0);
  });
});
