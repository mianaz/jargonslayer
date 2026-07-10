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
import { CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { handleButtonKeyDown } from "@/lib/a11y";
import {
  dismissTask,
  selectHasTasks,
  selectRunningCount,
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
  const tasks = useTasks((s) => s.tasks);
  const loadSession = useApp((s) => s.loadSession);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const runningCount = selectRunningCount(tasks);
  const hasTasks = selectHasTasks(tasks);
  const trayTasks = selectTrayTasks(tasks);

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
          <span className="tabular-nums">{trayTasks.length}</span>
        )}
      </button>

      {open && (
        <div className="scroll-thin absolute bottom-full right-0 z-50 mb-2 max-h-80 w-72 overflow-y-auto rounded-none border border-edge2 bg-panel2 p-1.5 shadow-xl">
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
                className={`group relative rounded-sm px-2.5 py-2 ${
                  jumpable ? "cursor-pointer hover:bg-panel3" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-fg">{task.label}</span>
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
