// v0.4 S3 chunk 4 (docs/design-explorations/s3-tauri-uv-blueprint.md,
// §Chunk 4) — the pure first-run-wizard state machine:
//
//   CHECKING -> HEALTHY (adopt)
//            -> STARTING (marker present+valid, probe dead — "provisioned-
//               dead", skip provisioning entirely)
//            -> INSTALL_PYTHON -> CREATE_VENV -> INSTALL_DEPS ->
//               DOWNLOAD_MODEL -> STARTING -> POLLING_HEALTH -> HEALTHY
//               (marker absent/invalid — full provision)
//
// Events in, effects out — this module never calls invoke(), never
// touches @tauri-apps/*, never imports IS_DESKTOP (apps/web/src/lib/
// platform/desktop.ts) or any other platform-detection code; it is a
// plain, synchronous, fully-deterministic reducer given the SAME (ctx,
// state, event) triple always returns the SAME (state, effects) pair.
// Chunk 5's runner is the only thing that ever performs the effects this
// returns (invoke("run_uv", ...), invoke("start_server", ...), etc.) and
// feeds the results back in as events — this file has no idea any of
// that machinery exists.
//
// The crash-restart policy (bottom of this file: RestartState/
// decideRestart) is deliberately a SEPARATE small reducer, not woven
// into `transition()` — per the blueprint's own chunk-4 instruction. It
// only decides; CRASH_RESTART/CRASH_TERMINAL below are how a caller
// applies that decision back onto the main MachineState.

import type { DesktopPaths, UvCommand } from "./uvCommands";
import { PINNED_PYTHON_MINOR, pipInstall, pythonInstall, venvCreate } from "./uvCommands";

// ---- steps ----

export type ProvisionStep =
  | "INSTALL_PYTHON"
  | "CREATE_VENV"
  | "INSTALL_DEPS"
  | "DOWNLOAD_MODEL"
  | "STARTING"
  | "POLLING_HEALTH";

const STEP_ORDER: ProvisionStep[] = [
  "INSTALL_PYTHON",
  "CREATE_VENV",
  "INSTALL_DEPS",
  "DOWNLOAD_MODEL",
  "STARTING",
  "POLLING_HEALTH",
];

function nextStep(step: ProvisionStep): ProvisionStep | null {
  const i = STEP_ORDER.indexOf(step);
  return i >= 0 && i + 1 < STEP_ORDER.length ? STEP_ORDER[i + 1] : null;
}

// ---- context (external config threaded through every call — never
// carried inside MachineState itself, so state stays trivially
// serializable/comparable in tests) ----

export interface ProvisionContext {
  paths: DesktopPaths;
  /** The Whisper model this run provisions/starts — S3 always "small"
   *  (blueprint architecture decision 4, first-run reliability); S4 is
   *  the picker that makes this caller-chosen. */
  model: string;
}

// ---- provision marker (.provisioned.json — read/written verbatim by
// S3 chunk 3's Rust side, which treats it as an opaque string; THIS is
// the schema authority) ----

export interface ProvisionMarker {
  schema: number;
  model: string;
  py: string;
  deps: string;
  ts: string;
}

export const MARKER_SCHEMA_VERSION = 1;

// sidecar/requirements-sidecar.txt's own exact-pin set as of S3 chunk 2 —
// bump this string if that file's pins change, so a marker written
// against a stale dependency set is at least visible in diagnostics (not
// consumed by any comparison logic yet — parseMarker below only checks
// shape/types, not this exact value, on purpose: a value MISMATCH here
// doesn't mean the venv is unusable, only that IT MIGHT be worth a fresh
// install someday, which is a UX decision, not a validity one).
const DEPS_TAG = "faster-whisper==1.2.1,websockets==13.1,numpy==2.5.1";

function buildMarker(ctx: ProvisionContext): Omit<ProvisionMarker, "ts"> {
  return { schema: MARKER_SCHEMA_VERSION, model: ctx.model, py: PINNED_PYTHON_MINOR, deps: DEPS_TAG };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bad marker -> NEEDS_PROVISION (treated identically to "no marker at
 *  all" by handleCheckResult below) — malformed JSON, an unrecognized
 *  schema version, or any wrong-typed/missing field all return `null`,
 *  never throw. `raw` is exactly what S3 chunk 3's
 *  `read_provision_marker()` returns (`null` when the file is absent). */
export function parseMarker(raw: string | null): ProvisionMarker | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { schema, model, py, deps, ts } = parsed;
  if (schema !== MARKER_SCHEMA_VERSION) return null;
  if (typeof model !== "string" || model === "") return null;
  if (typeof py !== "string" || typeof deps !== "string" || typeof ts !== "string") return null;
  return { schema, model, py, deps, ts };
}

// ---- effects (machine -> interpreter; the machine only ever RETURNS
// these, never performs them) ----

export type Effect =
  | { kind: "probeHealth" }
  | { kind: "readMarker" }
  | { kind: "runUv"; command: UvCommand }
  | { kind: "prewarmModel"; model: string }
  | { kind: "startServer"; model: string }
  | { kind: "writeMarker"; marker: Omit<ProvisionMarker, "ts"> };

// ---- events (interpreter -> machine) ----

export type MachineEvent =
  /** CHECKING's own result — the interpreter is expected to await BOTH
   *  of CHECKING's two initial effects (probeHealth + readMarker) and
   *  report them together in one event, since the decision genuinely
   *  needs both. */
  | { type: "CHECK_RESULT"; probeHealthy: boolean; markerRaw: string | null }
  | { type: "STEP_OK"; step: ProvisionStep }
  | { type: "STEP_ERROR"; step: ProvisionStep; error: string; retriable: boolean }
  /** Re-enters whichever step is currently parked in STEP/ERROR. */
  | { type: "RETRY" }
  | { type: "HEALTH_POLL_RESULT"; healthy: boolean }
  /** Applies a decideRestart "restart" verdict onto the main machine —
   *  re-enters STARTING. */
  | { type: "CRASH_RESTART" }
  /** Applies a decideRestart "terminal" verdict onto the main machine. */
  | { type: "CRASH_TERMINAL"; reason: string };

// ---- state ----

export type MachineState =
  | { phase: "CHECKING" }
  | { phase: "HEALTHY" }
  | { phase: "STEP"; step: ProvisionStep; status: "RUNNING" }
  | { phase: "STEP"; step: "POLLING_HEALTH"; status: "POLLING"; attempts: number }
  | { phase: "STEP"; step: ProvisionStep; status: "ERROR"; error: string; retriable: boolean }
  | { phase: "TERMINAL_ERROR"; reason: string };

export interface TransitionResult {
  state: MachineState;
  effects: Effect[];
}

/** Attempts before POLLING_HEALTH gives up and becomes a STEP_ERROR
 *  (blueprint: "POLLING_HEALTH with attempt cap -> STEP_ERROR"). The
 *  server itself binds fast once spawned (prewarm already paid the
 *  model-load cost as its own decoupled step) — this cap is generous
 *  headroom for process-startup jitter, not model loading. */
export const POLLING_HEALTH_ATTEMPT_CAP = 30;

export function initial(): TransitionResult {
  return { state: { phase: "CHECKING" }, effects: [{ kind: "probeHealth" }, { kind: "readMarker" }] };
}

function stepEffect(ctx: ProvisionContext, step: Exclude<ProvisionStep, "POLLING_HEALTH">): Effect {
  switch (step) {
    case "INSTALL_PYTHON":
      return { kind: "runUv", command: pythonInstall(ctx.paths) };
    case "CREATE_VENV":
      return { kind: "runUv", command: venvCreate(ctx.paths) };
    case "INSTALL_DEPS":
      return { kind: "runUv", command: pipInstall(ctx.paths) };
    case "DOWNLOAD_MODEL":
      return { kind: "prewarmModel", model: ctx.model };
    case "STARTING":
      return { kind: "startServer", model: ctx.model };
  }
}

/** Enter `step` fresh — used both for normal step-to-step advancement
 *  and for RETRY (re-entering the SAME step). */
function startStep(ctx: ProvisionContext, step: ProvisionStep): TransitionResult {
  if (step === "POLLING_HEALTH") {
    return { state: { phase: "STEP", step, status: "POLLING", attempts: 1 }, effects: [{ kind: "probeHealth" }] };
  }
  return { state: { phase: "STEP", step, status: "RUNNING" }, effects: [stepEffect(ctx, step)] };
}

function handleCheckResult(
  ctx: ProvisionContext,
  state: MachineState,
  event: Extract<MachineEvent, { type: "CHECK_RESULT" }>,
): TransitionResult {
  if (state.phase !== "CHECKING") return { state, effects: [] };

  if (event.probeHealthy) {
    return { state: { phase: "HEALTHY" }, effects: [] };
  }

  const marker = parseMarker(event.markerRaw);
  if (marker) {
    // provisioned-dead: fully set up before, just re-launch with
    // whatever model that earlier successful provision recorded (not
    // necessarily ctx.model — S3 has no picker yet so these always
    // agree today, but a future marker from a picker-equipped build
    // should win over ctx's fixed default).
    return startStep({ ...ctx, model: marker.model }, "STARTING");
  }
  return startStep(ctx, "INSTALL_PYTHON");
}

function handleStepOk(
  ctx: ProvisionContext,
  state: MachineState,
  event: Extract<MachineEvent, { type: "STEP_OK" }>,
): TransitionResult {
  if (state.phase !== "STEP" || state.step !== event.step || state.status !== "RUNNING") {
    return { state, effects: [] };
  }

  const upcoming = nextStep(event.step);
  if (!upcoming) {
    // Nothing currently reports STEP_OK with no successor (POLLING_
    // HEALTH resolves via HEALTH_POLL_RESULT instead) — stay a no-op
    // rather than throw if that ever changes.
    return { state, effects: [] };
  }

  const started = startStep(ctx, upcoming);
  if (event.step === "DOWNLOAD_MODEL") {
    // Full provisioning pipeline just finished — persist the marker
    // before/alongside moving on to STARTING, so a crash between now
    // and a future launch still adopts (or at least skips straight to
    // STARTING) correctly.
    return { state: started.state, effects: [{ kind: "writeMarker", marker: buildMarker(ctx) }, ...started.effects] };
  }
  return started;
}

function handleStepError(
  state: MachineState,
  event: Extract<MachineEvent, { type: "STEP_ERROR" }>,
): TransitionResult {
  if (state.phase !== "STEP" || state.step !== event.step || state.status !== "RUNNING") {
    return { state, effects: [] };
  }
  return {
    state: { phase: "STEP", step: event.step, status: "ERROR", error: event.error, retriable: event.retriable },
    effects: [],
  };
}

function handleRetry(ctx: ProvisionContext, state: MachineState): TransitionResult {
  if (state.phase !== "STEP" || state.status !== "ERROR") return { state, effects: [] };
  return startStep(ctx, state.step);
}

function handleHealthPollResult(
  state: MachineState,
  event: Extract<MachineEvent, { type: "HEALTH_POLL_RESULT" }>,
): TransitionResult {
  if (state.phase !== "STEP" || state.step !== "POLLING_HEALTH" || state.status !== "POLLING") {
    return { state, effects: [] };
  }
  if (event.healthy) {
    return { state: { phase: "HEALTHY" }, effects: [] };
  }
  if (state.attempts >= POLLING_HEALTH_ATTEMPT_CAP) {
    return {
      state: {
        phase: "STEP",
        step: "POLLING_HEALTH",
        status: "ERROR",
        error: `sidecar did not become healthy after ${POLLING_HEALTH_ATTEMPT_CAP} health checks`,
        retriable: true,
      },
      effects: [],
    };
  }
  return {
    state: { phase: "STEP", step: "POLLING_HEALTH", status: "POLLING", attempts: state.attempts + 1 },
    effects: [{ kind: "probeHealth" }],
  };
}

export function transition(ctx: ProvisionContext, state: MachineState, event: MachineEvent): TransitionResult {
  switch (event.type) {
    case "CHECK_RESULT":
      return handleCheckResult(ctx, state, event);
    case "STEP_OK":
      return handleStepOk(ctx, state, event);
    case "STEP_ERROR":
      return handleStepError(state, event);
    case "RETRY":
      return handleRetry(ctx, state);
    case "HEALTH_POLL_RESULT":
      return handleHealthPollResult(state, event);
    case "CRASH_RESTART":
      // Accepted unconditionally (not gated on state.phase === "HEALTHY"
      // here) — the caller is the one that observed server://exit while
      // HEALTHY and ran decideRestart below; re-deriving that
      // precondition here would just be duplicated policy.
      return startStep(ctx, "STARTING");
    case "CRASH_TERMINAL":
      return { state: { phase: "TERMINAL_ERROR", reason: event.reason }, effects: [] };
  }
}

// ---- crash-restart policy: a SEPARATE small reducer (blueprint's own
// wording) — server://exit while HEALTHY -> restart, up to
// MAX_RESTARTS_PER_WINDOW attempts per any rolling RESTART_WINDOW_MS
// window, then give up. This does NOT touch MachineState itself; a
// caller applies its verdict by feeding CRASH_RESTART/CRASH_TERMINAL
// into transition() above. ----

export interface RestartState {
  /** Wall-clock timestamps (ms) of restart attempts already made,
   *  oldest first. */
  attempts: number[];
}

export function initialRestartState(): RestartState {
  return { attempts: [] };
}

export const RESTART_WINDOW_MS = 60_000;
export const MAX_RESTARTS_PER_WINDOW = 3;

export type RestartDecision =
  | { action: "restart"; state: RestartState }
  | { action: "terminal"; state: RestartState };

/** `nowMs` is an explicit parameter (never `Date.now()` internally) so
 *  this stays fake-clock testable, same purity contract as `transition`
 *  above. */
export function decideRestart(state: RestartState, nowMs: number): RestartDecision {
  const withinWindow = state.attempts.filter((t) => nowMs - t < RESTART_WINDOW_MS);
  if (withinWindow.length >= MAX_RESTARTS_PER_WINDOW) {
    return { action: "terminal", state: { attempts: withinWindow } };
  }
  return { action: "restart", state: { attempts: [...withinWindow, nowMs] } };
}
