"use client";

// Right-side drawer listing saved sessions, with search (title +
// lazy-loaded expression match) and delete-confirm.
//
// #58: every import path used to live inline here (a 导入录音 popover +
// a separate ImportTranscriptDialog), each tracking its own progress
// in component-local state that vanished on drawer close. That's now
// ImportHub (one 导入 button opens it) + the task registry
// (src/lib/tasks/registry.ts) — the in-progress rows below just READ
// the registry (running/error tasks, see activeImportRows below), so
// progress survives this drawer closing and reopening, matching
// StatusLine's task tray.
//
// #62 item 2: ImportHub itself no longer mounts inside this drawer —
// Header's own 导入 pill (desktop pill row + mobile icon button, a
// peer of the engine pills) needs to open the exact same dialog
// instance without requiring this drawer to be open at all, so the
// mount + open-state moved up to page.tsx (onOpenImport prop below);
// this drawer's own 导入 buttons just call it, same as before.

import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Trash, UploadSimple, X } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { handleButtonKeyDown } from "@/lib/a11y";
import * as storage from "@/lib/history/storage";
import type { MeetingSession } from "@/lib/types";
import {
  dismissTask,
  EMPTY_TASKS,
  isFiniteProgress,
  useTasks,
  type TaskState,
} from "@/lib/tasks/registry";

export interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  onOpenImport: () => void;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

function formatDurationMin(startMs: number, endMs: number): string {
  const min = Math.max(0, Math.round((endMs - startMs) / 60000));
  return `${min} 分`;
}

// F4 LOW (codex review round 1): the registry's updateTaskProgress
// choke point already rules out NaN/Infinity before a progress value
// ever reaches TaskState, but this bar's CSS `width` percentage is
// still clamped to [0,1] before formatting — a defensively-guarded
// belt-and-suspenders (not currently reachable from any known producer)
// against a negative-width or overflowing-past-100% bar.
function clampProgress(progress: number): number {
  return Math.min(1, Math.max(0, progress));
}

/** In-progress/failed imports only — a completed one already appears
 *  as a saved session below (and briefly in StatusLine's task tray via
 *  jump-to-session), so it drops out of this inline list the moment it
 *  finishes, exactly like the old component-local job rows did. */
function activeImportRows(tasks: Record<string, TaskState>): TaskState[] {
  return Object.values(tasks)
    .filter((t) => t.status === "running" || t.status === "error")
    .sort((a, b) => a.createdAt - b.createdAt);
}

export default function HistoryDrawer({ open, onClose, onOpenImport }: HistoryDrawerProps) {
  const sessions = useApp((s) => s.sessions);
  const loadSession = useApp((s) => s.loadSession);
  const deleteSession = useApp((s) => s.deleteSession);

  const [query, setQuery] = useState("");
  const [cache, setCache] = useState<Record<string, MeetingSession>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Narrow selector (review fix 6): the drawer is unmounted-in-effect
  // (renders null below) while closed, but the `useTasks` hook itself
  // still has to be called every render regardless — gating the
  // derivation on `open` means a closed drawer resolves to the SAME
  // EMPTY_TASKS reference on every progress tick instead of a fresh
  // array, so it doesn't re-render at all while it isn't visible.
  // useShallow is load-bearing under zustand v5 (unstable selector
  // output = infinite render loop, React #185) — same crash class as
  // TaskTray's trayTasks selector, see TaskTray.test.tsx.
  const importRows = useTasks(useShallow((s) => (open ? activeImportRows(s.tasks) : EMPTY_TASKS)));

  useEffect(() => {
    if (!open) {
      setQuery("");
      setConfirmDeleteId(null);
    }
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    // Lazy-load full sessions once so we can match by expression text.
    let cancelled = false;
    (async () => {
      for (const meta of sessions) {
        if (cache[meta.id]) continue;
        const full = await storage.getSession(meta.id);
        if (cancelled) return;
        if (full) {
          setCache((prev) => ({ ...prev, [meta.id]: full }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, sessions]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const matchesExpr = (id: string): string | null => {
    if (q.length < 2) return null;
    const full = cache[id];
    if (!full) return null;
    const hit = full.cards.find((c) =>
      c.expression.toLowerCase().includes(q),
    );
    return hit ? hit.expression : null;
  };

  const filtered = sessions.filter((m) => {
    if (!q) return true;
    if (m.title.toLowerCase().includes(q)) return true;
    return matchesExpr(m.id) !== null;
  });

  const handleDeleteClick = (id: string) => {
    if (confirmDeleteId === id) {
      void deleteSession(id);
      setConfirmDeleteId(null);
      return;
    }
    setConfirmDeleteId(id);
    setTimeout(() => {
      setConfirmDeleteId((cur) => (cur === id ? null : cur));
    }, 3000);
  };

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-black/50"
        onClick={onClose}
        aria-hidden
      />
      {/* w-full + max-w, not a bare fixed width: 380px overflowed a
          375px phone viewport by 5px, bleeding every row past the left
          edge (Miana's v0.2.2 E2E finding #5). */}
      <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[380px] translate-x-0 flex-col border-l border-edge bg-panel transition-transform">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <span className="font-medium text-fg">会议历史</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onOpenImport}
              className="flex items-center gap-2 border border-edge px-2.5 py-1.5 text-xs text-mut hover:bg-panel3 hover:text-fg"
            >
              <UploadSimple size={16} weight="regular" />
              导入
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex h-8 w-8 items-center justify-center text-mut hover:bg-panel3 hover:text-fg"
            >
              <X size={18} weight="regular" />
            </button>
          </div>
        </div>

        <div className="shrink-0 px-4 py-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按标题或表达搜索…"
            className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
          />
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-4">
          {importRows.length > 0 && (
            <div className="mb-3 space-y-2">
              {importRows.map((task) => (
                <div
                  key={task.id}
                  className="rounded-none border border-edge bg-panel2 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-fg">
                      {task.label}
                    </span>
                    <span className="shrink-0 text-xs text-mut">
                      {task.status === "error" ? "失败" : task.stage || "处理中"}
                    </span>
                  </div>
                  {task.status === "error" ? (
                    <div className="mt-2 flex items-start justify-between gap-2 text-xs text-warn-soft">
                      <span>{task.error}</span>
                      <button
                        type="button"
                        onClick={() => dismissTask(task.id)}
                        className="shrink-0 text-mut2 hover:text-fg"
                      >
                        忽略
                      </button>
                    </div>
                  ) : (
                    // isFiniteProgress gated, not `typeof === "number"`
                    // (F4 LOW, codex review round 1) and not
                    // `task.progress ?? 0` (coordinator follow-up on the
                    // honest-progress fix): a phase with no trustworthy
                    // ratio (download with unknown Content-Length, or
                    // transcribe — see whisper.worker.ts) previously
                    // coerced to a bar frozen at a fabricated 0% for the
                    // entire phase, reproducing the exact reported bug in
                    // this second surface. `typeof === "number"` on its
                    // own is also true for NaN/Infinity (e.g. FFmpeg on a
                    // duration-less media file) — isFiniteProgress rules
                    // those out too. Mirrors TaskTray.tsx's own guard —
                    // stage text above is enough when there's no real
                    // number.
                    isFiniteProgress(task.progress) && (
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-none bg-edge">
                          <div
                            className="h-full rounded-none bg-lab-green transition-all"
                            style={{ width: `${Math.round(clampProgress(task.progress) * 100)}%` }}
                          />
                        </div>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-mut2">
                          {Math.round(clampProgress(task.progress) * 100)}%
                        </span>
                      </div>
                    )
                  )}
                </div>
              ))}
              <div className="text-xs text-mut">
                刷新页面不会中断转录，但会丢失进度显示
              </div>
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="text-sm font-medium text-fg">
                {sessions.length === 0 ? "还没有会议记录" : "没有匹配的会议"}
              </div>
              <div className="mt-2 max-w-xs text-xs leading-[1.7] text-mut">
                {sessions.length === 0
                  ? "开一场会议或点「演示」，结束后会自动出现在这里。"
                  : "换个关键词试试。"}
              </div>
              {sessions.length === 0 && (
                <button
                  type="button"
                  onClick={onOpenImport}
                  className="mt-4 flex items-center gap-2 border border-edge px-3 py-1.5 text-xs text-mut hover:bg-panel3 hover:text-fg"
                >
                  <UploadSimple size={14} weight="regular" />
                  或导入已有录音/文稿
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((meta) => {
                const hintExpr = matchesExpr(meta.id);
                const openSession = () => {
                  void loadSession(meta.id);
                  onClose();
                };
                return (
                  <div
                    key={meta.id}
                    role="button"
                    tabIndex={0}
                    onClick={openSession}
                    onKeyDown={(e) => handleButtonKeyDown(e, openSession)}
                    className="cursor-pointer rounded-none border-l-2 border-edge2 border-b border-b-edge bg-panel2 p-3 hover:bg-panel3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-fg">{meta.title}</span>
                      <button
                        type="button"
                        aria-label="删除会议"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteClick(meta.id);
                        }}
                        className="flex h-7 w-7 shrink-0 items-center justify-center text-mut hover:bg-panel3 hover:text-warn-soft"
                      >
                        <Trash size={16} weight="regular" />
                      </button>
                    </div>

                    {confirmDeleteId === meta.id && (
                      <div className="mt-2 text-xs text-warn-soft">确认删除?</div>
                    )}

                    <div className="mt-2 font-mono text-xs tabular-nums text-mut2">
                      {formatDateTime(meta.startedAt)} ·{" "}
                      {formatDurationMin(meta.startedAt, meta.endedAt)}
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-mut">
                      <span className="border border-edge px-1.5 py-0">
                        {meta.segmentCount} 段
                      </span>
                      <span className="border border-edge px-1.5 py-0">
                        {meta.cardCount} 表达
                      </span>
                      <span className="border border-edge px-1.5 py-0">
                        {meta.termCount} 术语
                      </span>
                      <span className="border border-edge px-1.5 py-0">
                        摘要{meta.hasSummary ? "✓" : "✗"}
                      </span>
                    </div>

                    {hintExpr && (
                      <div className="mt-2 text-xs text-lab-orange">
                        含 &quot;{hintExpr}&quot;
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
