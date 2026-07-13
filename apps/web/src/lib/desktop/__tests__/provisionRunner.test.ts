// v0.4 S3 chunk 5 — the effect interpreter's own coverage. Fakes for
// invoke/listen/probeSidecar only (no @tauri-apps import anywhere in
// this file, matching provisionRunner.ts's own zero-Tauri-imports
// contract) — every test drives `runEffects` directly with a
// (state, effects) pair exactly as `initial()`/`transition()`
// (provisionMachine.test.ts) already prove those functions return.
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import type { Effect, MachineState, ProvisionMarker } from "../provisionMachine";
import { getAppPaths, runEffects, stopServer, type RunnerDeps } from "../provisionRunner";
import type { InvokeFn, ListenFn, TauriEvent } from "../tauriApi";
import { pythonInstall, venvCreate, type DesktopPaths } from "../uvCommands";

const paths: DesktopPaths = {
  appData: "/fake/AppData",
  pythonInstallDir: "/fake/AppData/python",
  uvCacheDir: "/fake/AppData/uv-cache",
  venvDir: "/fake/AppData/venv",
  venvPython: "/fake/AppData/venv/bin/python",
  modelsDir: "/fake/AppData/models",
  scriptPath: "/fake/Resources/sidecar/whisper_server.py",
  requirementsPath: "/fake/Resources/sidecar/requirements-sidecar.txt",
  logPath: "/fake/Logs/whisper_server.log",
  markerPath: "/fake/AppData/.provisioned.json",
};

interface FakeCall {
  cmd: string;
  args?: Record<string, unknown>;
}

/** Records every invoke() call and dispatches to a per-command handler
 *  — throws for any command a given test didn't expect, so an
 *  unexpected/wrongly-named invoke() call fails loudly instead of
 *  silently resolving undefined. */
function makeFakeInvoke(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
  const calls: FakeCall[] = [];
  const invoke: InvokeFn = (async <T>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (!(cmd in handlers)) throw new Error(`unexpected invoke("${cmd}")`);
    return handlers[cmd](args) as T;
  }) as InvokeFn;
  return { invoke, calls };
}

/** Records listen()/unlisten() activity and lets a test emit an event
 *  to whatever's currently subscribed — enough to prove
 *  withUvLog's "subscribe before the call starts, unsubscribe once it
 *  settles" contract. */
function makeFakeListen() {
  const active = new Map<string, Array<(event: TauriEvent<unknown>) => void>>();
  const listenCalls: string[] = [];
  const listen: ListenFn = (async <T>(event: string, handler: (event: TauriEvent<T>) => void) => {
    listenCalls.push(event);
    const list = active.get(event) ?? [];
    list.push(handler as (event: TauriEvent<unknown>) => void);
    active.set(event, list);
    return () => {
      const remaining = (active.get(event) ?? []).filter((h) => h !== handler);
      active.set(event, remaining);
    };
  }) as ListenFn;
  function emit(event: string, payload: unknown): void {
    for (const handler of active.get(event) ?? []) handler({ event, payload });
  }
  function activeCount(event: string): number {
    return (active.get(event) ?? []).length;
  }
  return { listen, emit, activeCount, listenCalls };
}

describe("runEffects — CHECKING (probeHealth + readMarker -> CHECK_RESULT)", () => {
  it("maps to probeSidecar + invoke(\"read_provision_marker\") with no args, combined into one CHECK_RESULT", async () => {
    const { invoke, calls } = makeFakeInvoke({
      read_provision_marker: () => "the-marker-json",
    });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = {
      invoke,
      listen,
      settings: DEFAULT_SETTINGS,
      probeSidecarFn: async () => ({ up: true, model: "small" }),
    };
    const state: MachineState = { phase: "CHECKING" };
    const effects: Effect[] = [{ kind: "probeHealth" }, { kind: "readMarker" }];

    const event = await runEffects(state, effects, deps);

    expect(event).toEqual({ type: "CHECK_RESULT", probeHealthy: true, markerRaw: "the-marker-json" });
    expect(calls).toEqual([{ cmd: "read_provision_marker", args: undefined }]);
  });

  it("probeHealthy:false threads through from probeSidecarFn's {up:false}", async () => {
    const { invoke } = makeFakeInvoke({ read_provision_marker: () => null });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = {
      invoke,
      listen,
      settings: DEFAULT_SETTINGS,
      probeSidecarFn: async () => ({ up: false }),
    };
    const event = await runEffects(
      { phase: "CHECKING" },
      [{ kind: "probeHealth" }, { kind: "readMarker" }],
      deps,
    );
    expect(event).toEqual({ type: "CHECK_RESULT", probeHealthy: false, markerRaw: null });
  });

  it("a read_provision_marker invoke() rejection fails OPEN to markerRaw:null, never throws", async () => {
    const invoke: InvokeFn = (async () => {
      throw new Error("fs permission denied");
    }) as InvokeFn;
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = {
      invoke,
      listen,
      settings: DEFAULT_SETTINGS,
      probeSidecarFn: async () => ({ up: false }),
    };
    const event = await runEffects(
      { phase: "CHECKING" },
      [{ kind: "probeHealth" }, { kind: "readMarker" }],
      deps,
    );
    expect(event).toEqual({ type: "CHECK_RESULT", probeHealthy: false, markerRaw: null });
  });
});

describe("runEffects — STEP/POLLING_HEALTH (probeHealth alone -> HEALTH_POLL_RESULT)", () => {
  it("maps to probeSidecar only, never touches invoke()", async () => {
    const { invoke, calls } = makeFakeInvoke({});
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = {
      invoke,
      listen,
      settings: DEFAULT_SETTINGS,
      probeSidecarFn: async () => ({ up: true }),
      sleep: async () => {}, // Finding 1: attempts:3 below is past the first attempt — instant fake, no real 2s wait.
    };
    const state: MachineState = { phase: "STEP", step: "POLLING_HEALTH", status: "POLLING", attempts: 3 };
    const event = await runEffects(state, [{ kind: "probeHealth" }], deps);
    expect(event).toEqual({ type: "HEALTH_POLL_RESULT", healthy: true });
    expect(calls).toEqual([]);
  });

  it("Finding 1: the FIRST attempt (attempts:1) probes immediately — never calls sleep", async () => {
    const { invoke } = makeFakeInvoke({});
    const { listen } = makeFakeListen();
    const sleepCalls: number[] = [];
    const deps: RunnerDeps = {
      invoke,
      listen,
      settings: DEFAULT_SETTINGS,
      probeSidecarFn: async () => ({ up: false }),
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    };
    const state: MachineState = { phase: "STEP", step: "POLLING_HEALTH", status: "POLLING", attempts: 1 };
    const event = await runEffects(state, [{ kind: "probeHealth" }], deps);
    expect(sleepCalls).toEqual([]);
    expect(event).toEqual({ type: "HEALTH_POLL_RESULT", healthy: false });
  });

  it("Finding 1: every attempt AFTER the first sleeps 2000ms BEFORE probing — a 30x2s ≈ 60s budget for whisper_server.py's load-before-bind bind, instead of exhausting the cap in under a second against a connection-refused probe", async () => {
    const { invoke } = makeFakeInvoke({});
    const { listen } = makeFakeListen();
    const order: string[] = [];
    const deps: RunnerDeps = {
      invoke,
      listen,
      settings: DEFAULT_SETTINGS,
      probeSidecarFn: async () => {
        order.push("probe");
        return { up: false };
      },
      sleep: async (ms) => {
        order.push(`sleep:${ms}`);
      },
    };
    const state: MachineState = { phase: "STEP", step: "POLLING_HEALTH", status: "POLLING", attempts: 2 };
    const event = await runEffects(state, [{ kind: "probeHealth" }], deps);
    expect(order).toEqual(["sleep:2000", "probe"]); // sleep BEFORE the probe, not after
    expect(event).toEqual({ type: "HEALTH_POLL_RESULT", healthy: false });
  });

  it("without an injected sleep, defaults to a REAL timer (production behavior) — proven via fake timers rather than a real 2s wait", async () => {
    vi.useFakeTimers();
    try {
      const { invoke } = makeFakeInvoke({});
      const { listen } = makeFakeListen();
      const deps: RunnerDeps = {
        invoke,
        listen,
        settings: DEFAULT_SETTINGS,
        probeSidecarFn: async () => ({ up: true }),
        // no `sleep` override — exercises defaultSleep's real setTimeout
      };
      const state: MachineState = { phase: "STEP", step: "POLLING_HEALTH", status: "POLLING", attempts: 2 };
      const eventPromise = runEffects(state, [{ kind: "probeHealth" }], deps);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await eventPromise).toEqual({ type: "HEALTH_POLL_RESULT", healthy: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runEffects — runUv (INSTALL_PYTHON/CREATE_VENV/INSTALL_DEPS)", () => {
  it('maps to invoke("run_uv", {args, env}) with the effect\'s OWN command, verbatim', async () => {
    const command = pythonInstall(paths);
    const { invoke, calls } = makeFakeInvoke({ run_uv: () => ({ code: 0 }) });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };
    const state: MachineState = { phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" };

    const event = await runEffects(state, [{ kind: "runUv", command }], deps);

    expect(event).toEqual({ type: "STEP_OK", step: "INSTALL_PYTHON" });
    expect(calls).toEqual([{ cmd: "run_uv", args: { args: command.args, env: command.env } }]);
  });

  it("a non-zero exit code -> STEP_ERROR{retriable:true} for the current step", async () => {
    const { invoke } = makeFakeInvoke({ run_uv: () => ({ code: 1 }) });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };
    const state: MachineState = { phase: "STEP", step: "CREATE_VENV", status: "RUNNING" };

    const event = await runEffects(state, [{ kind: "runUv", command: venvCreate(paths) }], deps);

    expect(event).toEqual({
      type: "STEP_ERROR",
      step: "CREATE_VENV",
      error: "exited with code 1",
      retriable: true,
    });
  });

  it("a null exit code (killed/crashed) also -> STEP_ERROR{retriable:true}", async () => {
    const { invoke } = makeFakeInvoke({ run_uv: () => ({ code: null }) });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };
    const event = await runEffects(
      { phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" },
      [{ kind: "runUv", command: pythonInstall(paths) }],
      deps,
    );
    expect(event).toMatchObject({ type: "STEP_ERROR", retriable: true });
  });

  it("a rejected invoke() (spawn/IPC failure) -> STEP_ERROR{retriable:true} carrying the error message", async () => {
    const invoke: InvokeFn = (async () => {
      throw new Error("could not resolve the uv sidecar");
    }) as InvokeFn;
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };
    const event = await runEffects(
      { phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" },
      [{ kind: "runUv", command: pythonInstall(paths) }],
      deps,
    );
    expect(event).toEqual({
      type: "STEP_ERROR",
      step: "INSTALL_PYTHON",
      error: "could not resolve the uv sidecar",
      retriable: true,
    });
  });

  it("subscribes to uv://log BEFORE invoking, forwards lines to onLog, unsubscribes after", async () => {
    const { invoke } = makeFakeInvoke({
      run_uv: () => {
        // Emitted "during" the call — proves the listener was already
        // active by the time this handler ran (listen() is awaited
        // before invoke() is ever called, see provisionRunner.ts's
        // withUvLog).
        emit("uv://log", { stream: "stdout", line: "Installed Python 3.12" });
        emit("uv://log", { stream: "stderr", line: "warning: slow mirror" });
        return { code: 0 };
      },
    });
    const { listen, emit, activeCount, listenCalls } = makeFakeListen();
    const lines: Array<[string, string]> = [];
    const deps: RunnerDeps = {
      invoke,
      listen,
      settings: DEFAULT_SETTINGS,
      onLog: (stream, line) => lines.push([stream, line]),
    };

    await runEffects(
      { phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" },
      [{ kind: "runUv", command: pythonInstall(paths) }],
      deps,
    );

    expect(listenCalls).toEqual(["uv://log"]);
    expect(lines).toEqual([
      ["stdout", "Installed Python 3.12"],
      ["stderr", "warning: slow mirror"],
    ]);
    expect(activeCount("uv://log")).toBe(0); // unlistened after the call settled
  });
});

describe("runEffects — prewarmModel (DOWNLOAD_MODEL)", () => {
  it('maps to invoke("prewarm_model", {model}), also uv://log-streamed', async () => {
    const { invoke, calls } = makeFakeInvoke({
      prewarm_model: () => {
        emit("uv://log", { stream: "stdout", line: "Downloading small model..." });
        return { code: 0 };
      },
    });
    const { listen, emit } = makeFakeListen();
    const lines: Array<[string, string]> = [];
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS, onLog: (s, l) => lines.push([s, l]) };

    const event = await runEffects(
      { phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" },
      [{ kind: "prewarmModel", model: "small" }],
      deps,
    );

    expect(event).toEqual({ type: "STEP_OK", step: "DOWNLOAD_MODEL" });
    expect(calls).toEqual([{ cmd: "prewarm_model", args: { model: "small" } }]);
    expect(lines).toEqual([["stdout", "Downloading small model..."]]);
  });

  it("a non-zero exit code -> STEP_ERROR{retriable:true}", async () => {
    const { invoke } = makeFakeInvoke({ prewarm_model: () => ({ code: 137 }) });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };
    const event = await runEffects(
      { phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" },
      [{ kind: "prewarmModel", model: "small" }],
      deps,
    );
    expect(event).toEqual({
      type: "STEP_ERROR",
      step: "DOWNLOAD_MODEL",
      error: "exited with code 137",
      retriable: true,
    });
  });

  it("also subscribes to prewarm://progress BEFORE invoking (after uv://log), forwards payloads to onDownloadProgress, unsubscribes after", async () => {
    const { invoke } = makeFakeInvoke({
      prewarm_model: () => {
        // Emitted "during" the call — proves BOTH listeners were
        // already active by the time this handler ran (mirrors the
        // uv://log test above; see provisionRunner.ts's
        // withDownloadProgress).
        emit("prewarm://progress", { downloaded: 1_000_000, total: 3_000_000 });
        emit("prewarm://progress", { downloaded: 3_000_000, total: 3_000_000 });
        return { code: 0 };
      },
    });
    const { listen, emit, activeCount, listenCalls } = makeFakeListen();
    const progressUpdates: Array<{ downloaded: number; total: number }> = [];
    const deps: RunnerDeps = {
      invoke,
      listen,
      settings: DEFAULT_SETTINGS,
      onDownloadProgress: (progress) => progressUpdates.push(progress),
    };

    const event = await runEffects(
      { phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" },
      [{ kind: "prewarmModel", model: "small" }],
      deps,
    );

    expect(event).toEqual({ type: "STEP_OK", step: "DOWNLOAD_MODEL" });
    expect(listenCalls).toEqual(["uv://log", "prewarm://progress"]);
    expect(progressUpdates).toEqual([
      { downloaded: 1_000_000, total: 3_000_000 },
      { downloaded: 3_000_000, total: 3_000_000 },
    ]);
    expect(activeCount("prewarm://progress")).toBe(0); // unlistened after the call settled
  });

  it("a download_error rejection (server.rs's own captured-message Err) -> STEP_ERROR carrying that exact message", async () => {
    const invoke: InvokeFn = (async () => {
      throw new Error("磁盘空间不足，需要至少 3.6GB 可用空间");
    }) as InvokeFn;
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };
    const event = await runEffects(
      { phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" },
      [{ kind: "prewarmModel", model: "small" }],
      deps,
    );
    expect(event).toEqual({
      type: "STEP_ERROR",
      step: "DOWNLOAD_MODEL",
      error: "磁盘空间不足，需要至少 3.6GB 可用空间",
      retriable: true,
    });
  });
});

describe("runEffects — startServer (STARTING), with and without a bundled writeMarker", () => {
  it('bare STARTING (provisioned-dead re-launch) maps to invoke("start_server", {model}) only', async () => {
    const { invoke, calls } = makeFakeInvoke({ start_server: () => ({ alreadyRunning: false }) });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };

    const event = await runEffects(
      { phase: "STEP", step: "STARTING", status: "RUNNING" },
      [{ kind: "startServer", model: "medium" }],
      deps,
    );

    expect(event).toEqual({ type: "STEP_OK", step: "STARTING" });
    expect(calls).toEqual([{ cmd: "start_server", args: { model: "medium" } }]);
  });

  it("start_server never touches uv://log", async () => {
    const { invoke } = makeFakeInvoke({ start_server: () => ({ alreadyRunning: false }) });
    const { listen, listenCalls } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };
    await runEffects(
      { phase: "STEP", step: "STARTING", status: "RUNNING" },
      [{ kind: "startServer", model: "small" }],
      deps,
    );
    expect(listenCalls).toEqual([]);
  });

  it("a rejected start_server -> STEP_ERROR{step:\"STARTING\", retriable:true}", async () => {
    const invoke: InvokeFn = (async () => {
      throw new Error("failed to spawn whisper_server.py: ENOENT");
    }) as InvokeFn;
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };
    const event = await runEffects(
      { phase: "STEP", step: "STARTING", status: "RUNNING" },
      [{ kind: "startServer", model: "small" }],
      deps,
    );
    expect(event).toEqual({
      type: "STEP_ERROR",
      step: "STARTING",
      error: "failed to spawn whisper_server.py: ENOENT",
      retriable: true,
    });
  });

  it("DOWNLOAD_MODEL->STARTING's bundled writeMarker: stamps ts via the injected now(), writes BEFORE start_server, then STEP_OK", async () => {
    const order: string[] = [];
    const { invoke, calls } = makeFakeInvoke({
      write_provision_marker: () => {
        order.push("write_provision_marker");
        return undefined;
      },
      start_server: () => {
        order.push("start_server");
        return { alreadyRunning: false };
      },
    });
    const { listen } = makeFakeListen();
    const marker: Omit<ProvisionMarker, "ts"> = {
      schema: 1,
      model: "small",
      py: "3.12",
      deps: "faster-whisper==1.2.1,websockets==13.1,numpy==2.5.1",
    };
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS, now: () => "2026-07-12T00:00:00.000Z" };

    const event = await runEffects(
      { phase: "STEP", step: "STARTING", status: "RUNNING" },
      [{ kind: "writeMarker", marker }, { kind: "startServer", model: "small" }],
      deps,
    );

    expect(event).toEqual({ type: "STEP_OK", step: "STARTING" });
    expect(order).toEqual(["write_provision_marker", "start_server"]);
    expect(calls[0]).toEqual({
      cmd: "write_provision_marker",
      args: { json: JSON.stringify({ ...marker, ts: "2026-07-12T00:00:00.000Z" }) },
    });
  });

  it("a rejected write_provision_marker fails the CURRENT step (STARTING) and never calls start_server", async () => {
    const { invoke, calls } = makeFakeInvoke({
      write_provision_marker: () => {
        throw new Error("failed to rename .tmp -> .provisioned.json");
      },
      start_server: () => ({ alreadyRunning: false }),
    });
    const { listen } = makeFakeListen();
    const marker: Omit<ProvisionMarker, "ts"> = { schema: 1, model: "small", py: "3.12", deps: "x" };
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };

    const event = await runEffects(
      { phase: "STEP", step: "STARTING", status: "RUNNING" },
      [{ kind: "writeMarker", marker }, { kind: "startServer", model: "small" }],
      deps,
    );

    expect(event).toEqual({
      type: "STEP_ERROR",
      step: "STARTING",
      error: "failed to rename .tmp -> .provisioned.json",
      retriable: true,
    });
    expect(calls.map((c) => c.cmd)).toEqual(["write_provision_marker"]); // start_server never reached
  });
});

describe("runEffects — RETRY-into-STARTING's bundled stopServer (Finding 7)", () => {
  it('a leading stopServer effect invokes "stop_server" BEFORE start_server, then STEP_OK', async () => {
    const order: string[] = [];
    const { invoke, calls } = makeFakeInvoke({
      stop_server: () => {
        order.push("stop_server");
        return undefined;
      },
      start_server: () => {
        order.push("start_server");
        return { alreadyRunning: false };
      },
    });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };

    const event = await runEffects(
      { phase: "STEP", step: "STARTING", status: "RUNNING" },
      [{ kind: "stopServer" }, { kind: "startServer", model: "small" }],
      deps,
    );

    expect(event).toEqual({ type: "STEP_OK", step: "STARTING" });
    expect(order).toEqual(["stop_server", "start_server"]);
    expect(calls.map((c) => c.cmd)).toEqual(["stop_server", "start_server"]);
  });

  it("a rejected stop_server fails the CURRENT step (STARTING) and never calls start_server", async () => {
    const { invoke, calls } = makeFakeInvoke({
      stop_server: () => {
        throw new Error("failed to kill whisper_server.py");
      },
      start_server: () => ({ alreadyRunning: false }),
    });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };

    const event = await runEffects(
      { phase: "STEP", step: "STARTING", status: "RUNNING" },
      [{ kind: "stopServer" }, { kind: "startServer", model: "small" }],
      deps,
    );

    expect(event).toEqual({
      type: "STEP_ERROR",
      step: "STARTING",
      error: "failed to kill whisper_server.py",
      retriable: true,
    });
    expect(calls.map((c) => c.cmd)).toEqual(["stop_server"]); // start_server never reached
  });
});

describe("runEffects — unrecognized (state, effects) combinations", () => {
  it("throws rather than silently stalling the machine (e.g. a HEALTHY/TERMINAL_ERROR state has no effects to run)", async () => {
    const { invoke } = makeFakeInvoke({});
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };
    await expect(runEffects({ phase: "HEALTHY" }, [], deps)).rejects.toThrow(/no interpretation/);
  });
});

describe("stopServer", () => {
  it('invokes "stop_server" with no args', async () => {
    const { invoke, calls } = makeFakeInvoke({ stop_server: () => undefined });
    await stopServer(invoke);
    expect(calls).toEqual([{ cmd: "stop_server", args: undefined }]);
  });
});

describe("getAppPaths", () => {
  it('invokes "app_paths" with no args and returns it verbatim', async () => {
    const { invoke, calls } = makeFakeInvoke({ app_paths: () => paths });
    const result = await getAppPaths(invoke);
    expect(result).toBe(paths);
    expect(calls).toEqual([{ cmd: "app_paths", args: undefined }]);
  });
});

describe("RunnerDeps defaults", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("without probeSidecarFn, falls back to the REAL probeSidecar (reused, not duplicated) — proven via global fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, model: "small", diarization_ready: false }), { status: 200 }),
      ),
    );
    const { invoke } = makeFakeInvoke({ read_provision_marker: () => null });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS }; // no probeSidecarFn override
    const event = await runEffects({ phase: "CHECKING" }, [{ kind: "probeHealth" }, { kind: "readMarker" }], deps);
    expect(event).toEqual({ type: "CHECK_RESULT", probeHealthy: true, markerRaw: null });
  });
});
