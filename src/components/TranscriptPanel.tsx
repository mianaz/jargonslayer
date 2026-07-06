"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
 * "raised eyebrows". */
function buildMatcher(cards: ExpressionCard[]): HighlightMatcher {
  const recent = cards.slice(-MAX_HIGHLIGHT_CARDS);
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

export default function TranscriptPanel() {
  const segments = useApp((s) => s.segments);
  const interim = useApp((s) => s.interim);
  const cards = useApp((s) => s.cards);
  const status = useApp((s) => s.status);
  const focusMode = useApp((s) => s.focusMode);
  const setFocusCard = useApp((s) => s.setFocusCard);
  const setLookup = useApp((s) => s.setLookup);

  const containerRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  const matcher = useMemo(() => buildMatcher(cards), [cards]);
  const cardsById = useMemo(() => {
    const map = new Map<string, ExpressionCard>();
    for (const c of cards) map.set(c.id, c);
    return map;
  }, [cards]);

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

  const handleMouseUp = () => {
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
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="text-xl font-medium text-fg">准备好开会了</div>
            <div className="mt-2 max-w-sm text-sm text-mut">
              选择上方引擎并点「开始监听」，或点「演示」先看效果 —
              演示无需麦克风与 API Key
            </div>
          </div>
        ) : (
          <>
            {segments.map((seg) => {
              const palette = seg.speaker
                ? SPEAKER_PALETTE[hashSpeaker(seg.speaker)]
                : null;
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
                      className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-xs ${palette.text} ${palette.border} ${palette.bg}`}
                    >
                      {seg.speaker}
                    </span>
                  )}
                  <span className="text-[15px] leading-relaxed">
                    <HighlightedText
                      text={seg.text}
                      matcher={matcher}
                      onExpr={handleExprClick}
                      onExprEnter={handleExprEnter}
                      onExprLeave={handleExprLeave}
                    />
                  </span>
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
    </div>
  );
}
