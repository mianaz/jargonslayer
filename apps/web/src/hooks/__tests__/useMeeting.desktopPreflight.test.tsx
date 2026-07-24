// @vitest-environment jsdom
//
// Field-test fix B (desktop, verified root cause): selecting 本地
// Whisper (or appaudio) with the managed local sidecar not actually
// provisioned/healthy used to sail straight into the engine's own
// doomed connect (a raw CLI error no desktop-app user can act on).
// start()'s new preflight (useMeeting.ts) checks the bootstrap handle
// FIRST and, if unhealthy, aborts before ever attaching an engine.
//
// A SEPARATE file from useMeeting.lifecycle.test.tsx (not an addition
// to it) because IS_DESKTOP is a module-scope import-time const — vi.mock
// affects the WHOLE file — mirrors SettingsDialog.desktop.test.tsx/
// DesktopBootstrap.test.tsx's own established split for the identical
// constraint; the every-other-scenario coverage (pause/resume races,
// soft-pause, etc.) stays exactly where it is, untouched.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { DesktopBootstrapHandle, DesktopBootstrapState } from "../../lib/desktop/bootstrap";
import type { DesktopPaths } from "../../lib/desktop/uvCommands";

vi.mock("../../lib/platform/desktop", () => ({ IS_DESKTOP: true }));

const mockInitDesktop = vi.fn();
vi.mock("../../lib/desktop/bootstrap", () => ({
  initDesktop: () => mockInitDesktop(),
}));

type AnyEvents = {
  onStatus: (status: string, detail?: string) => void;
  onInterim: (text: string, speaker?: string) => void;
  [k: string]: unknown;
};

// Bare-minimum fake — this suite mostly only cares whether an engine
// was ever constructed/attached at all (engines.length), not its own
// lifecycle mechanics (those are useMeeting.lifecycle.test.tsx's job) —
// EXCEPT stopCalls, tracked here too now (F2 field-test fix, round 2):
// resume()'s own preflight tests below need to assert a preflight-
// BLOCKED resume left the old engine's stop() uncalled.
class FakeEngine {
  kind = "whisper";
  events: AnyEvents | null = null;
  startResolve: (() => void) | null = null;
  stopCalls = 0;
  private startP = new Promise<void>((r) => (this.startResolve = r));
  async start(events: AnyEvents): Promise<void> {
    this.events = events;
    await this.startP;
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

// F2 field-test fix (round 2, Sol review) — a soft-pause-capable fake
// (mirrors useMeeting.lifecycle.test.tsx's own FakeSoftPauseEngine): the
// FakeEngine above has no pause()/resume() at all (whisper doesn't, in
// reality), so testing resume()'s own kind-mismatch reconcile branch
// (which only matters while an engine is still ALIVE across a pause —
// see useMeeting.ts's needsFreshAttach) needs a distinct fake that
// actually stays alive. kind: "osspeech" mirrors the one real engine
// that's both soft-pause-capable AND not sidecar-riding (osSpeech.ts) —
// the tests below flip settings.engine (never this fake's own kind) to
// "whisper" to simulate the user switching engines in Settings while
// paused.
class FakeSoftPauseEngine extends FakeEngine {
  kind = "osspeech";
  pauseCalls = 0;
  resumeCalls = 0;
  async pause(): Promise<void> {
    this.pauseCalls += 1;
  }
  async resume(): Promise<void> {
    this.resumeCalls += 1;
  }
}

const engines: FakeEngine[] = [];
// Which class createEngine() constructs next — FakeEngine (the default,
// matches every existing test below) unless a test below points this at
// FakeSoftPauseEngine for exactly one call, then restores it immediately
// (mirrors useMeeting.lifecycle.test.tsx's own nextEngineClass).
let nextEngineClass: new () => FakeEngine = FakeEngine;
vi.mock("../../lib/stt", () => ({
  createEngine: vi.fn(() => {
    const e = new nextEngineClass();
    engines.push(e);
    return e as unknown as import("@jargonslayer/core/types").STTEngine;
  }),
}));

import { useMeeting, type UseMeetingResult } from "../useMeeting";
import { useApp } from "../../lib/store";

let api: UseMeetingResult | null = null;
function Probe() {
  api = useMeeting();
  return null;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const FAKE_PATHS: DesktopPaths = {
  appData: "",
  pythonInstallDir: "",
  uvCacheDir: "",
  venvDir: "",
  venvPython: "",
  modelsDir: "",
  scriptPath: "",
  requirementsPath: "",
  diarRequirementsPath: "",
  logPath: "",
  markerPath: "",
  mlxVenvDir: "",
  mlxVenvPython: "",
  mlxRequirementsLockPath: "",
};

function makeFakeHandle(
  state: DesktopBootstrapState,
  overrides: Partial<DesktopBootstrapHandle> = {},
): DesktopBootstrapHandle {
  return {
    state$: () => () => {},
    currentState: () => state,
    retryStep: () => {},
    beginProvision: () => {},
    log$: () => () => {},
    downloadProgress$: () => () => {},
    currentDownloadProgress: () => null,
    paths: FAKE_PATHS,
    recheckHealth: async () => {},
    reprovision: async () => {},
    requestProvisionCheck: vi.fn(async () => {}),
    installedModel: async () => null,
    switchModel: async () => {},
    switchModelProgress$: () => () => {},
    currentSwitchModelProgress: () => null,
    installDiarization: async () => {},
    readSidecarLog: async () => "",
    ...overrides,
  };
}

describe("useMeeting — desktop session-start preflight (field-test fix B)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    engines.length = 0;
    mockInitDesktop.mockReset();
    useApp.setState({
      status: "idle",
      segments: [],
      interim: null,
      toast: null,
      settings: { ...useApp.getState().settings, engine: "whisper", sidecarMode: "managed" },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
    api = null;
  });

  it("handle not healthy: aborts before attaching an engine, toasts, and calls requestProvisionCheck() — same state as if Start was never clicked", async () => {
    const handle = makeFakeHandle({ phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" });
    mockInitDesktop.mockResolvedValue(handle);

    await act(async () => {
      await api!.start();
    });

    expect(engines.length).toBe(0); // no engine ever constructed/attached
    expect(useApp.getState().status).toBe("idle"); // unchanged — beginMeeting() never ran
    expect(useApp.getState().meetingGen).toBe(0); // unchanged
    expect(useApp.getState().toast).toBe("本地 Whisper 尚未安装，正在打开安装向导…");
    expect(handle.requestProvisionCheck).toHaveBeenCalledTimes(1);
  });

  it("handle healthy: proceeds with a normal start (engine attaches, requestProvisionCheck never called)", async () => {
    const handle = makeFakeHandle({ phase: "HEALTHY" });
    mockInitDesktop.mockResolvedValue(handle);

    let p: Promise<void>;
    await act(async () => {
      p = api!.start();
      await flush();
      engines[0]!.startResolve!();
      await p;
      engines[0]!.events!.onStatus("listening");
    });

    expect(engines.length).toBe(1);
    expect(useApp.getState().status).toBe("listening");
    expect(handle.requestProvisionCheck).not.toHaveBeenCalled();
  });

  it("external sidecar mode: never even probes the bootstrap handle — proceeds straight to a normal start regardless of sidecar health", async () => {
    useApp.setState({ settings: { ...useApp.getState().settings, sidecarMode: "external" } });

    let p: Promise<void>;
    await act(async () => {
      p = api!.start();
      await flush();
      engines[0]!.startResolve!();
      await p;
      engines[0]!.events!.onStatus("listening");
    });

    expect(mockInitDesktop).not.toHaveBeenCalled();
    expect(engines.length).toBe(1);
    expect(useApp.getState().status).toBe("listening");
  });

  it("a non-sidecar engine (webspeech): never probes the bootstrap handle either, even in managed mode", async () => {
    useApp.setState({ settings: { ...useApp.getState().settings, engine: "webspeech" } });

    let p: Promise<void>;
    await act(async () => {
      p = api!.start();
      await flush();
      engines[0]!.startResolve!();
      await p;
      engines[0]!.events!.onStatus("listening");
    });

    expect(mockInitDesktop).not.toHaveBeenCalled();
    expect(engines.length).toBe(1);
  });

  // ---------------------------------------------------------------
  // F2 field-test fix (round 2, Sol review): settings cards unlock
  // while paused, so resume()'s own reconcile (tear down a live,
  // kind-mismatched engine, then attach the newly selected one) used to
  // bypass this SAME preflight entirely — see useMeeting.ts's own
  // preflightManagedSidecar/needsFreshAttach doc comments.
  // ---------------------------------------------------------------

  it("resume(): switched to a DIFFERENT sidecar engine while paused + handle UNHEALTHY — blocks before tearing down the old engine, meeting stays paused", async () => {
    nextEngineClass = FakeSoftPauseEngine;
    useApp.setState({ settings: { ...useApp.getState().settings, engine: "osspeech" } }); // not sidecar-riding — the initial start() below needs no preflight at all
    let p: Promise<void>;
    await act(async () => {
      p = api!.start();
      await flush();
      engines[0]!.startResolve!();
      await p;
      engines[0]!.events!.onStatus("listening");
    });
    nextEngineClass = FakeEngine;
    const oldEngine = engines[0] as FakeSoftPauseEngine;

    await act(async () => {
      await api!.pause();
    });
    expect(useApp.getState().status).toBe("paused");
    expect(oldEngine.pauseCalls).toBe(1);

    // Settings unlock while paused — user switches to whisper (sidecar-
    // only), reported unhealthy.
    useApp.setState({ settings: { ...useApp.getState().settings, engine: "whisper" } });
    const unhealthyHandle = makeFakeHandle({ phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" });
    mockInitDesktop.mockResolvedValue(unhealthyHandle);

    await act(async () => {
      await api!.resume();
    });

    expect(useApp.getState().status).toBe("paused"); // never resumed
    expect(oldEngine.stopCalls).toBe(0); // old engine's stop NOT called — fully untouched
    expect(oldEngine.resumeCalls).toBe(0); // never soft-resumed either
    expect(engines.length).toBe(1); // no new engine ever constructed
    expect(unhealthyHandle.requestProvisionCheck).toHaveBeenCalledTimes(1);
    expect(useApp.getState().toast).toBe("本地 Whisper 尚未安装，正在打开安装向导…");
  });

  it("resume(): switched to a DIFFERENT sidecar engine while paused + handle HEALTHY — reconcile proceeds normally (old engine stopped, new one attached)", async () => {
    nextEngineClass = FakeSoftPauseEngine;
    useApp.setState({ settings: { ...useApp.getState().settings, engine: "osspeech" } });
    let p: Promise<void>;
    await act(async () => {
      p = api!.start();
      await flush();
      engines[0]!.startResolve!();
      await p;
      engines[0]!.events!.onStatus("listening");
    });
    nextEngineClass = FakeEngine;
    const oldEngine = engines[0] as FakeSoftPauseEngine;

    await act(async () => {
      await api!.pause();
    });
    expect(useApp.getState().status).toBe("paused");

    useApp.setState({ settings: { ...useApp.getState().settings, engine: "whisper" } });
    const handle = makeFakeHandle({ phase: "HEALTHY" });
    mockInitDesktop.mockResolvedValue(handle);

    await act(async () => {
      const resumeP = api!.resume();
      await flush();
      engines[1]!.startResolve!();
      await resumeP;
    });

    expect(oldEngine.stopCalls).toBe(1); // torn down
    expect(oldEngine.resumeCalls).toBe(0); // never soft-resumed — kind no longer matches
    expect(engines.length).toBe(2); // a fresh engine was attached
    expect(useApp.getState().status).toBe("listening");
    expect(handle.requestProvisionCheck).not.toHaveBeenCalled();
  });

  it("resume(): a live soft-paused engine resuming as the SAME kind never runs the preflight at all — no probe, even though it rides the managed sidecar", async () => {
    nextEngineClass = FakeSoftPauseEngine;
    const handle = makeFakeHandle({ phase: "HEALTHY" });
    mockInitDesktop.mockResolvedValue(handle);
    // beforeEach's own default settings.engine is already "whisper"
    // (sidecar-riding) — the INITIAL start() below still preflights
    // (see the "handle healthy" case above); only resume()'s own probe
    // (or lack of one) is this test's actual subject.
    let p: Promise<void>;
    await act(async () => {
      p = api!.start();
      await flush();
      engines[0]!.startResolve!();
      await p;
      engines[0]!.events!.onStatus("listening");
    });
    nextEngineClass = FakeEngine;
    const engine = engines[0] as FakeSoftPauseEngine;
    // FakeSoftPauseEngine's own class default is kind: "osspeech" (used
    // by the two mismatch tests above) — override it here so this
    // engine's kind actually MATCHES settings.engine ("whisper"),
    // exercising the true same-kind soft-resume-in-place path instead
    // of a (unintended) mismatch reconcile.
    engine.kind = "whisper";
    expect(mockInitDesktop).toHaveBeenCalledTimes(1); // the initial start()'s own preflight

    await act(async () => {
      await api!.pause();
    });
    expect(useApp.getState().status).toBe("paused");
    expect(engine.pauseCalls).toBe(1);

    mockInitDesktop.mockClear();

    await act(async () => {
      await api!.resume();
    });

    expect(mockInitDesktop).not.toHaveBeenCalled(); // no preflight probe at all
    expect(engine.resumeCalls).toBe(1); // soft-resumed in place
    expect(engine.stopCalls).toBe(0); // never torn down
    expect(engines.length).toBe(1); // no reattach
    expect(useApp.getState().status).toBe("listening");
  });
});
