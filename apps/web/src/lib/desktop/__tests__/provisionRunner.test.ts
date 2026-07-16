// v0.4 S3 chunk 5 — the effect interpreter's own coverage. Fakes for
// invoke/listen/probeSidecar only (no @tauri-apps import anywhere in
// this file, matching provisionRunner.ts's own zero-Tauri-imports
// contract) — every test drives `runEffects` directly with a
// (state, effects) pair exactly as `initial()`/`transition()`
// (provisionMachine.test.ts) already prove those functions return.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import { MARKER_SCHEMA_VERSION, type Effect, type MachineState, type ProvisionMarker } from "../provisionMachine";
import { getAppPaths, runEffects, stopServer, type RunnerDeps } from "../provisionRunner";
import type { InvokeFn, ListenFn, TauriEvent } from "../tauriApi";
import { pythonInstall, venvCreate, type DesktopPaths } from "../uvCommands";
import { resetMlxCapsCache } from "../mlxCaps";

const paths: DesktopPaths = {
  appData: "/fake/AppData",
  pythonInstallDir: "/fake/AppData/python",
  uvCacheDir: "/fake/AppData/uv-cache",
  venvDir: "/fake/AppData/venv",
  venvPython: "/fake/AppData/venv/bin/python",
  modelsDir: "/fake/AppData/models",
  scriptPath: "/fake/Resources/sidecar/whisper_server.py",
  requirementsPath: "/fake/Resources/sidecar/requirements-sidecar.txt",
  diarRequirementsPath: "/fake/Resources/sidecar/requirements-diar.txt",
  logPath: "/fake/Logs/whisper_server.log",
  markerPath: "/fake/AppData/.provisioned.json",
  mlxVenvDir: "/fake/AppData/mlx-venv",
  mlxVenvPython: "/fake/AppData/mlx-venv/bin/python",
  mlxRequirementsLockPath: "/fake/Resources/sidecar/requirements-mlx.lock",
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

// S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
// Provision, F14) — CHECKING's own conditional mlx-usability probe:
// ONLY reached when the just-read marker parses to an
// MLX_ONLY_MARKER_MODELS member. mlxCaps.ts's own module-level cache is
// reset around every test here (probeMlxCapabilitiesWith, reused
// verbatim by provisionRunner.ts's probeMlxUsable, writes into that
// SAME shared cache) so these tests stay isolated from each other and
// from mlxCaps.test.ts's own suite.
// S12a fix round (§D F2, HIGH) — probeMlxUsable's own 4-state result
// (usable | unsupported | invalid-venv | probe-error), including the
// "retry the failed probe once" contract. RED-VERIFICATION EVIDENCE for
// F2 (see this task's own PR report): the old code collapsed a genuine
// invoke() rejection of mlx_capabilities to the SAME `mlxUsable:false`
// shape as a definitively-resolved `mlxSupported:false` — i.e. it
// treated "we don't know" identically to "we know, and the answer is
// no", which is exactly what durably persisted `small` over a merely
// FLAKY probe (bootstrap.ts's own quarantine branch, pre-fix, read
// `event.mlxUsable !== true` and persisted unconditionally). The
// "a genuine invoke() rejection, even after one retry, must NEVER
// resolve the SAME shape as a resolved mlxSupported:false" test below
// is the direct proof: reverting probeMlxUsable to `return
// !caps.mlxSupported ? false : ...` (bare boolean, no retry, no status
// distinction) makes it fail, because BOTH conditions would then
// collapse to `mlxUsable:false`.
describe("runEffects — CHECKING's conditional mlx-usability probe (F14, redesigned §D F2)", () => {
  beforeEach(() => resetMlxCapsCache());
  afterEach(() => resetMlxCapsCache());

  const parakeetMarkerJson = JSON.stringify({
    schema: MARKER_SCHEMA_VERSION,
    model: "parakeet-tdt-0.6b-v3",
    py: "3.12",
    deps: "x",
    ts: "t",
  } satisfies ProvisionMarker);

  it("a WHISPER-family marker never triggers mlx_capabilities/mlx_import_preflight at all", async () => {
    const { invoke, calls } = makeFakeInvoke({
      read_provision_marker: () => "the-marker-json", // unparseable -> null marker either way
    });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = {
      invoke,
      listen,
      settings: DEFAULT_SETTINGS,
      probeSidecarFn: async () => ({ up: false }),
    };
    const event = await runEffects({ phase: "CHECKING" }, [{ kind: "probeHealth" }, { kind: "readMarker" }], deps);
    expect(event).toEqual({ type: "CHECK_RESULT", probeHealthy: false, markerRaw: "the-marker-json" });
    expect(calls.map((c) => c.cmd)).toEqual(["read_provision_marker"]); // never mlx_capabilities/mlx_import_preflight
  });

  it("a parakeet marker + mlx_capabilities{mlxSupported:true} + a clean mlx_import_preflight -> {status:'usable'}, no retries", async () => {
    const { invoke, calls } = makeFakeInvoke({
      read_provision_marker: () => parakeetMarkerJson,
      mlx_capabilities: () => ({ mlxSupported: true, reason: null }),
      mlx_import_preflight: () => ({ ok: true, stderr: "" }),
    });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = {
      invoke,
      listen,
      settings: DEFAULT_SETTINGS,
      probeSidecarFn: async () => ({ up: false }),
    };
    const event = await runEffects({ phase: "CHECKING" }, [{ kind: "probeHealth" }, { kind: "readMarker" }], deps);
    expect(event).toEqual({
      type: "CHECK_RESULT",
      probeHealthy: false,
      markerRaw: parakeetMarkerJson,
      mlxUsability: { status: "usable" },
    });
    // Exactly ONE call each — a resolved answer is never retried.
    expect(calls.map((c) => c.cmd)).toEqual(["read_provision_marker", "mlx_capabilities", "mlx_import_preflight"]);
  });

  it("§D F2 case (a): mlx_capabilities RESOLVED {mlxSupported:false} -> {status:'unsupported', reason}, and mlx_import_preflight is never even called (hardware fails fast, no retry — a resolved answer, even a negative one, is trusted immediately)", async () => {
    const { invoke, calls } = makeFakeInvoke({
      read_provision_marker: () => parakeetMarkerJson,
      mlx_capabilities: () => ({ mlxSupported: false, reason: "需要 Apple 芯片（M 系列）" }),
    });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS, probeSidecarFn: async () => ({ up: false }) };
    const event = await runEffects({ phase: "CHECKING" }, [{ kind: "probeHealth" }, { kind: "readMarker" }], deps);
    expect(event).toMatchObject({ mlxUsability: { status: "unsupported", reason: "需要 Apple 芯片（M 系列）" } });
    expect(calls.map((c) => c.cmd)).toEqual(["read_provision_marker", "mlx_capabilities"]); // exactly once, no retry
  });

  it("§D F2 case (a) with no reason from the probe falls back to the standard zh copy", async () => {
    const { invoke } = makeFakeInvoke({
      read_provision_marker: () => parakeetMarkerJson,
      mlx_capabilities: () => ({ mlxSupported: false, reason: null }),
    });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS, probeSidecarFn: async () => ({ up: false }) };
    const event = await runEffects({ phase: "CHECKING" }, [{ kind: "probeHealth" }, { kind: "readMarker" }], deps);
    expect(event).toMatchObject({
      mlxUsability: { status: "unsupported", reason: "需要 Apple 芯片（M 系列），macOS 14 或更高" },
    });
  });

  it("§D F2 case (b): mlx_capabilities OK but mlx_import_preflight RESOLVED {ok:false} -> {status:'invalid-venv'}, no retry (a resolved ok:false is trusted immediately)", async () => {
    const { invoke, calls } = makeFakeInvoke({
      read_provision_marker: () => parakeetMarkerJson,
      mlx_capabilities: () => ({ mlxSupported: true, reason: null }),
      mlx_import_preflight: () => ({ ok: false, stderr: "ModuleNotFoundError: parakeet_mlx" }),
    });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS, probeSidecarFn: async () => ({ up: false }) };
    const event = await runEffects({ phase: "CHECKING" }, [{ kind: "probeHealth" }, { kind: "readMarker" }], deps);
    expect(event).toMatchObject({ mlxUsability: { status: "invalid-venv" } });
    expect(calls.map((c) => c.cmd)).toEqual(["read_provision_marker", "mlx_capabilities", "mlx_import_preflight"]); // exactly once
  });

  it("§D F2 case (c): mlx_import_preflight invoke() REJECTS TWICE (surviving the internal retry) -> {status:'probe-error', message} using '无法检测' wording — RED-VERIFIED against the OLD boolean behavior below", async () => {
    let preflightCalls = 0;
    const { invoke, calls } = makeFakeInvoke({
      read_provision_marker: () => parakeetMarkerJson,
      mlx_capabilities: () => ({ mlxSupported: true, reason: null }),
      mlx_import_preflight: () => {
        preflightCalls += 1;
        throw new Error("ENOENT");
      },
    });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS, probeSidecarFn: async () => ({ up: false }) };
    const event = await runEffects({ phase: "CHECKING" }, [{ kind: "probeHealth" }, { kind: "readMarker" }], deps);
    expect(event).toMatchObject({
      mlxUsability: { status: "probe-error", message: "无法检测 MLX 运行环境状态，请重试" },
    });
    expect(preflightCalls).toBe(2); // one retry, per §D F2's own "retry the failed probe once"
    expect(calls.map((c) => c.cmd)).toEqual([
      "read_provision_marker",
      "mlx_capabilities",
      "mlx_import_preflight",
      "mlx_import_preflight",
    ]);
  });

  it("mlx_import_preflight rejects ONCE then SUCCEEDS on the retry -> the retry's own resolved answer wins ({status:'usable'})", async () => {
    let preflightCalls = 0;
    const { invoke } = makeFakeInvoke({
      read_provision_marker: () => parakeetMarkerJson,
      mlx_capabilities: () => ({ mlxSupported: true, reason: null }),
      mlx_import_preflight: () => {
        preflightCalls += 1;
        if (preflightCalls === 1) throw new Error("transient");
        return { ok: true, stderr: "" };
      },
    });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS, probeSidecarFn: async () => ({ up: false }) };
    const event = await runEffects({ phase: "CHECKING" }, [{ kind: "probeHealth" }, { kind: "readMarker" }], deps);
    expect(event).toMatchObject({ mlxUsability: { status: "usable" } });
    expect(preflightCalls).toBe(2);
  });

  it("§D F2 case (c): mlx_capabilities invoke() REJECTS TWICE -> {status:'probe-error'} using '无法检测' wording, mlx_import_preflight is NEVER called at all (we don't even know if hardware is usable)", async () => {
    let capsCalls = 0;
    const { invoke, calls } = makeFakeInvoke({
      read_provision_marker: () => parakeetMarkerJson,
      mlx_capabilities: () => {
        capsCalls += 1;
        throw new Error("ipc failure");
      },
    });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS, probeSidecarFn: async () => ({ up: false }) };
    const event = await runEffects({ phase: "CHECKING" }, [{ kind: "probeHealth" }, { kind: "readMarker" }], deps);
    expect(event).toMatchObject({
      mlxUsability: { status: "probe-error", message: "无法检测 Apple 芯片支持状态，请重试" },
    });
    expect(capsCalls).toBe(2); // one retry
    expect(calls.map((c) => c.cmd)).toEqual(["read_provision_marker", "mlx_capabilities", "mlx_capabilities"]); // never reaches mlx_import_preflight
  });

  it("mlx_capabilities rejects ONCE then RESOLVES {mlxSupported:false} on the retry -> the retry's resolved (definitive) answer wins ({status:'unsupported'}), never 'probe-error'", async () => {
    let capsCalls = 0;
    const { invoke } = makeFakeInvoke({
      read_provision_marker: () => parakeetMarkerJson,
      mlx_capabilities: () => {
        capsCalls += 1;
        if (capsCalls === 1) throw new Error("transient");
        return { mlxSupported: false, reason: "需要 Apple 芯片（M 系列）" };
      },
    });
    const { listen } = makeFakeListen();
    const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS, probeSidecarFn: async () => ({ up: false }) };
    const event = await runEffects({ phase: "CHECKING" }, [{ kind: "probeHealth" }, { kind: "readMarker" }], deps);
    expect(event).toMatchObject({ mlxUsability: { status: "unsupported", reason: "需要 Apple 芯片（M 系列）" } });
    expect(capsCalls).toBe(2);
  });

  // §D F2's own RED-VERIFICATION: proves the fix actually changed
  // behavior relative to the OLD code, not just relative to what the
  // new tests happen to assert. The OLD probeMlxUsable was:
  //   const caps = await probeMlxCapabilitiesWith(deps.invoke);
  //   if (!caps.mlxSupported) return false;   // <- no retry, no status
  //   ...
  // probeMlxCapabilitiesWith ITSELF never throws (mlxCaps.ts's own
  // fail-closed policy swallows the rejection into a synthetic
  // `{mlxSupported:false, reason:"无法确认..."}`), so under the OLD
  // code a genuine invoke() rejection and a genuine RESOLVED
  // mlxSupported:false were LITERALLY INDISTINGUISHABLE — both
  // resolved the bare `mlxUsable:false`. The two tests directly above
  // this one prove the NEW code tells them apart
  // ({status:"probe-error"} vs {status:"unsupported"}); this test
  // documents that distinction explicitly, one more time, side by
  // side, as the red-verification record for the PR report.
  it("RED-VERIFICATION: an invoke() REJECTION and a RESOLVED mlxSupported:false must resolve DIFFERENT statuses — the exact collapse the old boolean code had", async () => {
    const rejected = makeFakeInvoke({
      read_provision_marker: () => parakeetMarkerJson,
      mlx_capabilities: () => {
        throw new Error("ipc failure");
      },
    });
    const resolvedFalse = makeFakeInvoke({
      read_provision_marker: () => parakeetMarkerJson,
      mlx_capabilities: () => ({ mlxSupported: false, reason: "x" }),
    });
    const { listen } = makeFakeListen();
    const baseDeps = { listen, settings: DEFAULT_SETTINGS, probeSidecarFn: async () => ({ up: false }) } as const;

    const rejectedEvent = await runEffects(
      { phase: "CHECKING" },
      [{ kind: "probeHealth" }, { kind: "readMarker" }],
      { ...baseDeps, invoke: rejected.invoke },
    );
    const resolvedEvent = await runEffects(
      { phase: "CHECKING" },
      [{ kind: "probeHealth" }, { kind: "readMarker" }],
      { ...baseDeps, invoke: resolvedFalse.invoke },
    );

    expect(rejectedEvent).toMatchObject({ mlxUsability: { status: "probe-error" } });
    expect(resolvedEvent).toMatchObject({ mlxUsability: { status: "unsupported" } });
    // The old code's own collapse point: under the PRE-fix
    // implementation, `(rejectedEvent as any).mlxUsable` and
    // `(resolvedEvent as any).mlxUsable` were BOTH `false` — the two
    // assertions above (status:"probe-error" vs status:"unsupported")
    // are exactly what that reverted implementation would fail.
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

  // S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
  // Q6/§3.5 HF-token) — RunnerDeps.readHfToken's own passthrough.
  describe("hfToken passthrough (§C Q6)", () => {
    it("readHfToken returning a non-empty token adds hfToken to the invoke payload, trimmed", async () => {
      const { invoke, calls } = makeFakeInvoke({ prewarm_model: () => ({ code: 0 }) });
      const { listen } = makeFakeListen();
      const deps: RunnerDeps = {
        invoke,
        listen,
        settings: DEFAULT_SETTINGS,
        readHfToken: () => "  hf_abc123  ",
      };
      await runEffects(
        { phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" },
        [{ kind: "prewarmModel", model: "small" }],
        deps,
      );
      expect(calls).toEqual([{ cmd: "prewarm_model", args: { model: "small", hfToken: "hf_abc123" } }]);
    });

    it("readHfToken returning an empty string omits the hfToken key entirely (Rust's Option<String> treats a missing key as None)", async () => {
      const { invoke, calls } = makeFakeInvoke({ prewarm_model: () => ({ code: 0 }) });
      const { listen } = makeFakeListen();
      const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS, readHfToken: () => "" };
      await runEffects(
        { phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" },
        [{ kind: "prewarmModel", model: "small" }],
        deps,
      );
      expect(calls).toEqual([{ cmd: "prewarm_model", args: { model: "small" } }]);
    });

    it("readHfToken returning a whitespace-only string ALSO omits the key", async () => {
      const { invoke, calls } = makeFakeInvoke({ prewarm_model: () => ({ code: 0 }) });
      const { listen } = makeFakeListen();
      const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS, readHfToken: () => "   " };
      await runEffects(
        { phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" },
        [{ kind: "prewarmModel", model: "small" }],
        deps,
      );
      expect(calls).toEqual([{ cmd: "prewarm_model", args: { model: "small" } }]);
    });

    it("no readHfToken dep at all (every pre-S12a caller) omits the key — byte-identical to before this task", async () => {
      const { invoke, calls } = makeFakeInvoke({ prewarm_model: () => ({ code: 0 }) });
      const { listen } = makeFakeListen();
      const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };
      await runEffects(
        { phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" },
        [{ kind: "prewarmModel", model: "small" }],
        deps,
      );
      expect(calls).toEqual([{ cmd: "prewarm_model", args: { model: "small" } }]);
    });
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

  // S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
  // Q6/§3.5 HF-token) — RunnerDeps.readHfToken's own passthrough,
  // mirrors the prewarmModel describe block's own coverage above.
  describe("hfToken passthrough (§C Q6)", () => {
    it("readHfToken returning a non-empty token adds hfToken to the invoke payload, trimmed", async () => {
      const { invoke, calls } = makeFakeInvoke({ start_server: () => ({ alreadyRunning: false }) });
      const { listen } = makeFakeListen();
      const deps: RunnerDeps = {
        invoke,
        listen,
        settings: DEFAULT_SETTINGS,
        readHfToken: () => "  hf_abc123  ",
      };
      await runEffects(
        { phase: "STEP", step: "STARTING", status: "RUNNING" },
        [{ kind: "startServer", model: "medium" }],
        deps,
      );
      expect(calls).toEqual([{ cmd: "start_server", args: { model: "medium", hfToken: "hf_abc123" } }]);
    });

    it("readHfToken returning an empty/whitespace-only string omits the hfToken key entirely", async () => {
      const { invoke, calls } = makeFakeInvoke({ start_server: () => ({ alreadyRunning: false }) });
      const { listen } = makeFakeListen();
      const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS, readHfToken: () => "   " };
      await runEffects(
        { phase: "STEP", step: "STARTING", status: "RUNNING" },
        [{ kind: "startServer", model: "medium" }],
        deps,
      );
      expect(calls).toEqual([{ cmd: "start_server", args: { model: "medium" } }]);
    });

    it("no readHfToken dep at all omits the key — byte-identical to before this task", async () => {
      const { invoke, calls } = makeFakeInvoke({ start_server: () => ({ alreadyRunning: false }) });
      const { listen } = makeFakeListen();
      const deps: RunnerDeps = { invoke, listen, settings: DEFAULT_SETTINGS };
      await runEffects(
        { phase: "STEP", step: "STARTING", status: "RUNNING" },
        [{ kind: "startServer", model: "medium" }],
        deps,
      );
      expect(calls).toEqual([{ cmd: "start_server", args: { model: "medium" } }]);
    });
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
