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
import type { DesktopBootstrapHandle } from "./bootstrap";

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
 *  registry is the source of truth from here on). */
export function trackSwitchModel(handle: DesktopBootstrapHandle, model: string): string {
  const id = newId();
  startTask(id, "model-download", modelLabel(model));
  modelByTaskId.set(id, model);

  const unsubscribe = handle.switchModelProgress$((progress) => {
    if (!progress) return; // null = no active phase (reset at both ends by bootstrap.ts) — settle below handles the terminal state itself
    if (progress.phase === "restarting") {
      updateTaskProgress(id, undefined, "启动中");
    } else {
      updateTaskProgress(id, progress.progress, "下载中");
    }
  });

  handle
    .switchModel(model)
    .then(() => completeTask(id))
    .catch((err: unknown) => failTask(id, err instanceof Error ? err.message : String(err)))
    .finally(() => unsubscribe());

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
