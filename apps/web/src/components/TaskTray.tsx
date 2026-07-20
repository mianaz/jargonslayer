"use client";

// Task chip (#58 design decision 4; S10 field-fix #6 Q2 verdict) —
// StatusLine-mounted compact activity blip for the background task
// registry (src/lib/tasks/registry.ts). Spinner + N while any task is
// running; once nothing is running, a static count keeps recently
// finished/errored tasks discoverable. This chip no longer owns a
// popover of its own — S10 replaced it with TaskCenterDrawer.tsx (the
// Q2-pinned header-launched slide-over): clicking the chip just opens
// that drawer via the `onOpen` callback threaded down from page.tsx
// through StatusLine, same substrate, one less bespoke popover.

import { selectHasTasks, selectRunningCount, selectTotalCount, useTasks, type TaskState } from "@/lib/tasks/registry";
import { ListChecks } from "@phosphor-icons/react";

// Kind -> Chinese label, TaskCenterDrawer's own row rendering imports
// this directly (single source of truth — see registry.ts's own
// "every exhaustive Record<TaskKind,…>" doc comment on TaskKind).
export const KIND_LABEL: Record<TaskState["kind"], string> = {
  "import-audio": "音频导入",
  "import-video": "视频导入",
  "import-url": "链接导入",
  "import-text": "文稿导入",
  "model-download": "下载模型",
  "diar-install": "安装说话人分离",
  "os-speech-asset": "下载系统识别模型",
  "mlx-install": "安装 MLX 运行环境",
  "selection-lookup": "解释所选",
};

export interface TaskTrayProps {
  onOpen: () => void;
}

export default function TaskTray({ onOpen }: TaskTrayProps) {
  // Narrow primitive selectors only (review fix 6's own rationale,
  // still true post-S10): a progress-only tick (stage/progress%
  // changing without any of these changing) doesn't re-render this
  // chip at all. No array/object-returning selector lives here anymore
  // — the row list moved to TaskCenterDrawer.tsx — so this component no
  // longer needs useShallow at all (see registry.ts's own invariant
  // doc: primitive-returning selectors are safe bare).
  const runningCount = useTasks((s) => selectRunningCount(s.tasks));
  const hasTasks = useTasks((s) => selectHasTasks(s.tasks));
  const totalCount = useTasks((s) => selectTotalCount(s.tasks));

  if (!hasTasks) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
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
  );
}
