"use client";

// Task chip + tray (#58 design decision 4) — StatusLine-mounted
// in-app surface for the background task registry (src/lib/tasks/
// registry.ts). Spinner + N while any task is running; once nothing is
// running, a static count keeps recently finished/errored tasks
// reachable (jump-to-session on done) until dismissed — no persistence,
// purely this session, same tradeoff the old component-local job rows
// already had. No browser Notification API (explicit v1 scope
// decision, see the registry module doc) — completion is surfaced via
// the existing toast; this tray is a detail/history view, not the
// notification itself.

import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { CheckCircle, ListChecks, WarningCircle, X } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { handleButtonKeyDown } from "@/lib/a11y";
import {
  dismissTask,
  EMPTY_TASKS,
  selectCanDismiss,
  selectHasTasks,
  selectRunningCount,
  selectTotalCount,
  selectTrayTasks,
  useTasks,
  type TaskState,
} from "@/lib/tasks/registry";

const KIND_LABEL: Record<TaskState["kind"], string> = {
  "import-audio": "音频导入",
  "import-video": "视频导入",
  "import-url": "链接导入",
  "import-text": "文稿导入",
};

export default function TaskTray() {
  const loadSession = useApp((s) => s.loadSession);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Narrow selectors (review fix 6): runningCount/hasTasks/totalCount
  // are primitives, so a progress-only tick (stage/progress% changing
  // without any of those changing) doesn't re-render this chip at all.
  // trayTasks — the only piece that needs the full per-row stage/
  // progress — is only computed while the popover is actually open;
  // closed, it resolves to the SAME EMPTY_TASKS reference every time,
  // so a closed tray sees zero re-renders from progress ticks.
  //
  // useShallow is load-bearing, not an optimization: zustand v5's
  // plain useSyncExternalStore requires referentially-stable selector
  // output, and selectTrayTasks builds a fresh array per call — bare,
  // that loops render→snapshot forever the moment the tray opens with
  // any task present (the 2026-07-10 prod React #185 crash; see
  // TaskTray.test.tsx).
  const runningCount = useTasks((s) => selectRunningCount(s.tasks));
  const hasTasks = useTasks((s) => selectHasTasks(s.tasks));
  const totalCount = useTasks((s) => selectTotalCount(s.tasks));
  const trayTasks = useTasks(useShallow((s) => (open ? selectTrayTasks(s.tasks) : EMPTY_TASKS)));

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [open]);

  // A dismiss/jump action can drain the registry to empty while the
  // tray is open — close rather than leave an empty popover floating.
  useEffect(() => {
    if (!hasTasks) setOpen(false);
  }, [hasTasks]);

  if (!hasTasks) return null;

  const jumpToSession = (task: TaskState) => {
    if (!task.sessionId) return;
    void loadSession(task.sessionId);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative flex h-full items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="后台任务"
        className="flex h-full items-center gap-1.5 whitespace-nowrap px-2 font-mono text-xs text-mut hover:bg-panel3 hover:text-fg sm:px-3"
      >
        {runningCount > 0 ? (
          <>
            <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent" />
            {runningCount}
          </>
        ) : (
          <>
            {/* Icon only <sm (#58 review fix 1): the chip is now reachable
                below 640px too, and a bare number there reads as
                ambiguous next to the rest of the status line — desktop
                keeps its pre-existing bare-number presentation. */}
            <ListChecks size={12} weight="regular" className="sm:hidden" />
            <span className="tabular-nums">{totalCount}</span>
          </>
        )}
      </button>

      {open && (
        <div className="scroll-thin fixed inset-x-4 bottom-9 z-50 max-h-80 overflow-y-auto rounded-none border border-edge2 bg-panel2 p-1.5 shadow-xl sm:absolute sm:inset-x-auto sm:bottom-full sm:right-0 sm:mb-2 sm:w-72">
          {trayTasks.map((task) => {
            const jumpable = task.status === "done" && !!task.sessionId;
            return (
              <div
                key={task.id}
                role={jumpable ? "button" : undefined}
                tabIndex={jumpable ? 0 : undefined}
                onClick={jumpable ? () => jumpToSession(task) : undefined}
                onKeyDown={
                  jumpable ? (e) => handleButtonKeyDown(e, () => jumpToSession(task)) : undefined
                }
                className={`group relative px-2.5 py-2 ${
                  jumpable ? "cursor-pointer hover:bg-panel3" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-fg">{task.label}</span>
                  {selectCanDismiss(task.status) && (
                    <button
                      type="button"
                      aria-label="移除"
                      onClick={(e) => {
                        e.stopPropagation();
                        dismissTask(task.id);
                      }}
                      className="shrink-0 text-mut2 opacity-0 hover:text-fg group-hover:opacity-100"
                    >
                      <X size={12} weight="regular" />
                    </button>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-mut2">
                  <span>{KIND_LABEL[task.kind]}</span>
                  <span>·</span>
                  {task.status === "running" && (
                    <span className="text-mut">
                      {task.stage || "处理中"}
                      {typeof task.progress === "number" && ` ${Math.round(task.progress * 100)}%`}
                    </span>
                  )}
                  {task.status === "done" && (
                    <span className="flex items-center gap-1 text-lab-green">
                      <CheckCircle size={11} weight="fill" />
                      完成{task.sessionId ? "·点击查看" : ""}
                    </span>
                  )}
                  {task.status === "error" && (
                    <span className="flex items-center gap-1 text-warn-soft">
                      <WarningCircle size={11} weight="fill" />
                      {task.error ?? "失败"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
