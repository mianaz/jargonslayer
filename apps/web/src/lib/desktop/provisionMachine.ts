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

// S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
// Provision) — "INSTALL_MLX" joins the step vocabulary as a real
// ProvisionStep identity (type/label completeness + a future S12b
// wizard-path entry point), DELIBERATELY left OUT of STEP_ORDER below
// and out of stepEffect's/startStep's auto-advance support (see
// startStep's own INSTALL_MLX guard further down for the full
// rationale) — bootstrap.ts's ensureMlxExtras drives the real
// venv-create/pip-install/preflight sequence directly, a bootstrap-only
// detour (same posture as switchModel()/installDiarization(), neither
// of which runs through this file's transition()/effects either),
// chosen specifically because that caller needs live, per-substep
// progress (§Task 7's three task-row stages) a single opaque Effect
// would hide.
export type ProvisionStep =
  | "INSTALL_PYTHON"
  | "CREATE_VENV"
  | "INSTALL_DEPS"
  | "DOWNLOAD_MODEL"
  | "STARTING"
  | "POLLING_HEALTH"
  | "INSTALL_MLX";

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
const DEPS_TAG = "faster-whisper==1.2.1,websockets==13.1,numpy==2.5.1,huggingface-hub==1.23.0";

function buildMarker(ctx: ProvisionContext): Omit<ProvisionMarker, "ts"> {
  return { schema: MARKER_SCHEMA_VERSION, model: ctx.model, py: PINNED_PYTHON_MINOR, deps: DEPS_TAG };
}

// Mirrors apps/desktop/src-tauri/src/server.rs's own ALLOWED_MODELS —
// bump both together if the accepted Whisper model set ever changes. A
// marker whose model isn't one of these is corrupted/foreign (never a
// value THIS app could have written) — parseMarker below rejects it
// the same as a missing/empty model, landing on a fresh provision
// rather than riding a bogus model string into startStep/start_server.
// A cheap shape guard ONLY — NOT the deliberately-avoided pin
// comparison against ctx.model (see handleCheckResult below: a
// marker's OWN model is meant to win over ctx's fixed default).
// Exported (S4 chunk 3) so bootstrap.ts's ctx-seed clamp and the
// MODEL_CATALOG invariant test (lib/desktop/modelCatalog.ts) validate
// against this EXACT list rather than a hand-duplicated copy that could
// silently drift — this module's own use above is otherwise unchanged.
export const ALLOWED_MARKER_MODELS: readonly string[] = [
  "tiny",
  "base",
  "small",
  "medium",
  "large-v3",
  "large-v3-turbo",
  // S12a (v0.4.4, §C L1/Task 6) — parakeet joins the marker allowlist
  // now that this file owns its own quarantine handling (see
  // handleCheckResult's mlx-usability branch below); modelCatalog.
  // test.ts's own catalog⊆allowlist invariant carve-out is removed in
  // lockstep (§C L1's prelude comment addressed to this worker).
  "parakeet-tdt-0.6b-v3",
];

/** S12a (v0.4.4, §C R1/Provision) — the subset of ALLOWED_MARKER_MODELS
 *  that needs the separate, hash-locked MLX venv (uvCommands.ts's
 *  DesktopPaths mlx fields) rather than the shared base whisper venv —
 *  bootstrap.ts's performSwitchModel/ensureMlxExtras and
 *  handleCheckResult's own quarantine branch below both gate on this
 *  ONE list rather than a hand-duplicated `model.startsWith("parakeet")`
 *  check or a second copy of modelCatalog.ts's `mlxOnly` flag (worker
 *  A3's file, off this worker's touch list, and catalog membership is a
 *  UI-offering concern — `available:false` — orthogonal to "does this
 *  marker id need the mlx venv"). A second, deliberately SEPARATE list
 *  from ALLOWED_MARKER_MODELS above (every mlx-only model is ALSO a
 *  member of that one, but not vice versa) — kept here, not
 *  modelCatalog.ts, so it stays a plain provisioning-machinery fact
 *  bootstrap.ts can import without pulling in catalog UI copy. */
export const MLX_ONLY_MARKER_MODELS: readonly string[] = ["parakeet-tdt-0.6b-v3"];

/** S12a (v0.4.4, §C Provision, F14) — handleCheckResult's own quarantine
 *  fallback: "select `small`" verbatim, per §C's own wording. A
 *  deliberately independent constant from bootstrap.ts's
 *  DEFAULT_DESKTOP_MODEL (same value, "small", but that constant is
 *  private to bootstrap.ts — this module stays the single source of
 *  truth for a QUARANTINE outcome specifically). Never
 *  ALLOWED_MARKER_MODELS[0] or similar derived indexing — an explicit,
 *  named literal is what keeps a future reordering of that list from
 *  silently changing the quarantine fallback too. Exported so
 *  bootstrap.ts's drive() can reseed its OWN separate `ctx` closure
 *  variable the moment it detects the identical quarantine condition
 *  from its own vantage point — transition()'s returned MachineState
 *  is, BY DESIGN, indistinguishable from an ordinary first-time fresh
 *  install (see handleCheckResult's own quarantine doc comment above),
 *  so bootstrap.ts's `ctx.model` needs its own explicit reseed or a
 *  later no-arg beginProvision() (which defaults to ctx.model) would
 *  silently re-drive the SAME quarantined model straight back through
 *  the ordinary whisper pipeline. */
export const QUARANTINE_FALLBACK_MODEL = "small";

/** S12a fix round (§D F2, HIGH — lead-adjudicated matrix, implemented
 *  exactly) — replaces the old boolean `mlxUsable` with the FULL
 *  4-state result provisionRunner.ts's probeMlxUsable resolves:
 *  - `usable`: mlx_capabilities resolved supported AND
 *    mlx_import_preflight resolved ok:true — proceed normally.
 *  - `unsupported`: mlx_capabilities RESOLVED mlxSupported:false — a
 *    DEFINITIVE hardware/OS verdict. handleCheckResult below durably
 *    quarantines exactly as before this fix round (bootstrap.ts's own
 *    drive() persists QUARANTINE_FALLBACK_MODEL); a stale marker
 *    divergence from that point on is INERT — Rust's own start_server
 *    belt (server.rs's check_mlx_capable_if_parakeet) re-checks
 *    mlx_capabilities and refuses to spawn parakeet on a machine this
 *    already knows can't run it, so even a later crash-restart reading
 *    the untouched-parakeet marker can never actually launch the wrong
 *    model — see bootstrap.ts's own doc comment on this exact point.
 *  - `invalid-venv`: mlx_capabilities resolved supported, but
 *    mlx_import_preflight RESOLVED ok:false — a DEFINITIVE but
 *    fixable verdict (a broken/missing mlx venv, not a hardware
 *    limit). Routes to the SAME re-choice pause, but WITHOUT any
 *    durable persist (bootstrap.ts's own doc comment) —
 *    settings.whisperModel and the on-disk marker both stay
 *    "parakeet-tdt-0.6b-v3"; only the in-memory ctx/session fall back.
 *    Re-choosing parakeet (via Settings' switchModel, this sprint's
 *    only reachable re-choice path) re-enters ensureMlxExtras, whose
 *    own skip-check (mlx_import_preflight) will again see the same
 *    broken venv and fall through to a REAL install attempt, self-
 *    healing via its own `--clear` retry-on-failure arm — no special
 *    "repair mode" needed, ensureMlxExtras' EXISTING transactional
 *    sequence already IS the repair path.
 *  - `probe-error`: an actual invoke() rejection/spawn failure of
 *    EITHER probe, surviving ONE internal retry (provisionRunner.ts's
 *    own probeMlxCapabilitiesRetried/invokeImportPreflightRetried) —
 *    genuinely unknown, not a resolved answer either way.
 *    handleCheckResult below does NOT quarantine at all: it parks
 *    directly on the EXISTING retriable STEP/ERROR surface (INSTALL_MLX,
 *    §C Provision's own step identity — see startStep's/handleRetry's
 *    own INSTALL_MLX handling) with a message using "无法检测" wording,
 *    deliberately distinct from `unsupported`'s "不支持"/"需要 Apple 芯片"
 *    copy — the wizard's EXISTING STEP/ERROR retry UI (PROVISION_STEP_
 *    LABELS already covers INSTALL_MLX) re-enters CHECKING from
 *    scratch on 重试 (handleRetry's own INSTALL_MLX branch), re-running
 *    BOTH probes (each with their own fresh internal retry-once) —
 *    genuinely "try again", not a blind re-attempt at spawning
 *    parakeet. ZERO writes to marker/preference/ctx for this case —
 *    handleCheckResult never calls startStep with a reseeded ctx.model
 *    here at all, and bootstrap.ts's own mirroring logic only reseeds/
 *    persists for the unsupported/invalid-venv cases above. */
export type MlxUsability =
  | { status: "usable" }
  | { status: "unsupported"; reason: string }
  | { status: "invalid-venv" }
  | { status: "probe-error"; message: string };

/** handleCheckResult's own fallback message for the (should-never-
 *  happen-in-practice) case of an mlx-family marker whose CHECK_RESULT
 *  carries NO `mlxUsability` at all — provisionRunner.ts's runEffects
 *  always populates it for an mlx-family marker (never leaves it
 *  `undefined` the way the old boolean field legitimately could), so
 *  this is defense-in-depth for a malformed/hand-built event only.
 *  Treated identically to a genuine probe-error (the same "无法检测"
 *  wording, zero writes) — the single most conservative response to
 *  "this file has no idea what happened". */
const MLX_USABILITY_MISSING_MESSAGE = "无法检测 Apple 芯片 / MLX 运行环境状态，请重试";

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
  if (!ALLOWED_MARKER_MODELS.includes(model)) return null;
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
  | { kind: "writeMarker"; marker: Omit<ProvisionMarker, "ts"> }
  /** Leading effect on a STARTING/POLLING_HEALTH retry (see handleRetry
   *  below) — mirrors writeMarker's own "bundled leading effect ahead
   *  of the real step effect" shape. */
  | { kind: "stopServer" };

// ---- events (interpreter -> machine) ----

export type MachineEvent =
  /** CHECKING's own result — the interpreter is expected to await BOTH
   *  of CHECKING's two initial effects (probeHealth + readMarker) and
   *  report them together in one event, since the decision genuinely
   *  needs both. */
  | {
      type: "CHECK_RESULT";
      probeHealthy: boolean;
      markerRaw: string | null;
      /** S12a (§C Provision, F14; redesigned §D F2) — ONLY ever
       *  meaningful (and ONLY ever supplied by provisionRunner.ts's
       *  runEffects) when the parsed marker's model is a member of
       *  MLX_ONLY_MARKER_MODELS above — every ordinary whisper-family
       *  marker (the overwhelming common case) leaves this `undefined`,
       *  so every pre-S12a CHECK_RESULT event literal (this file's own
       *  tests included) keeps working unchanged. See MlxUsability's
       *  own doc comment above for the full 4-state contract
       *  handleCheckResult below implements from this field. */
      mlxUsability?: MlxUsability;
    }
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

function stepEffect(ctx: ProvisionContext, step: Exclude<ProvisionStep, "POLLING_HEALTH" | "INSTALL_MLX">): Effect {
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
  if (step === "INSTALL_MLX") {
    // See ProvisionStep's own doc comment above: INSTALL_MLX's own
    // venv-create/pip-install/preflight SEQUENCE has no driven-effect
    // implementation in THIS file — bootstrap.ts's ensureMlxExtras
    // drives that directly. handleCheckResult's own §D F2 probe-error
    // branch DOES construct a real `{step:"INSTALL_MLX", status:
    // "ERROR"}` MachineState directly (a literal object, bypassing
    // startStep entirely) — that's a legitimate, fully-supported use of
    // this step identity; THIS guard only fires if some caller tries
    // to auto-ADVANCE fresh INTO/THROUGH INSTALL_MLX via startStep
    // (e.g. a future STEP_ORDER change that forgot this file's own
    // exclusion) — failing loudly beats silently mis-sequencing a
    // multi-GB install. handleRetry's own INSTALL_MLX branch below
    // deliberately does NOT call startStep(ctx,"INSTALL_MLX") either
    // (it re-enters CHECKING instead) — this throw is provably
    // unreachable via any path this file itself drives today.
    throw new Error("provisionMachine: INSTALL_MLX has no driven-effect implementation (see bootstrap.ts's ensureMlxExtras)");
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
    // S12a (§C Provision, F14 — Sol finding #14, "Persisted-parakeet-
    // marker clamping doesn't work"; redesigned §D F2) — a parakeet-
    // family marker must be capability-checked BEFORE ever reaching
    // STARTING — spawning a parakeet sidecar process this app already
    // knows can't run (wrong hardware, or a broken mlx venv) would only
    // ever health-timeout-loop (POLLING_HEALTH_ATTEMPT_CAP, ~60s)
    // before finally giving up — never the honest, immediate re-choice
    // this amendment demands. See MlxUsability's own doc comment above
    // for the full per-status matrix; this branch implements only the
    // MachineState-shape half of it (identical for BOTH `unsupported`
    // and `invalid-venv` — the durable-persist-vs-not distinction is a
    // bootstrap.ts-level decision, made from its own mirrored read of
    // this SAME event, since a pure reducer has nowhere to persist
    // anything).
    if (MLX_ONLY_MARKER_MODELS.includes(marker.model)) {
      const usability = event.mlxUsability;
      if (!usability || usability.status === "probe-error") {
        // §D F2 case (c): genuinely unknown (a probe error surviving
        // provisionRunner.ts's own internal retry-once, or a malformed
        // event carrying no usability info at all) — ZERO writes to
        // marker/preference/ctx: no startStep, no ctx reseed, nothing.
        // Parks directly on the EXISTING retriable STEP/ERROR surface
        // (INSTALL_MLX) rather than either silently adopting the
        // marker's own model (unproven-safe) or silently quarantining
        // (a false-positive "unsupported" over a merely-flaky probe).
        // handleRetry's own INSTALL_MLX branch re-enters CHECKING from
        // scratch on 重试 — a genuine re-probe, not a blind re-attempt.
        return {
          state: {
            phase: "STEP",
            step: "INSTALL_MLX",
            status: "ERROR",
            error: usability?.status === "probe-error" ? usability.message : MLX_USABILITY_MISSING_MESSAGE,
            retriable: true,
          },
          effects: [],
        };
      }
      if (usability.status === "unsupported" || usability.status === "invalid-venv") {
        // §D F2 cases (a)/(b): BOTH land on the identical fresh-
        // INSTALL_PYTHON-entry shape (ignoring the marker's own model
        // entirely, falling back to QUARANTINE_FALLBACK_MODEL) — the
        // exact same shape a brand-new install produces, which
        // bootstrap.ts's isFreshProvisionEntry already recognizes and
        // pauses on (WIZARD_CONSENT_REQUIRED) rather than silently
        // auto-driving — "route to consent/re-choice" for free, no
        // extra machine state needed for either case. Whether this
        // gets DURABLY persisted (case a) or stays session-only (case
        // b) is decided by bootstrap.ts's own mirrored read of
        // event.mlxUsability — this reducer has no persistence layer
        // to make that call itself.
        return startStep({ ...ctx, model: QUARANTINE_FALLBACK_MODEL }, "INSTALL_PYTHON");
      }
      // usability.status === "usable" — falls through to the ordinary
      // provisioned-dead STARTING path below, same as any other model.
    }
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
  // server.rs's start_server short-circuits to already_running:true
  // whenever ServerState still holds a Child — spawned-but-never-bound
  // or not, since the slot is filled the instant spawn_streamed
  // succeeds, well before whisper_server.py's own load-before-bind
  // finishes. A bare re-entry into POLLING after a POLLING_HEALTH
  // timeout would therefore just re-observe the SAME hung child
  // forever — retrying it means stop-then-restart, re-entering
  // STARTING (not POLLING) with a LEADING stopServer. Applied
  // uniformly to a STARTING retry too (not just POLLING_HEALTH's):
  // stop_server is an idempotent Ok(()) when nothing is held (verified
  // in server.rs — a rejected start_server invoke never leaves a child
  // tracked, so this is provably a no-op there today), and one rule
  // for both post-spawn-attempt steps is simpler than two step-
  // dependent ones.
  if (state.step === "STARTING" || state.step === "POLLING_HEALTH") {
    const started = startStep(ctx, "STARTING");
    return { state: started.state, effects: [{ kind: "stopServer" }, ...started.effects] };
  }
  // S12a fix round (§D F2, case c) — INSTALL_MLX only ever lands in
  // STEP/ERROR via handleCheckResult's own probe-error branch above
  // (a genuinely unknown mlx-usability answer, zero writes committed).
  // "重试" here must mean a REAL re-probe, not a blind re-attempt at
  // spawning parakeet (there's no held child/venv-build to resume —
  // nothing was ever started) — re-entering CHECKING from scratch
  // re-runs BOTH the health probe and the marker+mlx-usability check
  // fresh (each with provisionRunner.ts's own internal retry-once),
  // landing back on INSTALL_MLX/ERROR again if still genuinely
  // unknown, or resolving into the correct usable/quarantine/adopt
  // outcome the instant a real answer comes back. Deliberately does
  // NOT call startStep(ctx,"INSTALL_MLX") (which throws — see that
  // function's own INSTALL_MLX guard) — this is the ONE step whose
  // OWN retry semantics are "start over", not "resume".
  if (state.step === "INSTALL_MLX") {
    return initial();
  }
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
