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
import { getInvoke, getListen, getTauriFetch, type InvokeFn, type ListenFn, type TauriFetchFn } from "./tauriApi";
import {
  getAppPaths,
  runEffects,
  stopServer,
  type LogStream,
  type OnLog,
  type PrewarmProgressEvent,
} from "./provisionRunner";
import type { DesktopPaths } from "./uvCommands";
import {
  decideRestart,
  initial,
  initialRestartState,
  transition,
  MAX_RESTARTS_PER_WINDOW,
  RESTART_WINDOW_MS,
  type MachineState,
  type ProvisionContext,
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
   *  stray/late call, same contract as retryStep). */
  beginProvision: () => void;
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
  const ctx: ProvisionContext = { paths, model: deps.model ?? DEFAULT_DESKTOP_MODEL };

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
    beginProvision() {
      if (!awaitingConsent) return;
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

async function bootstrapWithRealDeps(): Promise<DesktopBootstrapHandle> {
  const [tauriFetch, invoke, listen] = await Promise.all([getTauriFetch(), getInvoke(), getListen()]);
  return bootstrapDesktop({ invoke, listen, tauriFetch, setTransport, getSidecarMode: getPersistedSidecarMode });
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
