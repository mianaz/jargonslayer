// v0.4 S3 chunk 5 (docs/design-explorations/s3-tauri-uv-blueprint.md,
// §Chunk 5) — the effect interpreter: turns provisionMachine.ts's
// declarative Effect[] into real invoke()/listen() calls against the
// Rust commands chunk 3 shipped (apps/desktop/src-tauri/src/{paths,uv,
// server,provision}.rs), and folds the results back into the
// MachineEvent shapes transition() expects. invoke/listen arrive as
// plain injected function values (RunnerDeps) — this file has ZERO
// static or dynamic `@tauri-apps/*` imports of its own, so it unit-
// tests with fakes exactly like provisionMachine.ts/uvCommands.ts do
// (chunk 4); tauriApi.ts is the only thing that ever supplies the REAL
// invoke/listen (see bootstrap.ts).
//
// Command <-> effect mapping (arg names verified against each Rust
// `#[tauri::command]` signature — Tauri auto-camelCases a snake_case
// Rust param name for the JS-side arg object):
//   probeHealth  -> reuses stt/sidecarHealth.ts's probeSidecar verbatim
//                   (NOT an invoke() call — the sidecar's own :8766
//                   /health HTTP endpoint, unchanged from the web path)
//   readMarker   -> invoke("read_provision_marker")            -> string | null
//   writeMarker  -> invoke("write_provision_marker", { json }) -> void
//   runUv        -> invoke("run_uv", { args, env })             -> ProcessResult, uv://log-streamed
//   prewarmModel -> invoke("prewarm_model", { model })          -> ProcessResult, uv://log-
//                   AND prewarm://progress-streamed (S4 chunk 2's
//                   --download-only progress line -> {downloaded,total}
//                   events; see withDownloadProgress)
//   startServer  -> invoke("start_server", { model })           -> StartServerResult
//   stopServer   -> invoke("stop_server")                       -> void (Finding 7: the
//                   LEADING effect on a STARTING/POLLING_HEALTH retry
//                   — see provisionMachine.ts's handleRetry)
// stopServer is ALSO exported as its own small helper below (the exact
// same invoke("stop_server")) for callers outside the machine's driven
// flow entirely — bootstrap.ts's reprovision() and settings' "切换到
// 外部 sidecar"/app-quit handling invoke it directly, never via an
// Effect — so it still matches this chunk's Rust-command-name-parity
// mandate either way.

import type { Settings } from "@jargonslayer/core/types";
import { probeSidecar, type SidecarProbeResult } from "../stt/sidecarHealth";
import type { InvokeFn, ListenFn } from "./tauriApi";
import type { DesktopPaths } from "./uvCommands";
import type { Effect, MachineEvent, MachineState, ProvisionMarker, ProvisionStep } from "./provisionMachine";

export type LogStream = "stdout" | "stderr";
export type OnLog = (stream: LogStream, line: string) => void;

/** Mirrors apps/desktop/src-tauri/src/uv.rs's `ProcessResult` (also
 *  reused verbatim by server.rs's prewarm_model). */
export interface ProcessResult {
  code: number | null;
}

/** Mirrors apps/desktop/src-tauri/src/server.rs's `StartServerResult`. */
export interface StartServerResult {
  alreadyRunning: boolean;
}

/** Mirrors apps/desktop/src-tauri/src/uv.rs's `UvLogEvent` payload —
 *  the `uv://log` event both run_uv and prewarm_model emit. */
export interface UvLogEvent {
  stream: LogStream;
  line: string;
}

/** Mirrors apps/desktop/src-tauri/src/server.rs's `PrewarmProgressEvent`
 *  payload — the `prewarm://progress` event prewarm_model emits while
 *  its --download-only child reports download_progress lines (S4 chunk
 *  2, decision B's first-run one-shot path). */
export interface PrewarmProgressEvent {
  downloaded: number;
  total: number;
}

export type OnDownloadProgress = (progress: PrewarmProgressEvent) => void;

export interface RunnerDeps {
  invoke: InvokeFn;
  listen: ListenFn;
  /** Fixed managed-mode probe target (blueprint architecture decision
   *  6: managed mode's whisperUrl is fixed, not user-editable) — the
   *  ONLY field of Settings probeSidecar actually reads. Callers thread
   *  the real Settings.DEFAULT_SETTINGS through today (its whisperUrl
   *  already matches start_server's fixed --host 127.0.0.1 --port
   *  8765 — see bootstrap.ts); a future sidecarMode-aware caller can
   *  pass a different Settings without this file changing. */
  settings: Settings;
  /** uv/prewarm combined stdout+stderr line sink — omitted (a no-op) in
   *  tests that don't care about log output. */
  onLog?: OnLog;
  /** DOWNLOAD_MODEL's own prewarm://progress sink (S4 chunk 2) — omitted
   *  (a no-op) in tests/callers that don't care about download progress,
   *  same posture as onLog above. Only ever fires while a prewarmModel
   *  effect is in flight (see withDownloadProgress) — runUv/startServer
   *  never emit prewarm://progress. */
  onDownloadProgress?: OnDownloadProgress;
  /** Swappable purely for hermetic unit tests (default: the real
   *  probeSidecar import) — NOT a duplicate implementation, still the
   *  exact same probe this file "reuses, does not duplicate". */
  probeSidecarFn?: (settings: Settings) => Promise<SidecarProbeResult>;
  /** Swappable clock for the marker's `ts` field — provisionMachine.ts
   *  deliberately excludes `ts` from its own (pure, deterministic)
   *  writeMarker effect payload; this is the one place that stamps it,
   *  same "explicit nowMs, never Date.now() internally" contract
   *  provisionMachine.ts's own decideRestart already uses. */
  now?: () => string;
  /** Paces POLLING_HEALTH's own repeated probe loop (see runEffects'
   *  POLLING_HEALTH branch) — whisper_server.py loads the model BEFORE
   *  binding (load-before-bind, architecture decision 4), so the bind
   *  can be 10-60s away even once the process itself is up; probing
   *  back-to-back would exhaust POLLING_HEALTH_ATTEMPT_CAP in under a
   *  second against a connection-refused localhost probe (~1ms each).
   *  Defaults to a real setTimeout-backed sleep; swappable for
   *  hermetic, instant unit tests (a recorded fake never actually
   *  waits). */
  sleep?: (ms: number) => Promise<void>;
}

const noopLog: OnLog = () => {};
const noopDownloadProgress: OnDownloadProgress = () => {};
const defaultNow = () => new Date().toISOString();
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 2000ms × POLLING_HEALTH_ATTEMPT_CAP's 30 attempts ≈ a 60s budget for
 *  whisper_server.py's bind (Finding 1) — see runEffects' POLLING_
 *  HEALTH branch: the FIRST attempt (state.attempts === 1) never
 *  sleeps, every attempt after it does. */
const HEALTH_POLL_INTERVAL_MS = 2000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readMarkerEffect(deps: RunnerDeps): Promise<string | null> {
  try {
    return await deps.invoke<string | null>("read_provision_marker");
  } catch (error) {
    // Fail OPEN to "no marker" (same as an absent file) rather than
    // ever hard-failing CHECKING itself — mirrors parseMarker's own
    // "bad marker -> NEEDS_PROVISION, never throws" contract and every
    // other probe in this codebase's "never throws, always resolves"
    // convention (probeSidecar/agentHealth/isRemotelyKilled).
    void describeError(error);
    return null;
  }
}

async function invokeWriteMarker(
  deps: RunnerDeps,
  marker: Omit<ProvisionMarker, "ts">,
  now: () => string,
): Promise<void> {
  const full: ProvisionMarker = { ...marker, ts: now() };
  await deps.invoke<void>("write_provision_marker", { json: JSON.stringify(full) });
}

/** Wraps a run_uv/prewarm_model invoke() with a uv://log subscription
 *  that's active for the FULL duration of the call — listen() is
 *  awaited (subscribed) BEFORE the invoke starts and unlistened only
 *  after it settles, so no early log line is ever missed. */
async function withUvLog<T>(deps: RunnerDeps, onLog: OnLog, run: () => Promise<T>): Promise<T> {
  const unlisten = await deps.listen<UvLogEvent>("uv://log", (event) => {
    onLog(event.payload.stream, event.payload.line);
  });
  try {
    return await run();
  } finally {
    unlisten();
  }
}

/** Wraps a prewarm_model invoke with a prewarm://progress subscription,
 *  active for the FULL duration of the call — same "subscribe before,
 *  unlisten after" contract as withUvLog above. Composed ALONGSIDE
 *  withUvLog (not merged into it) in runStepEffect's prewarmModel case
 *  below, since only that one call shape ever emits prewarm://progress
 *  — runUv/startServer never do. */
async function withDownloadProgress<T>(
  deps: RunnerDeps,
  onDownloadProgress: OnDownloadProgress,
  run: () => Promise<T>,
): Promise<T> {
  const unlisten = await deps.listen<PrewarmProgressEvent>("prewarm://progress", (event) => {
    onDownloadProgress(event.payload);
  });
  try {
    return await run();
  } finally {
    unlisten();
  }
}

function processResultToEvent(step: ProvisionStep, result: ProcessResult): MachineEvent {
  if (result.code === 0) return { type: "STEP_OK", step };
  return {
    type: "STEP_ERROR",
    step,
    error: `exited with code ${result.code === null ? "null (killed or crashed)" : result.code}`,
    retriable: true,
  };
}

/** Runs the ONE step-producing effect (runUv | prewarmModel |
 *  startServer) a STEP/RUNNING transition carries and maps its outcome
 *  to STEP_OK/STEP_ERROR for `step`. All failure modes here — a
 *  rejected invoke() (spawn-level/IPC/allowlist failure) or a resolved
 *  ProcessResult with a non-zero/null exit code — are reported
 *  retriable:true: every command this app ever issues is either
 *  already allow-list-validated by our own correct-by-construction
 *  builders (uvCommands.ts) or a fixed, non-malformed invocation, so in
 *  practice the only failures reachable here are transient (uv/network/
 *  disk) — exactly the class the blueprint's escape-hatch/retry UX is
 *  for. */
async function runStepEffect(
  step: ProvisionStep,
  effect: Extract<Effect, { kind: "runUv" | "prewarmModel" | "startServer" }>,
  deps: RunnerDeps,
  onLog: OnLog,
  onDownloadProgress: OnDownloadProgress,
): Promise<MachineEvent> {
  try {
    switch (effect.kind) {
      case "runUv": {
        const result = await withUvLog(deps, onLog, () =>
          deps.invoke<ProcessResult>("run_uv", { args: effect.command.args, env: effect.command.env }),
        );
        return processResultToEvent(step, result);
      }
      case "prewarmModel": {
        // S4 chunk 2: prewarm_model's own Err(message) — the download_
        // error line server.rs captured (see that command's own doc
        // comment) — surfaces here as an ordinary invoke() rejection,
        // caught by this function's own try/catch below exactly like
        // any other invoke failure; no special-casing needed on this
        // side, it already carries the specific message through
        // verbatim as STEP_ERROR.error.
        const result = await withUvLog(deps, onLog, () =>
          withDownloadProgress(deps, onDownloadProgress, () =>
            deps.invoke<ProcessResult>("prewarm_model", { model: effect.model }),
          ),
        );
        return processResultToEvent(step, result);
      }
      case "startServer": {
        // No uv://log for this one — whisper_server.py's own
        // stdout/stderr go to whisper_server.log (server.rs's
        // start_server), not the uv://log event; StartServerResult
        // carries no exit code to interpret (the server is meant to
        // keep running) — resolving at all IS success.
        await deps.invoke<StartServerResult>("start_server", { model: effect.model });
        return { type: "STEP_OK", step };
      }
    }
  } catch (error) {
    return { type: "STEP_ERROR", step, error: describeError(error), retriable: true };
  }
}

function isStepRunningEffect(
  effect: Effect,
): effect is Extract<Effect, { kind: "runUv" | "prewarmModel" | "startServer" }> {
  return effect.kind === "runUv" || effect.kind === "prewarmModel" || effect.kind === "startServer";
}

/** The interpreter: given the machine's CURRENT state (needed only to
 *  disambiguate what the given effects mean — see below) and the
 *  effects `transition()`/`initial()` just returned, performs them and
 *  resolves the ONE MachineEvent to feed back into `transition()`.
 *  State-aware because the SAME `{kind:"probeHealth"}` effect means two
 *  different things depending on when it's issued: CHECKING pairs it
 *  with readMarker and expects a combined CHECK_RESULT back; POLLING_
 *  HEALTH issues it alone and expects a HEALTH_POLL_RESULT instead —
 *  provisionMachine.ts's own CHECK_RESULT doc comment spells out the
 *  same "await BOTH together" contract this implements. */
export async function runEffects(state: MachineState, effects: Effect[], deps: RunnerDeps): Promise<MachineEvent> {
  const probe = deps.probeSidecarFn ?? probeSidecar;
  const now = deps.now ?? defaultNow;
  const onLog = deps.onLog ?? noopLog;
  const onDownloadProgress = deps.onDownloadProgress ?? noopDownloadProgress;
  const sleep = deps.sleep ?? defaultSleep;

  if (state.phase === "CHECKING") {
    let probeHealthy = false;
    let markerRaw: string | null = null;
    await Promise.all(
      effects.map(async (effect) => {
        if (effect.kind === "probeHealth") {
          probeHealthy = (await probe(deps.settings)).up;
        } else if (effect.kind === "readMarker") {
          markerRaw = await readMarkerEffect(deps);
        }
      }),
    );
    return { type: "CHECK_RESULT", probeHealthy, markerRaw };
  }

  if (state.phase === "STEP" && state.step === "POLLING_HEALTH" && state.status === "POLLING") {
    // Finding 1: state.attempts === 1 is THIS call's first probe (set
    // by startStep/handleRetry) — fire it immediately. Every later
    // attempt (handleHealthPollResult already incremented attempts
    // before re-issuing probeHealth) paces HEALTH_POLL_INTERVAL_MS
    // first, so a connection-refused probe (~1ms) can't blow through
    // all POLLING_HEALTH_ATTEMPT_CAP attempts in under a second.
    if (state.attempts > 1) await sleep(HEALTH_POLL_INTERVAL_MS);
    const healthy = (await probe(deps.settings)).up;
    return { type: "HEALTH_POLL_RESULT", healthy };
  }

  if (state.phase === "STEP" && state.status === "RUNNING") {
    // A STARTING/POLLING_HEALTH retry bundles a leading stopServer
    // ahead of the real (startServer) step effect — see
    // provisionMachine.ts's handleRetry (Finding 7). Perform it first,
    // same "fails the CURRENT step, never silently swallowed" contract
    // as the writeMarker bundle just below.
    const stopServerEffect = effects.find(
      (effect): effect is Extract<Effect, { kind: "stopServer" }> => effect.kind === "stopServer",
    );
    if (stopServerEffect) {
      try {
        await stopServer(deps.invoke);
      } catch (error) {
        return { type: "STEP_ERROR", step: state.step, error: describeError(error), retriable: true };
      }
    }

    // A DOWNLOAD_MODEL -> STARTING transition bundles a leading
    // writeMarker alongside the real (startServer) step effect — see
    // provisionMachine.ts's handleStepOk. Perform it first; if it
    // fails, the pipeline genuinely isn't done (the marker is what lets
    // a future launch adopt/skip-provision), so it fails the CURRENT
    // step (`state.step`, e.g. "STARTING") rather than being silently
    // swallowed.
    const writeMarkerEffect = effects.find(
      (effect): effect is Extract<Effect, { kind: "writeMarker" }> => effect.kind === "writeMarker",
    );
    if (writeMarkerEffect) {
      try {
        await invokeWriteMarker(deps, writeMarkerEffect.marker, now);
      } catch (error) {
        return { type: "STEP_ERROR", step: state.step, error: describeError(error), retriable: true };
      }
    }

    const stepEffect = effects.find(isStepRunningEffect);
    if (!stepEffect) {
      // No step-running effect alongside (shouldn't happen — every
      // STEP/RUNNING transition pairs with exactly one) — treat as a
      // trivial success rather than stalling the machine forever.
      return { type: "STEP_OK", step: state.step };
    }
    return runStepEffect(state.step, stepEffect, deps, onLog, onDownloadProgress);
  }

  throw new Error(
    `runEffects: no interpretation for state ${JSON.stringify(state)} with effects ${JSON.stringify(effects)}`,
  );
}

/** stop_server — not a provisionMachine Effect (see this file's header
 *  comment); exposed directly for callers that need it outside the
 *  machine's own driven flow. */
export async function stopServer(invoke: InvokeFn): Promise<void> {
  await invoke<void>("stop_server");
}

/** app_paths() — also not a provisionMachine Effect (it's the
 *  prerequisite bootstrap.ts resolves BEFORE building the machine's own
 *  ProvisionContext, see the blueprint's Data flow section: "fetch
 *  app_paths -> build machine initial()"); exposed here so its Rust-
 *  command-name/shape (paths.rs's `app_paths()`, no args) lives beside
 *  every other command this file already mirrors. */
export async function getAppPaths(invoke: InvokeFn): Promise<DesktopPaths> {
  return invoke<DesktopPaths>("app_paths");
}
