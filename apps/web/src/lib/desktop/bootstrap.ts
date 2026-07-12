// v0.4 S3 chunk 5 (docs/design-explorations/s3-tauri-uv-blueprint.md,
// §Chunk 5 + §Data flow) — desktop app init: "① setTransport(plugin-
// http fetch) -> ② runs the provision flow: fetch app_paths -> build
// machine initial() -> drive transitions with provisionRunner until
// HEALTHY / NEEDS_PROVISION-wizard-required / TERMINAL_ERROR". The
// THIRD stopping condition ("NEEDS_PROVISION-wizard-required") is a
// STEP/ERROR machine state: the ONLY point besides the two true
// terminals (HEALTHY, TERMINAL_ERROR) where an automatic drive loop can
// meaningfully pause — every other STEP status (RUNNING/POLLING) keeps
// auto-advancing with no user action needed (the blueprint's own Data
// flow section describes the whole uv pipeline as one unattended
// sequence, "uv python install -> uv venv -> uv pip install ->
// prewarm(small) -> marker -> start_server -> /health", not a
// click-through wizard).
//
// `initDesktop()` is idempotent (a module-level cached promise —
// mirrors llmTransport.ts's activeTransport / client.ts's toast-latch
// module-state pattern) and returns almost immediately (as soon as
// app_paths() resolves and the machine is constructed) — it does NOT
// wait for the drive loop to reach a stopping point before resolving.
// Driving happens in the background from the moment the returned
// handle exists, notifying every `state$` subscriber of each
// transition live — this is what lets chunk 6's wizard render "coarse
// per-step rows" as they actually happen, not just a final result.
//
// `bootstrapDesktop` (the testable core, ZERO @tauri-apps imports —
// invoke/listen/tauriFetch/setTransport all arrive as injected
// BootstrapDeps) does the real work; `initDesktop()` is a thin
// IS_DESKTOP-gated wrapper that supplies tauriApi.ts's real
// implementations. Tests exercise bootstrapDesktop directly with fakes
// (no env stubbing needed) for every behavioral case, and initDesktop's
// own caching wrapper separately for idempotency/guard behavior.
//
// LEAD AMENDMENT (chunk 6 kickoff): a fresh NEEDS_PROVISION (no valid
// marker) must NOT auto-drive straight into INSTALL_PYTHON — that would
// silently start downloading ~0.5-1.5GB (Python + model) the moment a
// brand-new install is first opened, with no consent. The drive loop
// below now PAUSES the instant CHECKING resolves into a fresh
// INSTALL_PYTHON/RUNNING entry (the one and only shape that decision
// can produce — see provisionMachine.ts's handleCheckResult; a RETRY
// re-entering the SAME step after an error is a DIFFERENT event
// (RETRY, not CHECK_RESULT) and is deliberately not re-gated, since
// consent was already given the first time), surfacing
// WIZARD_CONSENT_REQUIRED on the handle until an explicit
// beginProvision() call. PROVISIONED_DEAD (marker present+valid, probe
// dead -> STARTING) is untouched: restarting an already-installed
// server needs no consent, so it keeps auto-driving exactly as before.
// The initial CHECKING itself (a localhost-only GET /health + a
// marker file READ, both performed BEFORE this gate) is deliberately
// NOT gated — it makes no external network call, writes nothing, and
// downloads nothing; it is only how this file learns whether
// provisioning is even needed in the first place, so consent isn't
// meaningful to ask for yet.
//
// Chunk 7 additions (same file, same testability contract): a
// server://exit listener wired to provisionMachine.ts's decideRestart
// policy (max 3 restarts / 60s, then TERMINAL_ERROR); a log$
// subscription surface (uv/prewarm stdout/stderr lines, for chunk 6's
// 详细日志 pane); reprovision() (SettingsDialog's managed-mode「重新运行
//安装向导」) and recheckHealth() (the wizard's on-error escape-hatch
// 「我已手动安装 → 重新检测」) — both new handle actions that reach
// outcomes provisionMachine.ts's own event vocabulary can't express
// directly, implemented here as thin, explicitly-scoped detours around
// the machine rather than new machine states (this file may drive the
// machine and splice its own bootstrap-only phases around it, but per
// this task's own touch-list boundary, provisionMachine.ts itself stays
// unmodified). Diag ring-buffer entries (lib/diag/log.ts) for every
// provision-step start/done/error and server start/exit/restart —
// labels only, matching that module's own "never transcript content"
// privacy rule.
//
// S4 chunk 2 addition (docs/design-explorations/s4-model-wizard-
// blueprint.md, decision B): a downloadProgress$ subscription surface +
// currentDownloadProgress() snapshot getter — mirrors log$/notifyLog's
// own shape exactly (a listener Set + a notify function), fed by
// provisionRunner.ts's runnerDeps.onDownloadProgress the same way onLog
// feeds notifyLog below. The snapshot resets to null the instant a
// DOWNLOAD_MODEL step starts OR ends (STEP_OK or STEP_ERROR) — anchored
// on drive()'s own existing per-step diagLog transitions, so a stale
// 100%-from-last-time (or a stale error-time percentage) never survives
// into STARTING/POLLING_HEALTH/HEALTHY or a later, different step.
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";

import { diagLog } from "../diag/log";
import { setTransport, type Transport } from "../llm/llmTransport";
import { probeSidecar, type SidecarProbeResult } from "../stt/sidecarHealth";
// S4 chunk 4 (blueprint decision C): the model-switch flow's own HTTP
// leg reuses upload.ts's httpBaseFromWs (the SAME ws://…:8765 ->
// http://…:8766 derivation every other sidecar-HTTP caller in this
// codebase already uses) and pollJob (the single GET /jobs/{id} fetch)
// — see switchModel()'s own doc comment below for why the LOOP around
// pollJob is a small local one rather than a reused upload.ts export
// (pollJobUntilDone exists there but is module-private, and lib/stt/
// is off this chunk's touch list either way).
import { httpBaseFromWs, pollJob } from "../stt/upload";
import { getInvoke, getListen, getTauriFetch, type InvokeFn, type ListenFn, type TauriFetchFn } from "./tauriApi";
import {
  getAppPaths,
  invokeWriteMarker,
  runEffects,
  stopServer,
  type LogStream,
  type OnLog,
  type PrewarmProgressEvent,
  type StartServerResult,
} from "./provisionRunner";
import { PINNED_PYTHON_MINOR, type DesktopPaths } from "./uvCommands";
import {
  decideRestart,
  initial,
  initialRestartState,
  parseMarker,
  transition,
  ALLOWED_MARKER_MODELS,
  MARKER_SCHEMA_VERSION,
  MAX_RESTARTS_PER_WINDOW,
  POLLING_HEALTH_ATTEMPT_CAP,
  RESTART_WINDOW_MS,
  type MachineState,
  type ProvisionContext,
  type ProvisionMarker,
  type ProvisionStep,
  type RestartState,
} from "./provisionMachine";

/** One uv/prewarm stdout/stderr line, as streamed to log$ subscribers —
 *  mirrors provisionRunner.ts's OnLog callback shape as a plain value
 *  type (chunk 6's wizard 详细日志 pane keeps its own capped buffer of
 *  these). */
export interface DesktopLogLine {
  stream: LogStream;
  line: string;
}

/** One phase update during an in-flight switchModel() call — mirrors
 *  downloadProgress$/currentDownloadProgress's own "listener Set +
 *  snapshot getter" shape exactly (S4 chunk 2's precedent), just for
 *  the NEW :8766 POST /download-model job (S4 chunk 1) instead of
 *  first-run's --download-only/prewarm://progress path — decision B
 *  deliberately keeps the two download transports separate, so their
 *  progress SHAPES stay separate too rather than forcing one to paper
 *  over the other's units (whisper_server.py's JobStatus.progress is
 *  already a 0..1 fraction; PrewarmProgressEvent is raw byte counts).
 *  switchModel's own signature stays the plain `(model) => Promise<void>`
 *  the blueprint specifies — this is how SettingsDialog's 下载并切换
 *  confirm button gets a live readout DURING that awaited call, the
 *  same way the wizard's 下载模型 row gets one from
 *  downloadProgress$ during beginProvision(). */
export interface SwitchModelProgress {
  phase: "downloading" | "restarting";
  /** whisper_server.py JobStatus.progress verbatim (0..1) — only
   *  present while phase is "downloading"; omitted once phase moves to
   *  "restarting" (the job is done, there's no fraction left to show). */
  progress?: number;
}

/** Chinese labels for chunk 6's wizard step rows AND this file's own
 *  diag-log messages — single source of truth so the two can never say
 *  different things about the same step. Lives here (not
 *  provisionMachine.ts, off this task's touch list) despite being
 *  UI-facing copy, same "bootstrap-only detour" rationale as this
 *  file's header comment above. */
export const PROVISION_STEP_LABELS: Record<ProvisionStep, string> = {
  INSTALL_PYTHON: "安装 Python",
  CREATE_VENV: "创建虚拟环境",
  INSTALL_DEPS: "安装依赖",
  DOWNLOAD_MODEL: "下载模型",
  STARTING: "启动本地服务",
  POLLING_HEALTH: "启动本地服务",
};

/** The 5 rows chunk 6's wizard actually shows (blueprint §Chunk 6:
 *  "安装 Python / 创建虚拟环境 / 安装依赖 / 下载模型 / 启动本地服务") —
 *  POLLING_HEALTH folds into the same "启动本地服务" row as STARTING
 *  (wizardRowStep below) rather than getting a confusing 6th row of its
 *  own; from the user's POV waiting for the just-spawned server to
 *  answer /health is still just "starting the local service". */
export const WIZARD_UI_STEPS: ProvisionStep[] = [
  "INSTALL_PYTHON",
  "CREATE_VENV",
  "INSTALL_DEPS",
  "DOWNLOAD_MODEL",
  "STARTING",
];

/** Maps a machine step onto the wizard UI row it belongs to (see
 *  WIZARD_UI_STEPS above) — the identity function for every step except
 *  POLLING_HEALTH, which folds into STARTING's row. */
export function wizardRowStep(step: ProvisionStep): ProvisionStep {
  return step === "POLLING_HEALTH" ? "STARTING" : step;
}

/** small — first-run reliability (blueprint architecture decision 4);
 *  S4's model picker is what makes this caller-chosen. */
const DEFAULT_DESKTOP_MODEL = "small";

/** S4 chunk 4: switchModel()'s own download-job poll loop's spacing —
 *  mirrors upload.ts's own (module-private, unexported) POLL_INTERVAL_MS
 *  convention for polling a sidecar job to done/error; not imported
 *  (lib/stt/ is off this chunk's touch list and the constant isn't
 *  exported anyway) so this is a same-valued local mirror, not a
 *  reuse. No attempt cap, same as upload.ts's own pollJobUntilDone —
 *  a large model's download can legitimately take many minutes, and
 *  imposing an arbitrary cap here would fail a slow-but-healthy
 *  download for no real reason. */
const SWITCH_DOWNLOAD_POLL_INTERVAL_MS = 1500;

/** S4 chunk 4: switchModel()'s own post-restart health-poll spacing —
 *  mirrors provisionRunner.ts's own (module-private, unexported)
 *  HEALTH_POLL_INTERVAL_MS/POLLING_HEALTH cadence exactly (2s spacing,
 *  first attempt never sleeps — see performSwitchModel below), bounded
 *  by the SAME POLLING_HEALTH_ATTEMPT_CAP provisionMachine.ts already
 *  exports (reused directly, not mirrored — an actual shared constant,
 *  unlike the interval itself). */
const SWITCH_HEALTH_POLL_INTERVAL_MS = 2000;

/** Mirrors provisionRunner.ts's own (module-private, unexported)
 *  defaultNow/defaultSleep — this file needs its own copies for
 *  switchModel()'s marker write (invokeWriteMarker's own `now` param)
 *  and its two poll loops, since provisionRunner.ts doesn't export
 *  either. */
const defaultNow = (): string => new Date().toISOString();
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** POST {httpBase}/download-model {model} -> 202 {job_id} (S4 chunk 1's
 *  sidecar endpoint) — httpBaseFromWs(DEFAULT_SETTINGS.whisperUrl) is
 *  the SAME managed-mode derivation runnerDeps.settings/probeSidecar
 *  already use elsewhere in this file (managed mode's whisperUrl is
 *  fixed, blueprint architecture decision 6). Plain global fetch, not
 *  deps.tauriFetch — every other sidecar-HTTP call in this codebase
 *  (uploadRecording/fetchSidecarHealth/pollJob/ingestUrl/probeSidecar)
 *  already talks to localhost this same way; tauriFetch exists only to
 *  back the LLM transport's plugin-http swap (setTransport above), not
 *  as a general fetch replacement. Error-body handling mirrors
 *  upload.ts's ingestUrl (try the JSON body's own `error` field, fall
 *  back to a generic zh message) — not reused directly since it's a
 *  different endpoint/body shape, just the same shape of convention. */
async function postDownloadModel(model: string): Promise<string> {
  const base = httpBaseFromWs(DEFAULT_SETTINGS.whisperUrl);
  const res = await fetch(`${base}/download-model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    let message = `下载模型请求失败（${res.status}）`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  const body = (await res.json()) as { job_id: string };
  return body.job_id;
}

/** The machine's own MachineState, widened with two extra phases this
 *  file alone can produce: IS_DESKTOP=false (an ordinary web build) has
 *  no provisioning to report at all (NOT_DESKTOP); a fresh
 *  NEEDS_PROVISION decision (LEAD AMENDMENT above) pauses BEFORE the
 *  underlying machine's own INSTALL_PYTHON/RUNNING state is ever
 *  revealed, surfacing WIZARD_CONSENT_REQUIRED instead until
 *  beginProvision() is called; Finding 2 — the user's persisted
 *  sidecarMode is "external" — never touches the underlying machine at
 *  ALL (no provisioning is this app's to do), surfacing EXTERNAL_
 *  UNMANAGED once a one-shot health probe comes back down (HEALTHY
 *  covers the up case — a real MachineState phase already, no widening
 *  needed there). */
export type DesktopBootstrapState =
  | MachineState
  | { phase: "NOT_DESKTOP" }
  | { phase: "WIZARD_CONSENT_REQUIRED" }
  | { phase: "EXTERNAL_UNMANAGED" };

/** Minimal subscription surface (blueprint chunk 5: "a tiny listener
 *  set, not a new dependency; NOT zustand — this predates store
 *  hydration") — a single subscribe function (returns its own
 *  unsubscribe), a state snapshot getter, and a retry trigger. Chunk 6/7
 *  extend this shape with exactly what their own UI/wiring needs (see
 *  each method's own doc comment below) — still no new dependency, same
 *  plain-callbacks posture throughout. */
export interface DesktopBootstrapHandle {
  /** Subscribe to every subsequent state transition; returns an
   *  unsubscribe function. Does NOT replay past transitions — call
   *  `currentState()` first for the snapshot as of subscribe time. */
  state$: (listener: (state: DesktopBootstrapState) => void) => () => void;
  currentState: () => DesktopBootstrapState;
  /** Re-enters the current step's SAME effect — a no-op outside a
   *  STEP/ERROR state, mirroring provisionMachine.ts's own RETRY
   *  no-op contract exactly (never throws on a stray/late call). */
  retryStep: () => void;
  /** LEAD AMENDMENT: resumes driving past a WIZARD_CONSENT_REQUIRED
   *  pause — a no-op outside that exact state (never throws on a
   *  stray/late call, same contract as retryStep).
   *  S4 chunk 3 (blueprint decision A + C): `model` is the user's pick
   *  from the wizard's <ModelPicker> — reseeds `ctx.model` (ctx is
   *  reassignable now, see bootstrapDesktop's own `let ctx` below) so
   *  every effect this drive issues from here on (prewarmModel/
   *  startServer, and the marker STEP_OK writes at DOWNLOAD_MODEL ->
   *  STARTING) carries it, and persists it to `settings.whisperModel`
   *  via deps.persistDesktopModel (optional — a no-op when absent,
   *  same posture as every other optional BootstrapDeps callback).
   *  Optional, defaulting to the ALREADY-seeded `ctx.model` (see
   *  bootstrapDesktop's own ctx-seed, fed by deps.getDesktopModel) —
   *  backward compat: every pre-S4 call site/test calling
   *  `beginProvision()` with no argument keeps working unchanged,
   *  simply re-confirming (and re-persisting) whatever model was
   *  already seeded rather than picking a new one. */
  beginProvision: (model?: string) => void;
  /** Subscribe to every uv/prewarm stdout/stderr line as it streams in
   *  (provisionRunner.ts's withUvLog, via this file's own onLog wiring
   *  below) — chunk 6's wizard 详细日志 pane. Does NOT replay past lines
   *  (mirrors state$'s own "call currentState() first" contract) —
   *  callers keep their own capped buffer. */
  log$: (listener: (line: DesktopLogLine) => void) => () => void;
  /** Subscribe to every prewarm download-progress update (S4 chunk 2's
   *  `prewarm://progress` event, via provisionRunner.ts's own
   *  onDownloadProgress wiring below) — chunk 3's wizard progress bar
   *  for the 下载模型 row. Does NOT replay past updates (mirrors log$'s
   *  own "call currentDownloadProgress() first" contract). */
  downloadProgress$: (listener: (progress: PrewarmProgressEvent | null) => void) => () => void;
  /** Snapshot of the LATEST download-progress update, or null outside
   *  an active DOWNLOAD_MODEL step — reset the instant that step starts
   *  OR ends (see drive()'s own per-step diagLog transitions, which
   *  this reset is anchored to), so a stale value never survives into a
   *  later step. */
  currentDownloadProgress: () => PrewarmProgressEvent | null;
  /** app_paths(), resolved once during bootstrap and exposed verbatim —
   *  chunk 6's wizard escape hatch shows these ("the exact app-data
   *  paths") on a STEP/ERROR screen. Immutable for the handle's whole
   *  lifetime (paths never change mid-session). */
  paths: DesktopPaths;
  /** chunk 6's wizard on-error escape hatch 「我已手动安装 → 重新检测」:
   *  a raw health re-probe that bypasses whichever uv step is currently
   *  stuck — jumps straight to HEALTHY if the user's own manual install
   *  now answers /health, otherwise leaves the current STEP/ERROR
   *  exactly as it was (the caller manages its own "checking…" busy
   *  state around the returned promise). A no-op outside STEP/ERROR. */
  recheckHealth: () => Promise<void>;
  /** SettingsDialog's managed-mode 「重新运行安装向导」: stops whatever
   *  server this session may be holding, clears the provision marker
   *  (an invalid-but-non-null write — parseMarker treats it exactly
   *  like "absent", see provisionMachine.ts), then restarts the WHOLE
   *  bootstrap flow from a fresh CHECKING — which, with the marker
   *  gone, lands back on WIZARD_CONSENT_REQUIRED immediately (no app
   *  relaunch needed). Meaningful from every reachable state (not
   *  gated the way retryStep/beginProvision are) — "redo setup" is a
   *  deliberate user action, valid whether currently HEALTHY, mid-
   *  error, or already paused for consent. Rejects (does not swallow)
   *  on a stop_server/write_provision_marker failure — the caller
   *  (a UI button) is expected to catch and toast. */
  reprovision: () => Promise<void>;
  /** SettingsDialog's 转录引擎 desktop-managed block (S4 chunk 4): the
   *  TRUTHFUL installed model, read fresh from the provision marker
   *  (deps.invoke("read_provision_marker") + parseMarker — both
   *  already exist, provisionMachine.ts's own schema authority) rather
   *  than settings.whisperModel, which is only the user's TARGET/
   *  preference (decision C) and can briefly diverge from what's
   *  actually running (e.g. right after a backup restore, before any
   *  switch). null on a missing/corrupt marker or a read failure (fails
   *  open, mirrors provisionRunner.ts's own readMarkerEffect contract)
   *  — the caller (SettingsDialog) renders an em-dash for both "still
   *  loading" and this null case, same posture as sidecarStatus's own
   *  `null = not probed yet` idiom just above it in that file. */
  installedModel: () => Promise<string | null>;
  /** SettingsDialog's 转录引擎 「更换模型」 confirm button (S4 chunk 4,
   *  blueprint decision C's switch flow): POST :8766 /download-model
   *  {model} -> poll its job to done/error -> stop_server -> start_
   *  server(model) -> poll /health -> on success, write the marker
   *  (invokeWriteMarker, reused verbatim from provisionRunner.ts) AND
   *  persist settings.whisperModel TOGETHER (decision C: "this keeps
   *  the two in lock-step"). A thin bootstrap-only detour around the
   *  machine, same posture as reprovision()/recheckHealth() above —
   *  provisionMachine.ts itself gains no new state for this.
   *
   *  Rejects (never silently no-ops) in three cases: `model` isn't
   *  ALLOWED_MARKER_MODELS-valid; current.state.phase isn't HEALTHY
   *  (switching only makes sense from an already-running managed
   *  sidecar — the UI is expected to only ever offer this button then,
   *  same "mode gating lives in SettingsDialog, not the handle" posture
   *  reprovision()'s own sidecarMode-agnostic implementation already
   *  established); or the switch itself fails. On a DOWNLOAD-phase
   *  failure the old server was never touched — current.state stays
   *  exactly HEALTHY, a truthful "nothing changed, try again" outcome.
   *  On a failure from stop_server onward (the old server IS already
   *  gone), current.state instead lands on a real STEP/ERROR
   *  MachineState — the closest existing shape to "a fresh provision
   *  would be stuck here too" — so DesktopWizard.tsx's existing 重试/
   *  EscapeHatch machinery (unmodified by this chunk) can recover the
   *  session-wide loss of local transcription; see this file's own
   *  landOnSwitchFailure for exactly which step. Single-flighted +
   *  generation-guarded like reprovision() (see that field's own latch
   *  doc comment) — a second overlapping call joins the SAME in-flight
   *  attempt rather than double-downloading/double-restarting. */
  switchModel: (model: string) => Promise<void>;
  /** Subscribe to every phase update during an in-flight switchModel()
   *  call — see SwitchModelProgress's own doc comment for why this is
   *  a SEPARATE surface from downloadProgress$ rather than a reused
   *  one. Does NOT replay past updates (mirrors downloadProgress$'s own
   *  "call the snapshot getter first" contract). */
  switchModelProgress$: (listener: (progress: SwitchModelProgress | null) => void) => () => void;
  /** Snapshot of the LATEST switchModel() phase update, or null outside
   *  an active call — reset the instant switchModel() settles (success
   *  or failure), same "both ends" contract as currentDownloadProgress. */
  currentSwitchModelProgress: () => SwitchModelProgress | null;
  /** SettingsDialog's desktop-only 诊断信息 → 「查看本地服务日志」: tails
   *  whisper_server.log via Rust's read_sidecar_log (provision.rs).
   *  Deliberately routed through THIS handle (reusing the SAME
   *  deps.invoke bootstrapWithRealDeps already resolved via ONE
   *  getInvoke() call) rather than having SettingsDialog.tsx call
   *  getInvoke() itself a second, independent time — every direct
   *  caller of tauriApi.ts's exported getInvoke/getListen/getTauriFetch
   *  is its own separate reachability path for the web bundler's tree-
   *  shaking (see initDesktop()'s own header comment below for the
   *  concrete tree-shake-grep failure this sidesteps); funneling every
   *  UI caller through this one already-proven-safe gateway keeps that
   *  guarantee to exactly one call site, this file's own. */
  readSidecarLog: (tailLines: number) => Promise<string>;
}

const NOT_DESKTOP_PATHS: DesktopPaths = {
  appData: "",
  pythonInstallDir: "",
  uvCacheDir: "",
  venvDir: "",
  venvPython: "",
  modelsDir: "",
  scriptPath: "",
  requirementsPath: "",
  logPath: "",
  markerPath: "",
};

const NOT_DESKTOP_HANDLE: DesktopBootstrapHandle = {
  state$: () => () => {},
  currentState: () => ({ phase: "NOT_DESKTOP" }),
  retryStep: () => {},
  beginProvision: () => {},
  log$: () => () => {},
  downloadProgress$: () => () => {},
  currentDownloadProgress: () => null,
  paths: NOT_DESKTOP_PATHS,
  recheckHealth: async () => {},
  reprovision: async () => {},
  installedModel: async () => null,
  switchModel: async () => {},
  switchModelProgress$: () => () => {},
  currentSwitchModelProgress: () => null,
  readSidecarLog: async () => "",
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Finding 4: diagLog's ring buffer (lib/diag/log.ts) is labels/
 *  origins/counts, never raw paths — that module's own hard PRIVACY
 *  RULE — but a provisioning error reaching this file usually
 *  originates as a Rust error string that embeds an absolute path
 *  ("failed to create /Users/<name>/Library/... : permission denied"),
 *  leaking the OS username into a 复制诊断信息 report. Redacts ONLY the
 *  drive-segment + username portion (the REST of the path carries no
 *  PII) for macOS/Linux/Windows home directories. Applied at the
 *  choke point — every string that reaches diagLog's detail/reason in
 *  this file goes through this — NEVER at state construction, so the
 *  wizard UI (DesktopWizard.tsx) keeps showing the raw, unredacted
 *  error on screen: that's local-only and the user may need the real
 *  path to actually use the escape hatch. Exported so
 *  DesktopBootstrap.tsx's own terminalReason diagLog call (the other
 *  choke point, outside this file) routes through the exact same
 *  rule. */
export function redactHomePath(text: string): string {
  return text
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/\/home\/[^/\s]+/g, "~")
    .replace(/C:\\Users\\[^\\\s]+/g, "~");
}

function isAutoAdvancing(state: MachineState): boolean {
  return state.phase === "CHECKING" || (state.phase === "STEP" && state.status !== "ERROR");
}

export interface BootstrapDeps {
  invoke: InvokeFn;
  listen: ListenFn;
  tauriFetch: TauriFetchFn;
  /** Injected rather than imported so bootstrapDesktop stays free of
   *  any module with side-effecting global state beyond what the
   *  caller explicitly hands it — llmTransport.ts's own module-level
   *  `activeTransport` is exactly that kind of state, hence injection
   *  here instead of a bare top-level import + call. */
  setTransport: (transport: Transport) => void;
  /** small by default (see DEFAULT_DESKTOP_MODEL) — overridable for
   *  tests exercising the provisioned-dead-marker path without
   *  fighting the default. */
  model?: string;
  onLog?: OnLog;
  probeSidecarFn?: (settings: Settings) => Promise<SidecarProbeResult>;
  now?: () => string;
  /** chunk 7 crash-restart policy clock — explicit nowMs, never
   *  Date.now() internally except as this default, mirroring
   *  provisionMachine.ts's own decideRestart "explicit nowMs" contract
   *  (and this file's pre-existing `now` above, for the marker's `ts`).
   *  Overridable for restart-window tests. */
  restartClock?: () => number;
  /** Finding 2: the user's persisted sidecarMode ("managed"|"external",
   *  packages/core/src/types.ts) — awaited right after getAppPaths,
   *  before any provisioning decision is made. Absent (every existing
   *  test, and any caller that hasn't wired it) defaults to "managed",
   *  today's only behavior — see bootstrapWithRealDeps below for the
   *  one real implementation. */
  getSidecarMode?: () => Promise<"managed" | "external">;
  /** S4 chunk 3 (blueprint decision C): hydration-gated read of the
   *  user's persisted `settings.whisperModel` preference — mirrors
   *  getSidecarMode's own "await BEFORE any provisioning decision"
   *  contract exactly, just for the model instead of the sidecar mode.
   *  Only ever MATTERS for a fresh provision in effect (a provisioned-
   *  dead restart's `startStep({...ctx, model: marker.model},
   *  "STARTING")` in provisionMachine.ts always overrides ctx.model
   *  with the marker's own, unconditionally) — clamped against
   *  provisionMachine.ts's ALLOWED_MARKER_MODELS, falling back to
   *  DEFAULT_DESKTOP_MODEL on anything else (decision C's clamp: a
   *  corrupted/foreign persisted value — e.g. a restored backup written
   *  by a future build with a wider model set — must never reach
   *  prewarmModel/startServer as a raw string). Absent (every pre-S4
   *  test, and any caller that hasn't wired it) leaves ctx.model at
   *  DEFAULT_DESKTOP_MODEL exactly as before this chunk — see
   *  bootstrapWithRealDeps below for the one real implementation. */
  getDesktopModel?: () => Promise<string>;
  /** S4 chunk 3 (blueprint decision C's wiring bullet): persists a
   *  beginProvision(model) pick to `settings.whisperModel` — "ride the
   *  store's normal persistence" means going through the exact same
   *  `updateSettings` action every other settings write in this app
   *  uses (store.ts), not a bespoke bypass. Same dynamic-import-of-
   *  store.ts + hydration-gate shape as getSidecarMode/getDesktopModel
   *  above (keeps store.ts's own sizeable transitive graph out of every
   *  test that doesn't explicitly wire this) — and the gate isn't just
   *  belt-and-suspenders here: store.ts's own hydrate() does a raw
   *  `set({settings, ...})` overwrite (not a merge), so a write that
   *  landed BEFORE hydrate() resolved would be silently clobbered the
   *  instant it does. Optional — a no-op when absent (every pre-S4
   *  test) — fire-and-forget from beginProvision, matching store.ts's
   *  own updateSettings -> storage.saveSettings posture (already
   *  un-awaited there). */
  persistDesktopModel?: (model: string) => Promise<void>;
  /** S4 chunk 4: paces switchModel()'s own download-job/health-poll
   *  loops (SWITCH_DOWNLOAD_POLL_INTERVAL_MS / SWITCH_HEALTH_POLL_
   *  INTERVAL_MS below) — same "real setTimeout-backed default,
   *  swappable for hermetic instant unit tests" contract as
   *  provisionRunner.ts's own RunnerDeps.sleep (that file's own doc
   *  comment on POLLING_HEALTH's pacing). Deliberately NOT threaded
   *  into runnerDeps.sleep below — runnerDeps already drives the
   *  UNRELATED first-run provisioning loop via runEffects, and this
   *  chunk's own touch-list stays surgical by leaving that existing,
   *  already-tested wiring untouched rather than growing its blast
   *  radius to cover a second, independent caller. */
  sleep?: (ms: number) => Promise<void>;
}

/** The testable core — see this file's header comment. Resolves once
 *  app_paths() has been fetched and the machine's initial CHECKING
 *  state exists; the provisioning drive loop itself then runs in the
 *  background, notifying `state$` subscribers of every transition. */
export async function bootstrapDesktop(deps: BootstrapDeps): Promise<DesktopBootstrapHandle> {
  // ① MUST precede any invoke/probe call below (order-sensitive — see
  // this file's header comment and the task's own acceptance test).
  deps.setTransport(deps.tauriFetch);

  // ② the provision flow.
  const paths = await getAppPaths(deps.invoke);
  // Finding 2: read BEFORE any provisioning decision — "external"
  // branches away from the managed drive loop entirely, further down.
  const sidecarMode = (await deps.getSidecarMode?.()) ?? "managed";
  // S4 chunk 3 (decision C's clamp): the user's persisted whisperModel
  // preference, read the same "await early, before any provisioning
  // decision" way as sidecarMode above — clamped against
  // ALLOWED_MARKER_MODELS (see getDesktopModel's own doc comment) and
  // falling back to DEFAULT_DESKTOP_MODEL otherwise. Computed
  // unconditionally, same as sidecarMode, keeping this file's one
  // "gather everything before deciding" shape — even though it only
  // ever matters for a fresh provision (provisioned-dead always defers
  // to the marker's own model instead, see handleCheckResult).
  const persistedModel = await deps.getDesktopModel?.();
  const seededModel =
    persistedModel !== undefined && ALLOWED_MARKER_MODELS.includes(persistedModel)
      ? persistedModel
      : DEFAULT_DESKTOP_MODEL;
  // ctx becomes reassignable (S4 chunk 3): beginProvision(model) below
  // re-seeds it with the wizard's own <ModelPicker> pick, the same
  // "explicitly rebuild the pinned config" shape every other piece of
  // mutable state in this closure already uses (current/awaitingConsent/
  // etc. below) rather than a param object mutated in place.
  let ctx: ProvisionContext = { paths, model: deps.model ?? seededModel };

  const logListeners = new Set<(line: DesktopLogLine) => void>();
  function notifyLog(stream: LogStream, line: string): void {
    for (const listener of logListeners) listener({ stream, line });
  }

  // S4 chunk 2 — mirrors logListeners/notifyLog exactly (a listener Set
  // + a notify function over a single held snapshot); see
  // DesktopBootstrapHandle.downloadProgress$/currentDownloadProgress's
  // own doc comments and drive()'s reset-on-step-start/end below.
  let downloadProgress: PrewarmProgressEvent | null = null;
  const downloadProgressListeners = new Set<(progress: PrewarmProgressEvent | null) => void>();
  function notifyDownloadProgress(): void {
    for (const listener of downloadProgressListeners) listener(downloadProgress);
  }
  /** Used by drive() below at the two DOWNLOAD_MODEL boundaries (step
   *  start, step end) — see this file's header comment on why both
   *  ends reset, not just one. */
  function resetDownloadProgress(): void {
    downloadProgress = null;
    notifyDownloadProgress();
  }

  // S4 chunk 4 — mirrors downloadProgress/notifyDownloadProgress just
  // above exactly (same listener-Set-+-snapshot shape), for
  // switchModel()'s own :8766 /download-model job instead of first-run's
  // --download-only/prewarm://progress path; see SwitchModelProgress's
  // own doc comment on why the two stay separate surfaces.
  let switchModelProgress: SwitchModelProgress | null = null;
  const switchModelProgressListeners = new Set<(progress: SwitchModelProgress | null) => void>();
  function notifySwitchModelProgress(progress: SwitchModelProgress | null): void {
    switchModelProgress = progress;
    for (const listener of switchModelProgressListeners) listener(switchModelProgress);
  }

  const runnerDeps = {
    invoke: deps.invoke,
    listen: deps.listen,
    // Managed mode's whisperUrl is fixed (blueprint architecture
    // decision 6), and DEFAULT_SETTINGS.whisperUrl ("ws://
    // localhost:8765") already matches start_server's own fixed --host
    // 127.0.0.1 --port 8765 (server.rs) — no override needed today. A
    // future sidecarMode-aware caller can thread a real Settings
    // through once chunk 6 adds that toggle.
    settings: DEFAULT_SETTINGS,
    // Wraps deps.onLog (kept for tests that inject their own) so every
    // uv://log line ALSO reaches log$ subscribers — chunk 7 addition,
    // see DesktopBootstrapHandle.log$'s own doc comment.
    onLog: (stream: LogStream, line: string) => {
      deps.onLog?.(stream, line);
      notifyLog(stream, line);
    },
    // S4 chunk 2: every prewarm://progress update (only ever emitted
    // while a DOWNLOAD_MODEL step's prewarmModel effect is in flight —
    // see provisionRunner.ts's withDownloadProgress) updates the held
    // snapshot and fans it out to downloadProgress$ subscribers, same
    // "wrap the callback, notify a listener Set" shape as onLog above.
    onDownloadProgress: (progress: PrewarmProgressEvent) => {
      downloadProgress = progress;
      notifyDownloadProgress();
    },
    probeSidecarFn: deps.probeSidecarFn,
    now: deps.now,
  };
  const probe = deps.probeSidecarFn ?? probeSidecar;
  const restartClock = deps.restartClock ?? Date.now;

  let current = initial();
  // LEAD AMENDMENT: true from the instant CHECKING resolves into a
  // fresh NEEDS_PROVISION decision until beginProvision() is called —
  // see this file's header comment. `current.state` itself is left
  // completely untouched while paused (still the real
  // INSTALL_PYTHON/RUNNING the machine already decided on); only the
  // EXTERNALLY-visible state (externalState() below) and whether the
  // drive loop keeps looping are affected.
  let awaitingConsent = false;
  // Finding 2b: true once external mode's own one-shot probe comes
  // back down — see externalState() below. Never true at the same
  // time as awaitingConsent (external mode never touches the managed
  // drive loop that flag guards).
  let externalUnmanaged = false;
  let restartState: RestartState = initialRestartState();
  // Finding 3 (drive-loop re-entrancy): two overlapping drives — e.g.
  // reprovision() racing the initial drive, or two interleaved
  // reprovision() clicks — would otherwise both read/write the SAME
  // `current`/`awaitingConsent`/`externalUnmanaged` closure state,
  // each applying transitions against whatever the OTHER most
  // recently wrote, producing interleaved duplicate effects (and
  // eventually concurrent start_server invokes). Bumped by every
  // method that starts a NEW drive (reprovision(), beginProvision(),
  // retryStep(), and external mode's own one-shot probe below) BEFORE
  // calling driveGuarded()/driveExternalGuarded() — drive() (and the
  // external probe) capture the CURRENT value at entry and re-check it
  // after every await, exiting silently the instant it no longer
  // matches (a newer drive already took over). The very FIRST drive,
  // kicked off unconditionally further down, never needs to bump
  // anything — it naturally owns whatever `generation` starts at.
  // switchModel() (S4 chunk 4) also bumps it on entry, mirroring
  // reprovision()'s own leading bump — it never loops through drive()
  // itself so the bump can't supersede ITS OWN progress the way it
  // does for a real drive, but it still invalidates any drive() that
  // happens to be concurrently in flight (e.g. a crash-restart) the
  // same way every other entry point here already does.
  let generation = 0;
  // Finding 3: reprovision()'s own single-flight latch — a second
  // overlapping call awaits the SAME in-flight promise (settling
  // together, including a rejection) rather than double-running
  // stop_server + the marker write. Cleared via `.finally()` once
  // settled either way, mirroring initDesktop()'s own cached-promise
  // idempotency pattern further down this file — EXCEPT that latch
  // clears automatically on settle (not just via an explicit reset
  // call), since a failed reprovision() must still let a LATER, non-
  // overlapping attempt through.
  let reprovisionInFlight: Promise<void> | null = null;
  // S4 chunk 4: switchModel()'s own single-flight latch — same
  // contract as reprovisionInFlight just above (a second overlapping
  // call joins the SAME in-flight attempt; clears on settle either
  // way), kept as its own separate variable since the two actions are
  // unrelated (a reprovision() and a switchModel() should never be
  // coalesced into "the same" in-flight attempt just because both
  // happen to be pending).
  let switchModelInFlight: Promise<void> | null = null;
  const listeners = new Set<(state: DesktopBootstrapState) => void>();

  function externalState(): DesktopBootstrapState {
    if (externalUnmanaged) return { phase: "EXTERNAL_UNMANAGED" };
    return awaitingConsent ? { phase: "WIZARD_CONSENT_REQUIRED" } : current.state;
  }

  function notify(): void {
    const state = externalState();
    for (const listener of listeners) listener(state);
  }

  function isFreshProvisionEntry(state: MachineState): boolean {
    // The ONE shape handleCheckResult's NEEDS_PROVISION branch ever
    // produces (provisionMachine.ts) — see this file's header comment
    // for why gating on the EVENT (CHECK_RESULT, checked by the only
    // caller below) rather than just this shape alone matters: a RETRY
    // re-entering INSTALL_PYTHON after an error must NOT re-pause.
    return state.phase === "STEP" && state.step === "INSTALL_PYTHON" && state.status === "RUNNING";
  }

  async function drive(): Promise<void> {
    // Finding 3 — see `generation`'s own doc comment above.
    const myGeneration = generation;
    while (isAutoAdvancing(current.state)) {
      if (current.state.phase === "STEP" && current.state.status === "RUNNING") {
        diagLog("info", "desktop-provision", `${PROVISION_STEP_LABELS[current.state.step]} 开始`);
        // A fresh entry OR a RETRY re-entry into DOWNLOAD_MODEL both
        // land here (current.state.step is checked fresh every
        // iteration) — reset BEFORE its prewarmModel effect runs, so a
        // retry never starts from a stale progress value left over from
        // the failed attempt.
        if (current.state.step === "DOWNLOAD_MODEL") resetDownloadProgress();
      }
      const event = await runEffects(current.state, current.effects, runnerDeps);
      if (generation !== myGeneration) return; // superseded — apply nothing further.
      current = transition(ctx, current.state, event);
      if (event.type === "STEP_OK") {
        diagLog("info", "desktop-provision", `${PROVISION_STEP_LABELS[event.step]} 完成`);
        if (event.step === "DOWNLOAD_MODEL") resetDownloadProgress();
      } else if (event.type === "STEP_ERROR") {
        diagLog("error", "desktop-provision", `${PROVISION_STEP_LABELS[event.step]} 失败`, redactHomePath(event.error));
        if (event.step === "DOWNLOAD_MODEL") resetDownloadProgress();
      }
      if (event.type === "CHECK_RESULT" && isFreshProvisionEntry(current.state)) {
        awaitingConsent = true;
        notify();
        return;
      }
      notify();
    }
  }

  function driveGuarded(): void {
    drive().catch((error: unknown) => {
      // Every expected failure mode is already turned into a
      // STEP_ERROR event inside runEffects' own try/catch — reaching
      // here means something outside that contract broke (a genuine
      // bug). Surface it as TERMINAL_ERROR rather than an unhandled
      // rejection + a silently-stuck handle.
      current = { state: { phase: "TERMINAL_ERROR", reason: describeError(error) }, effects: [] };
      notify();
    });
  }

  // Finding 2b: external mode's entire "drive" — a ONE-SHOT health
  // probe (no marker read: this app never provisioned an externally-
  // managed sidecar, so there's nothing of its own to adopt), run in
  // the BACKGROUND exactly like driveGuarded()'s managed CHECKING probe
  // above, so bootstrapDesktop's own "resolves almost immediately"
  // contract (this file's header comment) holds for external mode too
  // — sidecarHealth.ts's PROBE_TIMEOUT_MS is 3s, long enough to be
  // worth never blocking app mount on. Captures its own generation
  // (Finding 3) so a reprovision() racing this probe can still
  // supersede it, the same guard drive() uses for the managed loop.
  function driveExternalGuarded(): void {
    const myGeneration = generation;
    probe(runnerDeps.settings)
      .then((result) => {
        if (generation !== myGeneration) return;
        if (result.up) {
          current = { state: { phase: "HEALTHY" }, effects: [] };
        } else {
          externalUnmanaged = true;
        }
        notify();
      })
      .catch((error: unknown) => {
        if (generation !== myGeneration) return;
        // Mirrors driveGuarded()'s own defensive posture — probeSidecar
        // is documented "never throws", so reaching here means
        // something outside that contract broke.
        current = { state: { phase: "TERMINAL_ERROR", reason: describeError(error) }, effects: [] };
        notify();
      });
  }

  // chunk 7 — server://exit crash-restart wiring: only ever meaningful
  // once HEALTHY (provisionMachine.ts's own decideRestart doc: "server
  // ://exit while HEALTHY -> restart") — an exit received in any other
  // phase is left to that phase's OWN existing error handling (e.g.
  // POLLING_HEALTH's attempt cap) rather than double-handled here.
  // Registered once, for the whole session; a registration failure is
  // swallowed (best-effort, same "never hard-fail bootstrap over a
  // single IO step" posture as readMarkerEffect/probeSidecar) rather
  // than rejecting the whole bootstrapDesktop() call over it — worst
  // case, a crashed sidecar this session just won't auto-restart.
  async function handleServerExit(): Promise<void> {
    if (current.state.phase !== "HEALTHY") return;
    diagLog("warn", "desktop-server", "本地服务意外退出");
    const decision = decideRestart(restartState, restartClock());
    restartState = decision.state;
    if (decision.action === "restart") {
      diagLog("info", "desktop-server", "正在自动重启本地服务");
      current = transition(ctx, current.state, { type: "CRASH_RESTART" });
      notify();
      driveGuarded();
    } else {
      diagLog(
        "error",
        "desktop-server",
        `本地服务反复退出，已停止自动重启（${MAX_RESTARTS_PER_WINDOW} 次 / ${RESTART_WINDOW_MS / 1000}s）`,
      );
      current = transition(ctx, current.state, {
        type: "CRASH_TERMINAL",
        reason: `本地服务在 ${RESTART_WINDOW_MS / 1000} 秒内退出了 ${MAX_RESTARTS_PER_WINDOW} 次，已停止自动重启`,
      });
      notify();
    }
  }

  // S4 chunk 4 (blueprint decision C) — the switch flow's own "land on
  // a truthful STEP/ERROR" step, used by performSwitchModel below for
  // every failure from stop_server onward (the old server is already
  // gone by then — see switchModel's own interface doc comment on the
  // two failure buckets). `step` picks whichever of STARTING/POLLING_
  // HEALTH is the closest analog to where a FRESH provision would be
  // stuck at that same moment (STARTING: the stop_server/start_server
  // invoke itself failed, mirroring runStepEffect's own catch for that
  // step; POLLING_HEALTH: start_server succeeded but health never came
  // up, mirroring handleHealthPollResult's own attempt-cap branch) —
  // behaviorally identical either way (handleRetry in
  // provisionMachine.ts treats both steps the same: a leading
  // stopServer + re-enter STARTING), but picking the nearer analog is
  // still the more honest, better-justified choice per this chunk's own
  // "pick the closest existing shape and justify" instruction.
  // retriable:true throughout, matching runStepEffect's own "every
  // failure reachable here is in practice transient" posture.
  function landOnSwitchFailure(step: Extract<ProvisionStep, "STARTING" | "POLLING_HEALTH">, message: string): void {
    diagLog(
      "error",
      "desktop-provision",
      `切换模型失败（旧服务已停止，${PROVISION_STEP_LABELS[step]}未恢复）`,
      redactHomePath(message),
    );
    current = { state: { phase: "STEP", step, status: "ERROR", error: message, retriable: true }, effects: [] };
    notify();
  }

  /** The real work behind the `switchModel` handle action (split out
   *  as its own nested function, mirroring drive()/driveGuarded()'s own
   *  split, so the returned handle method itself stays a thin validate
   *  + single-flight wrapper below). Callable only once switchModel()
   *  has already confirmed `model` is ALLOWED_MARKER_MODELS-valid and
   *  current.state.phase === "HEALTHY" — this function trusts both. */
  async function performSwitchModel(model: string): Promise<void> {
    try {
      // ---- bucket 1: download (old server untouched throughout — a
      // failure here rethrows as-is, current.state is never touched) ----
      notifySwitchModelProgress({ phase: "downloading", progress: 0 });
      const jobId = await postDownloadModel(model);
      const sleep = deps.sleep ?? defaultSleep;
      for (;;) {
        const job = await pollJob(jobId, runnerDeps.settings);
        if (job.status === "error") throw new Error(job.error ?? "模型下载失败");
        notifySwitchModelProgress({ phase: "downloading", progress: job.progress });
        if (job.status === "done") break;
        await sleep(SWITCH_DOWNLOAD_POLL_INTERVAL_MS);
      }

      // ---- bucket 2 begins here: the old server is about to go away ----
      // Reseed ctx BEFORE touching the running server — a later
      // same-session crash-restart (handleServerExit's own CRASH_
      // RESTART above, which reads ctx.model directly, never the
      // marker) must relaunch the NEW model, not silently revert to
      // whatever ctx.model was before this switch.
      ctx = { ...ctx, model };
      notifySwitchModelProgress({ phase: "restarting" });
      diagLog("info", "desktop-provision", `切换模型：停止旧服务，准备启动 ${model}`);
      try {
        await stopServer(deps.invoke);
        await deps.invoke<StartServerResult>("start_server", { model });
      } catch (error) {
        const message = describeError(error);
        landOnSwitchFailure("STARTING", message);
        throw error instanceof Error ? error : new Error(message);
      }

      let healthy = false;
      // Finding 1's own cadence, mirrored: the first attempt never
      // sleeps, every attempt after paces SWITCH_HEALTH_POLL_INTERVAL_MS
      // first — see that constant's own doc comment.
      for (let attempt = 1; attempt <= POLLING_HEALTH_ATTEMPT_CAP; attempt++) {
        if (attempt > 1) await sleep(SWITCH_HEALTH_POLL_INTERVAL_MS);
        healthy = (await probe(runnerDeps.settings)).up;
        if (healthy) break;
      }
      if (!healthy) {
        const message = `切换到 ${model} 后本地服务在 ${POLLING_HEALTH_ATTEMPT_CAP} 次检测内仍未恢复健康`;
        landOnSwitchFailure("POLLING_HEALTH", message);
        throw new Error(message);
      }

      // ---- durably record the switch (marker + settings together,
      // decision C: "this keeps the two in lock-step") ----
      // py/deps are reused verbatim from whatever marker is already on
      // disk (untouched by a model switch — only `model` actually
      // changes) rather than reconstructed from provisionMachine.ts's
      // own buildMarker/DEPS_TAG, which are module-private there and
      // off this chunk's touch list to export; a fallback only matters
      // for the pathological case of reaching HEALTHY with no marker at
      // all (e.g. an adopted external-ish server), and neither field is
      // ever compared — parseMarker only shape-checks them (blueprint
      // risk register #5: "pin comparison still skipped").
      const existingMarker = parseMarker(
        await deps.invoke<string | null>("read_provision_marker").catch(() => null),
      );
      const marker: Omit<ProvisionMarker, "ts"> = {
        schema: MARKER_SCHEMA_VERSION,
        model,
        py: existingMarker?.py ?? PINNED_PYTHON_MINOR,
        deps: existingMarker?.deps ?? "unknown",
      };
      await invokeWriteMarker(runnerDeps, marker, deps.now ?? defaultNow);
      await deps.persistDesktopModel?.(model);
      diagLog("info", "desktop-provision", `已切换到模型 ${model}`);
      notify(); // current.state is still HEALTHY — re-announce per this action's own contract.
    } finally {
      notifySwitchModelProgress(null);
    }
  }

  if (sidecarMode === "external") {
    // Finding 2b: never touches the managed drive loop OR its
    // server://exit crash-restart wiring below — this app neither
    // provisions nor starts/restarts anything it doesn't manage.
    driveExternalGuarded();
  } else {
    try {
      await deps.listen<{ code: number | null }>("server://exit", () => {
        void handleServerExit();
      });
    } catch {
      // best-effort — see this block's own doc comment above.
    }

    driveGuarded();
  }

  return {
    state$(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentState() {
      return externalState();
    },
    retryStep() {
      if (current.state.phase !== "STEP" || current.state.status !== "ERROR") return;
      generation++; // Finding 3 — see that variable's own doc comment above.
      current = transition(ctx, current.state, { type: "RETRY" });
      notify();
      driveGuarded();
    },
    beginProvision(model: string = ctx.model) {
      if (!awaitingConsent) return;
      // S4 chunk 3 — see this method's own doc comment on
      // DesktopBootstrapHandle above: reseeds ctx.model (a no-op value-
      // wise on the backward-compat no-arg path, since `model` already
      // defaulted to ctx.model) and rides the store's normal
      // persistence, fire-and-forget like updateSettings' own
      // storage.saveSettings call.
      ctx = { ...ctx, model };
      void deps.persistDesktopModel?.(model);
      diagLog("info", "desktop-provision", "用户已确认开始安装");
      generation++; // Finding 3 — see that variable's own doc comment above.
      awaitingConsent = false;
      notify();
      driveGuarded();
    },
    log$(listener) {
      logListeners.add(listener);
      return () => logListeners.delete(listener);
    },
    downloadProgress$(listener) {
      downloadProgressListeners.add(listener);
      return () => downloadProgressListeners.delete(listener);
    },
    currentDownloadProgress() {
      return downloadProgress;
    },
    paths,
    async recheckHealth() {
      if (current.state.phase !== "STEP" || current.state.status !== "ERROR") return;
      const erroredState = current.state;
      const result = await probe(runnerDeps.settings);
      // Stale-guard: only apply if the machine is STILL parked on this
      // exact error (a RETRY/another recheckHealth/anything else that
      // moved current.state on in the meantime wins) — current.state is
      // always a freshly-allocated object per transition(), never
      // mutated in place, so reference equality is a valid "has
      // anything changed since I captured this snapshot" check.
      if (current.state !== erroredState) return;
      if (result.up) {
        diagLog("info", "desktop-provision", "手动重新检测：本地服务已就绪，采用现状");
        current = { state: { phase: "HEALTHY" }, effects: [] };
        notify();
      } else {
        diagLog("warn", "desktop-provision", "手动重新检测：仍未连接到本地服务");
      }
    },
    async reprovision() {
      // Finding 3: a second, overlapping call joins the SAME in-flight
      // attempt (see reprovisionInFlight's own doc comment above)
      // instead of double-running stop_server + the marker write.
      if (reprovisionInFlight) return reprovisionInFlight;
      const run = (async () => {
        generation++; // supersedes whatever drive is currently running.
        await stopServer(deps.invoke);
        await deps.invoke<void>("write_provision_marker", { json: "null" });
        diagLog("info", "desktop-provision", "重新运行安装向导");
        restartState = initialRestartState();
        awaitingConsent = false;
        // A stale EXTERNAL_UNMANAGED parking must not survive a reset
        // back into the (managed) drive loop below — externalState()
        // checks this flag FIRST, ahead of current.state, so leaving it
        // true would mask the fresh drive's real progress entirely.
        externalUnmanaged = false;
        current = initial();
        notify();
        driveGuarded();
      })();
      reprovisionInFlight = run.finally(() => {
        reprovisionInFlight = null;
      });
      return reprovisionInFlight;
    },
    async installedModel() {
      try {
        const raw = await deps.invoke<string | null>("read_provision_marker");
        return parseMarker(raw)?.model ?? null;
      } catch {
        // Fail open to null — mirrors provisionRunner.ts's own
        // readMarkerEffect contract (never throws, "no marker" and "a
        // read failure" render identically to this method's caller).
        return null;
      }
    },
    async switchModel(model: string) {
      if (!ALLOWED_MARKER_MODELS.includes(model)) {
        return Promise.reject(new Error(`不支持的模型：${model}`));
      }
      if (current.state.phase !== "HEALTHY") {
        return Promise.reject(new Error("本地服务当前不可用，暂时无法切换模型"));
      }
      // Finding 3-style single-flight — mirrors reprovision()'s own
      // latch immediately above (see switchModelInFlight's own doc
      // comment).
      if (switchModelInFlight) return switchModelInFlight;
      generation++; // supersedes whatever drive is currently running — mirrors reprovision()'s own leading bump.
      const run = performSwitchModel(model);
      switchModelInFlight = run.finally(() => {
        switchModelInFlight = null;
      });
      return switchModelInFlight;
    },
    switchModelProgress$(listener) {
      switchModelProgressListeners.add(listener);
      return () => switchModelProgressListeners.delete(listener);
    },
    currentSwitchModelProgress() {
      return switchModelProgress;
    },
    async readSidecarLog(tailLines: number) {
      return deps.invoke<string>("read_sidecar_log", { tailLines });
    },
  };
}

// ---------------------------------------------------------------
// initDesktop() — the real, IS_DESKTOP-gated, idempotent entry point.
// ---------------------------------------------------------------

let cachedHandlePromise: Promise<DesktopBootstrapHandle> | null = null;

/** Finding 2c: bootstrapWithRealDeps' own BootstrapDeps.getSidecarMode
 *  implementation — the ONE place allowed to reach into the zustand
 *  store (see BootstrapDeps.setTransport's own doc comment on why
 *  bootstrapDesktop itself never imports a module with side-effecting
 *  global state directly; store.ts's useApp singleton is exactly that
 *  kind of state, same as llmTransport.ts's activeTransport). A
 *  dynamic import (not a top-level one) keeps store.ts's own sizeable
 *  transitive graph — IndexedDB-backed history/learnset/autoExport,
 *  theming, the subscription-direct kill-switch — out of
 *  bootstrapDesktop's module graph entirely; every existing
 *  bootstrapDesktop test therefore still imports zero of it, exactly
 *  as before this finding.
 *
 *  Waits on store.ts's `hydrated` flag via subscribe() rather than a
 *  synchronous getState() read — bootstrapDesktop can start (and even
 *  finish) running before page.tsx's own hydrate() call resolves (see
 *  DesktopBootstrapHandle's own "NOT zustand — this predates store
 *  hydration" doc comment above), so a synchronous read here could
 *  still observe DEFAULT_SETTINGS.sidecarMode ("managed") even for a
 *  user who saved "external". Same "gate on hydrated, don't just read
 *  settings" contract SettingsDialog.tsx's own #62 auto-promote effect
 *  already uses for the identical race (settingsSections.ts's
 *  shouldAutoPromoteToAdvanced) — reused here rather than re-derived. */
async function getPersistedSidecarMode(): Promise<"managed" | "external"> {
  const { useApp } = await import("../store");
  if (!useApp.getState().hydrated) {
    await new Promise<void>((resolve) => {
      const unsubscribe = useApp.subscribe((state) => {
        if (state.hydrated) {
          unsubscribe();
          resolve();
        }
      });
    });
  }
  return useApp.getState().settings.sidecarMode;
}

/** S4 chunk 3 — mirrors getPersistedSidecarMode above exactly (same
 *  dynamic-import + hydration-gate shape, same rationale — see that
 *  function's own doc comment), just reading `settings.whisperModel`
 *  instead of `settings.sidecarMode`. The clamp against
 *  ALLOWED_MARKER_MODELS happens in bootstrapDesktop's own ctx-seed
 *  (getDesktopModel's doc comment above), not here — this function is a
 *  plain, honest read of whatever is persisted, valid or not. */
async function getPersistedDesktopModel(): Promise<string> {
  const { useApp } = await import("../store");
  if (!useApp.getState().hydrated) {
    await new Promise<void>((resolve) => {
      const unsubscribe = useApp.subscribe((state) => {
        if (state.hydrated) {
          unsubscribe();
          resolve();
        }
      });
    });
  }
  return useApp.getState().settings.whisperModel;
}

/** S4 chunk 3 — the write counterpart of getPersistedDesktopModel above:
 *  persists beginProvision(model)'s pick via store.ts's `updateSettings`
 *  action (the store's normal setter — same one every other Settings
 *  write in this app already goes through, which itself fires off its
 *  own un-awaited `storage.saveSettings`). Hydration-gated for the same
 *  reason the two read-side functions above are — see
 *  persistDesktopModel's own doc comment on BootstrapDeps. */
async function persistDesktopModelToStore(model: string): Promise<void> {
  const { useApp } = await import("../store");
  if (!useApp.getState().hydrated) {
    await new Promise<void>((resolve) => {
      const unsubscribe = useApp.subscribe((state) => {
        if (state.hydrated) {
          unsubscribe();
          resolve();
        }
      });
    });
  }
  useApp.getState().updateSettings({ whisperModel: model });
}

async function bootstrapWithRealDeps(): Promise<DesktopBootstrapHandle> {
  const [tauriFetch, invoke, listen] = await Promise.all([getTauriFetch(), getInvoke(), getListen()]);
  return bootstrapDesktop({
    invoke,
    listen,
    tauriFetch,
    setTransport,
    getSidecarMode: getPersistedSidecarMode,
    getDesktopModel: getPersistedDesktopModel,
    persistDesktopModel: persistDesktopModelToStore,
  });
}

/** Call once during desktop app init (chunk 6's DesktopBootstrap.tsx).
 *  Idempotent: every call after the first returns the SAME cached
 *  promise/handle, never re-runs setTransport/app_paths/the drive loop
 *  again.
 *
 *  Guards on a DIRECT `process.env.NEXT_PUBLIC_DESKTOP === "1"` literal
 *  here — deliberately NOT the re-exported `IS_DESKTOP` const
 *  (platform/desktop.ts) chunk 5 originally used, and every OTHER
 *  caller in this app still correctly uses (provisionRunner.ts,
 *  DesktopBootstrap.tsx, SettingsDialog.tsx, StatusLine.tsx, page.tsx —
 *  none of THOSE call into tauriApi.ts's exports themselves). Chunk 6
 *  is what first made this function genuinely reachable from
 *  page.tsx's own module graph (nothing did before it), which is what
 *  surfaced a real bug tauriApi.ts's own header comment had already
 *  named as a risk but chunk 5 never actually exercised: an
 *  `IS_DESKTOP ? bootstrapWithRealDeps() : …` ternary left
 *  `bootstrapWithRealDeps` (and therefore its own calls into
 *  getInvoke/getListen/getTauriFetch, and THEIR `import("@tauri-apps/
 *  …")` calls) looking "live" to the web bundle's tree-shaking even in
 *  an ordinary web build — verified via `npm run build` + `grep -rl
 *  "@tauri-apps\|__TAURI" apps/web/.next/` (see this task's own PR
 *  report for the exact before/after). Reading the literal directly, in
 *  THIS module, at THIS call site — the same fix tauriApi.ts's own
 *  functions already apply to their OWN dynamic `import()` guards —
 *  makes `bootstrapWithRealDeps` provably uncalled in a web build, so
 *  it (and everything it alone reaches) tree-shakes out entirely. This
 *  is also why `readSidecarLog` above is a method on THIS handle rather
 *  than a second direct `getInvoke()` call from SettingsDialog.tsx: a
 *  second independent caller of the SAME exported tauriApi.ts function
 *  would be a second, independent reachability path this ONE fix can't
 *  cover — see that field's own doc comment. */
export function initDesktop(): Promise<DesktopBootstrapHandle> {
  if (!cachedHandlePromise) {
    cachedHandlePromise =
      process.env.NEXT_PUBLIC_DESKTOP === "1" ? bootstrapWithRealDeps() : Promise.resolve(NOT_DESKTOP_HANDLE);
  }
  return cachedHandlePromise;
}

/** Test-only reset — clears the cached handle promise. Mirrors
 *  llmTransport.ts's resetTransport / tauriApi.ts's resetTauriApiCache
 *  convention for module-level state that must never leak between
 *  independent `it()` blocks. */
export function resetDesktopBootstrap(): void {
  cachedHandlePromise = null;
}
