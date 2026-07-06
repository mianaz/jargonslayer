"use client";

// Cornell-note study artifact: full-screen overlay showing the
// transcript with jargon highlighted inline, numbered annotations in
// a right margin column, and a summary block — exportable as PNG or
// Markdown. The note "sheet" is a deliberately light parchment
// surface (scoped inline styles, not global tokens) so the exported
// image reads as a real study note against the dark app chrome.

import { useEffect, useMemo, useRef } from "react";
import { toPng } from "html-to-image";
import { Copy, DownloadSimple, FileArrowDown, X } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import {
  buildCornellModel,
  cornellToMarkdown,
  type AnnotationKind,
  type CornellSegment,
} from "@/lib/cornell";
import { copyToClipboard, downloadFile } from "@/lib/history/export";

export interface CornellNoteProps {
  open: boolean;
  onClose: () => void;
}

const PAPER_BG = "#F5F0E6";
const PAPER_TEXT = "#2A2620";
const PAPER_BORDER = "rgba(42, 38, 32, 0.18)";
const PAPER_BORDER_INNER = "rgba(42, 38, 32, 0.1)";
const PAPER_MUT = "rgba(42, 38, 32, 0.55)";
const GOLD_HL = "rgba(229, 180, 85, 0.28)";
const GOLD_HL_TEXT = "#8A6413";
// The parchment sheet is a frozen v2-era artifact: its serif display face
// is pinned inline (the global font-display utility was retired in v3).
const PAPER_DISPLAY = '"Songti SC", "STSong", serif';
const BLUE_HL = "rgba(91, 157, 255, 0.22)";
const BLUE_HL_TEXT = "#2857A6";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

/** Renders one segment's runs, coloring highlighted spans gold
 *  (expression) or blue (term) with a superscript ref number. */
function SegmentRuns({
  segment,
  kindByRef,
}: {
  segment: CornellSegment;
  kindByRef: Map<number, AnnotationKind>;
}) {
  return (
    <>
      {segment.runs.map((run, i) => {
        if (run.ref === undefined) return <span key={i}>{run.text}</span>;
        const isTerm = kindByRef.get(run.ref) === "term";
        return (
          <span key={i}>
            <span
              style={{
                background: isTerm ? BLUE_HL : GOLD_HL,
                color: isTerm ? BLUE_HL_TEXT : GOLD_HL_TEXT,
                borderRadius: 2,
                padding: "0 2px",
              }}
            >
              {run.text}
            </span>
            <sup style={{ color: PAPER_MUT, fontSize: "0.7em" }}>{run.ref}</sup>
          </span>
        );
      })}
    </>
  );
}

export default function CornellNote({ open, onClose }: CornellNoteProps) {
  const segments = useApp((s) => s.segments);
  const cards = useApp((s) => s.cards);
  const terms = useApp((s) => s.terms);
  const summary = useApp((s) => s.summary);
  const explainLanguage = useApp((s) => s.settings.explainLanguage);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const startedAt = useApp((s) => s.startedAt);
  const showToast = useApp((s) => s.showToast);

  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const title = activeSessionId ? "会议笔记" : "当前会议";
  const date = startedAt ?? (segments[0]?.startedAt ?? Date.now());

  const model = useMemo(
    () =>
      buildCornellModel({
        title,
        date,
        segments,
        cards,
        terms,
        summary: summary?.summary ?? null,
        explainLanguage,
      }),
    [title, date, segments, cards, terms, summary, explainLanguage],
  );

  const kindByRef = useMemo(() => {
    const map = new Map<number, AnnotationKind>();
    for (const a of model.annotations) map.set(a.n, a.kind);
    return map;
  }, [model.annotations]);

  // ESC dismisses; close button gets focus on open (a11y baseline for
  // a role="dialog" overlay — see HistoryDrawer's Escape pattern for
  // nested popovers, extended here to the overlay itself).
  useEffect(() => {
    if (!open) return;
    closeBtnRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleExportPng = async () => {
    const node = sheetRef.current;
    if (!node) return;
    try {
      const dataUrl = await toPng(node, { pixelRatio: 2, backgroundColor: PAPER_BG });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `${formatDateStamp(date)}-cornell.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      console.warn("[CornellNote] PNG export failed", err);
      showToast("导出图片失败");
    }
  };

  const handleExportMarkdown = () => {
    downloadFile(`${formatDateStamp(date)}-cornell.md`, cornellToMarkdown(model), "text/markdown");
  };

  const handleCopyMarkdown = async () => {
    const ok = await copyToClipboard(cornellToMarkdown(model));
    showToast(ok ? "已复制到剪贴板" : "复制失败");
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="康奈尔笔记"
      data-testid="cornell-overlay"
      className="fixed inset-0 z-50 flex flex-col bg-ink/95"
    >
      {/* Toolbar: sticky top, outside the exported sheet. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-edge bg-panel px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          康奈尔笔记
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleExportPng()}
            className="btn-tactile flex items-center gap-1.5 rounded-sm border border-edge2 px-3 py-1.5 font-mono text-xs text-fg hover:bg-panel3"
          >
            <DownloadSimple size={14} weight="regular" />
            导出 PNG
          </button>
          <button
            type="button"
            onClick={handleExportMarkdown}
            className="btn-tactile flex items-center gap-1.5 rounded-sm border border-edge2 px-3 py-1.5 font-mono text-xs text-fg hover:bg-panel3"
          >
            <FileArrowDown size={14} weight="regular" />
            导出 Markdown
          </button>
          <button
            type="button"
            onClick={() => void handleCopyMarkdown()}
            className="btn-tactile flex items-center gap-1.5 rounded-sm border border-edge2 px-3 py-1.5 font-mono text-xs text-fg hover:bg-panel3"
          >
            <Copy size={14} weight="regular" />
            复制 Markdown
          </button>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="btn-tactile flex h-8 w-8 items-center justify-center rounded-sm text-mut hover:bg-panel3 hover:text-fg"
          >
            <X size={18} weight="regular" />
          </button>
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto px-4 py-8 sm:px-8">
        {model.empty ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-24 text-center">
            <div className="text-lg font-medium text-fg">
              还没有可生成的笔记
            </div>
            <div className="text-sm leading-[26px] text-mut">
              开一场会议，留下转录之后，康奈尔笔记会自动整理高亮与批注。
            </div>
          </div>
        ) : (
          <div
            ref={sheetRef}
            className="relative mx-auto max-w-[880px] rounded-xl p-8 sm:p-10"
            style={{
              background: PAPER_BG,
              color: PAPER_TEXT,
              border: `1px solid ${PAPER_BORDER}`,
            }}
          >
            {/* Double-line manuscript border: outer border above, inner
               ruling here (globals.css's .card-manuscript is tuned for
               the dark app surface — gold/blue rgba on near-black — and
               reads as invisible on this light parchment sheet, so the
               inner line is a scoped inline-style div instead). */}
            <div
              aria-hidden
              className="pointer-events-none absolute rounded-lg"
              style={{ inset: 6, border: `1px solid ${PAPER_BORDER_INNER}` }}
            />
            <div className="relative">
              {/* header */}
              <div className="text-center">
                <div style={{ color: "#B4863A" }}>❖</div>
                <div
                  className="mt-2 text-2xl font-semibold"
                  style={{ fontFamily: PAPER_DISPLAY }}
                >
                  {model.title}
                </div>
                <div className="mt-1 text-xs font-mono tabular-nums" style={{ color: PAPER_MUT }}>
                  {formatDateTime(model.date)}
                </div>
              </div>

              {/* body: transcript (left) + annotations (right), row-aligned per segment */}
              <div className="mt-8 grid grid-cols-1 gap-y-6 sm:grid-cols-[1fr_260px] sm:gap-x-6">
                {model.segments.map((seg) => {
                  const segAnnotations = model.annotations.filter(
                    (a) => a.segmentIndex === seg.index,
                  );
                  return (
                    <div key={seg.index} className="contents">
                      <div className="text-[15px] leading-[26px]">
                        {seg.speaker && (
                          <span className="font-semibold">{seg.speaker}　</span>
                        )}
                        <SegmentRuns segment={seg} kindByRef={kindByRef} />
                      </div>
                      <div className="flex flex-col gap-2 sm:border-l sm:pl-4" style={{ borderColor: PAPER_BORDER }}>
                        {segAnnotations.map((a) => (
                          <div
                            key={a.n}
                            className="rounded-lg p-2 text-xs leading-[1.7]"
                            style={{
                              background: a.kind === "expression" ? "rgba(229,180,85,0.08)" : "rgba(91,157,255,0.08)",
                              border: `1px solid ${a.kind === "expression" ? "rgba(229,180,85,0.25)" : "rgba(91,157,255,0.25)"}`,
                            }}
                          >
                            <div
                              className="font-semibold"
                              style={{ color: a.kind === "expression" ? GOLD_HL_TEXT : BLUE_HL_TEXT }}
                            >
                              {a.n}　{a.headword}
                            </div>
                            <div className="mt-1">{a.gloss}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* summary block, full width */}
              <div className="mt-10 border-t pt-6" style={{ borderColor: PAPER_BORDER }}>
                <div
                  className="text-lg font-semibold"
                  style={{ fontFamily: PAPER_DISPLAY }}
                >
                  小结
                </div>
                {model.summary.hasSummary ? (
                  <div className="mt-3 space-y-3 text-[15px] leading-[26px]">
                    <div className="font-medium">{model.summary.topicZh}</div>
                    {model.summary.keyPointsZh.length > 0 && (
                      <ul className="list-disc space-y-1.5 pl-5">
                        {model.summary.keyPointsZh.map((p, i) => (
                          <li key={i}>{p}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <div className="mt-3 text-sm" style={{ color: PAPER_MUT }}>
                    尚未生成纪要
                  </div>
                )}
              </div>

              {/* footer */}
              <div
                className="relative mt-8 flex items-center justify-center gap-2 border-t pt-4 text-xs"
                style={{ borderColor: PAPER_BORDER, color: PAPER_MUT }}
              >
                <img
                  src="/icon-192.png"
                  alt=""
                  className="h-4 w-4 opacity-30"
                />
                JargonSlayer · {formatDateStamp(model.date)}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
