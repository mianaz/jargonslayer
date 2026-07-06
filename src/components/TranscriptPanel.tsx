"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import { useApp } from "../lib/store";
import type { ExpressionCard } from "../lib/types";
import HoverGlossCard from "./HoverGlossCard";

const SCROLL_STICKY_THRESHOLD = 80;
const MAX_HIGHLIGHT_CARDS = 30;
const HOVER_ENTER_DELAY_MS = 150;
const HOVER_LEAVE_DELAY_MS = 200;

// Fixed 5-color palette (theme tokens only) for speaker chips, picked
// by a stable hash of the speaker name.
const SPEAKER_PALETTE = [
  { text: "text-acc", border: "border-acc/40", bg: "bg-acc/10" },
  { text: "text-acc2", border: "border-acc2/40", bg: "bg-acc2/10" },
  { text: "text-gold", border: "border-gold/40", bg: "bg-gold/10" },
  { text: "text-warn", border: "border-warn/40", bg: "bg-warn/10" },
  { text: "text-fg", border: "border-fg/30", bg: "bg-fg/5" },
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface HighlightMatcher {
  regex: RegExp | null;
  // lowercased matched literal -> card id (last one wins if duplicate
  // expressions across cards; acceptable, purely cosmetic).
  byLower: Map<string, string>;
}

/** Build one combined regex from the most recent cards, longest
 * expression first so multi-word phrases win over their substrings.
 * The last word of each expression may carry an optional trailing
 * inflection (s|ed|ing|d), e.g. "raise eyebrows" also matches
 * "raised eyebrows". "Most recent" is by lastSeenAt, not insertion
 * order — a card re-detected recently should stay eligible even if
 * many other cards were newly inserted after it. */
function buildMatcher(cards: ExpressionCard[]): HighlightMatcher {
  const recent = [...cards]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_HIGHLIGHT_CARDS);
  const byLower = new Map<string, string>();
  const parts: string[] = [];

  const sorted = [...recent].sort(
    (a, b) => b.expression.length - a.expression.length,
  );

  for (const card of sorted) {
    const expr = card.expression.trim();
    if (!expr) continue;
    byLower.set(expr.toLowerCase(), card.id);

    const words = expr.split(/\s+/);
    const escapedWords = words.map((w, i) => {
      const escaped = escapeRegExp(w);
      const isLast = i === words.length - 1;
      return isLast ? `${escaped}(?:s|ed|ing|d)?` : escaped;
    });
    parts.push(escapedWords.join("\\s+"));
  }

  if (parts.length === 0) {
    return { regex: null, byLower };
  }

  const regex = new RegExp(`\\b(${parts.join("|")})\\b`, "giu");
  return { regex, byLower };
}

/** Look up a matched literal's card id, trying the exact match then
 * stripping a trailing inflection off the last word. */
function resolveCardId(matcher: HighlightMatcher, matched: string): string | undefined {
  const lower = matched.toLowerCase();
  const direct = matcher.byLower.get(lower);
  if (direct) return direct;

  const stripped = lower.replace(/(?:ing|ed|s|d)$/u, "");
  for (const [key, id] of matcher.byLower) {
    if (key === stripped || key.replace(/(?:ing|ed|s|d)$/u, "") === stripped) {
      return id;
    }
    if (lower.startsWith(key)) return id;
  }
  return undefined;
}

function HighlightedText({
  text,
  matcher,
  onExpr,
  onExprEnter,
  onExprLeave,
}: {
  text: string;
  matcher: HighlightMatcher;
  onExpr: (cardId: string, rect: DOMRect) => void;
  onExprEnter?: (cardId: string, rect: DOMRect) => void;
  onExprLeave?: () => void;
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
    const cardId = resolveCardId(matcher, matched);
    if (cardId) {
      nodes.push(
        <span
          key={key++}
          className="hl-expr"
          onClick={(e) =>
            onExpr(cardId, e.currentTarget.getBoundingClientRect())
          }
          onMouseEnter={(e) =>
            onExprEnter?.(cardId, e.currentTarget.getBoundingClientRect())
          }
          onMouseLeave={() => onExprLeave?.()}
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
  card: ExpressionCard;
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
      className="fixed z-50 w-64 rounded-xl border border-edge bg-panel2 p-3 shadow-xl"
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
        className="w-full rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg focus:outline-none"
      />
      <div className="mt-2 text-xs leading-[1.7] text-mut">
        重命名将应用到该说话人的所有 {request.segmentCount} 段发言
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="btn-tactile rounded-lg px-3 py-1.5 text-xs text-mut hover:bg-panel3 hover:text-fg"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          className="btn-tactile rounded-lg bg-acc px-3 py-1.5 text-xs font-medium text-white hover:bg-acchover"
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
        className="w-full resize-none rounded-lg border border-edge bg-panel2 p-2 text-[15px] leading-relaxed text-fg focus:outline-none"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="btn-tactile rounded-lg px-3 py-1 text-xs text-mut hover:bg-panel3 hover:text-fg"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSave}
          className="btn-tactile rounded-lg bg-acc px-3 py-1 text-xs font-medium text-white hover:bg-acchover"
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
  const status = useApp((s) => s.status);
  const focusMode = useApp((s) => s.focusMode);
  const setFocusCard = useApp((s) => s.setFocusCard);
  const setLookup = useApp((s) => s.setLookup);
  const updateSegmentText = useApp((s) => s.updateSegmentText);

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

  const matcher = useMemo(() => buildMatcher(cards), [cards]);
  const cardsById = useMemo(() => {
    const map = new Map<string, ExpressionCard>();
    for (const c of cards) map.set(c.id, c);
    return map;
  }, [cards]);

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

  const handleExprEnter = (cardId: string, rect: DOMRect) => {
    if (!focusMode) return;
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    const card = cardsById.get(cardId);
    if (!card) return;
    if (enterTimer.current) clearTimeout(enterTimer.current);
    enterTimer.current = setTimeout(() => {
      enterTimer.current = null;
      setGloss((prev) =>
        prev?.pinned
          ? prev
          : { card, x: rect.left, y: rect.bottom + 6, pinned: false },
      );
    }, HOVER_ENTER_DELAY_MS);
  };

  const handleExprLeave = () => {
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

  const handleExprClick = (cardId: string, rect: DOMRect) => {
    if (!focusMode) {
      setFocusCard(cardId);
      return;
    }
    clearTimers();
    const card = cardsById.get(cardId);
    if (!card) return;
    setGloss({ card, x: rect.left, y: rect.bottom + 6, pinned: true });
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
        className="scroll-thin flex-1 overflow-y-auto px-4 py-3"
        onScroll={handleScroll}
        onMouseUp={handleMouseUp}
      >
        {isEmpty ? (
          <div className="relative flex h-full flex-col items-center justify-center text-center">
            <div className="text-xl font-display font-semibold text-fg">
              <span className="text-gold/50">❖</span> 准备好开会了{" "}
              <span className="text-gold/50">❖</span>
            </div>
            {/* No drop-cap here: on a centered two-line zh paragraph the
                floated cap splits the word 「选择」 and reads as a bug;
                the cap stays on the tutorial's left-aligned lead. */}
            <div className="mt-2 max-w-sm text-[15px] leading-[26px] text-mut">
              选择上方引擎并点「开始监听」，或点「演示」先看效果，演示无需麦克风与
              API Key。
            </div>
            <img
              src="/icon-192.png"
              alt=""
              className="pointer-events-none absolute bottom-6 right-6 h-56 w-56 select-none opacity-[0.05]"
            />
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
                  className="fade-up mb-2 flex items-start gap-2"
                  data-segment-text={seg.text}
                >
                  <span className="mt-0.5 shrink-0 font-mono text-xs text-mut">
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
                                segmentCount: speakerCounts.get(seg.speaker!) ?? 1,
                                x: rect.left,
                                y: rect.bottom,
                              });
                            }
                          : undefined
                      }
                      className={`group/chip mt-0.5 flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${palette.text} ${palette.border} ${palette.bg} ${
                        editable
                          ? "cursor-pointer hover:ring-1 hover:ring-edge"
                          : ""
                      }`}
                    >
                      {seg.speaker}
                      {editable && (
                        <PencilSimple
                          size={10}
                          weight="regular"
                          className="opacity-0 transition-opacity group-hover/chip:opacity-100"
                        />
                      )}
                    </span>
                  )}
                  {isEditingThis ? (
                    <div className="flex-1">
                      <SegmentEditTextarea
                        value={editValue}
                        onChange={setEditValue}
                        onSave={saveEditingSegment}
                        onCancel={cancelEditingSegment}
                      />
                    </div>
                  ) : (
                    <span
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
                        onExpr={handleExprClick}
                        onExprEnter={handleExprEnter}
                        onExprLeave={handleExprLeave}
                      />
                    </span>
                  )}
                </div>
              );
            })}

            {interim && (
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 font-mono text-xs text-mut opacity-0">
                  --:--:--
                </span>
                {interim.speaker &&
                  (() => {
                    const palette = SPEAKER_PALETTE[hashSpeaker(interim.speaker)];
                    return (
                      <span
                        className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-xs ${palette.text} ${palette.border} ${palette.bg}`}
                      >
                        {interim.speaker}
                      </span>
                    );
                  })()}
                <span className="text-[15px] italic leading-relaxed text-mut">
                  {interim.text}
                  <span className="dot-live inline-block">▍</span>
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
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-edge bg-panel2 px-3 py-1 text-xs text-fg shadow-lg"
        >
          ↓ 回到底部
        </button>
      )}

      {focusMode && gloss && (
        <HoverGlossCard
          card={gloss.card}
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
