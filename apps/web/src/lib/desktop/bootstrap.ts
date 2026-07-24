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
// S11 osspeech blueprint (docs/design-explorations/s11-osspeech-
// blueprint.md, §3 Worker D, §A4): a plain top-level import — mirrors
// this file's own probeSidecar/httpBaseFromWs imports above (a stateless
// utility module), NOT the store.ts/llmTransport.ts injected-dependency
// shape, since osspeechCaps.ts carries no mutable "current instance"
// global the way those two do (see BootstrapDeps.setTransport's own doc
// comment on why THAT split exists). Worker C's module — mocked via
// vi.mock in every test that reaches this file (bootstrap.test.ts +
// every DesktopWizard.tsx-importing suite), never stubbed on disk.
import { preinstallOsSpeech } from "./osspeechCaps";
// S12a (v0.4.4, §C Provision) — probeMlxCapabilitiesWith (NOT the
// getInvoke()-owning probeMlxCaps() singleton, which is IS_DESKTOP-
// gated and bypasses this file's own injected `deps.invoke` entirely —
// bootstrapDesktop's whole testable-core contract is "zero
// @tauri-apps/tauriApi coupling of its own", see this file's header
// comment) reused verbatim for ensureMlxExtras' own leading hardware
// gate, fed `deps.invoke` exactly like provisionRunner.ts's own
// probeMlxUsable does — this ALSO warms mlxCaps.ts's shared
// module-level cache as a side effect, so a later UI read of
// getMlxCapsSnapshot() in the SAME session skips a redundant round
// trip.
import { probeMlxCapabilitiesWith } from "./mlxCaps";
import { getInvoke, getListen, getTauriFetch, type InvokeFn, type ListenFn, type TauriFetchFn } from "./tauriApi";
import {
  getAppPaths,
  invokeWriteMarker,
  runEffects,
  stopServer,
  type LogStream,
  type MlxImportPreflightResult,
  type OnLog,
  type PrewarmProgressEvent,
  type ProcessResult,
  type StartServerResult,
  type UvLogEvent,
} from "./provisionRunner";
import {
  PINNED_PYTHON_MINOR,
  pipInstallDiar,
  pipCheckMlx,
  pipInstallMlxLock,
  venvCreate,
  venvCreateMlx,
  type DesktopPaths,
} from "./uvCommands";
import {
  decideRestart,
  initial,
  initialRestartState,
  parseMarker,
  transition,
  ALLOWED_MARKER_MODELS,
  MARKER_SCHEMA_VERSION,
  MAX_RESTARTS_PER_WINDOW,
  MLX_ONLY_MARKER_MODELS,
  POLLING_HEALTH_ATTEMPT_CAP,
  QUARANTINE_FALLBACK_MODEL,
  RESTART_WINDOW_MS,
  type Effect,
  type MachineEvent,
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
 *  downloadProgress$ during beginProvision(). S12a (v0.4.4, §C
 *  Provision/Task 7) — the phase union widens with three mlx-install
 *  sub-phases (`"mlx-venv"|"mlx-pip"|"mlx-preflight"`), emitted by
 *  ensureMlxExtras BEFORE the pre-existing "downloading"/"restarting"
 *  phases whenever performSwitchModel's target is an
 *  MLX_ONLY_MARKER_MODELS member — see ensureMlxExtras' own doc comment
 *  below for why this reuses the ONE existing progress stream rather
 *  than a second, parallel one: jobsBridge.ts's trackSwitchModel reads
 *  the transition INTO "downloading" as the mlx phase's own success
 *  signal (extras validated -> model download starts), so a single
 *  ordered stream tells the whole story with no separate correlation
 *  needed. A plain whisper-family switchModel() call never emits any of
 *  the three mlx phases (ensureMlxExtras is gated on
 *  MLX_ONLY_MARKER_MODELS.includes(model) — see performSwitchModel
 *  below), so that path's own progress sequence stays byte-identical to
 *  before this sprint. */
export interface SwitchModelProgress {
  phase: "mlx-venv" | "mlx-pip" | "mlx-preflight" | "downloading" | "restarting";
  /** whisper_server.py JobStatus.progress verbatim (0..1) — only
   *  present while phase is "downloading"; omitted for every other
   *  phase (the mlx sub-phases are indeterminate, same as
   *  installDiarization's own progress-less shape; "restarting" has no
   *  fraction left once the download job is done). */
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
  // S12a (v0.4.4, §C Provision) — provisionMachine.ts's Record<
  // ProvisionStep,string> completeness forces this entry the moment
  // INSTALL_MLX joins ProvisionStep; unused by THIS sprint's actual
  // drive (ensureMlxExtras below never lands `current.state` on this
  // step — see provisionMachine.ts's own INSTALL_MLX doc comment), kept
  // ready for a future S12b wizard-path integration that DOES drive it
  // through the machine.
  INSTALL_MLX: "安装 MLX 运行环境",
};

/** S12a (v0.4.4, §C Provision/Task 7) — Chinese labels for
 *  SwitchModelProgress's three mlx sub-phases, shared by ensureMlxExtras
 *  (which emits them) and jobsBridge.ts's trackSwitchModel (which reads
 *  them for the "mlx-install" task row's own `stage` text) — single
 *  source of truth, mirrors PROVISION_STEP_LABELS' own rationale just
 *  above. */
export const MLX_INSTALL_STAGE_LABELS: Record<"mlx-venv" | "mlx-pip" | "mlx-preflight", string> = {
  "mlx-venv": "创建虚拟环境",
  "mlx-pip": "安装依赖",
  "mlx-preflight": "检查依赖",
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

/** S4 review pair Finding 1a: the shared sidecar-lifecycle latch's own
 *  rejection message (reprovision()/switchModel() below) — extracted
 *  once so the two call sites can't drift into two different-but-
 *  similar wordings for the same condition. */
const SIDECAR_LIFECYCLE_BUSY_MESSAGE = "另一项本地服务操作正在进行";

/** S5 review pair Finding 2: switchModel()/installDiarization()'s own
 *  rejection when the persisted sidecarMode is "external" — extracted
 *  once, same "two call sites can't drift into two different-but-
 *  similar wordings" rationale as SIDECAR_LIFECYCLE_BUSY_MESSAGE above. */
const EXTERNAL_SIDECAR_MODE_MESSAGE = "当前为外部管理模式，此操作仅适用于内置本地服务";

/** S13 hotfix (v0.4.4 field report: "huge python RAM usage even after
 *  transcription finished" — a 系统识别/osspeech user who never uses the
 *  whisper sidecar for live meetings at all still got it fully loaded,
 *  every launch: an already-provisioned install's STARTING path
 *  (below) restarts the sidecar unconditionally on EVERY launch,
 *  regardless of which STT engine is actually persisted — the S11
 *  "park dormant" gate (`osspeechDormant` below) only covers a FRESH
 *  NEEDS_PROVISION decision, not a provisioned-dead restart).
 *
 *  The three STT engines that actually talk to whisper_server.py over
 *  its ws transport: "whisper" directly (lib/stt/whisperSocket.ts),
 *  plus "tabaudio"/"appaudio" (lib/stt/tabAudio.ts, lib/stt/appAudio.ts
 *  — both reuse the SAME WsTransport, just a different audio-capture
 *  source). Every OTHER engine (osspeech chief among them — the
 *  field-test bug this const exists for; also soniox/webspeech/demo)
 *  never opens a ws connection to the sidecar at all — though an
 *  osspeech user can still legitimately reach the sidecar's OWN :8766
 *  upload-a-recording HTTP job API via ImportHub's "本地 Whisper" file-
 *  import option (offered whenever the health probe answers), which is
 *  exactly why this hotfix does NOT skip start_server for these
 *  engines entirely (that fuller dormancy redesign is deliberately
 *  deferred) — it only defers the model's own (multi-GB, for medium/
 *  large models) RAM footprint until that FIRST actual use, via
 *  whisper_server.py's own opt-in `--lazy-load` flag (see runnerDeps'
 *  own readLazyLoad below). */
const SIDECAR_ENGINES = new Set(["whisper", "tabaudio", "appaudio"]);

/** S12a fix round (§D F6, MEDIUM) — ensureMlxExtras' own combined
 *  pre-Phase-1 disk-space reserve, named honestly (each summand is what
 *  it actually is, not a bare round "5GB") so a future re-tuning has
 *  something real to adjust against:
 *  - the separate mlx venv itself (parakeet-mlx + mlx/numpy/librosa/
 *    huggingface_hub's own on-disk footprint once installed);
 *  - uv's own package cache for that same resolve (shared across venvs,
 *    but a FRESH mlx extras resolve still has to populate it the first
 *    time);
 *  - the parakeet model download that follows immediately after this
 *    phase succeeds (§C R1 F12's own live-verified 2.51GB —
 *    config.json + model.safetensors, exactly);
 *  - headroom for uv's own temp/partial-write overhead during
 *    extraction/linking, so this reserve isn't a razor's-edge minimum.
 *  Totals ≈5.0GB — the blueprint's own "~5GB reserve" figure. */
const MLX_VENV_DISK_RESERVE_BYTES = 1 * 1024 ** 3; // ~1GB: the mlx venv's own installed footprint
const MLX_UV_CACHE_DISK_RESERVE_BYTES = 0.5 * 1024 ** 3; // ~0.5GB: uv's package cache for a fresh mlx resolve
const MLX_MODEL_DISK_RESERVE_BYTES = 2.51 * 1024 ** 3; // 2.51GB: the parakeet model itself (§C R1 F12, live-verified)
const MLX_INSTALL_DISK_HEADROOM_BYTES = 1 * 1024 ** 3; // ~1GB: safety margin (temp files, partial writes)
const MLX_INSTALL_DISK_RESERVE_BYTES =
  MLX_VENV_DISK_RESERVE_BYTES +
  MLX_UV_CACHE_DISK_RESERVE_BYTES +
  MLX_MODEL_DISK_RESERVE_BYTES +
  MLX_INSTALL_DISK_HEADROOM_BYTES;

/** Mirrors provisionRunner.ts's own (module-private, unexported)
 *  defaultNow/defaultSleep — this file needs its own copies for
 *  switchModel()'s marker write (invokeWriteMarker's own `now` param)
 *  and its two poll loops, since provisionRunner.ts doesn't export
 *  either. */
const defaultNow = (): string => new Date().toISOString();
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** S12a (v0.4.4, §C Q6/HF-token) — the `{hfToken}` fragment to spread
 *  into performSwitchModel's own direct start_server invoke() call
 *  below (that call isn't a provisionMachine Effect, so it never goes
 *  through provisionRunner.ts's runEffects/hfTokenArg at all). `{}`
 *  (nothing to spread) when `deps.readHfToken` is absent OR returns an
 *  empty/whitespace-only string, `{hfToken: <trimmed>}` otherwise — an
 *  independently-defined copy of provisionRunner.ts's own identically-
 *  shaped, identically-named helper, same "small dependency-shaped
 *  logic stays a private per-file copy" precedent as defaultNow/
 *  defaultSleep immediately above. */
function hfTokenArg(deps: BootstrapDeps): { hfToken: string } | Record<string, never> {
  const token = deps.readHfToken?.().trim();
  return token ? { hfToken: token } : {};
}

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
 *  different endpoint/body shape, just the same shape of convention.
 *
 *  S12a Q6 INVARIANT (accepted limitation, not a bug): this job runs
 *  INSIDE whichever sidecar process is CURRENTLY listening on :8766 —
 *  the ALREADY-spawned server's own env, set once at ITS OWN
 *  start_server/prewarm_model call. A server started before the user
 *  configured Settings.hfToken therefore will NOT see HF_TOKEN for
 *  THIS download job even if the token is configured moments before
 *  clicking 「下载并切换」— only that server's NEXT restart (this same
 *  switch's own start_server call further down, or any later
 *  prewarm/switch) picks up a just-configured token, since `hfToken` is
 *  read fresh (BootstrapDeps.readHfToken) at THAT call, not at job-post
 *  time. By design: fixing this would mean either re-spawning the
 *  server before every download job (defeats the point of an
 *  already-running sidecar) or threading the token through the running
 *  process at runtime (no such Rust command exists) — out of scope for
 *  this task. */
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

/** v0.4 S5 chunk 2 (installDiarization()): mirrors provisionRunner.ts's
 *  own (module-private, unexported) withUvLog exactly — listen() is
 *  awaited (subscribed) BEFORE the invoke starts and unlistened only
 *  after it settles, so no early uv://log line is ever missed. A local
 *  adaptation rather than a reuse: withUvLog isn't exported, and this
 *  file invokes run_uv directly (installDiarization() bypasses
 *  runEffects/runStepEffect entirely — it isn't a provisionMachine
 *  step), so it needs its own copy of the same contract rather than
 *  widening provisionRunner.ts's touch list for one caller. */
async function withUvLog<T>(deps: BootstrapDeps, onLog: OnLog, run: () => Promise<T>): Promise<T> {
  const unlisten = await deps.listen<UvLogEvent>("uv://log", (event) => {
    onLog(event.payload.stream, event.payload.line);
  });
  try {
    return await run();
  } finally {
    unlisten();
  }
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
 *  needed there).
 *
 *  S11 osspeech blueprint (§A4): OSSPEECH_ACTIVE is the THIRD synthetic
 *  phase this file alone produces — a fresh NEEDS_PROVISION decision
 *  whose persisted `settings.engine` already reads "osspeech" (the
 *  user's own past EngineChoiceScreen pick, or a direct Settings pick)
 *  is dormant BY DESIGN: this phase never auto-drives into installing
 *  the whisper sidecar (see isFreshProvisionEntry's own call site
 *  below), and DesktopBootstrap.tsx's existing `visible` computation
 *  (untouched by this worker — see this worker's own PR report) already
 *  renders nothing for any phase it doesn't explicitly recognize, the
 *  same way it already does for HEALTHY/CHECKING/NOT_DESKTOP — so this
 *  new phase needs no companion edit there. */
export type DesktopBootstrapState =
  | MachineState
  | { phase: "NOT_DESKTOP" }
  | { phase: "WIZARD_CONSENT_REQUIRED" }
  | { phase: "EXTERNAL_UNMANAGED" }
  | { phase: "OSSPEECH_ACTIVE" };

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
   *  (a UI button) is expected to catch and toast. Single-flighted via
   *  a latch SHARED with switchModel() below (S4 review pair Finding
   *  1a — see sidecarLifecycleInFlight's own doc comment): a second
   *  overlapping call, of EITHER method, REJECTS with a zh "another
   *  sidecar-lifecycle operation is already running" message rather
   *  than joining — joining a DIFFERENT operation's promise would
   *  resolve as if the SECOND caller's own action had happened, which
   *  it hadn't. */
  reprovision: () => Promise<void>;
  /** Field-test fix B (verified root cause): the NON-destructive sibling
   *  of reprovision() above — useMeeting.ts's session-start preflight
   *  for a sidecar-only engine (whisper/appaudio) calls this instead of
   *  reprovision() when the sidecar isn't currently HEALTHY, so a
   *  transient probe blip (or a launch that just hasn't finished its
   *  first CHECKING yet) never wipes an already-good install record —
   *  it re-enters the SAME fresh CHECKING flow reprovision() lands on
   *  AFTER its own stop_server + write_provision_marker(null), just
   *  without ever calling either: genuinely unprovisioned -> lands back
   *  on WIZARD_CONSENT_REQUIRED (or the engine re-choice screen, same as
   *  reprovision()); already healthy -> lands right back on HEALTHY,
   *  the wizard shows nothing (DesktopBootstrap.tsx's own `visible`
   *  computation already treats HEALTHY as "nothing to show"). Also
   *  resets the S11 osspeechDormant park + re-arms forceEngineSetupOnce
   *  (mirrors reprovision()'s identical reset): without this, a stale
   *  boot-time persistedEngine of "osspeech" would silently re-park
   *  dormant instead of ever showing the wizard this call exists to
   *  surface. Single-flighted via the SAME shared latch reprovision()/
   *  switchModel() use (S4 review pair Finding 1a) for the SYNCHRONOUS
   *  reset + drive() kickoff only (F4 field-test round 2 correction —
   *  Sol review: this used to claim the latch covers the whole check,
   *  which it doesn't): driveGuarded() never awaits drive() itself, so
   *  the returned promise — and the latch with it — settles on the
   *  next microtask, well before the CHECKING probe it just kicked off
   *  actually resolves. Overlap safety for that ASYNC drive against a
   *  second, later reprovision()/requestProvisionCheck()/switchModel()
   *  call comes from the `generation` counter instead (a superseded
   *  drive silently no-ops on its own next await — see that variable's
   *  own doc comment above), not from this latch still being held. */
  requestProvisionCheck: () => Promise<void>;
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
   *  {model} -> poll its job to done/error -> write the marker
   *  (invokeWriteMarker, reused verbatim from provisionRunner.ts) AND
   *  persist settings.whisperModel TOGETHER (decision C: "this keeps
   *  the two in lock-step") -> stop_server -> start_server(model) ->
   *  poll /health. S4 review pair Finding 3 moved the marker+settings
   *  write to right after the download succeeds, BEFORE stop_server
   *  (it used to happen after health passed) — see performSwitchModel's
   *  own doc comment for why that ordering is what makes the switch
   *  self-healing across a post-stop failure/retry. A thin
   *  bootstrap-only detour around the machine, same posture as
   *  reprovision()/recheckHealth() above — provisionMachine.ts itself
   *  gains no new state for this.
   *
   *  Rejects (never silently no-ops) in five cases: the persisted
   *  sidecarMode is "external" (S5 review pair Finding 2 — checked
   *  FIRST, ahead of every other case below: external mode can reach
   *  HEALTHY too, since that phase there just reflects the EXTERNAL
   *  sidecar's own health probe, nothing this handle provisioned — a
   *  draft-flipped UI, or any future caller, must not be able to reach
   *  stop_server/start_server against whatever's actually listening on
   *  managed mode's fixed ports; this replaces switchModel()'s own
   *  former "mode gating lives in SettingsDialog, not the handle"
   *  posture, which this finding showed was the wrong layer for an
   *  action that mutates/restarts a process rather than just reading
   *  one); `model` isn't ALLOWED_MARKER_MODELS-valid; current.state.
   *  phase isn't HEALTHY (switching only makes sense from an already-
   *  running managed sidecar); a meeting is active right as the
   *  download finishes
   *  (S4 review pair Finding 2 — deps.isMeetingActive, rechecked fresh
   *  since SettingsDialog's own picker-open-time check is stale by the
   *  time a minutes-long download completes; current.state stays
   *  HEALTHY, and the now-cached download lets a later attempt skip
   *  straight through); or the switch itself fails. On a DOWNLOAD-phase
   *  (or meeting-active) failure the old server was never touched —
   *  current.state stays exactly HEALTHY, a truthful "nothing changed,
   *  try again" outcome. On a failure from stop_server onward (the old
   *  server IS already gone), current.state instead lands on a real
   *  STEP/ERROR MachineState — the closest existing shape to "a fresh
   *  provision would be stuck here too" — so DesktopWizard.tsx's
   *  existing 重试/EscapeHatch machinery (unmodified by this chunk) can
   *  recover the session-wide loss of local transcription; see this
   *  file's own landOnSwitchFailure for exactly which step. Single-
   *  flighted via the SAME shared latch reprovision() uses (S4 review
   *  pair Finding 1a — see sidecarLifecycleInFlight's own doc comment):
   *  a second overlapping call, of EITHER method, REJECTS rather than
   *  joins. Also generation-guarded from the inside (Finding 1b):
   *  captures its own generation at entry and rechecks it after every
   *  await, aborting silently if superseded — mirrors drive()'s own
   *  pattern, belt-and-suspenders on top of the shared latch.
   *
   *  S12b fix round (§F FB8, MED) — SAME-TARGET NO-OP: settles with
   *  zero download/stop/start/marker-write when the on-disk marker's
   *  own model ALREADY equals `model` (and, for an mlx-family target,
   *  its own extras are still verified valid — see
   *  isAlreadyInstalledAndValid's own doc comment for exactly what
   *  that reuses). Implemented as performSwitchModel's own FIRST
   *  action (see that function's own doc comment for why it does NOT
   *  live here, ahead of the busy-latch check, the way an earlier
   *  draft of this fix placed it): this method's own pre-latch gates
   *  must stay fully SYNCHRONOUS (Finding 3's own generation/latch
   *  invariant — an `await` inserted before `sidecarLifecycleInFlight`
   *  is set would let a concurrent reprovision()/switchModel() call
   *  race in and wrongly observe the latch as free). The latch is
   *  still acquired for a same-target no-op (a very short hold — one
   *  invoke round trip, maybe two), so a concurrent reprovision()/
   *  switchModel() correctly rejects against it exactly as it would
   *  against any other in-flight switchModel() call; only the
   *  DOWNLOAD/marker/stop/start work is skipped once the no-op check
   *  itself resolves true. */
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
  /** SettingsDialog's 说话人分离 「安装扩展」 button (S5 chunk 2,
   *  docs/design-explorations/s5-diarization-addon-blueprint.md decision
   *  B): installs the optional pyannote/diarization add-on into the
   *  ALREADY-provisioned venv via the exact SAME run_uv pip-install
   *  shape INSTALL_DEPS already uses, just targeting
   *  requirements-diar.txt instead of requirements-sidecar.txt
   *  (uvCommands.ts's pipInstallDiar) — zero Rust change (see that
   *  builder's own doc comment). A thin bootstrap-only detour around the
   *  machine, same posture as reprovision()/switchModel() above —
   *  provisionMachine.ts itself gains no new state for this. Unlike
   *  EITHER of those, this action never touches `current.state` or
   *  `ctx` at all and never redrives: the running server keeps running
   *  throughout (the venv merely gains packages on disk) — decision D's
   *  "no restart needed, the running sidecar picks pyannote up on its
   *  own next /health probe via importlib.invalidate_caches()". So,
   *  deliberately, no `generation++`, no `current = initial()`/machine
   *  reset. It still captures the CURRENT generation on entry purely as
   *  defense-in-depth (mirrors performSwitchModel's own belt-and-
   *  suspenders guard) — a reprovision()/switchModel() that somehow
   *  raced in from elsewhere (the shared latch below already prevents
   *  this in the ordinary case) would still structurally invalidate this
   *  run, aborting it silently rather than reporting success/failure for
   *  a venv that's already been recreated out from under it.
   *
   *  Rejects (never silently no-ops) in three cases: the persisted
   *  sidecarMode is "external" (S5 review pair Finding 2 — checked
   *  FIRST, same rationale as switchModel()'s own identical leading
   *  check just above); `current.state.phase` isn't HEALTHY (installing
   *  only makes sense against an already-running managed sidecar — same
   *  "the caller's own precondition check, not a UI-only gate" posture
   *  reprovision()/switchModel() already established); or the shared
   *  sidecarLifecycleInFlight latch (S4 review pair Finding 1a) is
   *  already held by an in-flight reprovision()/switchModel() call —
   *  an install must never race
   *  reprovision()'s venv recreation (it would either install into a
   *  venv about to be destroyed, or destroy a venv mid-install) or a
   *  model switch's own stop/start of the SAME server process. Held for
   *  this call's own full duration too, so a LATER reprovision()/
   *  switchModel() call correctly rejects against THIS one in turn —
   *  single-flighted via the exact same shared latch, not a separate
   *  one.
   *
   *  Streams every uv://log line for the run to log$ subscribers (this
   *  file's own withUvLog above — see that function's own doc comment
   *  for why it's a local adaptation rather than a direct reuse of
   *  provisionRunner.ts's own withUvLog) — the SAME pane chunk 6's
   *  wizard 详细日志/chunk 3's Settings tail already render, so a slow
   *  ~1.2GB pip install isn't a silent multi-minute hang from the user's
   *  POV. A non-zero/null run_uv exit code rejects with a zh message
   *  naming the exit code. */
  installDiarization: () => Promise<void>;
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
  diarRequirementsPath: "",
  logPath: "",
  markerPath: "",
  mlxVenvDir: "",
  mlxVenvPython: "",
  mlxRequirementsLockPath: "",
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
  requestProvisionCheck: async () => {},
  installedModel: async () => null,
  switchModel: async () => {},
  switchModelProgress$: () => () => {},
  currentSwitchModelProgress: () => null,
  installDiarization: async () => {},
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
  /** S11 osspeech blueprint (§A4): the user's persisted `settings.engine`
   *  string, read the same "await BEFORE any provisioning decision"
   *  way as getSidecarMode/getDesktopModel above — the ONE input the
   *  new ENGINE_CHOICE pre-consent branch needs (see
   *  isFreshProvisionEntry's own call site below). Deliberately typed
   *  as a plain `string`, not `STTEngineKind` (mirrors getDesktopModel's
   *  own "plain string, ALLOWED_MARKER_MODELS clamps it" posture) — the
   *  only comparison this file ever makes against it is `=== "osspeech"`,
   *  which needs no narrower type. Absent (every pre-S11 test, and any
   *  caller that hasn't wired it) never equals "osspeech", so the new
   *  branch is a no-op and every existing behavior is unchanged — see
   *  bootstrapWithRealDeps below for the one real implementation. */
  getDesktopEngine?: () => Promise<string>;
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
  /** S4 review pair Finding 2: performSwitchModel's own pre-stop_server
   *  recheck of meeting activity — SettingsDialog.tsx's own
   *  `meetingActive` is only ever a snapshot taken at 「下载并切换」click
   *  time; the download itself can take minutes, long enough for a
   *  meeting to start mid-download and get its sidecar pulled out from
   *  under it the instant switchModel() reaches stop_server. Injected
   *  rather than imported for the SAME reason getSidecarMode/
   *  getDesktopModel/persistDesktopModel above are — see
   *  BootstrapDeps.setTransport's own doc comment. Deliberately
   *  SYNCHRONOUS (unlike those three, each awaited once up front): this
   *  is called possibly minutes into an already-in-flight switchModel(),
   *  not at bootstrap time — see resolveIsMeetingActive below for the
   *  one real implementation, which resolves the async store-hydration
   *  dance ONCE and hands back a plain sync closure. Absent (every test
   *  that hasn't wired it) means "never active" — switchModel() behaves
   *  exactly as it did before this finding. */
  isMeetingActive?: () => boolean;
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
  /** S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
   *  Q6/§3.5 HF-token) — a LIVE read of the user's configured
   *  Settings.hfToken, threaded into runnerDeps below (provisionRunner.
   *  ts's own RunnerDeps.readHfToken, for the prewarmModel/startServer
   *  effects) AND read directly by performSwitchModel's own restart
   *  section further down (a direct invoke() call, not a
   *  provisionMachine Effect at all). Injected rather than imported for
   *  the SAME reason isMeetingActive above is — see that field's own
   *  doc comment and BootstrapDeps.setTransport's. Deliberately
   *  SYNCHRONOUS (mirrors isMeetingActive exactly, not the three
   *  awaited-once-up-front accessors above it): a prewarm/start/switch
   *  call can happen minutes into an already-running session, and the
   *  user may configure Settings.hfToken AFTER bootstrap first ran —
   *  see resolveReadHfToken below for the one real implementation,
   *  which resolves the async store-hydration dance ONCE and hands
   *  back a plain sync closure reading whatever is CURRENTLY
   *  persisted. Absent (every pre-S12a test, and any caller that
   *  hasn't wired it) means "no token" — both invoke payloads simply
   *  omit the `hfToken` key, byte-identical to before this task. */
  readHfToken?: () => string;
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
  // S5 review pair Finding 2: this SAME closure variable is also read
  // directly by switchModel()/installDiarization() below (no separate
  // copy) — see each method's own doc comment on DesktopBootstrapHandle.
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
  // S11 osspeech blueprint (§A4): gathered the SAME "up front, before
  // any provisioning decision" way as sidecarMode/persistedModel above —
  // isFreshProvisionEntry's own call site below is the ONE place this
  // is read.
  const persistedEngine = await deps.getDesktopEngine?.();
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
    // S12a Q6: threaded straight through — see BootstrapDeps.
    // readHfToken's own doc comment above and RunnerDeps.readHfToken's
    // (provisionRunner.ts).
    readHfToken: deps.readHfToken,
    // S13 hotfix (field-test RAM-usage fix) — see provisionRunner.ts's
    // own RunnerDeps.readLazyLoad doc comment for the full contract.
    // `persistedEngine` is the SAME "await BEFORE any provisioning
    // decision" read the S11 osspeechDormant gate above already uses
    // (this file's own header comment) — reused here directly, not
    // re-read, so this covers the STARTING step regardless of whether
    // it's reached via a fresh provision or a provisioned-dead restart
    // (both funnel through this ONE runnerDeps object — see the drive
    // loop's own runEffects call further down). `undefined` (every
    // pre-S13 test, and any caller that hasn't wired getDesktopEngine)
    // returns false — "eager", byte-identical to before this hotfix.
    readLazyLoad: () => persistedEngine !== undefined && !SIDECAR_ENGINES.has(persistedEngine),
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
  // S11 osspeech blueprint (§A4): true the instant a fresh NEEDS_
  // PROVISION decision lands with persistedEngine already "osspeech" —
  // see isFreshProvisionEntry's own call site below. Mutually exclusive
  // with awaitingConsent (the SAME branch sets exactly one of the two,
  // never both) — a dormant osspeech session never shows ANY wizard
  // screen and never auto-drives into installing the whisper sidecar.
  let osspeechDormant = false;
  // Lead integration fix (S11): one-shot override consumed by the next
  // fresh NEEDS_PROVISION decision. reprovision() is the user explicitly
  // asking for the setup wizard — with engine === "osspeech" persisted,
  // the dormant gate below would otherwise re-park silently and the
  // Settings「重新运行安装向导」button would visibly do nothing. Set only
  // by reprovision(); cleared the moment the branch consumes it. The
  // consent path it forces re-renders EngineChoiceScreen first (Worker
  // D's DesktopWizard sequencer), so "re-run wizard" becomes a genuine
  // re-choice: the user can pick whisper and provision, or re-confirm
  // 系统识别 and land dormant again.
  let forceEngineSetupOnce = false;
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
  // reprovision()'s own leading bump, and it still invalidates any
  // drive() that happens to be concurrently in flight (e.g. a
  // crash-restart) the same way every other entry point here already
  // does. S4 review pair Finding 1b: unlike before, performSwitchModel
  // now ALSO loops back through this same counter itself — it captures
  // its own generation at entry and rechecks it after every await,
  // aborting silently if superseded, mirroring drive()'s own guard
  // exactly. Belt-and-suspenders once reprovision()/switchModel() share
  // ONE latch (Finding 1a, sidecarLifecycleInFlight below): that latch
  // already keeps a second reprovision()/switchModel() call from ever
  // running concurrently with this one, but a reprovision() bumping
  // `generation` still structurally invalidates any switchModel() that
  // somehow ended up concurrently in flight anyway, latch or no latch.
  let generation = 0;
  // S4 review pair Finding 1a: reprovision() and switchModel() BOTH
  // stop/restart the SAME sidecar process, so — unlike the two
  // originally-separate latches this replaces — they now share ONE
  // latch. Two independent latches let a reprovision() and a
  // switchModel() run fully concurrently, each blind to the other:
  // exactly how 「重新运行安装向导」mid-switch could clear the marker and
  // park on WIZARD_CONSENT_REQUIRED while the switch kept going in the
  // background, started the new server, and rewrote the marker behind
  // the wizard's back. A second caller — of EITHER method, while
  // EITHER is in flight — now REJECTS (SIDECAR_LIFECYCLE_BUSY_MESSAGE)
  // instead of joining the in-flight promise: joining made sense when
  // only one KIND of call could ever be in flight at a time, but once
  // the latch is shared, a switchModel() call joining a DIFFERENT
  // reprovision() attempt's promise would resolve as if IT had
  // switched the model, when really the wizard had just reset the
  // whole session out from under it — semantically wrong regardless of
  // which of the two methods got there first. Cleared via `.finally()`
  // once the FIRST caller's own attempt settles either way, same
  // idempotency-latch shape as before.
  let sidecarLifecycleInFlight: Promise<void> | null = null;
  const listeners = new Set<(state: DesktopBootstrapState) => void>();

  function externalState(): DesktopBootstrapState {
    if (externalUnmanaged) return { phase: "EXTERNAL_UNMANAGED" };
    // S11 osspeech blueprint (§A4): checked ahead of awaitingConsent —
    // the two are mutually exclusive by construction (see
    // osspeechDormant's own doc comment above), so ordering between
    // them never actually matters, but this mirrors externalUnmanaged's
    // own "checked first" placement for a consistent read order.
    if (osspeechDormant) return { phase: "OSSPEECH_ACTIVE" };
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

  /** Field-test self-heal (v0.5.1 fix round) — an app closed mid
   *  CREATE_VENV leaves a half-written `venvDir` behind; on the NEXT
   *  launch, a bare `uv venv` against that SAME half-written directory
   *  exits code 2 ("a virtual environment already exists") every time,
   *  and — before this fix — the wizard's own 重试 button just re-ran
   *  the identical failing command forever (venvCreate had no `--clear`
   *  arm at all). Mirrors ensureMlxExtras' own `--clear` retry-once
   *  below, for the BASE venv instead of the separate mlx one: run the
   *  step's ORIGINAL effects first via runEffects (byte-identical to
   *  before this fix whenever CREATE_VENV succeeds on the first try),
   *  and only on a STEP_ERROR, retry EXACTLY once with a fresh
   *  `venvCreate(paths, {clear:true})` effect. Deliberately just calls
   *  runEffects a second time rather than duplicating its {args,env} ->
   *  invoke("run_uv") -> ProcessResult -> MachineEvent plumbing here
   *  (provisionRunner.ts stays untouched) — so a successful self-heal is
   *  invisible to transition()/the wizard UI (never surfaced as an
   *  intermediate failure), and a genuine second failure propagates with
   *  the exact same STEP_ERROR shape runEffects would have produced on
   *  its own (same error surface as today). */
  async function runCreateVenvStep(state: MachineState, effects: Effect[]): Promise<MachineEvent> {
    const event = await runEffects(state, effects, runnerDeps);
    if (event.type !== "STEP_ERROR") return event;
    const retryEffects: Effect[] = [{ kind: "runUv", command: venvCreate(paths, { clear: true }) }];
    return runEffects(state, retryEffects, runnerDeps);
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
        if (current.state.step === "DOWNLOAD_MODEL") {
          resetDownloadProgress();
          // S12b fix round (§F FB1, BLOCKER) — the first-run WIZARD's
          // own counterpart of performSwitchModel's leading
          // ensureMlxExtras phase. Without this, an mlx-family
          // ctx.model reaching DOWNLOAD_MODEL via beginProvision() ->
          // INSTALL_PYTHON -> CREATE_VENV -> INSTALL_DEPS (all
          // base-venv steps, byte-unchanged below for every
          // whisper-family model) would fire prewarmModel's own
          // prewarm_model invoke DIRECTLY — server.rs's own
          // venv_for_model then resolves `mlxVenvPython` for the
          // download child (a venv ensureMlxExtras never got a chance
          // to build), and prewarm fails outright against a
          // nonexistent interpreter. Reuses ensureMlxExtras() VERBATIM
          // (not a new driven step/effect) — deliberately: that
          // function already owns the disk check, the skip-if-
          // already-valid check, the venv/pip/preflight/pip-check
          // sequence, its OWN `--clear` self-heal, AND emits through
          // switchModelProgress$ (the mlx-install task row surface,
          // §Task 7) — routing this through provisionMachine.ts's pure
          // transition()/runEffects instead would mean re-plumbing
          // that SAME progress surface (plus `paths`) into
          // provisionRunner.ts, which has neither, for zero
          // behavioral gain; provisionMachine.ts stays a plain,
          // synchronous, zero-IO reducer either way. A structural
          // no-op for every whisper-family model (the
          // MLX_ONLY_MARKER_MODELS gate below) — a plain first-run's
          // own invoke order/effects stay byte-identical to before
          // this fix.
          if (MLX_ONLY_MARKER_MODELS.includes(ctx.model)) {
            try {
              await ensureMlxExtras();
            } catch (error) {
              if (generation !== myGeneration) return; // superseded — apply nothing further, mirrors this loop's own runEffects guard below.
              const message = describeError(error);
              diagLog("error", "desktop-provision", "安装 MLX 运行环境失败", redactHomePath(message));
              // Same "the pane must never read 暂无输出 on a failure"
              // rule as the STEP_ERROR branch further below — RAW
              // (unredacted) display.
              notifyLog("stderr", `安装 MLX 运行环境失败：${message}`);
              // Lands on DOWNLOAD_MODEL/ERROR — deliberately NOT
              // INSTALL_MLX (this file's own §D F2 code already uses
              // that landing, for a DIFFERENT scenario: a fresh
              // CHECKING-time capability probe with nothing yet
              // attempted, whose own handleRetry branch re-enters
              // CHECKING from scratch, provisionMachine.ts). By THIS
              // point in the wizard flow, INSTALL_PYTHON/CREATE_VENV/
              // INSTALL_DEPS have ALREADY succeeded — retrying via
              // "re-enter CHECKING" would blindly re-attempt
              // CREATE_VENV against an already-existing base-venv
              // directory. (v0.5.1 fix round: CREATE_VENV's own
              // drive()-loop step now self-heals that exact case with a
              // `--clear` retry too — see runCreateVenvStep above and
              // venvCreate's own doc comment, uvCommands.ts — so this
              // would no longer fail outright, but re-verifying three
              // steps that never actually failed is still needless
              // work.) DOWNLOAD_MODEL's own EXISTING retry semantic
              // (handleRetry's generic fallback: re-enter DOWNLOAD_MODEL
              // directly, never CHECKING) is the "closest existing
              // shape" that actually behaves correctly here — and since
              // THIS hook re-fires on EVERY DOWNLOAD_MODEL entry (fresh
              // OR retried, re-checked fresh above), retrying naturally
              // re-runs ensureMlxExtras first, which self-heals via its
              // own `--clear` arm on a second failure.
              current = {
                state: { phase: "STEP", step: "DOWNLOAD_MODEL", status: "ERROR", error: message, retriable: true },
                effects: [],
              };
              notify();
              return;
            }
            if (generation !== myGeneration) return;
          }
        }
      }
      // CREATE_VENV routes through runCreateVenvStep's own --clear
      // self-heal wrapper (see that function's own doc comment above)
      // instead of calling runEffects directly — every other step stays
      // byte-identical to before this fix.
      const event =
        current.state.phase === "STEP" && current.state.step === "CREATE_VENV" && current.state.status === "RUNNING"
          ? await runCreateVenvStep(current.state, current.effects)
          : await runEffects(current.state, current.effects, runnerDeps);
      if (generation !== myGeneration) return; // superseded — apply nothing further.
      current = transition(ctx, current.state, event);
      if (event.type === "CHECK_RESULT" && event.mlxUsability) {
        // S12a (§C Provision, F14 / Store coercion; redesigned §D F2,
        // HIGH) — mirrors provisionMachine.ts's OWN per-status handling
        // (handleCheckResult) from this file's separate vantage point:
        // see QUARANTINE_FALLBACK_MODEL's own doc comment
        // (provisionMachine.ts) for why `ctx.model` needs an explicit
        // reseed here at all, distinct from the resulting MachineState
        // the isFreshProvisionEntry check just below already handles
        // identically to an ordinary first-time install — a pure
        // reducer has nowhere to persist anything, so THIS file is the
        // one place that can act on the durable-vs-session-only
        // distinction §D F2's lead-adjudicated matrix draws between
        // `unsupported` and `invalid-venv` (see MlxUsability's own doc
        // comment, provisionMachine.ts, for the full rationale of each
        // branch below — this block only re-derives it from its own
        // vantage point, the underlying policy is decided there).
        const checkedMarker = parseMarker(event.markerRaw);
        const markerLabel = checkedMarker?.model ?? "parakeet";
        if (event.mlxUsability.status === "unsupported") {
          // §D F2 case (a): a DEFINITIVE hardware/OS verdict — durable
          // quarantine, exactly as before this fix round. Also durably
          // corrects the PERSISTED settings.whisperModel (fire-and-
          // forget, mirroring beginProvision()'s own un-awaited
          // persistDesktopModel call below) — the task brief's own
          // "Store coercion" framing of F14: the clamp can't live in
          // store.ts's synchronous migration (caps are async), so it's
          // implemented HERE instead, as the live quarantine path
          // writing the correction back through the store the moment
          // it's actually known. Without this, a stale persisted
          // "parakeet-tdt-0.6b-v3" preference would keep seeding
          // ctx.model back to the already-quarantined value on every
          // FUTURE app relaunch's fresh-provision path too
          // (getDesktopModel/seededModel, this file's own top-of-
          // function clamp). A marker divergence surviving this point
          // (the on-disk marker itself is never rewritten here) is
          // INERT: server.rs's start_server belt
          // (check_mlx_capable_if_parakeet) re-checks mlx_capabilities
          // and refuses to spawn parakeet on hardware this already
          // knows can't run it, so even a later same-session
          // crash-restart reading ctx.model (already reseeded, never
          // the marker) — or a FUTURE relaunch re-reading the
          // untouched marker and re-deriving the SAME `unsupported`
          // verdict fresh — can never actually launch the wrong model.
          diagLog(
            "warn",
            "desktop-provision",
            `${markerLabel} 不支持（${event.mlxUsability.reason}），已回退到默认模型`,
          );
          ctx = { ...ctx, model: QUARANTINE_FALLBACK_MODEL };
          void deps.persistDesktopModel?.(QUARANTINE_FALLBACK_MODEL);
        } else if (event.mlxUsability.status === "invalid-venv") {
          // §D F2 case (b): a DEFINITIVE but FIXABLE verdict (a broken/
          // missing mlx venv, not a hardware limit) — re-choice pause
          // WITHOUT any durable persist: settings.whisperModel and the
          // on-disk marker both stay "parakeet-tdt-0.6b-v3" (no
          // persistDesktopModel call here, deliberately) — only THIS
          // session's in-memory ctx falls back, so the user can keep
          // running the fallback model this session while re-choosing
          // parakeet (via Settings' switchModel, once reachable) later
          // re-enters ensureMlxExtras' own repair sequence fresh — its
          // skip-check will see the SAME broken venv and fall through
          // to a real (re)install, self-healing via its own existing
          // `--clear` retry-on-failure arm.
          diagLog(
            "warn",
            "desktop-provision",
            `${markerLabel} 的 MLX 运行环境无效，本次会话回退到默认模型（未更改已保存的偏好）`,
          );
          ctx = { ...ctx, model: QUARANTINE_FALLBACK_MODEL };
        }
        // "usable": no action — falls through to the ordinary
        // provisioned-dead STARTING path the machine itself already
        // produced. "probe-error": ALSO no action here — the machine
        // never produced a fresh-INSTALL_PYTHON-shaped state for this
        // case at all (it parks directly on INSTALL_MLX/ERROR, §D F2
        // case c), so there is nothing for ctx to get out of sync
        // with; zero writes to marker/preference/ctx is satisfied by
        // this branch simply not existing.
      }
      if (event.type === "STEP_OK") {
        diagLog("info", "desktop-provision", `${PROVISION_STEP_LABELS[event.step]} 完成`);
        if (event.step === "DOWNLOAD_MODEL") resetDownloadProgress();
      } else if (event.type === "STEP_ERROR") {
        diagLog("error", "desktop-provision", `${PROVISION_STEP_LABELS[event.step]} 失败`, redactHomePath(event.error));
        // v0.4.0 field fix: a step that fails BEFORE its subprocess ever
        // produces output (e.g. the uv sidecar failing to spawn) emitted
        // zero uv://log lines, leaving the wizard 详细日志 pane at
        // 「暂无输出」 exactly when its content mattered most. The error
        // line goes to the pane RAW (unredacted) — same "local-only
        // display keeps the real path, only the diag ring redacts" rule
        // as redactHomePath's own doc comment above.
        notifyLog("stderr", `${PROVISION_STEP_LABELS[event.step]} 失败：${event.error}`);
        if (event.step === "DOWNLOAD_MODEL") resetDownloadProgress();
      }
      if (event.type === "CHECK_RESULT" && isFreshProvisionEntry(current.state)) {
        // S11 osspeech blueprint (§A4): a fresh NEEDS_PROVISION decision
        // whose persisted engine already reads "osspeech" (the user's
        // own past EngineChoiceScreen pick, or a direct Settings pick)
        // must NOT pause on WIZARD_CONSENT_REQUIRED — that would silently
        // re-show the wizard on every relaunch even though the user
        // already told us not to use the local whisper sidecar at all.
        // Parking here INSTEAD of setting awaitingConsent (both branches
        // `return` without ever calling runEffects for this STEP) is
        // what keeps the drive loop from EVER auto-installing Python for
        // an osspeech user — the exact silent-download the LEAD
        // AMENDMENT above already forbids, just for a second condition.
        // A LATER relaunch with the engine switched away from "osspeech"
        // (e.g. back to whisper, still unprovisioned) reads a fresh
        // persistedEngine and falls through to the unchanged
        // awaitingConsent branch below — "still show provisioning if the
        // user later switches to whisper without a provisioned model"
        // (blueprint §3 Worker D), achieved for free by re-deriving this
        // check from scratch on every bootstrapDesktop() call rather
        // than caching the decision anywhere durable.
        if (persistedEngine === "osspeech" && !forceEngineSetupOnce) {
          osspeechDormant = true;
          notify();
          return;
        }
        // Consumed exactly once — see forceEngineSetupOnce's own doc
        // comment (reprovision()'s explicit re-choice).
        forceEngineSetupOnce = false;
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
    // Review finding (v0.4.0 hotfix round): this is the ONE STEP/ERROR
    // entry point that bypasses drive()'s own STEP_ERROR branch, so it
    // needs its own 详细日志 line too — same "the pane must never read
    // 暂无输出 on a failure" rule, same RAW-not-redacted display posture.
    notifyLog("stderr", `切换模型失败（${PROVISION_STEP_LABELS[step]}未恢复）：${message}`);
    current = { state: { phase: "STEP", step, status: "ERROR", error: message, retriable: true }, effects: [] };
    notify();
  }

  /** S12a fix round (§D F6, MEDIUM) — ensureMlxExtras' own combined
   *  pre-Phase-1 disk-space precheck, invoking the cross-lane-pinned
   *  Rust command `app_data_disk_free` (worker A1, landing alongside
   *  this fix) → `{freeBytes: number}`. Throws a STEP_ERROR-style
   *  message naming the exact shortfall (both sides in GB, one
   *  decimal) when free space is below MLX_INSTALL_DISK_RESERVE_BYTES
   *  — propagates through ensureMlxExtras' own existing try/self-heal-
   *  once-with-`--clear` wrapper exactly like any other attempt()
   *  failure, no special-casing needed there.
   *
   *  Best-effort on the PROBE's own availability (deliberate choice,
   *  §D F6): an invoke() rejection (a spawn/IPC failure, OR simply an
   *  older packaged build that predates this command entirely) does
   *  NOT hard-block the install — this diagLogs and returns as if the
   *  check had passed, rather than throwing. The precheck is a
   *  best-effort courtesy (an honest "you're about to run out of
   *  space" warning ahead of a ~1.2GB+ install) layered ON TOP of
   *  every download/pip-install step's own EXISTING real failure
   *  surfacing (a genuinely-out-of-space uv/pip/download call still
   *  fails on its own, later, with its own OS-level error) — it is not
   *  the only thing standing between the user and a failed install, so
   *  its own unavailability must never be treated as equivalent to
   *  "definitely not enough space". */
  async function checkMlxInstallDiskSpace(): Promise<void> {
    let freeBytes: number;
    try {
      const result = await deps.invoke<{ freeBytes: number }>("app_data_disk_free");
      freeBytes = result.freeBytes;
    } catch {
      diagLog("warn", "desktop-provision", "磁盘空间预检查不可用，已跳过（继续安装）");
      return;
    }
    if (freeBytes < MLX_INSTALL_DISK_RESERVE_BYTES) {
      const freeGb = (freeBytes / 1024 ** 3).toFixed(1);
      const neededGb = (MLX_INSTALL_DISK_RESERVE_BYTES / 1024 ** 3).toFixed(1);
      throw new Error(`磁盘空间不足：可用 ${freeGb}GB，需要至少 ${neededGb}GB`);
    }
  }

  /** S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
   *  R1/Provision, F16) — Phase 1 of an mlx-family switch (§C Q5's
   *  two-phase provision): builds+validates the separate, hash-locked
   *  MLX venv AHEAD of performSwitchModel's own existing bucket 1
   *  (model download) below — the "extras validated (atomic mark) ->
   *  model downloaded -> ..." pinned order. Called from EXACTLY one
   *  place today (performSwitchModel, gated on
   *  MLX_ONLY_MARKER_MODELS.includes(model) — see that function's own
   *  new leading branch): "one ensure-mlx service" per §C, structured
   *  so a FUTURE wizard-path caller (S12b, once parakeet's
   *  `available:false` catalog flip lands) can reuse it identically —
   *  it reads no switchModel-specific state (no `model`/`ctx`
   *  parameter at all) and never touches `current`/the provision
   *  marker itself, so nothing here is switchModel-shaped.
   *
   *  A direct, bootstrap-only imperative sequence — same posture as
   *  performSwitchModel/performInstallDiarization (neither of which
   *  drives provisionMachine.ts's transition()/runEffects either;
   *  provisionMachine.ts's own INSTALL_MLX doc comment explains why
   *  this stays OUT of that pure machine's auto-advance vocabulary this
   *  sprint) — chosen specifically because THIS caller (jobsBridge.ts's
   *  "mlx-install" task row, §Task 7) needs live, per-substep progress
   *  (venv create / pip install / preflight+check) that a single opaque
   *  provisionMachine Effect would hide; each notifySwitchModelProgress
   *  call below fires BEFORE its own sub-step starts.
   *
   *  Transactional per §C Provision, step (1)-(3): a fresh attempt
   *  tries WITHOUT `--clear` first, short-circuiting entirely via a
   *  cheap mlx_import_preflight probe if an earlier install already
   *  left a working venv (S5 installDiarization's own "skip if already
   *  present" precedent — here realized via a live re-import check
   *  rather than a dedicated marker file/Rust command, since none was
   *  cross-lane-pinned this sprint; see this task's own PR report for
   *  the full rationale, mirrored in provisionRunner.ts's identical
   *  probeMlxUsable). ANY failure of that first attempt self-heals with
   *  exactly ONE retry using `--clear` (discharges the uv-venv
   *  retry-poisoning debt, V040-VERIFICATION-RUNPLAN.md:35) before
   *  finally rethrowing the retry attempt's own error. Step (4)'s
   *  "atomic valid-mark" is likewise realized implicitly: a
   *  successfully-completed attempt (venv created, lock installed,
   *  import+pip-check both clean) IS the valid mark — nothing further
   *  is persisted, and the very same mlx_import_preflight re-import is
   *  what a LATER quarantine check (provisionRunner.ts's
   *  probeMlxUsable, feeding provisionMachine.ts's own F14 branch)
   *  re-verifies from scratch rather than trusting a possibly-stale
   *  file.
   *
   *  Never touches `current`/ctx/the provision marker — a caller
   *  failing here (performSwitchModel's new leading bucket) leaves the
   *  OLD server/marker/preference completely untouched, matching bucket
   *  1's own pre-existing "old server never touched" contract (this
   *  function runs BEFORE that bucket's own try, so a failure here
   *  never even reaches it). */
  async function ensureMlxExtras(): Promise<void> {
    const capsResult = await probeMlxCapabilitiesWith(deps.invoke);
    if (capsResult.status === "error" || !capsResult.caps.mlxSupported) {
      throw new Error(capsResult.caps.reason || "当前设备不支持 Apple 芯片 MLX 加速");
    }

    const attempt = async (clear: boolean): Promise<void> => {
      if (!clear) {
        const already = await deps
          .invoke<MlxImportPreflightResult>("mlx_import_preflight")
          .catch(() => null);
        if (already?.ok) return; // already installed+valid — nothing to do
      }

      // S12a fix round (§D F6, MEDIUM) — the combined pre-Phase-1 disk
      // check, BEFORE this attempt's own first venv mutation (the
      // venvCreateMlx run_uv call right below) — see
      // checkMlxInstallDiskSpace's own doc comment for the reserve's
      // derivation and this probe's own best-effort-availability
      // posture.
      await checkMlxInstallDiskSpace();

      notifySwitchModelProgress({ phase: "mlx-venv" });
      const createCmd = venvCreateMlx(paths, { clear });
      const createResult = await withUvLog(deps, notifyLog, () =>
        deps.invoke<ProcessResult>("run_uv", { args: createCmd.args, env: createCmd.env }),
      );
      if (createResult.code !== 0) {
        throw new Error(`创建 MLX 虚拟环境失败（退出码 ${createResult.code === null ? "null" : createResult.code}）`);
      }

      notifySwitchModelProgress({ phase: "mlx-pip" });
      const installCmd = pipInstallMlxLock(paths);
      const installResult = await withUvLog(deps, notifyLog, () =>
        deps.invoke<ProcessResult>("run_uv", { args: installCmd.args, env: installCmd.env }),
      );
      if (installResult.code !== 0) {
        throw new Error(`安装 MLX 依赖失败（退出码 ${installResult.code === null ? "null" : installResult.code}）`);
      }

      notifySwitchModelProgress({ phase: "mlx-preflight" });
      const preflight = await deps.invoke<MlxImportPreflightResult>("mlx_import_preflight");
      if (!preflight.ok) {
        throw new Error(preflight.stderr || "MLX 依赖导入检查失败");
      }
      const checkCmd = pipCheckMlx(paths);
      const checkResult = await withUvLog(deps, notifyLog, () =>
        deps.invoke<ProcessResult>("run_uv", { args: checkCmd.args, env: checkCmd.env }),
      );
      if (checkResult.code !== 0) {
        throw new Error(`MLX 依赖兼容性检查失败（退出码 ${checkResult.code === null ? "null" : checkResult.code}）`);
      }
    };

    try {
      await attempt(false);
    } catch {
      await attempt(true); // self-heal once with --clear; a second failure propagates as-is
    }
  }

  /** S12b fix round (§F FB8, MED) — performSwitchModel's own SAME-
   *  TARGET no-op check: `true` iff the on-disk marker's own model
   *  ALREADY equals `model` AND (for an mlx-family target only) its
   *  own extras are still verified valid.
   *
   *  Whisper-family target: the marker match ALONE is sufficient —
   *  there is no separate "extras validity" concept for a whisper
   *  model (its only dependency is the base venv, which is assumed
   *  intact whenever `current.state.phase === "HEALTHY"`, switchModel's
   *  own precondition).
   *
   *  Mlx-family target: reuses the EXACT SAME skip-check
   *  ensureMlxExtras' own fresh (non-`--clear`) attempt leads with —
   *  a real `mlx_import_preflight` re-import, not a cached/assumed
   *  answer — so a marker that says "parakeet" but whose mlx venv has
   *  since gone missing/broken (§D F2's own `invalid-venv` case,
   *  should the user have hit that earlier) correctly falls through
   *  to the real (repair) install below, rather than wrongly no-op-
   *  ing over a broken environment. */
  async function isAlreadyInstalledAndValid(model: string): Promise<boolean> {
    const marker = parseMarker(await deps.invoke<string | null>("read_provision_marker").catch(() => null));
    if (!marker || marker.model !== model) return false;
    if (!MLX_ONLY_MARKER_MODELS.includes(model)) return true;
    const preflight = await deps
      .invoke<MlxImportPreflightResult>("mlx_import_preflight")
      .catch(() => null);
    return preflight?.ok === true;
  }

  /** The real work behind the `switchModel` handle action (split out
   *  as its own nested function, mirroring drive()/driveGuarded()'s own
   *  split, so the returned handle method itself stays a thin validate
   *  + single-flight wrapper below). Callable only once switchModel()
   *  has already confirmed `model` is ALLOWED_MARKER_MODELS-valid and
   *  current.state.phase === "HEALTHY" — this function trusts both. */
  async function performSwitchModel(model: string): Promise<void> {
    // S4 review pair Finding 1b: captured at entry — switchModel()
    // already bumped `generation` synchronously, immediately before
    // calling this function (see that method's own leading bump) — and
    // rechecked after EVERY await below, aborting silently the instant
    // it no longer matches, mirroring drive()'s own "superseded — apply
    // nothing further" guard exactly (see `generation`'s own doc
    // comment above). The shared sidecarLifecycleInFlight latch
    // (Finding 1a) already keeps a second reprovision()/switchModel()
    // call from ever running concurrently with this one, so this is
    // belt-and-suspenders — but a cheap, structural one: it makes the
    // wizard-mid-switch interleave impossible even if that latch were
    // somehow bypassed.
    const myGeneration = generation;
    try {
      // S12b fix round (§F FB8, MED) — the SAME-TARGET no-op, checked
      // FIRST (before even the mlx-extras bucket below): deliberately
      // NOT placed in switchModel() itself, ahead of the busy-latch
      // check there — this method's own pre-latch gates must stay
      // fully SYNCHRONOUS (Finding 3's generation/latch invariant; an
      // `await` inserted before sidecarLifecycleInFlight is SET would
      // let a concurrent reprovision()/switchModel() call race in and
      // wrongly observe the latch as free — see switchModel()'s own
      // doc comment on DesktopBootstrapHandle for the full rationale).
      // Landing it HERE instead means a same-target call still
      // correctly HOLDS the latch for its own (very short: one or two
      // invoke round trips) duration — a concurrent reprovision()/
      // switchModel() rejects against it exactly as it would against
      // any other in-flight switchModel() call — only the real
      // download/marker/stop/start work below is skipped.
      if (await isAlreadyInstalledAndValid(model)) {
        return;
      }
      if (generation !== myGeneration) return;
      // S12a (§C Provision, Q5's two-phase flow): Phase 1, only for an
      // mlx-family target — a plain whisper-family switchModel() call
      // never enters this branch, so its own bucket 1 (below) stays
      // byte-identical to pre-S12a. A failure here throws BEFORE bucket
      // 1's own try/notify even starts — old server/marker/preference
      // completely untouched, same as a bucket-1 (download) failure.
      if (MLX_ONLY_MARKER_MODELS.includes(model)) {
        await ensureMlxExtras();
        if (generation !== myGeneration) return;
      }

      // ---- bucket 1: download (old server untouched throughout — a
      // failure here rethrows as-is, current.state is never touched) ----
      notifySwitchModelProgress({ phase: "downloading", progress: 0 });
      const jobId = await postDownloadModel(model);
      if (generation !== myGeneration) return;
      const sleep = deps.sleep ?? defaultSleep;
      for (;;) {
        const job = await pollJob(jobId, runnerDeps.settings);
        if (generation !== myGeneration) return;
        if (job.status === "error") throw new Error(job.error ?? "模型下载失败");
        notifySwitchModelProgress({ phase: "downloading", progress: job.progress });
        if (job.status === "done") break;
        await sleep(SWITCH_DOWNLOAD_POLL_INTERVAL_MS);
        if (generation !== myGeneration) return;
      }

      // S4 review pair Finding 2: the meetingActive check SettingsDialog
      // makes at 「下载并切换」click time is only ever a snapshot — the
      // download above can take minutes, long enough for a meeting to
      // start mid-download and get its sidecar pulled out from under it
      // the instant this function reaches the stop_server bucket below.
      // Rechecked fresh, right here — before ANYTHING durable happens,
      // the marker/settings write included (see that code's own comment
      // just below on why the marker must NOT move to `model` for a
      // switch that isn't actually going to happen). current.state is
      // left untouched (still HEALTHY) and the old server is never
      // touched either — the model is already downloaded and cached
      // sidecar-side, so a LATER switchModel(model) call (once the
      // meeting ends) skips straight through this same download bucket.
      if (deps.isMeetingActive?.()) {
        throw new Error("会议进行中，已取消切换（模型已下载，可稍后一键切换）");
      }

      // ---- bucket 2 begins here: durably record the switch BEFORE the
      // old server goes away (S4 review pair Finding 3 reorder — this
      // used to happen AFTER health passed). `model` is fully downloaded
      // and the meeting-active gate above just passed, so "marker = the
      // model a relaunch should start" is truthful RIGHT NOW; writing it
      // here makes the switch self-healing across everything from here
      // on — stop_server/start_server throwing, health never coming up,
      // or even the wizard's own 重试 re-driving STARTING/POLLING_HEALTH
      // through provisionMachine.ts's handleRetry (which starts
      // ctx.model but writes no marker of its own — only DOWNLOAD_
      // MODEL's own STEP_OK does, see handleStepOk) — all relaunch/
      // retry into `model`, matching ctx below, never silently
      // reverting to whatever was running before this switch. py/deps
      // are reused verbatim from whatever marker is already on disk
      // (untouched by a model switch — only `model` actually changes)
      // rather than reconstructed from provisionMachine.ts's own
      // buildMarker/DEPS_TAG, which are module-private there and off
      // this chunk's touch list to export; a fallback only matters for
      // the pathological case of reaching HEALTHY with no marker at all
      // (e.g. an adopted external-ish server), and neither field is
      // ever compared — parseMarker only shape-checks them (blueprint
      // risk register #5: "pin comparison still skipped").
      const existingMarker = parseMarker(
        await deps.invoke<string | null>("read_provision_marker").catch(() => null),
      );
      if (generation !== myGeneration) return;
      const marker: Omit<ProvisionMarker, "ts"> = {
        schema: MARKER_SCHEMA_VERSION,
        model,
        py: existingMarker?.py ?? PINNED_PYTHON_MINOR,
        deps: existingMarker?.deps ?? "unknown",
      };
      await invokeWriteMarker(runnerDeps, marker, deps.now ?? defaultNow);
      if (generation !== myGeneration) return;
      await deps.persistDesktopModel?.(model);
      if (generation !== myGeneration) return;

      // Reseed ctx now too, matching the marker just written above — a
      // later same-session crash-restart (handleServerExit's own CRASH_
      // RESTART above, which reads ctx.model directly, never the
      // marker) must relaunch the NEW model, not silently revert to
      // whatever ctx.model was before this switch.
      ctx = { ...ctx, model };
      notifySwitchModelProgress({ phase: "restarting" });
      diagLog("info", "desktop-provision", `切换模型：停止旧服务，准备启动 ${model}`);
      try {
        await stopServer(deps.invoke);
        if (generation !== myGeneration) return;
        // S12a Q6: `hfToken` rides alongside `model`, same as
        // provisionRunner.ts's own startServer effect (see hfTokenArg's
        // own doc comment above) — this restart is the switch flow's
        // OWN direct start_server call, not a provisionMachine Effect,
        // so it needs its own copy of the same passthrough. THIS call
        // (unlike the download job just above) reads the token fresh
        // and DOES pick up a just-configured one — see
        // postDownloadModel's own doc comment for the accepted
        // limitation this asymmetry creates.
        await deps.invoke<StartServerResult>("start_server", { model, ...hfTokenArg(deps) });
        if (generation !== myGeneration) return;
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
        if (attempt > 1) {
          await sleep(SWITCH_HEALTH_POLL_INTERVAL_MS);
          if (generation !== myGeneration) return;
        }
        healthy = (await probe(runnerDeps.settings)).up;
        if (generation !== myGeneration) return;
        if (healthy) break;
      }
      if (!healthy) {
        const message = `切换到 ${model} 后本地服务在 ${POLLING_HEALTH_ATTEMPT_CAP} 次检测内仍未恢复健康`;
        landOnSwitchFailure("POLLING_HEALTH", message);
        throw new Error(message);
      }

      diagLog("info", "desktop-provision", `已切换到模型 ${model}`);
      notify(); // current.state is still HEALTHY — re-announce per this action's own contract.
    } finally {
      notifySwitchModelProgress(null);
    }
  }

  /** The real work behind the `installDiarization` handle action (split
   *  out as its own nested function, mirroring performSwitchModel's own
   *  split, so the returned handle method itself stays a thin validate +
   *  single-flight wrapper below). Callable only once installDiarization()
   *  has already confirmed current.state.phase === "HEALTHY" — this
   *  function trusts that. Deliberately does NOT touch `current`/`ctx`/
   *  `generation` (see installDiarization's own doc comment on
   *  DesktopBootstrapHandle) — the only thing it does besides the
   *  run_uv call itself is diagLog + stream uv://log to notifyLog. */
  async function performInstallDiarization(): Promise<void> {
    // Defense-in-depth only, mirroring performSwitchModel's own guard —
    // installDiarization() itself never bumps `generation`, so this can
    // only ever fire if some OTHER caller's reprovision()/switchModel()
    // raced in despite the shared latch below (shouldn't happen in
    // practice, since that latch already serializes all three).
    const myGeneration = generation;
    diagLog("info", "desktop-provision", "开始安装说话人分离扩展");
    // Destructured into a fresh object literal — same shape runEffects.ts's
    // own runStepEffect uses for the identical UvCommand -> invoke() args
    // conversion (`{ args: effect.command.args, env: effect.command.env }`)
    // — a UvCommand VARIABLE passed directly doesn't satisfy invoke()'s
    // `Record<string, unknown>` parameter type (interfaces get no implicit
    // string index signature; a literal does).
    const command = pipInstallDiar(paths);
    let result: ProcessResult;
    try {
      result = await withUvLog(deps, notifyLog, () =>
        deps.invoke<ProcessResult>("run_uv", { args: command.args, env: command.env }),
      );
    } catch (error) {
      const message = describeError(error);
      diagLog("error", "desktop-provision", "安装说话人分离扩展失败", redactHomePath(message));
      throw error instanceof Error ? error : new Error(message);
    }
    if (generation !== myGeneration) return; // superseded — see this function's own doc comment.
    if (result.code !== 0) {
      // S5 review pair Finding 3: bare — no "安装说话人分离扩展失败" prefix
      // here. SettingsDialog.tsx's handleInstallDiarization is the ONE
      // place that adds that prefix (mirrors handleReprovisionDesktop's
      // identical `失败：${err.message}` posture); this thrown message
      // used to carry the SAME phrase baked in too, so the toast doubled
      // it up ("安装说话人分离扩展失败：安装说话人分离扩展失败（退出码 1）").
      // Every OTHER rejection this function can throw (the run_uv
      // invoke-failure catch above, and installDiarization()'s own
      // not-HEALTHY/external-mode/busy-latch gates) was already bare —
      // this was the one holdout.
      const message = `退出码 ${result.code === null ? "null" : result.code}`;
      diagLog("error", "desktop-provision", "安装说话人分离扩展失败", redactHomePath(message));
      throw new Error(message);
    }
    diagLog("info", "desktop-provision", "说话人分离扩展安装完成");
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
      // S4 review pair Finding 1a: the shared sidecar-lifecycle latch
      // (see sidecarLifecycleInFlight's own doc comment above) — a
      // second caller, of EITHER this method or switchModel(), REJECTS
      // instead of joining while one is already in flight.
      if (sidecarLifecycleInFlight) {
        return Promise.reject(new Error(SIDECAR_LIFECYCLE_BUSY_MESSAGE));
      }
      const run = (async () => {
        generation++; // supersedes whatever drive is currently running.
        await stopServer(deps.invoke);
        await deps.invoke<void>("write_provision_marker", { json: "null" });
        diagLog("info", "desktop-provision", "重新运行安装向导");
        restartState = initialRestartState();
        awaitingConsent = false;
        // S11 osspeech blueprint (§A4): same "a stale parking flag must
        // not survive a reset" rationale as externalUnmanaged just
        // below — reprovision() is a deliberate "redo setup" action, so
        // the fresh drive it kicks off must re-decide osspeechDormant
        // from scratch (it will, immediately: persistedEngine was
        // captured once at bootstrap start and is still consulted at
        // the very next CHECK_RESULT), not keep parking on a stale
        // value.
        osspeechDormant = false;
        // Lead integration fix (S11): the user explicitly asked for the
        // wizard — the next fresh NEEDS_PROVISION decision must show the
        // engine re-choice instead of silently re-parking dormant (see
        // forceEngineSetupOnce's own doc comment).
        forceEngineSetupOnce = true;
        // A stale EXTERNAL_UNMANAGED parking must not survive a reset
        // back into the (managed) drive loop below — externalState()
        // checks this flag FIRST, ahead of current.state, so leaving it
        // true would mask the fresh drive's real progress entirely.
        externalUnmanaged = false;
        current = initial();
        notify();
        driveGuarded();
      })();
      sidecarLifecycleInFlight = run.finally(() => {
        sidecarLifecycleInFlight = null;
      });
      return sidecarLifecycleInFlight;
    },
    async requestProvisionCheck() {
      // F3 field-test round 2 (Sol/Opus review): a user can flip
      // sidecarMode external->managed in Settings without the required
      // restart, then hit Start — start()'s/resume()'s own preflight
      // (useMeeting.ts) reads LIVE settings, so it calls this method
      // believing "managed" applies, but THIS handle still booted
      // external. `sidecarMode` (the const captured once above, at the
      // top of bootstrapDesktop, from deps.getSidecarMode()) is the
      // authoritative record of which mode THIS handle actually booted
      // in — unlike the live setting, it can't have silently drifted.
      // An external-boot handle ran driveExternalGuarded()'s one-shot
      // probe at startup, never the managed drive loop below, and never
      // installed the server://exit crash-restart supervisor (see the
      // `if (sidecarMode === "external")` branch at the end of
      // bootstrapDesktop) — driving the managed loop on it here would
      // silently start acting like a managed handle without ever having
      // done that setup. No-op instead (no state reset, no drive) — the
      // existing restart-required UX (SettingsDialog's own copy) owns
      // getting the user a genuine managed handle. Checked FIRST, same
      // ordering as switchModel()'s/installDiarization()'s own
      // identical leading check.
      if (sidecarMode === "external") {
        diagLog(
          "info",
          "desktop-provision",
          "外部模式下的 handle 收到重新检测请求，已忽略（需重启应用以切换到本地托管模式）",
        );
        return;
      }
      // Field-test fix B — see this method's own doc comment on
      // DesktopBootstrapHandle above. Same shared-latch contract as
      // reprovision()/switchModel() immediately above/below.
      if (sidecarLifecycleInFlight) {
        return Promise.reject(new Error(SIDECAR_LIFECYCLE_BUSY_MESSAGE));
      }
      const run = (async () => {
        generation++; // supersedes whatever drive is currently running.
        restartState = initialRestartState();
        awaitingConsent = false;
        osspeechDormant = false;
        forceEngineSetupOnce = true;
        externalUnmanaged = false;
        current = initial();
        notify();
        driveGuarded();
      })();
      sidecarLifecycleInFlight = run.finally(() => {
        sidecarLifecycleInFlight = null;
      });
      return sidecarLifecycleInFlight;
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
      // S5 review pair Finding 2: checked FIRST — external mode can
      // reach HEALTHY too (the phase below reflects the EXTERNAL
      // sidecar's own health, not anything this handle provisioned), so
      // the phase check alone let a draft-flipped UI (or any future
      // caller) drive start_server against whatever's actually
      // listening on managed mode's fixed ports. See this method's own
      // doc comment on DesktopBootstrapHandle for the full rationale.
      if (sidecarMode === "external") {
        return Promise.reject(new Error(EXTERNAL_SIDECAR_MODE_MESSAGE));
      }
      if (!ALLOWED_MARKER_MODELS.includes(model)) {
        return Promise.reject(new Error(`不支持的模型：${model}`));
      }
      if (current.state.phase !== "HEALTHY") {
        return Promise.reject(new Error("本地服务当前不可用，暂时无法切换模型"));
      }
      // S4 review pair Finding 1a: the SAME shared sidecar-lifecycle
      // latch reprovision() uses immediately above — a second caller
      // rejects rather than joins (see sidecarLifecycleInFlight's own
      // doc comment).
      if (sidecarLifecycleInFlight) {
        return Promise.reject(new Error(SIDECAR_LIFECYCLE_BUSY_MESSAGE));
      }
      generation++; // supersedes whatever drive is currently running — mirrors reprovision()'s own leading bump.
      const run = performSwitchModel(model);
      sidecarLifecycleInFlight = run.finally(() => {
        sidecarLifecycleInFlight = null;
      });
      return sidecarLifecycleInFlight;
    },
    switchModelProgress$(listener) {
      switchModelProgressListeners.add(listener);
      return () => switchModelProgressListeners.delete(listener);
    },
    currentSwitchModelProgress() {
      return switchModelProgress;
    },
    async installDiarization() {
      // S5 review pair Finding 2 — see switchModel()'s own identical
      // leading check above for the full rationale.
      if (sidecarMode === "external") {
        return Promise.reject(new Error(EXTERNAL_SIDECAR_MODE_MESSAGE));
      }
      if (current.state.phase !== "HEALTHY") {
        return Promise.reject(new Error("本地服务未就绪，无法安装扩展"));
      }
      // S4 review pair Finding 1a's shared latch, reused verbatim — see
      // sidecarLifecycleInFlight's own doc comment above and this
      // method's own doc comment on DesktopBootstrapHandle.
      if (sidecarLifecycleInFlight) {
        return Promise.reject(new Error(SIDECAR_LIFECYCLE_BUSY_MESSAGE));
      }
      const run = performInstallDiarization();
      sidecarLifecycleInFlight = run.finally(() => {
        sidecarLifecycleInFlight = null;
      });
      return sidecarLifecycleInFlight;
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

/** S11 osspeech blueprint (§A4) — mirrors getPersistedDesktopModel above
 *  exactly (same dynamic-import + hydration-gate shape, same
 *  rationale), just reading `settings.engine` instead of
 *  `settings.whisperModel`. Wired as BootstrapDeps.getDesktopEngine
 *  below — the ONE input the new ENGINE_CHOICE pre-consent branch needs
 *  (see that dep's own doc comment on BootstrapDeps). */
async function getPersistedEngine(): Promise<string> {
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
  return useApp.getState().settings.engine;
}

/** S11 osspeech blueprint (§3 Worker D, §A4) — EngineChoiceScreen's own
 *  "选系统识别" action, wired directly by DesktopWizard.tsx rather than
 *  threaded onto DesktopBootstrapHandle: unlike beginProvision/
 *  reprovision/etc. this action needs NOTHING from a specific
 *  bootstrapDesktop() closure instance (not the current MachineState,
 *  not `ctx`, not `generation`), so a plain standalone function —
 *  callable straight from a presentational component, the same way
 *  OnboardingByokStep.tsx already calls useApp().updateSettings
 *  directly (see that file's own header comment: "there is no
 *  bootstrap-handle concern here at all") — is the right shape; a
 *  handle method here would need DesktopBootstrap.tsx to thread a new
 *  prop through (off this worker's file list) for zero behavioral gain.
 *  Persists `engine:"osspeech"` via the SAME updateSettings action
 *  persistDesktopModelToStore above already uses (store's normal
 *  setter, own un-awaited storage.saveSettings), then fire-and-forgets
 *  preinstallOsSpeech(settings.language) so the model is warm by the
 *  user's first real meeting (blueprint §Q5) — NOT awaited: a slow or
 *  offline download must never block the wizard from dismissing
 *  (DesktopWizard.tsx calls onDismissConsent immediately after firing
 *  this, without awaiting it either). The `.catch()` below is
 *  deliberately silent, not a swallowed bug: osspeechCaps.ts's own
 *  preinstallOsSpeech already drives an "os-speech-asset" 后台任务 row
 *  for this attempt's whole duration (its own doc comment), which is
 *  this failure's real user-facing surface (blueprint §Q9's designed
 *  asset-download-failed path) — this call site only needs to stop an
 *  unhandled-rejection warning from a promise nothing else awaits.
 *  Durably prevents the wizard from re-showing on a LATER relaunch
 *  purely as a side effect of the persisted write above —
 *  bootstrapDesktop's own isFreshProvisionEntry branch re-reads this
 *  same persisted value fresh on every launch (see that branch's own
 *  doc comment), so no separate "wizard seen" marker is needed. */
export async function chooseOsSpeechEngine(): Promise<void> {
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
  const { settings, updateSettings } = useApp.getState();
  updateSettings({ engine: "osspeech" });
  void preinstallOsSpeech(settings.language).catch(() => {});
}

/** S4 review pair Finding 2 — the real BootstrapDeps.isMeetingActive
 *  implementation. Unlike getPersistedSidecarMode/getPersistedDesktopModel/
 *  persistDesktopModelToStore above (each awaited ONCE, up front,
 *  before any provisioning decision), this is called synchronously —
 *  possibly minutes later, from deep inside an already-in-flight
 *  switchModel() — so it can't itself be async. Resolves the store
 *  module + waits out hydration ONCE (same dynamic-import +
 *  hydration-gate shape as the three functions above, same rationale),
 *  then hands back a plain synchronous closure over the
 *  ALREADY-resolved `useApp` reference — cheap, since useApp.getState()
 *  is itself synchronous (zustand's own contract). Applies the SAME
 *  three-status predicate SettingsDialog.tsx's own `meetingActive`
 *  already does (connecting/listening/paused — see that file's own
 *  doc comment on why "paused" counts too) rather than a
 *  hand-duplicated rule. */
async function resolveIsMeetingActive(): Promise<() => boolean> {
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
  return () => {
    const status = useApp.getState().status;
    return status === "connecting" || status === "listening" || status === "paused";
  };
}

/** S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
 *  Q6/§3.5 HF-token) — the real BootstrapDeps.readHfToken
 *  implementation. Mirrors resolveIsMeetingActive immediately above
 *  exactly (same dynamic-import + hydration-gate-ONCE + "hand back a
 *  plain SYNCHRONOUS closure over the already-resolved `useApp`
 *  reference" shape, same rationale): a prewarm_model/start_server call
 *  can happen minutes into an already-running session (a model switch,
 *  a crash-restart), and the user may configure Settings.hfToken AFTER
 *  bootstrap first ran — the returned closure re-reads
 *  `useApp.getState().settings.hfToken` fresh on every call, never a
 *  value snapshotted once at bootstrap start. */
async function resolveReadHfToken(): Promise<() => string> {
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
  return () => useApp.getState().settings.hfToken;
}

async function bootstrapWithRealDeps(): Promise<DesktopBootstrapHandle> {
  const [tauriFetch, invoke, listen, isMeetingActive, readHfToken] = await Promise.all([
    getTauriFetch(),
    getInvoke(),
    getListen(),
    resolveIsMeetingActive(),
    resolveReadHfToken(),
  ]);
  return bootstrapDesktop({
    invoke,
    listen,
    tauriFetch,
    setTransport,
    getSidecarMode: getPersistedSidecarMode,
    getDesktopModel: getPersistedDesktopModel,
    getDesktopEngine: getPersistedEngine,
    persistDesktopModel: persistDesktopModelToStore,
    isMeetingActive,
    readHfToken,
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

// ---------------------------------------------------------------
// initIos() — S13 (docs/design-explorations/s13-ios-blueprint.md, §6
// D4/D6) — the iOS init path. ONLY the LLM transport wiring
// (setTransport(tauri-plugin-http fetch), byte-identical to
// bootstrapDesktop's own step ① above) — none of initDesktop's
// sidecar/uv/wizard machinery: v1 iOS ships no uv/server/provision
// modules at all (blueprint D3 — those Rust modules are `#[cfg(desktop)]`-
// gated out of the iOS binary entirely), so there is nothing here for a
// DesktopBootstrapHandle/DesktopWizard to drive. A separate function
// rather than parameterizing bootstrapDesktop itself: that function's
// entire body (app_paths, the provision machine, the drive loop, every
// DesktopBootstrapHandle method) is desktop-only surface with no iOS
// analog, so branching it in place would be a far larger diff than a
// second, much smaller entry point that shares only the two things iOS
// actually needs (getTauriFetch/setTransport, already imported above).
// ---------------------------------------------------------------

let cachedIosPromise: Promise<void> | null = null;

async function bootstrapIos(): Promise<void> {
  const tauriFetch = await getTauriFetch();
  setTransport(tauriFetch);

  // S13.1 (docs/design-explorations/s13-ios-blueprint.md) — spike
  // harness gate: `spike_flags` echoes this launch's own argv
  // (devspike_ios.rs), armed only by `xcrun simctl launch … --spike-
  // osspeech`. The dynamic import keeps iosSpike.ts's own
  // createEngine/osSpeech pull out of every ordinary iOS build/boot —
  // best-effort try/catch so a spike-harness failure can never break a
  // real launch.
  try {
    const invoke = await getInvoke();
    const flags = await invoke<string[]>("spike_flags");
    if (flags.includes("--spike-osspeech")) {
      const { runIosSpike } = await import("./iosSpike");
      await runIosSpike();
    }
  } catch {
    // best-effort — see this block's own comment above.
  }
}

/** Call once during iOS app init (app/page.tsx, mounted under IS_IOS —
 *  see that file's own header comment). Idempotent: every call after the
 *  first returns the SAME cached promise, never re-runs setTransport
 *  again — mirrors initDesktop()'s own caching shape exactly.
 *
 *  Guards on a DIRECT `process.env.NEXT_PUBLIC_IOS === "1"` literal
 *  here, same rationale as initDesktop()'s own doc comment above (NOT
 *  the re-exported `IS_IOS` const — a re-exported const imported across
 *  a module boundary isn't reliably pruned by webpack/Terser's
 *  dead-branch elimination the same way a direct literal at the call
 *  site is): this makes `bootstrapIos` (and therefore its own
 *  getTauriFetch()/`import("@tauri-apps/plugin-http")` call) provably
 *  uncalled in an ordinary web OR macOS-desktop build, so it tree-shakes
 *  out entirely. */
export function initIos(): Promise<void> {
  if (!cachedIosPromise) {
    cachedIosPromise = process.env.NEXT_PUBLIC_IOS === "1" ? bootstrapIos() : Promise.resolve();
  }
  return cachedIosPromise;
}

/** Test-only reset — clears the cached iOS init promise. Mirrors
 *  resetDesktopBootstrap() immediately above. */
export function resetIosBootstrap(): void {
  cachedIosPromise = null;
}
