"use client";

// Right-side drawer listing saved sessions, with search (title +
// lazy-loaded expression match) and delete-confirm.

import { useEffect, useRef, useState } from "react";
import { X, Trash, UploadSimple, FileText, LinkSimple } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { handleButtonKeyDown } from "@/lib/a11y";
import * as storage from "@/lib/history/storage";
import type { MeetingSession } from "@/lib/types";
import {
  fetchSidecarHealth,
  importAndTrack,
  importUrlAndTrack,
  type ImportOptions,
} from "@/lib/stt/upload";
import { importTranscriptText } from "@/lib/ingest/importText";
import { importAudio } from "@/lib/ingest/importAudio";
import ImportTranscriptDialog from "@/components/ImportTranscriptDialog";
import PreviewLockedBadge from "@/components/PreviewLockedBadge";
import { PREVIEW_TIER } from "@/lib/deployTier";

const PREVIEW_SIDECAR_TITLE = "本地版功能：需要本地 sidecar";

// 本地转录（浏览器）(#43 phase 2a, video added in phase 2b) is a THIRD
// import-mode choice alongside importAndTrack's own "sidecar"/
// "cloud" — it never reaches importAndTrack at all (importAudio.ts is
// a separate, fully in-browser pipeline that also handles video files
// via ffmpegExtract.ts), so it's a plain local union rather than
// widening ImportOptions["mode"] itself.
type ImportModeChoice = NonNullable<ImportOptions["mode"]> | "browser";

// Upload-a-recording job tracking is intentionally component-local
// (not in the global store) — it's ephemeral UI progress, and a page
// refresh losing it is an accepted tradeoff (the sidecar keeps
// transcribing regardless; see the hint text below the section).
interface ImportJobState {
  filename: string;
  progress: number;
  phase: string;
  error: string | null;
  // "recording" (default, omitted): sidecar/cloud audio import — its
  // error row appends a sidecar-specific hint. "text": #43 transcript
  // import — errors are parse/detect/translate failures, so that hint
  // would be actively misleading and is suppressed for these rows.
  // "audio" (#43 phase 2a, video added in phase 2b): in-browser
  // Whisper transcription of an audio OR video file — decode/extract/
  // model/detect/translate failures, same reasoning as "text", no
  // sidecar involved at all.
  kind?: "recording" | "text" | "audio";
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
  const importModeRef = useRef<ImportModeChoice>("sidecar");
  const importPickerRef = useRef<HTMLDivElement>(null);
  // 本地 Whisper row's diarization status line — fetched lazily each
  // time the popover opens (not on mount) since it's a network call
  // whose relevance is scoped to "user is about to pick an import
  // source"; undefined = not yet checked this open, null = sidecar
  // unreachable.
  const [diarizationHealth, setDiarizationHealth] = useState<
    { diarization_ready: boolean } | null | undefined
  >(undefined);
  // 导入文稿 (#43) dialog — separate from the 导入录音 popover above
  // since it's a full paste/upload + preview flow, not a one-click
  // file-picker shortcut.
  const [importTextOpen, setImportTextOpen] = useState(false);
  // 从视频链接导入（本地）(#43 phase 2c, LOCAL TIER ONLY): inline URL
  // input revealed within the popover entry itself (rather than a
  // separate dialog like ImportTranscriptDialog) — a single text field
  // doesn't warrant a whole modal. Gated on sidecar reachability via
  // the SAME diarizationHealth fetch the 本地 Whisper entry already
  // triggers on popover open (fetchSidecarHealth returns null on any
  // unreachability/timeout, which doubles as "is the sidecar even
  // there" — no separate probe needed).
  const [urlImportOpen, setUrlImportOpen] = useState(false);
  const [urlImportValue, setUrlImportValue] = useState("");

  useEffect(() => {
    if (!open) {
      setQuery("");
      setConfirmDeleteId(null);
      setImportPickerOpen(false);
      setImportTextOpen(false);
      setUrlImportOpen(false);
      setUrlImportValue("");
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

  // Collapse the inline URL input whenever the popover itself closes
  // (Escape / click-outside / an unrelated entry picked) — otherwise
  // reopening the popover would show a stale expanded input.
  useEffect(() => {
    if (!importPickerOpen) {
      setUrlImportOpen(false);
      setUrlImportValue("");
    }
  }, [importPickerOpen]);

  useEffect(() => {
    // Preview tier (#61): sidecar-only rows are unconditionally
    // disabled below (see previewLocked) — no probe is ever fired,
    // per the showroom's "no sidecar probing to unlock" posture (a
    // preview visitor could never have a reachable local sidecar
    // anyway, but the point is this build never asks).
    if (!importPickerOpen || PREVIEW_TIER) return;
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
    const mode: NonNullable<ImportOptions["mode"]> =
      importModeRef.current === "cloud" ? "cloud" : "sidecar";
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

  // 本地转录（浏览器）(#43 phase 2a, video added in phase 2b): same
  // job-row tracking shape as handleImportFiles above, but calling
  // importAudio.ts directly instead of importAndTrack — this path
  // never touches the sidecar job API or the cloud route at all, so
  // kind:"audio" suppresses the sidecar-specific error hint exactly
  // like kind:"text" does for 导入文稿. A video file (mp4/webm/mov/
  // mkv/m4v) is routed the same way — importAudio.ts itself detects
  // and extracts the audio track via ffmpeg.wasm before transcribing,
  // this handler stays unaware of that distinction. importAudio never
  // throws in practice (every awaited step already produces a
  // zh-ready Error), but wrapped in try/catch anyway as the same
  // last-resort net every other import path here uses.
  const handleImportAudio = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const jobId = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setJobs((prev) =>
        new Map(prev).set(jobId, {
          filename: file.name,
          progress: 0,
          phase: "读取音频",
          error: null,
          kind: "audio",
        }),
      );

      void (async () => {
        try {
          const { sessionId, warnings } = await importAudio({
            file,
            // No dialog step in this one-click flow to ask explicitly
            // (unlike 导入文稿's ImportTranscriptDialog checkbox) — same
            // settings.bilingualTranscript default that dialog itself
            // seeds its checkbox from.
            translate: settings.bilingualTranscript,
            settings,
            onProgress: (progress, phase) => patchJob(jobId, { progress, phase }),
          });

          await loadSession(sessionId);
          await useApp.getState().hydrate();
          showToast(
            warnings.length > 0
              ? `音频已转录，分析完成，${warnings[0]}`
              : "音频已转录，分析完成",
          );
          setJobs((prev) => {
            const next = new Map(prev);
            next.delete(jobId);
            return next;
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "音频导入失败";
          patchJob(jobId, { error: msg, phase: "失败" });
        }
      })();
    }
  };

  // 导入文稿 (#43): same job-row tracking + error-containment shape as
  // handleImportFiles above — importTranscriptText never throws to
  // React, but wrapped in try/catch anyway as a last-resort net,
  // mirroring importAndTrack's own belt-and-suspenders callback
  // design.
  const handleImportTranscriptText = (opts: {
    raw: string;
    filename?: string;
    translate: boolean;
  }) => {
    setImportTextOpen(false);
    const label = opts.filename ?? "粘贴的文稿";
    const jobId = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setJobs((prev) =>
      new Map(prev).set(jobId, {
        filename: label,
        progress: 0,
        phase: "解析中",
        error: null,
        kind: "text",
      }),
    );

    const phaseLabel: Record<"parse" | "detect" | "translate", string> = {
      parse: "解析",
      detect: "检测",
      translate: "翻译",
    };

    void (async () => {
      try {
        const { sessionId, warnings } = await importTranscriptText({
          raw: opts.raw,
          filename: opts.filename,
          translate: opts.translate,
          settings,
          onProgress: (phase, done, total) => {
            patchJob(jobId, {
              progress: total > 0 ? done / total : 0,
              phase: `${phaseLabel[phase]} ${done}/${total}`,
            });
          },
        });

        await loadSession(sessionId);
        await useApp.getState().hydrate();
        showToast(warnings.length > 0 ? `文稿已导入，分析完成，${warnings[0]}` : "文稿已导入，分析完成");
        setJobs((prev) => {
          const next = new Map(prev);
          next.delete(jobId);
          return next;
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "文稿导入失败";
        patchJob(jobId, { error: msg, phase: "失败" });
      }
    })();
  };

  // 从视频链接导入（本地）(#43 phase 2c, LOCAL TIER ONLY): kind is left
  // at its default ("recording") rather than getting its own value —
  // this IS a sidecar job (yt-dlp download + the same job API the
  // uploaded-file path uses), so the sidecar-unreachable error hint
  // that "recording" rows already append is exactly appropriate here
  // too, unlike "text"/"audio" which suppress it.
  const handleImportUrl = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setUrlImportOpen(false);
    setUrlImportValue("");
    setImportPickerOpen(false);

    const jobId = `${trimmed}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setJobs((prev) =>
      new Map(prev).set(jobId, {
        filename: trimmed,
        progress: 0,
        phase: "下载中",
        error: null,
      }),
    );

    void importUrlAndTrack(trimmed, settings, {
      onProgress: (progress, phase) => patchJob(jobId, { progress, phase }),
      onDone: async (sessionId) => {
        await loadSession(sessionId);
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
  };

  const canUseCloud = settings.provider === "openai-compat";
  // 从视频链接导入（本地）is gated on the SAME sidecar-reachability
  // signal the 本地 Whisper entry's diarization status line already
  // uses: undefined (not yet checked) treated as available so the
  // entry doesn't flash disabled before the health check resolves;
  // null (fetchSidecarHealth's explicit "unreachable" sentinel) is the
  // only state that disables it. Preview tier (#61): irrelevant — the
  // probe above never fires there, diarizationHealth stays undefined
  // forever, so this alone would incorrectly read "reachable"; every
  // sidecar-only row below also ORs in previewLocked to force disabled.
  const sidecarReachable = diarizationHealth !== null;
  // Preview tier (#61): sidecar-only rows (本地 Whisper upload, 从视频
  // 链接导入) are unconditionally disabled+badged — never probe-gated —
  // per the showroom posture (see the diarizationHealth useEffect
  // above). Full tier is untouched: sidecarReachable's real probe
  // result still governs everything below exactly as before.
  const previewLocked = PREVIEW_TIER;

  const chooseImportMode = (mode: ImportModeChoice) => {
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
              accept="audio/*,.m4a,.mp3,.wav,.flac,.mp4,.webm,.mov,.mkv,.m4v,video/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (importModeRef.current === "browser") {
                  handleImportAudio(e.target.files);
                } else {
                  handleImportFiles(e.target.files);
                }
                e.target.value = "";
              }}
            />
            <div ref={importPickerRef} className="relative">
              <button
                type="button"
                onClick={() => setImportPickerOpen((v) => !v)}
                className="flex items-center gap-2 rounded-sm border border-edge px-2.5 py-1.5 text-xs text-mut hover:bg-panel3 hover:text-fg"
              >
                <UploadSimple size={16} weight="regular" />
                导入录音
              </button>

              {importPickerOpen && (
                <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-none border border-edge2 bg-panel2 p-1.5 shadow-xl">
                  <button
                    type="button"
                    onClick={() => chooseImportMode("browser")}
                    className="w-full rounded-sm px-2.5 py-2 text-left hover:bg-panel3"
                  >
                    <div className="text-sm text-fg">本地转录（浏览器·音频/视频·不出本机）</div>
                    <div className="mt-0.5 text-xs leading-[1.7] text-mut">
                      在浏览器内转录，文件不上传·支持音频与视频（自动提取音轨）·首次需下载模型
                    </div>
                  </button>
                  <button
                    type="button"
                    disabled={previewLocked}
                    title={previewLocked ? PREVIEW_SIDECAR_TITLE : undefined}
                    onClick={() => chooseImportMode("sidecar")}
                    className="w-full rounded-sm px-2.5 py-2 text-left hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    <div className="flex items-center gap-2 text-sm text-fg">
                      本地 Whisper（推荐·不出本机）
                      {previewLocked && <PreviewLockedBadge />}
                    </div>
                    <div className="mt-0.5 text-xs leading-[1.7] text-mut">
                      需启动本地 sidecar
                    </div>
                    {!previewLocked && diarizationHealth !== undefined && (
                      <div className="mt-0.5 text-[10px] leading-[1.7]">
                        {diarizationHealth?.diarization_ready ? (
                          <span className="text-lab-cyan">说话人分离已就绪</span>
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
                    className="w-full rounded-sm px-2.5 py-2 text-left hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    <div className="text-sm text-fg">云端转录（音频上传至你配置的服务地址）</div>
                    <div className="mt-0.5 text-xs leading-[1.7] text-mut">
                      {canUseCloud
                        ? "音频会上传到你配置的 OpenAI 兼容端点"
                        : "需先在设置→AI 检测中选择 OpenAI 兼容端点"}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setImportPickerOpen(false);
                      setImportTextOpen(true);
                    }}
                    className="w-full rounded-sm px-2.5 py-2 text-left hover:bg-panel3"
                  >
                    <div className="flex items-center gap-2 text-sm text-fg">
                      <FileText size={16} weight="regular" />
                      导入文稿（粘贴或上传 .txt/.srt/.vtt）
                    </div>
                    <div className="mt-0.5 text-xs leading-[1.7] text-mut">
                      文字记录不出本机，仅检测/翻译请求经 API
                    </div>
                  </button>
                  <div>
                    <button
                      type="button"
                      disabled={previewLocked || !sidecarReachable}
                      title={previewLocked ? PREVIEW_SIDECAR_TITLE : undefined}
                      onClick={() => setUrlImportOpen((v) => !v)}
                      className="w-full rounded-sm px-2.5 py-2 text-left hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                      <div className="flex items-center gap-2 text-sm text-fg">
                        <LinkSimple size={16} weight="regular" />
                        从视频链接导入（本地）
                        {previewLocked && <PreviewLockedBadge />}
                      </div>
                      <div className="mt-0.5 text-xs leading-[1.7] text-mut">
                        {!previewLocked && sidecarReachable
                          ? "通过本地 sidecar 下载并转录，仅限本地版·请确保你有权处理该内容"
                          : "需本地 Whisper sidecar（体验版不提供）"}
                      </div>
                    </button>
                    {urlImportOpen && !previewLocked && sidecarReachable && (
                      <div className="flex items-center gap-1.5 px-2.5 pb-2">
                        <input
                          type="text"
                          autoFocus
                          value={urlImportValue}
                          onChange={(e) => setUrlImportValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleImportUrl(urlImportValue);
                          }}
                          placeholder="https://..."
                          className="w-full min-w-0 rounded-sm border border-edge bg-panel2 px-2 py-1 text-xs text-fg placeholder:text-mut2 focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={!urlImportValue.trim()}
                          onClick={() => handleImportUrl(urlImportValue)}
                          className="shrink-0 rounded-sm border border-edge px-2 py-1 text-xs text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                        >
                          确认
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex h-8 w-8 items-center justify-center rounded-sm text-mut hover:bg-panel3 hover:text-fg"
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
            className="w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
          />
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-4">
          {jobs.size > 0 && (
            <div className="mb-3 space-y-2">
              {Array.from(jobs.entries()).map(([jobId, job]) => (
                <div
                  key={jobId}
                  className="rounded-none border border-edge bg-panel2 p-3"
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
                      {job.error}
                      {job.kind !== "text" &&
                        job.kind !== "audio" &&
                        "，确认 sidecar 已启动且 --http-port 开启"}
                    </div>
                  ) : (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1.5 flex-1 rounded-none bg-edge">
                        <div
                          className="h-full rounded-none bg-lab-green transition-all"
                          style={{ width: `${Math.round(job.progress * 100)}%` }}
                        />
                      </div>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-mut2">
                        {Math.round(job.progress * 100)}%
                      </span>
                    </div>
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
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-mut hover:bg-panel3 hover:text-warn-soft"
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
                      <span className="rounded-sm border border-edge px-1.5 py-0">
                        {meta.segmentCount} 段
                      </span>
                      <span className="rounded-sm border border-edge px-1.5 py-0">
                        {meta.cardCount} 表达
                      </span>
                      <span className="rounded-sm border border-edge px-1.5 py-0">
                        {meta.termCount} 术语
                      </span>
                      <span className="rounded-sm border border-edge px-1.5 py-0">
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

      <ImportTranscriptDialog
        open={importTextOpen}
        onClose={() => setImportTextOpen(false)}
        onConfirm={handleImportTranscriptText}
      />
    </>
  );
}
