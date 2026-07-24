// S10 field-fix #6 (Q2 verdict) — bridges DesktopBootstrapHandle's
// switchModel()/installDiarization() Promise-returning actions into
// lib/tasks/registry.ts's task registry, mirroring runTrackedAsync's
// own start/progress/settle shape (registry.ts ~line 314) WITHOUT
// reusing that function directly — its generic constrains the resolved
// value to `{ sessionId: string }` (an import-flow shape neither
// switchModel nor installDiarization produce). Both wrappers are called
// from SettingsDialog's 更换模型/安装扩展 buttons (wave 2 wiring) — the
// whole point of routing through the MODULE-GLOBAL registry instead of
// SettingsDialog's own component-local busy state is that the job now
// outlives the dialog closing.

import { newId } from "@jargonslayer/core/types";
import { completeTask, failTask, startTask, updateTaskProgress, useTasks } from "../tasks/registry";
import { useApp } from "../store";
import { probeSidecar } from "../stt/sidecarHealth";
import { MODEL_CATALOG } from "./modelCatalog";
import {
  MLX_INSTALL_STAGE_LABELS,
  type DesktopBootstrapHandle,
  type DesktopBootstrapState,
  type SwitchModelProgress,
} from "./bootstrap";

// Side-table: which model a given model-download task was FOR — never
// folded into TaskState itself (its shape stays exactly what #58
// pinned; see registry.ts's own taskWebhookUrls/taskLastStage for the
// established "private side-table, must never leak into TaskState/the
// tray UI" precedent). TaskCenterDrawer's per-row 重试 action reads
// this back via modelForTask() to re-call trackSwitchModel with the
// SAME model once the task has already gone terminal (error) — at that
// point nothing else on TaskState says which model it was, so this must
// survive PAST settling (done/error), not just while "running".
const modelByTaskId = new Map<string, string>();

// F11 (LOW, adversarial review): the doc comment above USED TO claim
// "the registry's own MAX_TERMINAL_TASKS pruning already bounds how
// many terminal task ids can pile up" — false: that cap only bounds
// registry.ts's OWN `tasks` map, a completely separate module-level
// object this side-table never shared. Pruning it at task SETTLE time
// (completeTask/failTask) would break the 重试 flow's own read (above)
// though, so this instead mirrors the task's ACTUAL removal from the
// registry — subscribed once, for the module's whole (session-scoped)
// lifetime: whenever a tracked id disappears from `s.tasks` (either
// dismissTask's explicit removal, or pruneTerminalTasks' own FIFO
// eviction — this can't tell which, and doesn't need to), its mapping
// is pruned in lockstep. A still-running task is never affected (its
// id never leaves `s.tasks` while running).
useTasks.subscribe((state) => {
  for (const id of modelByTaskId.keys()) {
    if (!(id in state.tasks)) modelByTaskId.delete(id);
  }
});

/** The model a model-download task (running OR settled) was started
 *  for — undefined for any other task id (never tracked here, or an id
 *  that was never a model-download task at all). */
export function modelForTask(id: string): string | undefined {
  return modelByTaskId.get(id);
}

/** MODEL_CATALOG's own zh label when `model` is a curated entry, else
 *  the raw model id verbatim (a manually-dropped-in/legacy model still
 *  needs SOME label — see modelCatalog.ts's own doc on tiny/base being
 *  catalog-excluded but still ALLOWED_MARKER_MODELS-valid). */
function modelLabel(model: string): string {
  return MODEL_CATALOG.find((entry) => entry.id === model)?.label ?? model;
}

/** S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
 *  Provision/Task 7) — true for SwitchModelProgress's three mlx-install
 *  sub-phases (bootstrap.ts's ensureMlxExtras), false for the
 *  pre-existing "downloading"/"restarting" ones. A type guard (not a
 *  bare `in`/key check) so trackSwitchModel's own branch below narrows
 *  `progress.phase` to MLX_INSTALL_STAGE_LABELS' exact key type. */
function isMlxInstallPhase(
  phase: SwitchModelProgress["phase"],
): phase is keyof typeof MLX_INSTALL_STAGE_LABELS {
  return phase === "mlx-venv" || phase === "mlx-pip" || phase === "mlx-preflight";
}

/** SettingsDialog's 转录引擎 「更换模型」 confirm button (wave 2 call
 *  site): tracks an in-flight handle.switchModel(model) call as a
 *  "model-download" task. Subscribes switchModelProgress$ BEFORE
 *  calling switchModel() so the very first phase update (performSwitch
 *  Model's own leading `{phase:"downloading",progress:0}`, see
 *  bootstrap.ts) is never missed. Phase mapping: "downloading" carries
 *  switchModel's own 0..1 fraction through as-is; "restarting" has no
 *  fraction left (the download job is done) — passing `undefined`
 *  clears the tray's progress bar in favor of stage text alone, exactly
 *  registry.ts's own established "no trustworthy ratio" contract (see
 *  updateTaskProgress's doc comment). Unsubscribes on settle either
 *  way. Returns the new task's id (rarely needed by the caller — the
 *  registry is the source of truth from here on).
 *
 *  S12a (§C Provision/Task 7): an mlx-family switch's leading extras
 *  phase gets its OWN, separate "mlx-install" task row (lazily started
 *  the moment the FIRST mlx-* phase update arrives — never for a plain
 *  whisper-family switch, which emits none) — mirrors trackOsSpeechAsset's
 *  own "lazy row start" shape, just driven by switchModelProgress$
 *  instead of a raw event listener. The transition INTO "downloading"
 *  (bucket 1 of performSwitchModel, always emitted right after
 *  ensureMlxExtras succeeds) IS this row's own success signal —
 *  completeTask() fires there, before the pre-existing "model-download"
 *  row handling below even runs for that same tick. If the OUTER
 *  switchModel() call instead rejects while the mlx row is STILL open
 *  (never saw "downloading" — the extras phase itself is what failed),
 *  that row is failed too, with the SAME rejection message the
 *  "model-download" row already gets. */
export function trackSwitchModel(handle: DesktopBootstrapHandle, model: string): string {
  const id = newId();
  startTask(id, "model-download", modelLabel(model));
  modelByTaskId.set(id, model);

  let mlxTaskId: string | null = null;

  const unsubscribe = handle.switchModelProgress$((progress) => {
    if (!progress) return; // null = no active phase (reset at both ends by bootstrap.ts) — settle below handles the terminal state itself

    if (isMlxInstallPhase(progress.phase)) {
      if (!mlxTaskId) {
        mlxTaskId = newId();
        startTask(mlxTaskId, "mlx-install", "MLX 运行环境");
      }
      updateTaskProgress(mlxTaskId, undefined, MLX_INSTALL_STAGE_LABELS[progress.phase]);
      return;
    }
    if (mlxTaskId) {
      // Reaching a non-mlx phase (only ever "downloading" in practice —
      // performSwitchModel's own pinned order runs the extras phase to
      // completion before bucket 1 starts) proves the mlx row finished
      // successfully.
      completeTask(mlxTaskId);
      mlxTaskId = null;
    }

    if (progress.phase === "restarting") {
      updateTaskProgress(id, undefined, "启动中");
    } else {
      updateTaskProgress(id, progress.progress, "下载中");
    }
  });

  handle
    .switchModel(model)
    .then(() => completeTask(id))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (mlxTaskId) failTask(mlxTaskId, message); // the extras phase never reached "downloading" — it's what failed
      failTask(id, message);
    })
    .finally(() => unsubscribe());

  return id;
}

/** Field-test issue 6 (cancellable first-run model downloads) —
 *  DesktopBootstrap.tsx's own 「后台继续」 handler (STEP/DOWNLOAD_MODEL/
 *  RUNNING) calls this the instant the user backgrounds the wizard,
 *  giving the download a live tray surface for the REST of the drive —
 *  through to either HEALTHY (success) or a genuine STEP/ERROR
 *  (failure), see bootstrap.ts's own downloadWasCancelled interception
 *  for why a user-cancelled download never reaches STEP/ERROR at all.
 *  `model` is the wizard's own <ModelPicker> pick at beginProvision()
 *  time (DesktopBootstrap.tsx stashes it in a ref for exactly this
 *  call), used only for modelLabel(model) — the row's display label.
 *
 *  Unlike trackSwitchModel/trackInstallDiar above (each subscribes a
 *  Promise-returning DesktopBootstrapHandle action itself), this is a
 *  PUSH-style driver mirroring trackOsSpeechAsset's own shape: first-run
 *  provisioning's beginProvision()/drive() loop is fire-and-forget from
 *  this handle's own vantage point (no one Promise whose resolution IS
 *  the outcome), so this instead watches handle.state$ for whichever
 *  terminal-ish transition happens first —
 *    HEALTHY                      -> completeTask
 *    STEP + status "ERROR"        -> failTask(state.error) — a genuine
 *      crash/failure (e.g. disk full), never a cancel (see above)
 *    any OTHER phase left "STEP"  -> failTask("已取消") — in practice
 *      the cancel_prewarm/「取消下载」 landing spot (WIZARD_CONSENT_
 *      REQUIRED), but also covers any other exotic bounce-back;
 *      mirrors trackOsSpeechAsset's settle()'s own "neutral message
 *      when the flow ends some OTHER way" precedent. A rare, narrow
 *      imprecision: a REAL TERMINAL_ERROR (repeated crash-restart,
 *      unrelated to this download) landing here too would ALSO read
 *      "已取消" rather than its own reason — accepted rather than adding
 *      a third branch for an interaction this unlikely.
 *
 *  Deliberately never registered in modelByTaskId (unlike
 *  trackSwitchModel) — TaskCenterDrawer's own 重试 button is gated on
 *  modelForTask(task.id) precisely so it never renders for THIS row: a
 *  first-run download's own retry path is reopening the wizard (帮助
 *  menu), never a bare switchModel(model) call, which requires an
 *  already-HEALTHY sidecar — the opposite of what just failed here.
 *  The SAME absence is also what tray cancel (TaskCenterDrawer.tsx)
 *  reads to route a running row's cancel click to handle.cancelPrewarm()
 *  instead of handle.cancelSwitchModel(). */
export function trackPrewarm(handle: DesktopBootstrapHandle, model: string): string {
  const id = newId();
  startTask(id, "model-download", modelLabel(model));

  // F5 (Sol LOW #21, review round): state$ is non-replaying (see
  // DesktopBootstrapHandle's own contract) — a caller invoked in a
  // stale render, after the drive already reached a terminal state
  // (HEALTHY / STEP+ERROR / bounced off STEP entirely) BEFORE this
  // function ever subscribed, would otherwise never see another
  // notification and the tray row would stay "running" until the next
  // reload. Shares its settle logic with the state$ subscription below
  // (same three-way branch) so both paths agree on what counts as
  // terminal.
  function settleFromState(state: DesktopBootstrapState): boolean {
    if (state.phase === "HEALTHY") {
      completeTask(id);
    } else if (state.phase === "STEP" && state.status === "ERROR") {
      failTask(id, state.error);
    } else if (state.phase !== "STEP") {
      failTask(id, "已取消");
    } else {
      return false; // still an in-flight STEP (RUNNING/POLLING, non-ERROR) — keep waiting
    }
    return true;
  }

  if (settleFromState(handle.currentState())) {
    return id; // already terminal at track time — never even subscribe
  }

  const unsubProgress = handle.downloadProgress$((progress) => {
    if (!progress) return;
    updateTaskProgress(id, progress.total > 0 ? progress.downloaded / progress.total : undefined, "下载中");
  });
  const unsubState = handle.state$((state) => {
    if (!settleFromState(state)) return;
    unsubProgress();
    unsubState();
  });

  return id;
}

/** SettingsDialog's 说话人分离 「安装扩展」 button (wave 2 call site):
 *  tracks an in-flight handle.installDiarization() call as an
 *  INDETERMINATE "diar-install" task (installDiarization() itself
 *  exposes no progress surface — see bootstrap.ts's own doc comment on
 *  why: the venv install has no phase/fraction to report). On success,
 *  re-probes the sidecar (probeSidecar — the SAME GET /health helper
 *  SettingsDialog's own 转录引擎 status row and this drawer's system-
 *  status sidecar row already use) and mirrors the result into the
 *  global store exactly like every other probe call site in this app
 *  does, so `sidecarUp`/`installed`-derived UI everywhere reflects the
 *  freshly-installed state without a page reload — decision C's "the
 *  running server is the truth" posture, not an optimistic flip.
 *  A re-probe failure can't actually happen (probeSidecar never throws
 *  — see its own doc comment), so there's no separate error path to
 *  reconcile against the task's own already-succeeded outcome. */
export function trackInstallDiar(handle: DesktopBootstrapHandle): string {
  const id = newId();
  startTask(id, "diar-install", "说话人分离扩展");
  updateTaskProgress(id, undefined, "安装中");

  handle
    .installDiarization()
    .then(async () => {
      const result = await probeSidecar(useApp.getState().settings);
      useApp.getState().setSidecarUp(result.up);
      completeTask(id);
    })
    .catch((err: unknown) => failTask(id, err instanceof Error ? err.message : String(err)));

  return id;
}

// --- os-speech-asset (S11, docs/design-explorations/
// s11-osspeech-blueprint.md, Worker C) ---

// The four osspeech://status kinds (lib/stt/osSpeech.ts's own
// OsSpeechStatusKind) this tracker ever reacts to — kept as its own
// narrow local union rather than importing OsSpeechStatusKind's full
// 13-kind closed set, since this module only ever cares about these
// four regardless of which lane call site is feeding them in (see
// trackOsSpeechAsset's own doc comment).
export type OsSpeechAssetKind = "asset-checking" | "asset-downloading" | "asset-installed" | "asset-failed";

export interface OsSpeechAssetTracker {
  handle(kind: OsSpeechAssetKind, progress?: number, message?: string): void;
  /** S11 fix-round J2(c): settles a still-RUNNING row with a neutral
   *  "stopped" message when the flow ends some OTHER way — any terminal
   *  osspeech://status kind besides asset-installed/asset-failed, both
   *  of which already settle the row themselves via `handle` above (see
   *  OsSpeechEngine.handleStatus's own terminal-latch branch, the one
   *  caller). Looks up the CURRENTLY active row via the registry, not
   *  this tracker's own local id — §J2(b)'s single-flight means the
   *  running row may belong to a DIFFERENT tracker instance entirely
   *  (the preempt-handoff case: a preinstall's row, now being driven by
   *  this session). No-op if no row is running. */
  settle(): void;
}

const OS_SPEECH_ASSET_LABEL = "系统识别模型";

// S11 fix-round J2 (b): the preempt handoff (a session start superseding
// an in-flight preinstall, per the osspeech://status `source` contract —
// see osSpeech.ts's own OsSpeechStatusPayload doc) must show exactly ONE
// "os-speech-asset" row throughout, never a second one the moment the
// session's OWN asset events start arriving on its OWN, freshly-created
// tracker (OsSpeechEngine mints "a FRESH tracker every start()" — see
// this file's own trackOsSpeechAsset doc below). Queried by kind+status
// alone (TaskState carries no `source` of its own, deliberately — see
// registry.ts's TaskState shape), so it's single-flighted across EVERY
// tracker instance, regardless of which side (an engine session or
// preinstallOsSpeech) created the row in the first place.
function activeOsSpeechAssetTaskId(): string | null {
  for (const task of Object.values(useTasks.getState().tasks)) {
    if (task.kind === "os-speech-asset" && task.status === "running") return task.id;
  }
  return null;
}

const OS_SPEECH_ASSET_STOPPED_MESSAGE = "系统识别已停止，模型下载未完成";

/** Drives an "os-speech-asset" task row off osspeech://status asset
 *  lifecycle events — a PUSH-style driver (unlike trackSwitchModel/
 *  trackInstallDiar above, which each subscribe a Promise-returning
 *  DesktopBootstrapHandle action themselves): both OsSpeechEngine's own
 *  osspeech://status listener (mid-session auto-download, §2.6) and
 *  osspeechCaps.ts's preinstallOsSpeech (its own, separate listener)
 *  feed this from whichever asset events THEY observe on their own
 *  lane — this function owns no listener of its own.
 *
 *  Per §2.6, the task row itself only ever starts at "asset-downloading"
 *  (or defensively at "asset-failed", so a checking-phase failure still
 *  surfaces a visible failed row rather than only a status toast) —
 *  "asset-checking" alone never creates a row (a model that's already
 *  installed only ever sees checking -> installed, with no download
 *  phase in between, and must never show an empty task row for that).
 *  "asset-installed" completes the row only if one was ever started —
 *  a no-op otherwise. Call ONCE per session/attempt — a fresh tracker
 *  every time, never reused across sessions (a reused tracker would
 *  attach a LATER session's events onto an EARLIER, already-settled
 *  task id) — §J2(b)'s single-flight check (activeOsSpeechAssetTaskId)
 *  is what lets that be true while STILL sharing one row across the
 *  preempt handoff: a fresh tracker's own local `id` starts null every
 *  time, but adopts whatever row is ALREADY running before minting a
 *  new one. */
export function trackOsSpeechAsset(label: string = OS_SPEECH_ASSET_LABEL): OsSpeechAssetTracker {
  let id: string | null = null;
  return {
    handle(kind, progress, message) {
      switch (kind) {
        case "asset-checking":
          break;
        case "asset-downloading":
          if (!id) {
            id = activeOsSpeechAssetTaskId();
            if (!id) {
              id = newId();
              startTask(id, "os-speech-asset", label);
            }
          }
          updateTaskProgress(id, progress, "下载中");
          break;
        case "asset-installed": {
          const target = id ?? activeOsSpeechAssetTaskId();
          if (target) completeTask(target);
          break;
        }
        case "asset-failed": {
          if (!id) {
            id = activeOsSpeechAssetTaskId();
            if (!id) {
              id = newId();
              startTask(id, "os-speech-asset", label);
            }
          }
          failTask(id, message || "系统识别模型下载失败");
          break;
        }
      }
    },
    settle() {
      const target = id ?? activeOsSpeechAssetTaskId();
      if (target && useTasks.getState().tasks[target]?.status === "running") {
        failTask(target, OS_SPEECH_ASSET_STOPPED_MESSAGE);
      }
    },
  };
}
