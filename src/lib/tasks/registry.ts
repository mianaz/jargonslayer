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

/** Fire-and-forget task.* webhook — reuses the SAME webhookUrl setting
 *  autoExport.ts's postWebhook already POSTs meeting.saved to (design
 *  decision 5: "the event bus doubles as the connector hook", no new
 *  config surface). No-ops silently when no webhookUrl is configured. */
function emitTaskEvent(event: "task.started" | "task.done" | "task.error", task: TaskState): void {
  const url = useApp.getState().settings.webhookUrl;
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
  useTasks.setState((s) => ({ tasks: { ...s.tasks, [id]: task } }));
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

export function failTask(id: string, error: string): void {
  const task = patchTask(id, { status: "error", error });
  if (task) emitTaskEvent("task.error", task);
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
