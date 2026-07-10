// Background task registry (#58) — the in-app "task center" substrate.
// A zustand store slice, IN-MEMORY ONLY, session-scoped (no
// persistence in v1 — matches the pre-existing "refresh loses import
// progress" tradeoff HistoryDrawer's old component-local job state
// already had; the sidecar keeps its own job state for recovery
// independent of this). zustand IS the event bus here — no pub/sub
// library, no extra abstraction: StatusLine's task chip/tray and
// HistoryDrawer's inline job rows both just subscribe to this same
// store (see the selectors at the bottom).
//
// runTracked/runTrackedAsync are thin wrappers used at IMPORT CALL
// SITES (ImportHub, HistoryDrawer) — stt/upload.ts's importAndTrack/
// importUrlAndTrack keep their existing ImportCallbacks contract
// completely unchanged (design decision 2: "refactor don't rebuild");
// a caller composes its own UI callbacks with the ones runTracked
// hands back so BOTH fire per event, and the registry becomes the
// single source of truth that survives the hub/drawer closing and
// reopening.

import { create } from "zustand";
import { newId } from "../types";
import { useApp } from "../store";
import { postTaskWebhook } from "../history/autoExport";
import { diagLog } from "../diag/log";

export type TaskKind = "import-audio" | "import-video" | "import-url" | "import-text";
export type TaskStatus = "running" | "done" | "error";

export interface TaskState {
  id: string;
  kind: TaskKind;
  label: string;
  stage: string;
  progress?: number;
  status: TaskStatus;
  error?: string;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
}

interface TaskRegistryStore {
  tasks: Record<string, TaskState>;
}

export const useTasks = create<TaskRegistryStore>(() => ({ tasks: {} }));

/** Referentially-stable empty list — narrow zustand selectors return
 *  this (instead of a fresh `[]` literal) when they have nothing to
 *  show, so the store's default Object.is comparison sees "no change"
 *  and skips a re-render (review fix 6: a closed tray/drawer shouldn't
 *  re-render on every progress tick just because it's still subscribed
 *  to the tasks map). See TaskTray's/HistoryDrawer's `open`-gated
 *  selectors.
 *
 *  INVARIANT (zustand v5): any useTasks selector that DERIVES an
 *  array/object (selectTrayTasks, activeImportRows, ...) must be
 *  wrapped in useShallow at the hook call site. v5's plain
 *  useSyncExternalStore has no selector-output caching — a selector
 *  returning a fresh reference per call re-renders in an infinite
 *  loop and crashes with React #185 ("Maximum update depth exceeded",
 *  the 2026-07-10 prod crash). Primitive-returning selectors are safe
 *  bare. */
export const EMPTY_TASKS: TaskState[] = [];

// Terminal-task cap (review fix 6): unbounded done/error tasks would
// otherwise grow the in-memory registry for the lifetime of a long
// session. Pruned on every startTask insert, oldest-updated first —
// running tasks are NEVER pruned, only done/error ones once they
// exceed the cap.
const MAX_TERMINAL_TASKS = 20;

function pruneTerminalTasks(tasks: Record<string, TaskState>): Record<string, TaskState> {
  const terminal = Object.values(tasks)
    .filter((t) => t.status !== "running")
    .sort((a, b) => a.updatedAt - b.updatedAt);
  const excess = terminal.length - MAX_TERMINAL_TASKS;
  if (excess <= 0) return tasks;
  const toRemove = new Set(terminal.slice(0, excess).map((t) => t.id));
  const next: Record<string, TaskState> = {};
  for (const [id, t] of Object.entries(tasks)) {
    if (!toRemove.has(id)) next[id] = t;
  }
  return next;
}

// Per-task webhook destination, captured once at startTask (review fix
// 7) — read fresh from settings only there, then reused for every
// event of that SAME task (task.started/task.done/task.error all land
// at the one destination even if settings.webhookUrl changes mid-task).
// Deliberately a private side-table, not a TaskState field: the value
// must never end up in the payload postTaskWebhook serializes. Cleared
// once a task reaches a terminal webhook event — no more events will
// ever fire for that id.
const taskWebhookUrls = new Map<string, string>();

/** Fire-and-forget task.* webhook — reuses the SAME webhookUrl setting
 *  autoExport.ts's postWebhook already POSTs meeting.saved to (design
 *  decision 5: "the event bus doubles as the connector hook", no new
 *  config surface). No-ops silently when no webhookUrl was configured
 *  at task-start time. */
function emitTaskEvent(event: "task.started" | "task.done" | "task.error", task: TaskState): void {
  const url = taskWebhookUrls.get(task.id);
  if (event !== "task.started") taskWebhookUrls.delete(task.id);
  if (!url) return;
  void postTaskWebhook(task, event, url);
}

function patchTask(id: string, patch: Partial<TaskState>): TaskState | undefined {
  let next: TaskState | undefined;
  useTasks.setState((s) => {
    const existing = s.tasks[id];
    if (!existing) return s;
    next = { ...existing, ...patch, updatedAt: Date.now() };
    return { tasks: { ...s.tasks, [id]: next } };
  });
  return next;
}

export function startTask(id: string, kind: TaskKind, label: string): TaskState {
  const now = Date.now();
  const task: TaskState = {
    id,
    kind,
    label,
    stage: "",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  taskWebhookUrls.set(id, useApp.getState().settings.webhookUrl ?? "");
  useTasks.setState((s) => ({ tasks: pruneTerminalTasks({ ...s.tasks, [id]: task }) }));
  emitTaskEvent("task.started", task);
  return task;
}

export function updateTaskProgress(id: string, progress: number, stage: string): void {
  patchTask(id, { progress, stage });
}

export function completeTask(id: string, sessionId?: string): void {
  const task = patchTask(id, { status: "done", sessionId });
  if (task) emitTaskEvent("task.done", task);
}

// Diagnostics privacy (tag-blocker MEDIUM 4): a task-failure string can
// come straight from a sidecar/job (upload/import) error and may carry
// a URL with a query string — filenames, signed params, tokens. This
// ONLY scrubs the copy of the message headed for the diag ring buffer
// (log.ts's copyable 诊断信息 panel/report) — failTask's own `error`
// (below, on TaskState) and the tray/task UI that reads it stay
// untouched. log.ts's own DIAG_MAX_FIELD_CHARS truncation still applies
// on top of this at insertion (see log.ts's diagLog).
function redactUrlsForDiag(message: string): string {
  return message.replace(/https?:\/\/\S+/gi, "<url>");
}

export function failTask(id: string, error: string): void {
  const task = patchTask(id, { status: "error", error });
  if (task) {
    // Diagnostics choke point (item 2): task kind + error message only
    // — never the imported session/file content that led here.
    diagLog("error", "task-registry", `${task.kind} 任务失败`, redactUrlsForDiag(error));
    emitTaskEvent("task.error", task);
  }
}

/** Removes a task from the registry — the tray's per-row dismiss
 *  affordance for a finished (done/error) task. Never called on a
 *  still-running task by any current caller. */
export function dismissTask(id: string): void {
  useTasks.setState((s) => {
    if (!(id in s.tasks)) return s;
    const next = { ...s.tasks };
    delete next[id];
    return { tasks: next };
  });
}

// ---------------------------------------------------------------
// runTracked wrappers
// ---------------------------------------------------------------

interface TrackedCallbacks {
  onProgress: (progress: number, stage: string) => void;
  onDone: (sessionId: string) => void;
  onError: (message: string) => void;
}

/** Wraps an ImportCallbacks-shaped call (stt/upload.ts's importAndTrack
 *  / importUrlAndTrack — signatures untouched) so its progress/done/
 *  error events ALSO write the task registry. The caller still passes
 *  its own callbacks for local UI work (hydrate/toast/etc) — call the
 *  handed-back `callbacks` from inside them so BOTH fire. Returns the
 *  new taskId immediately (the underlying call is still async and
 *  never throws, per upload.ts's own contract). */
export function runTracked(
  kind: TaskKind,
  label: string,
  fn: (callbacks: TrackedCallbacks) => void,
): string {
  const id = newId();
  startTask(id, kind, label);
  fn({
    onProgress: (progress, stage) => updateTaskProgress(id, progress, stage),
    onDone: (sessionId) => completeTask(id, sessionId),
    onError: (message) => failTask(id, message),
  });
  return id;
}

/** For import paths that return a Promise instead of using the
 *  ImportCallbacks contract (importAudio.ts, importText.ts — both can
 *  throw and resolve to `{sessionId, warnings}` rather than invoking
 *  callbacks) — same registry lifecycle, adapted to that shape. The
 *  returned `result` promise still rejects exactly like the wrapped
 *  call would have; the registry's own error is recorded regardless of
 *  whether the caller goes on to catch it. */
export function runTrackedAsync<T extends { sessionId: string }>(
  kind: TaskKind,
  label: string,
  run: (onProgress: (progress: number, stage: string) => void) => Promise<T>,
): { id: string; result: Promise<T> } {
  const id = newId();
  startTask(id, kind, label);
  const result = run((progress, stage) => updateTaskProgress(id, progress, stage))
    .then((value) => {
      completeTask(id, value.sessionId);
      return value;
    })
    .catch((err: unknown) => {
      failTask(id, err instanceof Error ? err.message : String(err));
      throw err;
    });
  return { id, result };
}

// ---------------------------------------------------------------
// Pure selectors — chip/tray derivation logic extracted for
// testability (prefer pure functions, per the plan's own note).
// ---------------------------------------------------------------

export function selectRunningTasks(tasks: Record<string, TaskState>): TaskState[] {
  return Object.values(tasks).filter((t) => t.status === "running");
}

export function selectRunningCount(tasks: Record<string, TaskState>): number {
  return selectRunningTasks(tasks).length;
}

/** Tray list order: most-recently-updated first, so a just-finished or
 *  just-failed task surfaces next to whatever is still running rather
 *  than sinking to the bottom behind older, still-running ones. */
export function selectTrayTasks(tasks: Record<string, TaskState>): TaskState[] {
  return Object.values(tasks).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function selectHasTasks(tasks: Record<string, TaskState>): boolean {
  return Object.keys(tasks).length > 0;
}

/** Total task count — the collapsed chip's idle-state number (review
 *  fix 1/6: it must stay live regardless of whether the tray popover
 *  is open, unlike selectTrayTasks' sorted row list, so it's its own
 *  narrow primitive selector rather than reading `trayTasks.length`). */
export function selectTotalCount(tasks: Record<string, TaskState>): number {
  return Object.keys(tasks).length;
}

/** Whether the tray's per-row dismiss (X) affordance should render for
 *  a task (review fix 3) — gated to non-running so dismissing never
 *  dangles a still-in-flight task's webhook lifecycle (task.done/
 *  task.error would otherwise never have anywhere to land once the
 *  user has already removed the row). Mirrors HistoryDrawer's own
 *  error-only 忽略 control, and makes dismissTask's own doc comment
 *  above ("never called on a still-running task") literally true. */
export function selectCanDismiss(status: TaskStatus): boolean {
  return status !== "running";
}
