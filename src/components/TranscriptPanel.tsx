"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import { useApp } from "../lib/store";
import { buildHighlightMatcher, type HighlightHit } from "../lib/highlight";
import type { ExpressionCard, TermCard } from "../lib/types";
import HoverGlossCard, { type GlossItem } from "./HoverGlossCard";

const SCROLL_STICKY_THRESHOLD = 80;
const HOVER_ENTER_DELAY_MS = 150;
const HOVER_LEAVE_DELAY_MS = 200;

// Terminal speaker set (docs/DESIGN.md v3.3: "说话人 glyph($ / > / # 三色)").
// Six deterministic glyph+hue pairs (spec calls out 6: $ > # % @ &) picked
// by a stable hash of the speaker name — glyph and speaker-name text share
// the same lab-* hue, no filled chip background.
const SPEAKER_PALETTE = [
  { glyph: "$", text: "text-lab-cyan" },
  { glyph: ">", text: "text-lab-purple" },
  { glyph: "#", text: "text-lab-orange" },
  { glyph: "%", text: "text-lab-green" },
  { glyph: "@", text: "text-lab-yellow" },
  { glyph: "&", text: "text-lab-red" },
];

function hashSpeaker(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % SPEAKER_PALETTE.length;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Term/expression matching for the live transcript now lives in
// src/lib/highlight.ts (buildHighlightMatcher) and covers both kinds.

function HighlightedText({
  text,
  matcher,
  onHit,
  onHitEnter,
  onHitLeave,
}: {
  text: string;
  matcher: ReturnType<typeof buildHighlightMatcher>;
  onHit: (hit: HighlightHit, rect: DOMRect) => void;
  onHitEnter?: (hit: HighlightHit, rect: DOMRect) => void;
  onHitLeave?: () => void;
}) {
  if (!matcher.regex) return <>{text}</>;

  const regex = matcher.regex;
  regex.lastIndex = 0;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    const matched = match[0];
    if (match.index > lastIndex) {
      nodes.push(
        <span key={key++}>{text.slice(lastIndex, match.index)}</span>,
      );
    }
    const hit = matcher.resolve(matched);
    if (hit) {
      nodes.push(
        <span
          key={key++}
          className={hit.kind === "expression" ? "hl-expr" : "hl-term"}
          onClick={(e) =>
            onHit(hit, e.currentTarget.getBoundingClientRect())
          }
          onMouseEnter={(e) =>
            onHitEnter?.(hit, e.currentTarget.getBoundingClientRect())
          }
          onMouseLeave={() => onHitLeave?.()}
        >
          {matched}
        </span>,
      );
    } else {
      nodes.push(<span key={key++}>{matched}</span>);
    }
    lastIndex = match.index + matched.length;
    if (matched.length === 0) {
      regex.lastIndex += 1;
    }
  }

  if (lastIndex < text.length) {
    nodes.push(<span key={key++}>{text.slice(lastIndex)}</span>);
  }

  return <>{nodes}</>;
}

interface GlossState {
  item: GlossItem;
  x: number;
  y: number;
  pinned: boolean;
}

const RENAME_POPOVER_WIDTH = 256; // w-64
const RENAME_POPOVER_MAX_HEIGHT = 160;
const VIEWPORT_MARGIN = 8;

interface RenameRequest {
  speaker: string;
  segmentCount: number;
  x: number;
  y: number;
}

/** Inline speaker-rename popover, anchored at the clicked chip. Same
 *  viewport-clamp / outside-click / Escape pattern as LookupPopover. */
function SpeakerRenamePopover({
  request,
  onClose,
}: {
  request: RenameRequest;
  onClose: () => void;
}) {
  const renameSpeaker = useApp((s) => s.renameSpeaker);
  const showToast = useApp((s) => s.showToast);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(request.speaker);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const maxLeft = window.innerWidth - RENAME_POPOVER_WIDTH - VIEWPORT_MARGIN;
    const maxTop =
      window.innerHeight - RENAME_POPOVER_MAX_HEIGHT - VIEWPORT_MARGIN;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, request.x),
      Math.max(VIEWPORT_MARGIN, maxLeft),
    );
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, request.y + 6),
      Math.max(VIEWPORT_MARGIN, maxTop),
    );
    setPos({ left, top });
    inputRef.current?.select();
  }, [request]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [onClose]);

  const handleConfirm = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === request.speaker) {
      onClose();
      return;
    }
    renameSpeaker(request.speaker, trimmed);
    showToast("已重命名");
    onClose();
  };

  if (!pos) return null;

  return (
    <div
      ref={ref}
      className="fixed z-50 w-64 rounded-sm border border-edge bg-panel2 p-3 shadow-xl"
      style={{ left: pos.left, top: pos.top }}
    >
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleConfirm();
        }}
        className="w-full rounded-sm border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg focus:outline-none"
      />
      <div className="mt-2 text-xs leading-[1.7] text-mut">
        重命名将应用到该说话人的所有 {request.segmentCount} 段发言
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="btn-tactile rounded-sm px-3 py-1.5 text-xs text-mut hover:bg-panel3 hover:text-fg"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          className="btn-terminal rounded-sm bg-act px-3 py-1.5 text-xs font-medium text-ink hover:bg-[#E8E8E8]"
        >
          确定
        </button>
      </div>
    </div>
  );
}

/** Auto-height textarea: grows with content, matches the transcript's
 *  font metrics so the swap-in reads as "the same text, now editable". */
function SegmentEditTextarea({
  value,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <div>
      <textarea
        ref={ref}
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && e.metaKey) {
            e.preventDefault();
            onSave();
          }
        }}
        className="w-full resize-none rounded-sm border border-edge bg-panel2 p-2 text-[15px] leading-relaxed text-fg focus:outline-none"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="btn-tactile rounded-sm px-3 py-1 text-xs text-mut hover:bg-panel3 hover:text-fg"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSave}
          className="btn-terminal rounded-sm bg-act px-3 py-1 text-xs font-medium text-ink hover:bg-[#E8E8E8]"
        >
          保存
        </button>
      </div>
    </div>
  );
}

export default function TranscriptPanel() {
  const segments = useApp((s) => s.segments);
  const interim = useApp((s) => s.interim);
  const cards = useApp((s) => s.cards);
  const terms = useApp((s) => s.terms);
  const status = useApp((s) => s.status);
  const focusMode = useApp((s) => s.focusMode);
  const setFocusCard = useApp((s) => s.setFocusCard);
  const setLookup = useApp((s) => s.setLookup);
  const updateSegmentText = useApp((s) => s.updateSegmentText);
  // Live bilingual transcript (#42).
  const bilingualTranscript = useApp((s) => s.settings.bilingualTranscript);
  const translations = useApp((s) => s.translations);

  // Transcript editing only applies to sessions that are done being
  // recorded (finished / imported / loaded from history). No editing
  // affordances while live listening.
  const editable = status === "stopped";

  const containerRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  // Speaker rename popover, anchored at the clicked chip.
  const [renameRequest, setRenameRequest] = useState<RenameRequest | null>(
    null,
  );

  // Segment text correction: one segment editable at a time; starting
  // another discards the previous unsaved edit.
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(
    null,
  );
  const [editValue, setEditValue] = useState("");

  const startEditingSegment = (segId: string, text: string) => {
    setEditingSegmentId(segId);
    setEditValue(text);
  };

  const cancelEditingSegment = () => {
    setEditingSegmentId(null);
    setEditValue("");
  };

  const saveEditingSegment = () => {
    if (!editingSegmentId) return;
    updateSegmentText(editingSegmentId, editValue);
    setEditingSegmentId(null);
    setEditValue("");
  };

  const matcher = useMemo(
    () => buildHighlightMatcher(cards, terms),
    [cards, terms],
  );
  const cardsById = useMemo(() => {
    const map = new Map<string, ExpressionCard>();
    for (const c of cards) map.set(c.id, c);
    return map;
  }, [cards]);
  const termsById = useMemo(() => {
    const map = new Map<string, TermCard>();
    for (const t of terms) map.set(t.id, t);
    return map;
  }, [terms]);

  // Segment count per speaker, for the rename popover's hint copy.
  const speakerCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of segments) {
      if (!s.speaker) continue;
      map.set(s.speaker, (map.get(s.speaker) ?? 0) + 1);
    }
    return map;
  }, [segments]);

  // Focus-mode hover gloss: one card at a time, hover shows it after a
  // short delay, click pins it. Timers via refs so re-entering a span
  // before the leave-timeout fires cancels the pending hide.
  const [gloss, setGloss] = useState<GlossState | null>(null);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (enterTimer.current) {
      clearTimeout(enterTimer.current);
      enterTimer.current = null;
    }
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  useEffect(() => clearTimers, []);

  // Focus mode toggling off: drop any open gloss card immediately.
  useEffect(() => {
    if (!focusMode) {
      clearTimers();
      setGloss(null);
    }
  }, [focusMode]);

  // Resolve a hit to its full GlossItem, looking it up in whichever map
  // matches its kind.
  const resolveGlossItem = (hit: HighlightHit): GlossItem | undefined => {
    if (hit.kind === "expression") {
      const card = cardsById.get(hit.id);
      return card ? { kind: "expression", card } : undefined;
    }
    const term = termsById.get(hit.id);
    return term ? { kind: "term", term } : undefined;
  };

  const handleHitEnter = (hit: HighlightHit, rect: DOMRect) => {
    if (!focusMode) return;
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    const item = resolveGlossItem(hit);
    if (!item) return;
    if (enterTimer.current) clearTimeout(enterTimer.current);
    enterTimer.current = setTimeout(() => {
      enterTimer.current = null;
      setGloss((prev) =>
        prev?.pinned
          ? prev
          : { item, x: rect.left, y: rect.bottom + 6, pinned: false },
      );
    }, HOVER_ENTER_DELAY_MS);
  };

  const handleHitLeave = () => {
    if (!focusMode) return;
    if (enterTimer.current) {
      clearTimeout(enterTimer.current);
      enterTimer.current = null;
    }
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      setGloss((prev) => (prev?.pinned ? prev : null));
    }, HOVER_LEAVE_DELAY_MS);
  };

  const handleHitClick = (hit: HighlightHit, rect: DOMRect) => {
    if (!focusMode) {
      setFocusCard(hit.id);
      return;
    }
    clearTimers();
    const item = resolveGlossItem(hit);
    if (!item) return;
    setGloss({ item, x: rect.left, y: rect.bottom + 6, pinned: true });
  };

  // Escape unpins the gloss card.
  useEffect(() => {
    if (!gloss?.pinned) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearTimers();
        setGloss(null);
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [gloss?.pinned]);

  const isEmpty = segments.length === 0 && status === "idle";

  // Auto-scroll: stick to bottom unless the user scrolled up.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !stickToBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [segments, interim, stickToBottom]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom <= SCROLL_STICKY_THRESHOLD);
  };

  const scrollToBottom = () => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    // e.detail is the native click count: 2+ means this mouseup is part
    // of a double-click, which starts a segment edit instead (see
    // onDoubleClick below) and must not also open the selection-lookup
    // popover for the word double-click just selected. Also skip while
    // a segment is mid-edit.
    if (e.detail >= 2 || editingSegmentId) return;
    const container = containerRef.current;
    if (!container) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const text = selection.toString().trim();
    if (text.length < 2 || text.length > 120) return;

    const anchorNode = selection.anchorNode;
    if (!anchorNode || !container.contains(anchorNode)) return;

    // Find the enclosing segment row to recover full-sentence context.
    let el: HTMLElement | null =
      anchorNode.nodeType === Node.ELEMENT_NODE
        ? (anchorNode as HTMLElement)
        : anchorNode.parentElement;
    let contextText = text;
    while (el && el !== container) {
      if (el.dataset.segmentText) {
        contextText = el.dataset.segmentText;
        break;
      }
      el = el.parentElement;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    setLookup({
      text,
      contextText,
      x: rect.left,
      y: rect.bottom,
    });
  };

  return (
    <div className="relative flex h-full flex-col" data-testid="transcript-panel">
      <div
        ref={containerRef}
        className="scroll-thin flex-1 overflow-y-auto"
        onScroll={handleScroll}
        onMouseUp={handleMouseUp}
      >
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="rounded-sm border border-edge bg-panel2 px-4 py-2 font-mono text-sm text-mut">
              <span className="text-lab-green">$</span> jargonslayer --listen
              <span className="cursor-block ml-1 inline-block h-[1em] w-[0.55em] translate-y-[0.15em] bg-mut align-baseline">
                &nbsp;
              </span>
            </div>
            <div className="mt-3 max-w-sm text-[15px] leading-[26px] text-mut">
              选择上方引擎并点「开始监听」，或在右上角 ≡ 菜单里点「演示」先看效果，演示无需麦克风与
              API Key。
            </div>
          </div>
        ) : (
          <>
            {segments.map((seg) => {
              const palette = seg.speaker
                ? SPEAKER_PALETTE[hashSpeaker(seg.speaker)]
                : null;
              const isEditingThis = editingSegmentId === seg.id;
              return (
                <div
                  key={seg.id}
                  className="fade-up grid grid-cols-[64px_1fr] gap-3 border-b border-edge/60 px-4 py-3"
                  data-segment-text={seg.text}
                >
                  <div className="select-none pt-0.5 font-mono text-[11px] leading-[1.6] text-mut2">
                    {palette && (
                      <span className={`block text-sm font-bold ${palette.text}`}>
                        {palette.glyph}
                      </span>
                    )}
                    <span className="block whitespace-nowrap">
                      {formatTime(seg.startedAt)}
                    </span>
                    {seg.speaker && palette && (
                      <span
                        onClick={
                          editable
                            ? (e) => {
                                const rect =
                                  e.currentTarget.getBoundingClientRect();
                                setRenameRequest({
                                  speaker: seg.speaker!,
                                  segmentCount:
                                    speakerCounts.get(seg.speaker!) ?? 1,
                                  x: rect.left,
                                  y: rect.bottom,
                                });
                              }
                            : undefined
                        }
                        className={`group/chip mt-0.5 inline-flex items-center gap-1 ${palette.text} ${
                          editable
                            ? "cursor-pointer hover:underline hover:decoration-dotted hover:underline-offset-2"
                            : ""
                        }`}
                      >
                        {seg.speaker}
                        {editable && (
                          <PencilSimple
                            size={9}
                            weight="regular"
                            className="opacity-0 transition-opacity group-hover/chip:opacity-100"
                          />
                        )}
                      </span>
                    )}
                  </div>
                  {isEditingThis ? (
                    <div>
                      <SegmentEditTextarea
                        value={editValue}
                        onChange={setEditValue}
                        onSave={saveEditingSegment}
                        onCancel={cancelEditingSegment}
                      />
                    </div>
                  ) : (
                    <div
                      className="text-[15px] leading-relaxed"
                      onDoubleClick={
                        editable
                          ? () => {
                              window.getSelection()?.removeAllRanges();
                              startEditingSegment(seg.id, seg.text);
                            }
                          : undefined
                      }
                    >
                      <HighlightedText
                        text={seg.text}
                        matcher={matcher}
                        onHit={handleHitClick}
                        onHitEnter={handleHitEnter}
                        onHitLeave={handleHitLeave}
                      />
                      {bilingualTranscript && translations[seg.id] && (
                        <div className="mt-0.5 text-xs leading-[1.6] text-mut">
                          {translations[seg.id]}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {interim && (
              <div className="grid grid-cols-[64px_1fr] gap-3 border-b border-edge/60 px-4 py-3">
                <div className="select-none pt-0.5 font-mono text-[11px] leading-[1.6] text-mut2">
                  {interim.speaker &&
                    (() => {
                      const palette =
                        SPEAKER_PALETTE[hashSpeaker(interim.speaker)];
                      return (
                        <>
                          <span className={`block text-sm font-bold ${palette.text}`}>
                            {palette.glyph}
                          </span>
                          <span className={`mt-0.5 inline-block ${palette.text}`}>
                            {interim.speaker}
                          </span>
                        </>
                      );
                    })()}
                </div>
                <span className="text-[15px] italic leading-relaxed text-mut">
                  {interim.text}
                  <span className="cursor-block ml-0.5 inline-block h-[1em] w-[0.6em] translate-y-[0.15em] bg-mut align-baseline" />
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {!stickToBottom && !isEmpty && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-sm border border-edge bg-panel2 px-3 py-1 font-mono text-xs text-fg shadow-xl"
        >
          ↓ 回到底部
        </button>
      )}

      {focusMode && gloss && (
        <HoverGlossCard
          item={gloss.item}
          x={gloss.x}
          y={gloss.y}
          pinned={gloss.pinned}
          onClose={() => {
            clearTimers();
            setGloss(null);
          }}
        />
      )}

      {renameRequest && (
        <SpeakerRenamePopover
          request={renameRequest}
          onClose={() => setRenameRequest(null)}
        />
      )}
    </div>
  );
}
