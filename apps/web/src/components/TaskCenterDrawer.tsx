"use client";

// Right-side slide-over listing background jobs + desktop system state
// (S10 field-fix #6, Q2 verdict: "header-launched slide-over drawer,
// NOT a content tab" — job substrate is the EXISTING lib/tasks/
// registry.ts, extended not forked). Mirrors HistoryDrawer.tsx's
// open/close mechanics/styling exactly (same backdrop+panel shape,
// same z-30/z-40 stacking) — read that file first if touching this
// one. Mounted in page.tsx beside HistoryDrawer with local open state;
// StatusLine's TaskTray chip (web/mobile) and, in wave 2, a desktop
// Header launcher both open this SAME instance.
//
// Zone 系统状态 (IS_DESKTOP only): sidecar up/down + managed/external,
// and app-update current/latest — both re-probe on open, mirroring
// SettingsDialog's own "probe once when this section becomes relevant"
// convention (see its 转录引擎 status effect).
// Zone 任务: every task in the registry (imports everywhere; model-
// download/diar-install desktop-only in practice, since only jobsBridge.
// ts's trackSwitchModel/trackInstallDiar ever create one) — this is
// where TaskTray's OLD popover row-rendering moved to (see TaskTray.tsx's
// own header comment), extended with per-kind retry/re-check actions.

import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowClockwise, ArrowSquareOut, CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { handleButtonKeyDown } from "@/lib/a11y";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { openExternal } from "@/lib/platform/openExternal";
import { probeSidecar } from "@/lib/stt/sidecarHealth";
import { initDesktop, type DesktopBootstrapHandle } from "@/lib/desktop/bootstrap";
import { checkAppUpdate, useUpdateCheck, type UpdateCheckStatus } from "@/lib/desktop/updateCheck";
import { modelForTask, trackInstallDiar, trackSwitchModel } from "@/lib/desktop/jobsBridge";
import { KIND_LABEL } from "@/components/TaskTray";
import {
  dismissTask,
  EMPTY_TASKS,
  isFiniteProgress,
  selectCanDismiss,
  selectTrayTasks,
  useTasks,
  type TaskState,
} from "@/lib/tasks/registry";

export interface TaskCenterDrawerProps {
  open: boolean;
  onClose: () => void;
}

const UPDATE_STATUS: Record<UpdateCheckStatus, { label: string; className: string }> = {
  idle: { label: "未检查", className: "text-mut" },
  checking: { label: "检查中…", className: "text-mut" },
  current: { label: "已是最新", className: "text-mut" },
  available: { label: "发现新版本", className: "text-lab-green" },
  error: { label: "检查失败", className: "text-warn-soft" },
};

// F4 LOW precedent (registry.ts/HistoryDrawer/TaskTray all guard the
// same way) — belt-and-suspenders clamp for a progress bar's CSS width.
function clampProgress(progress: number): number {
  return Math.min(1, Math.max(0, progress));
}

export default function TaskCenterDrawer({ open, onClose }: TaskCenterDrawerProps) {
  const settings = useApp((s) => s.settings);
  const sidecarUp = useApp((s) => s.sidecarUp);
  const loadSession = useApp((s) => s.loadSession);
  const showToast = useApp((s) => s.showToast);

  const [checkingSidecar, setCheckingSidecar] = useState(false);
  const [handle, setHandle] = useState<DesktopBootstrapHandle | null>(null);
  // F6 (lead live-finding, review round): the sidecar's own cancel_prewarm
  // / POST /jobs/{id}/cancel can take ~10s+ to actually be OBSERVED here
  // (a pre-byte network/process-teardown phase before the drive even
  // reacts — see bootstrap.ts's own downloadWasCancelled/jobsBridge.ts's
  // trackPrewarm/trackSwitchModel, neither of which settle the task
  // until THAT happens) — the row would otherwise keep reading "运行中"
  // for that whole window right after the user clicked 取消, looking
  // like the click did nothing. Purely a local optimistic label; the
  // task itself still only actually settles once one of those async
  // paths above observes it. ponytail: never pruned for a task id that
  // settles without this exact row re-rendering again — harmless, since
  // the running-only label branch below simply stops matching once
  // status changes (a session-bounded handful of stale ids sitting in
  // memory); add a useTasks-driven prune (mirrors jobsBridge.ts's F11
  // modelByTaskId precedent) if this ever needs tightening.
  const [cancelingTaskIds, setCancelingTaskIds] = useState<Set<string>>(new Set());

  const updateStatus = useUpdateCheck((s) => s.status);
  const updateCurrentVersion = useUpdateCheck((s) => s.currentVersion);
  const updateLatestVersion = useUpdateCheck((s) => s.latestVersion);
  const updateUrl = useUpdateCheck((s) => s.url);

  // Open-gated + useShallow-wrapped (registry.ts's own invariant, React
  // #185 history — see TaskTray.tsx's old popover/HistoryDrawer's
  // importRows for the identical precedent this mirrors): a closed
  // drawer resolves to the SAME EMPTY_TASKS reference every tick
  // instead of a fresh selectTrayTasks() array.
  const tasks = useTasks(useShallow((s) => (open ? selectTrayTasks(s.tasks) : EMPTY_TASKS)));

  useEffect(() => {
    if (!open || !IS_DESKTOP) return;
    let cancelled = false;
    void initDesktop().then((h) => {
      if (!cancelled) setHandle(h);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 系统状态 sidecar row: probes once per open, mirrors into the store
  // exactly like SettingsDialog's own 转录引擎 status effect (probeSidecar
  // + setSidecarUp) so every surface reading sidecarUp agrees.
  useEffect(() => {
    if (!open || !IS_DESKTOP) return;
    let cancelled = false;
    void probeSidecar(settings).then((result) => {
      if (!cancelled) useApp.getState().setSidecarUp(result.up);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 系统状态 update row: quiet first-open check only (status still
  // "idle" — never re-fires on every open; checkAppUpdate's own ETag
  // cache makes a repeat 重新检查 click cheap regardless).
  useEffect(() => {
    if (!open || !IS_DESKTOP || updateStatus !== "idle") return;
    void checkAppUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, updateStatus]);

  if (!open) return null;

  const handleRecheckSidecar = () => {
    setCheckingSidecar(true);
    void probeSidecar(settings)
      .then((result) => useApp.getState().setSidecarUp(result.up))
      .finally(() => setCheckingSidecar(false));
  };

  const jumpToSession = (task: TaskState) => {
    if (!task.sessionId) return;
    void loadSession(task.sessionId);
    onClose();
  };

  const handleRetryModelDownload = (task: TaskState) => {
    if (!handle) return;
    const model = modelForTask(task.id);
    if (!model) return;
    trackSwitchModel(handle, model);
  };

  // Field-test issue 6 (cancellable model downloads): a RUNNING
  // "model-download" row is either a switch-model job (jobsBridge.ts's
  // trackSwitchModel — registered in modelByTaskId, same test
  // modelForTask/the retry button above already use) or a first-run
  // prewarm row (trackPrewarm — deliberately NEVER registered there,
  // see that function's own doc comment) — modelForTask's presence is
  // what routes the click to the right sidecar/Rust cancel mechanism.
  // Fire-and-forget from this handler's own POV: the actual task
  // settling happens asynchronously either way (performSwitchModel's
  // poll loop observing "cancelled", or trackPrewarm's state$ watcher
  // observing the drive leave STEP) — this only surfaces a toast if the
  // cancel REQUEST itself failed to even go out.
  const handleCancelModelDownload = (task: TaskState) => {
    if (!handle) return;
    // F6: optimistic "取消中…" from click, not from the cancel call
    // settling — see cancelingTaskIds' own doc comment above.
    setCancelingTaskIds((prev) => new Set(prev).add(task.id));
    const cancel = modelForTask(task.id) ? handle.cancelSwitchModel() : handle.cancelPrewarm();
    cancel.catch((error: unknown) => {
      showToast(`取消失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const handleRetryDiarInstall = () => {
    if (!handle) return;
    trackInstallDiar(handle);
  };

  const handleRecheckDiar = () => {
    void probeSidecar(settings).then((result) => {
      useApp.getState().setSidecarUp(result.up);
      showToast(
        result.installed === true
          ? "说话人分离已安装"
          : result.installed === false
            ? "说话人分离尚未安装"
            : "无法确认安装状态",
      );
    });
  };

  const updateInfo = UPDATE_STATUS[updateStatus];

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/50" onClick={onClose} aria-hidden />
      <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[380px] flex-col border-l border-edge bg-panel glassable-panel">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <span className="font-medium text-fg">后台任务</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center text-mut hover:bg-panel3 hover:text-fg"
          >
            <X size={18} weight="regular" />
          </button>
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto px-3 py-3">
          {IS_DESKTOP && (
            <div className="mb-4 space-y-2">
              <div className="px-1 font-mono text-[11px] text-mut">系统状态</div>

              <div className="border-l-2 border-edge2 bg-panel2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-fg">
                    本地服务 · {settings.sidecarMode === "managed" ? "托管" : "外部"}
                  </span>
                  <span
                    className={`shrink-0 text-xs ${
                      sidecarUp === true ? "text-lab-green" : sidecarUp === false ? "text-warn-soft" : "text-mut"
                    }`}
                  >
                    {sidecarUp === null ? "未知" : sidecarUp ? "运行中" : "未连接"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleRecheckSidecar}
                  disabled={checkingSidecar}
                  className="mt-2 flex items-center gap-1 text-xs text-mut hover:text-fg disabled:opacity-50"
                >
                  <ArrowClockwise size={12} weight="regular" className={checkingSidecar ? "animate-spin" : undefined} />
                  {checkingSidecar ? "检测中…" : "重新检测"}
                </button>
              </div>

              <div className="border-l-2 border-edge2 bg-panel2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-fg">应用更新</span>
                  <span className={`shrink-0 text-xs ${updateInfo.className}`}>{updateInfo.label}</span>
                </div>
                <div className="mt-1 font-mono text-[11px] tabular-nums text-mut2">
                  当前 {updateCurrentVersion || "—"}
                  {updateLatestVersion ? ` · 最新 ${updateLatestVersion}` : ""}
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void checkAppUpdate()}
                    disabled={updateStatus === "checking"}
                    className="flex items-center gap-1 text-xs text-mut hover:text-fg disabled:opacity-50"
                  >
                    <ArrowClockwise
                      size={12}
                      weight="regular"
                      className={updateStatus === "checking" ? "animate-spin" : undefined}
                    />
                    重新检查
                  </button>
                  {updateStatus === "available" && updateUrl && (
                    <button
                      type="button"
                      onClick={() => void openExternal(updateUrl)}
                      className="flex items-center gap-1 text-xs text-lab-green hover:text-fg"
                    >
                      <ArrowSquareOut size={12} weight="regular" />
                      打开下载页
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="px-1 font-mono text-[11px] text-mut">任务</div>
          {tasks.length === 0 ? (
            <div className="px-1 py-6 text-center text-xs text-mut">暂无后台任务</div>
          ) : (
            <div className="mt-2 space-y-2">
              {tasks.map((task) => {
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
                    className={`group relative border-l-2 bg-panel2 p-3 ${
                      task.status === "error"
                        ? "border-lab-red"
                        : task.status === "done"
                          ? "border-lab-green"
                          : "border-edge2"
                    } ${jumpable ? "cursor-pointer hover:bg-panel3" : ""}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm text-fg">{task.label}</span>
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

                    <div className="mt-1 flex items-center gap-1.5 text-[10px]">
                      <span className="text-mut">{KIND_LABEL[task.kind]}</span>
                      <span className="text-mut2">·</span>
                      {task.status === "running" && (
                        <span className="text-mut">
                          {cancelingTaskIds.has(task.id) ? "取消中…" : task.stage || "处理中"}
                          {isFiniteProgress(task.progress) && (
                            <span className="text-mut2 tabular-nums">{` ${Math.round(task.progress * 100)}%`}</span>
                          )}
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

                    {task.status === "running" && isFiniteProgress(task.progress) && (
                      <div className="mt-2 h-1 bg-edge">
                        <div
                          className="h-full bg-lab-green transition-all"
                          style={{ width: `${Math.round(clampProgress(task.progress) * 100)}%` }}
                        />
                      </div>
                    )}

                    {/* Field-test issue 6 (cancellable model downloads):
                       covers BOTH switch-model rows (trackSwitchModel)
                       and first-run prewarm rows (trackPrewarm) — see
                       handleCancelModelDownload's own doc comment for
                       how it routes between the two. */}
                    {task.status === "running" && task.kind === "model-download" && handle && (
                      <button
                        type="button"
                        disabled={cancelingTaskIds.has(task.id)}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCancelModelDownload(task);
                        }}
                        className="mt-2 flex items-center gap-1 text-xs text-mut hover:text-fg disabled:opacity-50"
                      >
                        <X size={12} weight="regular" />
                        取消
                      </button>
                    )}

                    {task.status === "error" && task.kind === "model-download" && handle && modelForTask(task.id) && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRetryModelDownload(task);
                        }}
                        className="mt-2 flex items-center gap-1 text-xs text-mut hover:text-fg"
                      >
                        <ArrowClockwise size={12} weight="regular" />
                        重试
                      </button>
                    )}

                    {task.status === "error" && task.kind === "diar-install" && (
                      <div className="mt-2 flex items-center gap-3">
                        {handle && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRetryDiarInstall();
                            }}
                            className="flex items-center gap-1 text-xs text-mut hover:text-fg"
                          >
                            <ArrowClockwise size={12} weight="regular" />
                            重试
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRecheckDiar();
                          }}
                          className="text-xs text-mut hover:text-fg"
                        >
                          重新检测
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
