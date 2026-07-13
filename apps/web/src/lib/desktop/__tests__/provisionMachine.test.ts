// S3 chunk 4 — full transition coverage for the pure provisioning
// machine + the separate crash-restart reducer. Zero Tauri imports (the
// machine itself has none; this file doesn't add any either) — every
// assertion here exercises transition()/decideRestart() as plain
// synchronous functions.
import { describe, expect, it } from "vitest";

import type { DesktopPaths } from "../uvCommands";
import { pipInstall, pythonInstall, venvCreate } from "../uvCommands";
import {
  MARKER_SCHEMA_VERSION,
  MAX_RESTARTS_PER_WINDOW,
  POLLING_HEALTH_ATTEMPT_CAP,
  RESTART_WINDOW_MS,
  decideRestart,
  initial,
  initialRestartState,
  parseMarker,
  transition,
  type MachineState,
  type ProvisionContext,
} from "../provisionMachine";

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
};

const ctx: ProvisionContext = { paths, model: "small" };

const validMarkerJson = JSON.stringify({
  schema: MARKER_SCHEMA_VERSION,
  model: "small",
  py: "3.12",
  deps: "faster-whisper==1.2.1,websockets==13.1,numpy==2.5.1",
  ts: "2026-07-01T00:00:00.000Z",
});

describe("initial", () => {
  it("starts CHECKING and issues both probeHealth and readMarker", () => {
    expect(initial()).toEqual({
      state: { phase: "CHECKING" },
      effects: [{ kind: "probeHealth" }, { kind: "readMarker" }],
    });
  });
});

describe("parseMarker", () => {
  it("returns null for a null (absent-file) input", () => {
    expect(parseMarker(null)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseMarker("{not json")).toBeNull();
  });

  it("returns null for valid JSON that isn't an object", () => {
    expect(parseMarker("42")).toBeNull();
    expect(parseMarker("[1,2,3]")).toBeNull();
    expect(parseMarker('"just a string"')).toBeNull();
  });

  it("returns null when schema doesn't match MARKER_SCHEMA_VERSION", () => {
    expect(parseMarker(JSON.stringify({ schema: 999, model: "small", py: "3.12", deps: "x", ts: "t" }))).toBeNull();
  });

  it("returns null when model is missing or empty", () => {
    expect(parseMarker(JSON.stringify({ schema: MARKER_SCHEMA_VERSION, py: "3.12", deps: "x", ts: "t" }))).toBeNull();
    expect(
      parseMarker(JSON.stringify({ schema: MARKER_SCHEMA_VERSION, model: "", py: "3.12", deps: "x", ts: "t" })),
    ).toBeNull();
  });

  it("Finding 5: returns null when model isn't one of server.rs's ALLOWED_MODELS (corrupted/foreign marker)", () => {
    expect(
      parseMarker(JSON.stringify({ schema: MARKER_SCHEMA_VERSION, model: "gpt-4", py: "3.12", deps: "x", ts: "t" })),
    ).toBeNull();
  });

  it("returns null when any other field has the wrong type", () => {
    expect(
      parseMarker(JSON.stringify({ schema: MARKER_SCHEMA_VERSION, model: "small", py: 312, deps: "x", ts: "t" })),
    ).toBeNull();
  });

  it("parses a well-formed marker", () => {
    expect(parseMarker(validMarkerJson)).toEqual({
      schema: MARKER_SCHEMA_VERSION,
      model: "small",
      py: "3.12",
      deps: "faster-whisper==1.2.1,websockets==13.1,numpy==2.5.1",
      ts: "2026-07-01T00:00:00.000Z",
    });
  });

  it("accepts large-v3-turbo (added S4 chunk 0) as a valid marker model", () => {
    expect(
      parseMarker(
        JSON.stringify({ schema: MARKER_SCHEMA_VERSION, model: "large-v3-turbo", py: "3.12", deps: "x", ts: "t" }),
      ),
    ).toEqual({ schema: MARKER_SCHEMA_VERSION, model: "large-v3-turbo", py: "3.12", deps: "x", ts: "t" });
  });
});

describe("transition — CHECK_RESULT", () => {
  const checking: MachineState = { phase: "CHECKING" };

  it("adopt-existing: probe healthy -> HEALTHY with no effects, regardless of the marker", () => {
    expect(transition(ctx, checking, { type: "CHECK_RESULT", probeHealthy: true, markerRaw: null })).toEqual({
      state: { phase: "HEALTHY" },
      effects: [],
    });
    expect(
      transition(ctx, checking, { type: "CHECK_RESULT", probeHealthy: true, markerRaw: validMarkerJson }),
    ).toEqual({ state: { phase: "HEALTHY" }, effects: [] });
  });

  it("provisioned-dead: marker present+valid, probe dead -> skips straight to STARTING", () => {
    expect(
      transition(ctx, checking, { type: "CHECK_RESULT", probeHealthy: false, markerRaw: validMarkerJson }),
    ).toEqual({
      state: { phase: "STEP", step: "STARTING", status: "RUNNING" },
      effects: [{ kind: "startServer", model: "small" }],
    });
  });

  it("provisioned-dead uses the MARKER's model, not ctx.model, when they differ", () => {
    const markerForMedium = JSON.stringify({
      schema: MARKER_SCHEMA_VERSION,
      model: "medium",
      py: "3.12",
      deps: "x",
      ts: "t",
    });
    const result = transition(ctx, checking, { type: "CHECK_RESULT", probeHealthy: false, markerRaw: markerForMedium });
    expect(result.effects).toEqual([{ kind: "startServer", model: "medium" }]);
  });

  it("marker schema validation: bad marker (probe dead) -> NEEDS_PROVISION, same as no marker at all", () => {
    const noMarker = transition(ctx, checking, { type: "CHECK_RESULT", probeHealthy: false, markerRaw: null });
    const badMarker = transition(ctx, checking, {
      type: "CHECK_RESULT",
      probeHealthy: false,
      markerRaw: "{not json",
    });
    const expected = {
      state: { phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" },
      effects: [{ kind: "runUv", command: pythonInstall(paths) }],
    };
    expect(noMarker).toEqual(expected);
    expect(badMarker).toEqual(expected);
  });

  it("is a no-op when the machine isn't currently CHECKING (stale/duplicate event)", () => {
    const healthy: MachineState = { phase: "HEALTHY" };
    expect(transition(ctx, healthy, { type: "CHECK_RESULT", probeHealthy: false, markerRaw: null })).toEqual({
      state: healthy,
      effects: [],
    });
  });
});

describe("transition — the full NEEDS_PROVISION chain", () => {
  it("INSTALL_PYTHON ok -> CREATE_VENV", () => {
    const state: MachineState = { phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" };
    expect(transition(ctx, state, { type: "STEP_OK", step: "INSTALL_PYTHON" })).toEqual({
      state: { phase: "STEP", step: "CREATE_VENV", status: "RUNNING" },
      effects: [{ kind: "runUv", command: venvCreate(paths) }],
    });
  });

  it("CREATE_VENV ok -> INSTALL_DEPS", () => {
    const state: MachineState = { phase: "STEP", step: "CREATE_VENV", status: "RUNNING" };
    expect(transition(ctx, state, { type: "STEP_OK", step: "CREATE_VENV" })).toEqual({
      state: { phase: "STEP", step: "INSTALL_DEPS", status: "RUNNING" },
      effects: [{ kind: "runUv", command: pipInstall(paths) }],
    });
  });

  it("INSTALL_DEPS ok -> DOWNLOAD_MODEL", () => {
    const state: MachineState = { phase: "STEP", step: "INSTALL_DEPS", status: "RUNNING" };
    expect(transition(ctx, state, { type: "STEP_OK", step: "INSTALL_DEPS" })).toEqual({
      state: { phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" },
      effects: [{ kind: "prewarmModel", model: "small" }],
    });
  });

  it("DOWNLOAD_MODEL ok -> STARTING, and ALSO writes the marker (schema/model/py/deps, no ts)", () => {
    const state: MachineState = { phase: "STEP", step: "DOWNLOAD_MODEL", status: "RUNNING" };
    const result = transition(ctx, state, { type: "STEP_OK", step: "DOWNLOAD_MODEL" });
    expect(result.state).toEqual({ phase: "STEP", step: "STARTING", status: "RUNNING" });
    expect(result.effects).toEqual([
      {
        kind: "writeMarker",
        marker: {
          schema: MARKER_SCHEMA_VERSION,
          model: "small",
          py: "3.12",
          deps: "faster-whisper==1.2.1,websockets==13.1,numpy==2.5.1,huggingface-hub==1.23.0",
        },
      },
      { kind: "startServer", model: "small" },
    ]);
  });

  it("STARTING ok -> POLLING_HEALTH, attempts starts at 1", () => {
    const state: MachineState = { phase: "STEP", step: "STARTING", status: "RUNNING" };
    expect(transition(ctx, state, { type: "STEP_OK", step: "STARTING" })).toEqual({
      state: { phase: "STEP", step: "POLLING_HEALTH", status: "POLLING", attempts: 1 },
      effects: [{ kind: "probeHealth" }],
    });
  });

  it("STEP_OK is a no-op when it doesn't match the current step (stale event)", () => {
    const state: MachineState = { phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" };
    expect(transition(ctx, state, { type: "STEP_OK", step: "CREATE_VENV" })).toEqual({ state, effects: [] });
  });

  it("STEP_OK is a no-op when the current step is already parked in ERROR", () => {
    const state: MachineState = {
      phase: "STEP",
      step: "INSTALL_PYTHON",
      status: "ERROR",
      error: "boom",
      retriable: true,
    };
    expect(transition(ctx, state, { type: "STEP_OK", step: "INSTALL_PYTHON" })).toEqual({ state, effects: [] });
  });
});

describe("transition — STEP_ERROR", () => {
  it("RUNNING -> STEP_ERROR{retriable} for the matching step", () => {
    const state: MachineState = { phase: "STEP", step: "INSTALL_DEPS", status: "RUNNING" };
    expect(
      transition(ctx, state, { type: "STEP_ERROR", step: "INSTALL_DEPS", error: "pip failed", retriable: true }),
    ).toEqual({
      state: { phase: "STEP", step: "INSTALL_DEPS", status: "ERROR", error: "pip failed", retriable: true },
      effects: [],
    });
  });

  it("carries retriable:false through unchanged when the interpreter reports it", () => {
    const state: MachineState = { phase: "STEP", step: "STARTING", status: "RUNNING" };
    const result = transition(ctx, state, {
      type: "STEP_ERROR",
      step: "STARTING",
      error: "spawn ENOENT",
      retriable: false,
    });
    expect(result.state).toMatchObject({ status: "ERROR", retriable: false });
  });

  it("is a no-op for a stale step that doesn't match the current one", () => {
    const state: MachineState = { phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" };
    expect(
      transition(ctx, state, { type: "STEP_ERROR", step: "CREATE_VENV", error: "late", retriable: true }),
    ).toEqual({ state, effects: [] });
  });
});

describe("transition — RETRY", () => {
  it("re-enters the errored step's SAME effect (a step with no held child)", () => {
    const state: MachineState = {
      phase: "STEP",
      step: "CREATE_VENV",
      status: "ERROR",
      error: "boom",
      retriable: true,
    };
    expect(transition(ctx, state, { type: "RETRY" })).toEqual({
      state: { phase: "STEP", step: "CREATE_VENV", status: "RUNNING" },
      effects: [{ kind: "runUv", command: venvCreate(paths) }],
    });
  });

  it("Finding 7: retrying a POLLING_HEALTH timeout re-enters STARTING (not POLLING) with a LEADING stopServer — server.rs's start_server short-circuits to already_running:true while the hung child is still held, so a bare re-probe would just observe the SAME child forever", () => {
    const state: MachineState = {
      phase: "STEP",
      step: "POLLING_HEALTH",
      status: "ERROR",
      error: "timed out",
      retriable: true,
    };
    expect(transition(ctx, state, { type: "RETRY" })).toEqual({
      state: { phase: "STEP", step: "STARTING", status: "RUNNING" },
      effects: [{ kind: "stopServer" }, { kind: "startServer", model: "small" }],
    });
  });

  it("Finding 7: retrying a STARTING error ALSO carries a leading stopServer (uniform with POLLING_HEALTH's own retry — see handleRetry's own doc comment for why this is deliberately not step-dependent)", () => {
    const state: MachineState = {
      phase: "STEP",
      step: "STARTING",
      status: "ERROR",
      error: "spawn ENOENT",
      retriable: true,
    };
    expect(transition(ctx, state, { type: "RETRY" })).toEqual({
      state: { phase: "STEP", step: "STARTING", status: "RUNNING" },
      effects: [{ kind: "stopServer" }, { kind: "startServer", model: "small" }],
    });
  });

  it("is a no-op outside of an ERROR state", () => {
    const running: MachineState = { phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" };
    expect(transition(ctx, running, { type: "RETRY" })).toEqual({ state: running, effects: [] });
    const healthy: MachineState = { phase: "HEALTHY" };
    expect(transition(ctx, healthy, { type: "RETRY" })).toEqual({ state: healthy, effects: [] });
  });
});

describe("transition — HEALTH_POLL_RESULT / POLLING_HEALTH attempt cap", () => {
  it("healthy:true -> HEALTHY", () => {
    const state: MachineState = { phase: "STEP", step: "POLLING_HEALTH", status: "POLLING", attempts: 5 };
    expect(transition(ctx, state, { type: "HEALTH_POLL_RESULT", healthy: true })).toEqual({
      state: { phase: "HEALTHY" },
      effects: [],
    });
  });

  it("healthy:false under the cap increments attempts and re-probes", () => {
    const state: MachineState = { phase: "STEP", step: "POLLING_HEALTH", status: "POLLING", attempts: 1 };
    expect(transition(ctx, state, { type: "HEALTH_POLL_RESULT", healthy: false })).toEqual({
      state: { phase: "STEP", step: "POLLING_HEALTH", status: "POLLING", attempts: 2 },
      effects: [{ kind: "probeHealth" }],
    });
  });

  it("driving attempts up to the cap eventually yields a retriable STEP_ERROR, not an unbounded loop", () => {
    let state: MachineState = { phase: "STEP", step: "POLLING_HEALTH", status: "POLLING", attempts: 1 };
    for (let i = 1; i < POLLING_HEALTH_ATTEMPT_CAP; i++) {
      const result = transition(ctx, state, { type: "HEALTH_POLL_RESULT", healthy: false });
      expect(result.state).toEqual({ phase: "STEP", step: "POLLING_HEALTH", status: "POLLING", attempts: i + 1 });
      expect(result.effects).toEqual([{ kind: "probeHealth" }]);
      state = result.state;
    }
    // One more failure at the cap gives up.
    const capped = transition(ctx, state, { type: "HEALTH_POLL_RESULT", healthy: false });
    expect(capped.state).toEqual({
      phase: "STEP",
      step: "POLLING_HEALTH",
      status: "ERROR",
      error: expect.stringContaining(String(POLLING_HEALTH_ATTEMPT_CAP)),
      retriable: true,
    });
    expect(capped.effects).toEqual([]);
  });

  it("is a no-op when not currently POLLING", () => {
    const state: MachineState = { phase: "STEP", step: "INSTALL_PYTHON", status: "RUNNING" };
    expect(transition(ctx, state, { type: "HEALTH_POLL_RESULT", healthy: true })).toEqual({ state, effects: [] });
  });
});

describe("transition — CRASH_RESTART / CRASH_TERMINAL", () => {
  it("CRASH_RESTART re-enters STARTING", () => {
    const healthy: MachineState = { phase: "HEALTHY" };
    expect(transition(ctx, healthy, { type: "CRASH_RESTART" })).toEqual({
      state: { phase: "STEP", step: "STARTING", status: "RUNNING" },
      effects: [{ kind: "startServer", model: "small" }],
    });
  });

  it("CRASH_TERMINAL moves to TERMINAL_ERROR with the given reason", () => {
    const healthy: MachineState = { phase: "HEALTHY" };
    expect(transition(ctx, healthy, { type: "CRASH_TERMINAL", reason: "gave up after 3 restarts" })).toEqual({
      state: { phase: "TERMINAL_ERROR", reason: "gave up after 3 restarts" },
      effects: [],
    });
  });
});

describe("decideRestart — crash-restart window arithmetic (fake clock)", () => {
  it("starts empty and allows a restart, recording the attempt", () => {
    expect(decideRestart(initialRestartState(), 0)).toEqual({ action: "restart", state: { attempts: [0] } });
  });

  it(`allows up to ${MAX_RESTARTS_PER_WINDOW} restarts within one ${RESTART_WINDOW_MS}ms window`, () => {
    let state = initialRestartState();
    const timestamps = [0, 10_000, 20_000];
    for (const t of timestamps) {
      const decision = decideRestart(state, t);
      expect(decision.action).toBe("restart");
      state = decision.state;
    }
    expect(state.attempts).toEqual(timestamps);
  });

  it(`the ${MAX_RESTARTS_PER_WINDOW + 1}th attempt inside the same window is TERMINAL_ERROR`, () => {
    const state = { attempts: [0, 10_000, 20_000] };
    const decision = decideRestart(state, 30_000);
    expect(decision.action).toBe("terminal");
    // The (unusable) 4th attempt itself is not recorded — only what was
    // still within the window survives into the returned state.
    expect(decision.state.attempts).toEqual([0, 10_000, 20_000]);
  });

  it("the window slides: once old attempts age out, a restart is allowed again", () => {
    const state = { attempts: [0, 10_000, 20_000] };
    // 61s later: t=0 is 61000ms old (>= 60000, aged out); 10_000/20_000
    // are still within the last 60s.
    const decision = decideRestart(state, 61_000);
    expect(decision).toEqual({ action: "restart", state: { attempts: [10_000, 20_000, 61_000] } });
  });

  it("a restart exactly RESTART_WINDOW_MS after the previous one counts as aged out (boundary is exclusive)", () => {
    const state = { attempts: [0] };
    const decision = decideRestart(state, RESTART_WINDOW_MS);
    expect(decision).toEqual({ action: "restart", state: { attempts: [RESTART_WINDOW_MS] } });
  });
});
