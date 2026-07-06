"use client";

// Right-side drawer listing saved sessions, with search (title +
// lazy-loaded expression match) and delete-confirm.

import { useEffect, useRef, useState } from "react";
import { X, Trash, UploadSimple } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import * as storage from "@/lib/history/storage";
import type { MeetingSession } from "@/lib/types";
import { fetchSidecarHealth, importAndTrack, type ImportOptions } from "@/lib/stt/upload";

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
  // 导入录音 source-choice popover (#22: sidecar vs cloud). The chosen
  // mode is stashed in a ref (not state) because it only needs to
  // survive the synchronous "click row -> open native file picker"
  // round trip, read once when the file input's onChange fires.
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const importModeRef = useRef<ImportOptions["mode"]>("sidecar");
  const importPickerRef = useRef<HTMLDivElement>(null);
  // 本地 Whisper row's diarization status line — fetched lazily each
  // time the popover opens (not on mount) since it's a network call
  // whose relevance is scoped to "user is about to pick an import
  // source"; undefined = not yet checked this open, null = sidecar
  // unreachable.
  const [diarizationHealth, setDiarizationHealth] = useState<
    { diarization_ready: boolean } | null | undefined
  >(undefined);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setConfirmDeleteId(null);
      setImportPickerOpen(false);
    }
  }, [open]);

  useEffect(() => {
    if (!importPickerOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setImportPickerOpen(false);
    };
    const handleMouseDown = (e: MouseEvent) => {
      if (importPickerRef.current && !importPickerRef.current.contains(e.target as Node)) {
        setImportPickerOpen(false);
      }
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [importPickerOpen]);

  useEffect(() => {
    if (!importPickerOpen) return;
    setDiarizationHealth(undefined);
    let cancelled = false;
    void fetchSidecarHealth(settings).then((health) => {
      if (!cancelled) setDiarizationHealth(health);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importPickerOpen]);

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
    const mode = importModeRef.current ?? "sidecar";
    for (const file of Array.from(files)) {
      const jobId = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setJobs((prev) =>
        new Map(prev).set(jobId, {
          filename: file.name,
          progress: 0,
          phase: mode === "cloud" ? "云端转录中" : "转录中",
          error: null,
        }),
      );

      void importAndTrack(
        file,
        settings,
        {
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
        },
        { mode },
      );
    }
  };

  const canUseCloud = settings.provider === "openai-compat";

  const chooseImportMode = (mode: NonNullable<ImportOptions["mode"]>) => {
    importModeRef.current = mode;
    setImportPickerOpen(false);
    fileInputRef.current?.click();
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
            <div ref={importPickerRef} className="relative">
              <button
                type="button"
                onClick={() => setImportPickerOpen((v) => !v)}
                className="flex items-center gap-2 rounded-lg border border-edge px-2.5 py-1.5 text-xs text-mut hover:bg-panel3 hover:text-fg"
              >
                <UploadSimple size={16} weight="regular" />
                导入录音
              </button>

              {importPickerOpen && (
                <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-edge bg-panel2 p-1.5 shadow-xl">
                  <button
                    type="button"
                    onClick={() => chooseImportMode("sidecar")}
                    className="w-full rounded-lg px-2.5 py-2 text-left hover:bg-panel3"
                  >
                    <div className="text-sm text-fg">本地 Whisper（推荐·不出本机）</div>
                    <div className="mt-0.5 text-xs leading-[1.7] text-mut">
                      需启动本地 sidecar
                    </div>
                    {diarizationHealth !== undefined && (
                      <div className="mt-0.5 text-[10px] leading-[1.7]">
                        {diarizationHealth?.diarization_ready ? (
                          <span className="text-acc2">说话人分离已就绪</span>
                        ) : (
                          <span className="text-mut2">
                            说话人分离未启用 · 在设置中配置 HF Token
                          </span>
                        )}
                      </div>
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={!canUseCloud}
                    onClick={() => chooseImportMode("cloud")}
                    className="w-full rounded-lg px-2.5 py-2 text-left hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    <div className="text-sm text-fg">云端转录（音频上传至你配置的服务地址）</div>
                    <div className="mt-0.5 text-xs leading-[1.7] text-mut">
                      {canUseCloud
                        ? "音频会上传到你配置的 OpenAI 兼容端点"
                        : "需先在设置→AI 检测中选择 OpenAI 兼容端点"}
                    </div>
                  </button>
                </div>
              )}
            </div>
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
                    <div className="mt-2 text-xs text-warn-soft">
                      {job.error}，确认 sidecar 已启动且 --http-port 开启
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
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-mut hover:bg-panel3 hover:text-warn-soft"
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
                      <div className="mt-2 text-xs text-gold/80">
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
