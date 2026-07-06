"use client";

// Right-side drawer listing saved sessions, with search (title +
// lazy-loaded expression match) and delete-confirm.

import { useEffect, useRef, useState } from "react";
import { X, Trash, UploadSimple } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import * as storage from "@/lib/history/storage";
import type { MeetingSession } from "@/lib/types";
import { importAndTrack } from "@/lib/stt/upload";

// Upload-a-recording job tracking is intentionally component-local
// (not in the global store) — it's ephemeral UI progress, and a page
// refresh losing it is an accepted tradeoff (the sidecar keeps
// transcribing regardless; see the hint text below the section).
interface ImportJobState {
  filename: string;
  progress: number;
  phase: string;
  error: string | null;
}

export interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
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

export default function HistoryDrawer({ open, onClose }: HistoryDrawerProps) {
  const sessions = useApp((s) => s.sessions);
  const loadSession = useApp((s) => s.loadSession);
  const deleteSession = useApp((s) => s.deleteSession);
  const settings = useApp((s) => s.settings);
  const showToast = useApp((s) => s.showToast);

  const [query, setQuery] = useState("");
  const [cache, setCache] = useState<Record<string, MeetingSession>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Map<string, ImportJobState>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setConfirmDeleteId(null);
    }
  }, [open]);

  const patchJob = (jobId: string, patch: Partial<ImportJobState>) => {
    setJobs((prev) => {
      const next = new Map(prev);
      const existing = next.get(jobId);
      if (existing) next.set(jobId, { ...existing, ...patch });
      return next;
    });
  };

  const handleImportFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const jobId = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setJobs((prev) =>
        new Map(prev).set(jobId, {
          filename: file.name,
          progress: 0,
          phase: "转录中",
          error: null,
        }),
      );

      void importAndTrack(file, settings, {
        onProgress: (progress, phase) => patchJob(jobId, { progress, phase }),
        onDone: async (sessionId) => {
          await loadSession(sessionId);
          // No dedicated "refresh session metas" action exists on the
          // store — hydrate() re-reads settings/sessions/glossary from
          // storage, which is a superset that also refreshes the list.
          await useApp.getState().hydrate();
          showToast("已导入并打开会话");
          setJobs((prev) => {
            const next = new Map(prev);
            next.delete(jobId);
            return next;
          });
        },
        onError: (msg) => patchJob(jobId, { error: msg, phase: "失败" }),
      });
    }
  };

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
      <div className="fixed inset-y-0 right-0 z-40 flex w-[380px] translate-x-0 flex-col border-l border-edge bg-panel transition-transform">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <span className="font-medium text-fg">会议历史</span>
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.m4a,.mp3,.wav"
              multiple
              className="hidden"
              onChange={(e) => {
                handleImportFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-xs text-mut hover:bg-panel3 hover:text-fg"
            >
              <UploadSimple size={16} weight="regular" />
              导入录音
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-mut hover:bg-panel3 hover:text-fg"
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
            className="w-full rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
          />
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-4">
          {jobs.size > 0 && (
            <div className="mb-3 space-y-2">
              {Array.from(jobs.entries()).map(([jobId, job]) => (
                <div
                  key={jobId}
                  className="rounded-xl border border-edge bg-panel2 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-fg">
                      {job.filename}
                    </span>
                    <span className="shrink-0 text-xs text-mut">
                      {job.error ? "失败" : job.phase}
                    </span>
                  </div>
                  {job.error ? (
                    <div className="mt-1.5 text-xs text-warn">
                      {job.error} — 确认 sidecar 已启动且 --http-port 开启
                    </div>
                  ) : (
                    <div
                      className="mt-2 h-1.5 rounded bg-acc transition-all"
                      style={{ width: `${Math.round(job.progress * 100)}%` }}
                    />
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
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((meta) => {
                const hintExpr = matchesExpr(meta.id);
                return (
                  <div
                    key={meta.id}
                    onClick={() => {
                      void loadSession(meta.id);
                      onClose();
                    }}
                    className="cursor-pointer rounded-xl border border-edge bg-panel2 p-3 hover:bg-panel3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-fg">{meta.title}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteClick(meta.id);
                        }}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-mut hover:bg-panel3 hover:text-warn"
                      >
                        <Trash size={16} weight="regular" />
                      </button>
                    </div>

                    {confirmDeleteId === meta.id && (
                      <div className="mt-1 text-xs text-warn">确认删除?</div>
                    )}

                    <div className="mt-1 font-mono text-xs tabular-nums text-mut2">
                      {formatDateTime(meta.startedAt)} ·{" "}
                      {formatDurationMin(meta.startedAt, meta.endedAt)}
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-mut">
                      <span className="rounded-full border border-edge px-1.5 py-0">
                        {meta.segmentCount} 段
                      </span>
                      <span className="rounded-full border border-edge px-1.5 py-0">
                        {meta.cardCount} 表达
                      </span>
                      <span className="rounded-full border border-edge px-1.5 py-0">
                        {meta.termCount} 术语
                      </span>
                      <span className="rounded-full border border-edge px-1.5 py-0">
                        摘要{meta.hasSummary ? "✓" : "✗"}
                      </span>
                    </div>

                    {hintExpr && (
                      <div className="mt-1.5 text-xs text-gold/80">
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
