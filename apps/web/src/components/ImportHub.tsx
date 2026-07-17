"use client";

// ImportHub (#58 design decision 3) — the single 导入 entrance
// consolidating every path that used to be scattered across
// HistoryDrawer's 导入录音 popover + a separate ImportTranscriptDialog:
//   - 文件: an audio OR video file, via either 本地 Whisper（sidecar —
//     faster-whisper quality + diarization, local tier only) or 浏览器
//     转录（ffmpeg.wasm + in-browser Whisper, never leaves the tab).
//     decideVideoRouting (design decision 6) picks the recommended
//     default once a file is staged — the same reachability logic
//     already governed audio; video is the newly-unlocked capability.
//   - 文稿: paste or upload a transcript (.txt/.srt/.vtt) — inlines
//     what used to be the standalone ImportTranscriptDialog so there's
//     exactly one dialog surface.
//   - 链接: a video URL via the sidecar's yt-dlp download (#43 phase
//     2c), local tier only, unchanged posture.
// Every kind is dispatched through registry.ts's runTracked/
// runTrackedAsync so it shows up in StatusLine's task chip/tray and
// survives this dialog closing (decisions 2 + 4) — HistoryDrawer's own
// inline job rows read the SAME registry, this dialog does not own any
// progress UI once an import is confirmed.

import { useEffect, useRef, useState } from "react";
import { FileAudio, FileText, LinkSimple } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { PREVIEW_TIER } from "@/lib/deployTier";
import PreviewLockedBadge from "@/components/PreviewLockedBadge";
import {
  fetchSidecarHealth,
  importAndTrack,
  importUrlAndTrack,
  withSidecarHint,
} from "@/lib/stt/upload";
import { importAudio, isVideoFile, isSupportedMediaFile } from "@/lib/ingest/importAudio";
import { importTranscriptText } from "@/lib/ingest/importText";
import {
  parseTranscript,
  ParseTranscriptError,
  type ParsedTranscript,
} from "@/lib/ingest/parseTranscript";
import { runTracked, runTrackedAsync, type TaskKind } from "@/lib/tasks/registry";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { decideVideoRouting, resolveImportPath, type ImportPath } from "@/lib/tasks/videoRouting";

const PREVIEW_SIDECAR_TITLE = "本地版功能：需要本地 Whisper";
const FILE_ACCEPT = "audio/*,.m4a,.mp3,.wav,.flac,.mp4,.webm,.mov,.mkv,.m4v,video/*";
const PARSE_DEBOUNCE_MS = 300;

const FORMAT_LABEL: Record<ParsedTranscript["format"], string> = {
  srt: "SRT",
  vtt: "VTT",
  plain: "纯文本",
};

const TEXT_PHASE_LABEL: Record<"parse" | "detect" | "translate", string> = {
  parse: "解析",
  detect: "检测",
  translate: "翻译",
};

// R5 field fix (Sol F4): a completion toast used to append ONLY
// warnings[0] — importTranscriptText's own `warnings` array starts as
// the PARSER's warnings, then has any translate/AI-detect warning
// pushed on afterward (see importText.ts), so a parser warning
// silently hid a later AI-detect one (importAudio.ts's own `warnings`
// can carry the same kind of multi-source stacking too). Renders every
// UNIQUE warning, capped at 2, with an "等 N 条提示" suffix (N = the
// total unique count) once there are more than that — never silently
// drops one warning in favor of another.
function warningsSuffix(warnings: string[]): string {
  if (warnings.length === 0) return "";
  const unique = Array.from(new Set(warnings));
  const shown = unique.slice(0, 2);
  const parts = unique.length > 2 ? [...shown, `等 ${unique.length} 条提示`] : shown;
  return `，${parts.join("；")}`;
}

function speakerCount(parsed: ParsedTranscript): number {
  return new Set(parsed.segments.map((s) => s.speaker).filter(Boolean)).size;
}

export interface ImportHubProps {
  open: boolean;
  onClose: () => void;
}

type HubTab = "file" | "text" | "url";

const TABS: { key: HubTab; label: string; icon: typeof FileAudio }[] = [
  { key: "file", label: "文件", icon: FileAudio },
  { key: "text", label: "文稿", icon: FileText },
  { key: "url", label: "链接", icon: LinkSimple },
];

export default function ImportHub({ open, onClose }: ImportHubProps) {
  const settings = useApp((s) => s.settings);
  const loadSession = useApp((s) => s.loadSession);
  const showToast = useApp((s) => s.showToast);

  const [tab, setTab] = useState<HubTab>("file");

  // 本地 Whisper sidecar reachability — fetched lazily each time the
  // hub opens (not on mount), same posture as the old popover. Preview
  // tier never probes (showroom rule: no probing to unlock).
  const [diarizationHealth, setDiarizationHealth] = useState<
    { diarization_ready: boolean } | null | undefined
  >(undefined);

  // ---- 文件 tab state ----
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [filePath, setFilePath] = useState<ImportPath>("browser");

  // ---- 文稿 tab state (former ImportTranscriptDialog) ----
  const [raw, setRaw] = useState("");
  const [filename, setFilename] = useState<string | undefined>(undefined);
  const [translate, setTranslate] = useState(settings.bilingualTranscript);
  const [parsed, setParsed] = useState<ParsedTranscript | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const textFileInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- 链接 tab state ----
  const [urlValue, setUrlValue] = useState("");

  useEffect(() => {
    if (!open) {
      setTab("file");
      setStagedFiles([]);
      setFilePath("browser");
      setRaw("");
      setFilename(undefined);
      setTranslate(settings.bilingualTranscript);
      setParsed(null);
      setParseError(null);
      setUrlValue("");
      if (debounceRef.current) clearTimeout(debounceRef.current);
      return;
    }
    if (PREVIEW_TIER) return;
    setDiarizationHealth(undefined);
    let cancelled = false;
    void fetchSidecarHealth(settings).then((health) => {
      if (!cancelled) setDiarizationHealth(health);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Esc-to-close (#58 review fix 5) — matches the affordance the old
  // 导入录音 popover this dialog replaced already had.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose]);

  // Debounced live parse preview for the 文稿 tab.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!raw.trim()) {
      setParsed(null);
      setParseError(null);
      return;
    }
    debounceRef.current = setTimeout(() => {
      try {
        setParsed(parseTranscript(raw, filename));
        setParseError(null);
      } catch (err) {
        setParsed(null);
        setParseError(err instanceof ParseTranscriptError ? err.message : "解析失败");
      }
    }, PARSE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [raw, filename]);

  if (!open) return null;

  const routing = decideVideoRouting({ sidecarHealth: diarizationHealth, isPreviewTier: PREVIEW_TIER });
  // Confirm-time coercion (#58 review fix 4): a file staged while the
  // sidecar's health probe hadn't resolved yet (optimistic "sidecar"
  // default) can go stale once it resolves unreachable — filePath
  // itself doesn't auto-reset, so both the dispatch decision below and
  // the file-path cards' selected-state styling read this derived
  // value instead of the raw `filePath` state.
  const effectiveFilePath = resolveImportPath(filePath, routing);

  const handleFilesPicked = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    // Accept-list guard (#58 review fix 8): the native <input accept>
    // is advisory only — reject anything that isn't actually audio/
    // video BEFORE it can become a doomed transcription task.
    const accepted = list.filter(isSupportedMediaFile);
    const rejected = list.filter((f) => !isSupportedMediaFile(f));
    if (rejected.length > 0) {
      showToast(`不支持的文件类型，已跳过：${rejected.map((f) => f.name).join("、")}`);
    }
    if (accepted.length === 0) return;
    setStagedFiles(accepted);
    setFilePath(routing.defaultPath);
  };

  const handleConfirmFile = () => {
    if (stagedFiles.length === 0) return;
    for (const file of stagedFiles) {
      const kind: TaskKind = isVideoFile(file) ? "import-video" : "import-audio";
      if (effectiveFilePath === "sidecar") {
        runTracked(kind, file.name, (cb) => {
          void importAndTrack(file, settings, {
            onProgress: cb.onProgress,
            onDone: (sessionId) => {
              cb.onDone(sessionId);
              void (async () => {
                await useApp.getState().hydrate();
                showToast("已导入并打开会话");
              })();
            },
            onError: (message) => cb.onError(withSidecarHint(message)),
          });
        });
      } else {
        runTrackedAsync(kind, file.name, (onProgress) =>
          importAudio({ file, translate: settings.bilingualTranscript, settings, onProgress }),
        )
          .result.then(async ({ sessionId, warnings }) => {
            await loadSession(sessionId);
            await useApp.getState().hydrate();
            showToast(`音频已转录，分析完成${warningsSuffix(warnings)}`);
          })
          .catch(() => {
            // registry.error already recorded (runTrackedAsync) — the
            // failure surfaces in the task tray, nothing else to do.
          });
      }
    }
    onClose();
  };

  const handleTextFilePicked = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const text = await file.text();
    setRaw(text);
    setFilename(file.name);
  };

  const canConfirmText =
    raw.trim().length > 0 && !!parsed && parsed.segments.length > 0 && !parseError;

  const handleConfirmText = () => {
    if (!canConfirmText) return;
    const label = filename ?? "粘贴的文稿";
    runTrackedAsync("import-text", label, (onProgress) =>
      importTranscriptText({
        raw,
        filename,
        translate,
        settings,
        onProgress: (phase, done, total) =>
          onProgress(total > 0 ? done / total : 0, `${TEXT_PHASE_LABEL[phase]} ${done}/${total}`),
      }),
    )
      .result.then(async ({ sessionId, warnings }) => {
        await loadSession(sessionId);
        await useApp.getState().hydrate();
        showToast(`文稿已导入，分析完成${warningsSuffix(warnings)}`);
      })
      .catch(() => {
        // registry.error already recorded — surfaced in the task tray.
      });
    onClose();
  };

  const sidecarReachable = diarizationHealth !== null;
  const urlLocked = PREVIEW_TIER || !sidecarReachable;

  const handleConfirmUrl = () => {
    const trimmed = urlValue.trim();
    if (!trimmed || urlLocked) return;
    runTracked("import-url", trimmed, (cb) => {
      void importUrlAndTrack(trimmed, settings, {
        onProgress: cb.onProgress,
        onDone: (sessionId) => {
          cb.onDone(sessionId);
          void (async () => {
            await useApp.getState().hydrate();
            showToast("已导入并打开会话");
          })();
        },
        onError: (message) => cb.onError(withSidecarHint(message)),
      });
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="scroll-thin max-h-[85vh] w-[560px] max-w-[92vw] overflow-y-auto rounded-none border border-edge2 bg-panel p-5">
        <div className="mb-4 text-lg font-semibold text-fg">导入</div>

        <div className="mb-4 flex items-center gap-1 border-b border-edge">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 border border-b-0 px-3 py-2 font-mono text-xs uppercase tracking-wide transition-colors ${
                tab === key
                  ? "border-edge bg-panel2 text-fg"
                  : "border-transparent text-mut hover:text-fg"
              }`}
            >
              <Icon size={14} weight="regular" />
              {label}
            </button>
          ))}
        </div>

        {tab === "file" && (
          <div className="space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              accept={FILE_ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => {
                handleFilesPicked(e.target.files);
                e.target.value = "";
              }}
            />

            {stagedFiles.length === 0 ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="btn-tactile flex w-full items-center justify-center gap-2 border border-dashed border-edge2 px-3 py-8 text-sm text-mut hover:bg-panel3 hover:text-fg"
              >
                <FileAudio size={20} weight="regular" />
                选择音频或视频文件（支持多选）
              </button>
            ) : (
              <>
                <div className="space-y-1">
                  {stagedFiles.map((f, i) => (
                    <div key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 text-xs text-mut">
                      <span className="truncate">{f.name}</span>
                      <span className="shrink-0 text-mut2">{isVideoFile(f) ? "视频" : "音频"}</span>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setStagedFiles([])}
                    className="text-xs text-mut2 underline-offset-2 hover:text-mut hover:underline"
                  >
                    重新选择
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setFilePath("browser")}
                    className={`border p-3 text-left text-sm transition-colors ${
                      effectiveFilePath === "browser"
                        ? "border-act bg-panel3 text-fg"
                        : "border-edge text-fg hover:bg-panel3"
                    }`}
                  >
                    {/* v0.4.4 field ruling (finding round 2, item 1): calling
                       this path "浏览器" inside the DESKTOP app is a misframe —
                       to a desktop user it's all just "the app", so the card
                       reads 内置轻量转录 there; the web PWA keeps 浏览器转录,
                       where the browser really is the runtime the user chose. */}
                    <div className="font-medium">
                      {IS_DESKTOP ? "内置轻量转录（不出本机）" : "浏览器转录（不出本机）"}
                    </div>
                    <div className="mt-0.5 text-xs leading-[1.7] text-mut">
                      内置小型 Whisper 模型（base），质量低于本地大模型·文件不上传·音频与视频均支持（自动提取音轨）·首次需下载模型
                    </div>
                  </button>
                  <button
                    type="button"
                    disabled={!routing.sidecarAvailable}
                    title={routing.sidecarLocked ? PREVIEW_SIDECAR_TITLE : undefined}
                    onClick={() => setFilePath("sidecar")}
                    className={`border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      effectiveFilePath === "sidecar"
                        ? "border-act bg-panel3 text-fg"
                        : "border-edge text-fg hover:bg-panel3"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-medium">
                      本地 Whisper（推荐）
                      {routing.sidecarLocked && <PreviewLockedBadge />}
                    </div>
                    <div className="mt-0.5 text-xs leading-[1.7] text-mut">
                      需启动本地 Whisper·音频与视频均支持
                    </div>
                    {routing.sidecarAvailable && diarizationHealth !== undefined && (
                      <div className="mt-0.5 text-[10px] leading-[1.7]">
                        {diarizationHealth?.diarization_ready ? (
                          <span className="text-lab-cyan">说话人分离已就绪</span>
                        ) : (
                          <span className="text-mut2">说话人分离未启用 · 在设置中配置 HF Token</span>
                        )}
                      </div>
                    )}
                  </button>
                </div>

                <div className="flex justify-end gap-2 border-t border-edge pt-4">
                  <button
                    type="button"
                    onClick={onClose}
                    className="btn-tactile px-4 py-2 text-sm text-mut hover:bg-panel3 hover:text-fg"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmFile}
                    className="btn-terminal rounded-none bg-act px-4 py-2 font-mono text-sm font-semibold text-ink hover:bg-act/85"
                  >
                    开始导入
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {tab === "text" && (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-mut">粘贴文稿内容</label>
              <textarea
                value={raw}
                onChange={(e) => {
                  setRaw(e.target.value);
                  setFilename(undefined);
                }}
                rows={10}
                placeholder={
                  "粘贴会议文字记录，支持纯文本、SRT、VTT（Zoom/Otter 导出）格式\n" +
                  "可选说话人前缀，如 Alice: 今天先同步一下进度"
                }
                className="mt-1 w-full resize-y border border-edge bg-panel2 px-3 py-2 font-mono text-sm text-fg placeholder:text-mut2 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                ref={textFileInputRef}
                type="file"
                accept=".txt,.srt,.vtt,text/plain"
                className="hidden"
                onChange={(e) => {
                  void handleTextFilePicked(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => textFileInputRef.current?.click()}
                className="btn-tactile flex items-center gap-2 border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
              >
                <FileText size={16} weight="regular" />
                选择文件
              </button>
              {filename && <span className="truncate text-xs text-mut">{filename}</span>}
            </div>

            {raw.trim().length > 0 && (
              <div className="text-xs leading-[1.7]">
                {parseError ? (
                  <span className="text-warn-soft">{parseError}</span>
                ) : parsed ? (
                  <>
                    <span className="text-lab-cyan">
                      格式 {FORMAT_LABEL[parsed.format]} · {parsed.segments.length} 段 ·{" "}
                      {speakerCount(parsed)} 位说话人
                    </span>
                    {parsed.warnings.map((w, i) => (
                      <div key={i} className="mt-1 text-warn-soft">
                        {w}
                      </div>
                    ))}
                  </>
                ) : (
                  <span className="text-mut2">解析中…</span>
                )}
              </div>
            )}

            <label className="flex items-center justify-between gap-3 py-1">
              <div>
                <div className="text-sm text-fg">同时生成中文对照</div>
                <div className="text-xs text-mut2">逐句翻译，导入后可在转录面板查看</div>
              </div>
              <input
                type="checkbox"
                checked={translate}
                onChange={(e) => setTranslate(e.target.checked)}
                className="h-4 w-4 accent-act"
              />
            </label>

            <div className="flex justify-end gap-2 border-t border-edge pt-4">
              <button
                type="button"
                onClick={onClose}
                className="btn-tactile px-4 py-2 text-sm text-mut hover:bg-panel3 hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!canConfirmText}
                onClick={handleConfirmText}
                className="btn-terminal rounded-none bg-act px-4 py-2 font-mono text-sm font-semibold text-ink hover:bg-act/85 disabled:cursor-not-allowed disabled:opacity-50"
              >
                导入并分析
              </button>
            </div>
          </div>
        )}

        {tab === "url" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-fg">
              <LinkSimple size={16} weight="regular" />
              从视频链接导入
              {urlLocked && PREVIEW_TIER && <PreviewLockedBadge />}
            </div>
            <div className="text-xs leading-[1.7] text-mut">
              {PREVIEW_TIER
                ? "需本地 Whisper（体验版不提供）"
                : sidecarReachable
                  ? "通过本地 Whisper 下载并转录，仅限本地版·请确保你有权处理该内容"
                  : "需本地 Whisper，未检测到运行中的本地服务"}
            </div>
            <input
              type="text"
              disabled={urlLocked}
              value={urlValue}
              onChange={(e) => setUrlValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConfirmUrl();
              }}
              placeholder="https://..."
              className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            <div className="flex justify-end gap-2 border-t border-edge pt-4">
              <button
                type="button"
                onClick={onClose}
                className="btn-tactile px-4 py-2 text-sm text-mut hover:bg-panel3 hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                disabled={urlLocked || !urlValue.trim()}
                onClick={handleConfirmUrl}
                className="btn-terminal rounded-none bg-act px-4 py-2 font-mono text-sm font-semibold text-ink hover:bg-act/85 disabled:cursor-not-allowed disabled:opacity-50"
              >
                开始导入
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
