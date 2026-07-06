"use client";

// 导入文稿 (#43 phase 1): paste or upload a meeting transcript (.txt/
// .srt/.vtt) and preview how it will parse before committing to a
// full detect(+translate) pass. Structural/styling pattern mirrors
// SettingsDialog — same modal chrome, no new colors. The actual
// import orchestration (job row + importTranscriptText call) lives in
// HistoryDrawer; this component only collects input and reports a
// confirmed choice back via onConfirm.

import { useEffect, useRef, useState } from "react";
import { FileText } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { parseTranscript, ParseTranscriptError, type ParsedTranscript } from "@/lib/ingest/parseTranscript";

export interface ImportTranscriptDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (opts: { raw: string; filename?: string; translate: boolean }) => void;
}

const PARSE_DEBOUNCE_MS = 300;

const FORMAT_LABEL: Record<ParsedTranscript["format"], string> = {
  srt: "SRT",
  vtt: "VTT",
  plain: "纯文本",
};

function speakerCount(parsed: ParsedTranscript): number {
  return new Set(parsed.segments.map((s) => s.speaker).filter(Boolean)).size;
}

export default function ImportTranscriptDialog({
  open,
  onClose,
  onConfirm,
}: ImportTranscriptDialogProps) {
  const settings = useApp((s) => s.settings);

  const [raw, setRaw] = useState("");
  const [filename, setFilename] = useState<string | undefined>(undefined);
  const [translate, setTranslate] = useState(settings.bilingualTranscript);
  const [parsed, setParsed] = useState<ParsedTranscript | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) {
      setRaw("");
      setFilename(undefined);
      setTranslate(settings.bilingualTranscript);
      setParsed(null);
      setParseError(null);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Debounced live parse preview — typing in the textarea re-parses at
  // most once every PARSE_DEBOUNCE_MS, not per keystroke.
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

  const handleFilePicked = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const text = await file.text();
    setRaw(text);
    setFilename(file.name);
  };

  // Zero parsed segments (e.g. a file of pure NOTE/STYLE blocks or
  // unparseable garbage) would import a valid-but-empty session —
  // require at least one segment before enabling the confirm.
  const canConfirm =
    raw.trim().length > 0 && !!parsed && parsed.segments.length > 0 && !parseError;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm({ raw, filename, translate });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="scroll-thin max-h-[85vh] w-[560px] max-w-[92vw] overflow-y-auto rounded-none border border-edge2 bg-panel p-5">
        <div className="mb-4 text-lg font-semibold text-fg">导入文稿</div>

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
              className="mt-1 w-full resize-y rounded-sm border border-edge bg-panel2 px-3 py-2 font-mono text-sm text-fg placeholder:text-mut2 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.srt,.vtt,text/plain"
              className="hidden"
              onChange={(e) => {
                void handleFilePicked(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="btn-tactile flex items-center gap-2 rounded-sm border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
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
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t border-edge pt-4">
          <button
            type="button"
            onClick={onClose}
            className="btn-tactile rounded-sm px-4 py-2 text-sm text-mut hover:bg-panel3 hover:text-fg"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={handleConfirm}
            className="btn-terminal rounded-none bg-act px-4 py-2 font-mono text-sm font-semibold text-ink hover:bg-[#E8E8E8] disabled:cursor-not-allowed disabled:opacity-50"
          >
            导入并分析
          </button>
        </div>
      </div>
    </div>
  );
}
