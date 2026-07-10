"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PencilSimple } from "@phosphor-icons/react";
import { useApp } from "../lib/store";
import { buildHighlightMatcher, type HighlightHit } from "../lib/highlight";
import type { ExpressionCard, TermCard, TranscriptSegment } from "../lib/types";
import HoverGlossCard, { type GlossItem } from "./HoverGlossCard";

const SCROLL_STICKY_THRESHOLD = 80;
const HOVER_ENTER_DELAY_MS = 150;
const HOVER_LEAVE_DELAY_MS = 200;
// Interim growth throttle (render-perf split, see the design doc):
// commits an interim UPDATE at most this often (~8fps) — but a
// transition to null (a final just landed) always commits immediately,
// never throttled, so there's no stale interim flash after a final.
const INTERIM_THROTTLE_MS = 125;

// v0.2.1 transcript-only display settings (Settings → 显示): numeric
// multipliers for the --ts-scale / --ts-leading custom properties
// consumed by globals.css's .ts-body / .ts-translation classes.
// "follow"/"standard" map to 1 / 1.7 — i.e. today's unchanged look.
const TRANSCRIPT_SCALE_VALUE: Record<string, number> = {
  follow: 1,
  lg: 1.15,
  xl: 1.3,
};
const TRANSCRIPT_LEADING_VALUE: Record<string, number> = {
  compact: 1.5,
  standard: 1.7,
  relaxed: 1.9,
};

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
          className="btn-terminal rounded-sm bg-act px-3 py-1.5 text-xs font-medium text-ink hover:bg-act/85"
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
          className="btn-terminal rounded-sm bg-act px-3 py-1 text-xs font-medium text-ink hover:bg-act/85"
        >
          保存
        </button>
      </div>
    </div>
  );
}

// ---- render split (stt-vad-supervisor.md): a live interim tick used
// to re-render the WHOLE segment list (every row's highlight regex
// re-scanning its text on every partial). SegmentRow is memoized with
// stable (useCallback'd) handlers from the panel so an interim update
// — which no longer even lives in this component's props — never
// invalidates it; InterimLine owns its own `interim` subscription so
// only it re-renders on a partial. ----

// Test-only render-commit counters (see
// components/__tests__/TranscriptPanel.render.test.tsx). React.Profiler's
// onRender fires for a Profiler-wrapped subtree on every commit
// REGARDLESS of a memoized child bailing out (verified empirically —
// Profiler wraps a non-memoized boundary, so it can't distinguish
// "SegmentRow's memo held" from "it re-rendered to an unchanged
// result"), so it can't assert the render-split's actual point: a
// bailed memo never re-invokes its render function at all. These
// counters do, at the cost of one integer increment per real
// invocation — negligible, and otherwise inert outside tests.
export const renderCounters = { segmentRow: 0, interimLine: 0 };

interface SegmentRowProps {
  seg: TranscriptSegment;
  editable: boolean;
  isEditing: boolean;
  editValue: string;
  matcher: ReturnType<typeof buildHighlightMatcher>;
  translation: string | undefined;
  speakerCount: number;
  onStartEdit: (segId: string, text: string) => void;
  onChangeEditValue: (v: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onRenameRequest: (speaker: string, segmentCount: number, x: number, y: number) => void;
  onHitClick: (hit: HighlightHit, rect: DOMRect) => void;
  onHitEnter: (hit: HighlightHit, rect: DOMRect) => void;
  onHitLeave: () => void;
}

export const SegmentRow = memo(function SegmentRow({
  seg,
  editable,
  isEditing,
  editValue,
  matcher,
  translation,
  speakerCount,
  onStartEdit,
  onChangeEditValue,
  onSaveEdit,
  onCancelEdit,
  onRenameRequest,
  onHitClick,
  onHitEnter,
  onHitLeave,
}: SegmentRowProps) {
  renderCounters.segmentRow += 1;
  const palette = seg.speaker ? SPEAKER_PALETTE[hashSpeaker(seg.speaker)] : null;

  return (
    <div
      className="fade-up grid grid-cols-[64px_1fr] gap-3 border-b border-edge/60 px-4 py-3"
      data-segment-text={seg.text}
    >
      <div className="select-none pt-0.5 font-mono text-[11px] leading-[1.6] text-mut2">
        {palette && (
          <span className={`block text-sm font-bold ${palette.text}`}>
            {palette.glyph}
          </span>
        )}
        <span className="block whitespace-nowrap">{formatTime(seg.startedAt)}</span>
        {seg.speaker && palette && (
          <span
            onClick={
              editable
                ? (e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    onRenameRequest(seg.speaker!, speakerCount, rect.left, rect.bottom);
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
      {isEditing ? (
        <div>
          <SegmentEditTextarea
            value={editValue}
            onChange={onChangeEditValue}
            onSave={onSaveEdit}
            onCancel={onCancelEdit}
          />
        </div>
      ) : (
        <div
          className="ts-body"
          onDoubleClick={
            editable
              ? () => {
                  window.getSelection()?.removeAllRanges();
                  onStartEdit(seg.id, seg.text);
                }
              : undefined
          }
        >
          <HighlightedText
            text={seg.text}
            matcher={matcher}
            onHit={onHitClick}
            onHitEnter={onHitEnter}
            onHitLeave={onHitLeave}
          />
          {translation && (
            <div className="ts-translation mt-0.5 text-mut">{translation}</div>
          )}
        </div>
      )}
    </div>
  );
});

/** Owns the live `interim` subscription alone — the whole point of the
 *  split above. Growth is throttled to INTERIM_THROTTLE_MS (~8fps),
 *  but a transition to null (a final just landed, see webSpeech.ts's
 *  onFinal->setInterim(null) ordering in useMeeting.ts) always commits
 *  immediately so a stale interim never lingers on screen after its
 *  text has already become a real segment. */
export function InterimLine({ onGrow }: { onGrow?: () => void }) {
  renderCounters.interimLine += 1;
  const interim = useApp((s) => s.interim);
  const [displayed, setDisplayed] = useState(interim);
  const lastCommitAtRef = useRef(0);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearPending = () => {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    };

    if (interim === null) {
      clearPending();
      setDisplayed(null);
      lastCommitAtRef.current = Date.now();
      return;
    }

    const commit = () => {
      lastCommitAtRef.current = Date.now();
      setDisplayed(interim);
      onGrow?.();
    };

    const elapsed = Date.now() - lastCommitAtRef.current;
    if (elapsed >= INTERIM_THROTTLE_MS) {
      clearPending();
      commit();
    } else if (pendingTimerRef.current === null) {
      pendingTimerRef.current = setTimeout(() => {
        pendingTimerRef.current = null;
        commit();
      }, INTERIM_THROTTLE_MS - elapsed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interim]);

  useEffect(
    () => () => {
      if (pendingTimerRef.current !== null) clearTimeout(pendingTimerRef.current);
    },
    [],
  );

  if (!displayed) return null;

  return (
    <div className="grid grid-cols-[64px_1fr] gap-3 border-b border-edge/60 px-4 py-3">
      <div className="select-none pt-0.5 font-mono text-[11px] leading-[1.6] text-mut2">
        {displayed.speaker &&
          (() => {
            const palette = SPEAKER_PALETTE[hashSpeaker(displayed.speaker)];
            return (
              <>
                <span className={`block text-sm font-bold ${palette.text}`}>
                  {palette.glyph}
                </span>
                <span className={`mt-0.5 inline-block ${palette.text}`}>
                  {displayed.speaker}
                </span>
              </>
            );
          })()}
      </div>
      <span className="ts-body italic text-mut">
        {displayed.text}
        <span className="cursor-block ml-0.5 inline-block h-[1em] w-[0.6em] translate-y-[0.15em] bg-mut align-baseline" />
      </span>
    </div>
  );
}

export default function TranscriptPanel() {
  const segments = useApp((s) => s.segments);
  const cards = useApp((s) => s.cards);
  const terms = useApp((s) => s.terms);
  const status = useApp((s) => s.status);
  const focusMode = useApp((s) => s.focusMode);
  const setFocusCard = useApp((s) => s.setFocusCard);
  const setLookup = useApp((s) => s.setLookup);
  const updateSegmentText = useApp((s) => s.updateSegmentText);
  // Bilingual transcript (#42/#43): rendering is data-driven — a
  // translation exists, it shows. The settings toggle governs live
  // GENERATION only (TranslateQueue gates on it); imported sessions
  // (#43's 中文对照 checkbox) carry translations regardless of the
  // toggle, and hiding paid-for lines behind an unrelated setting
  // would strand them invisibly.
  const translations = useApp((s) => s.translations);
  // v0.2.1 transcript-only font scale / line-height (independent of
  // the global font-size tier) — set as inline CSS custom properties
  // on this panel's own root so .ts-body/.ts-translation (globals.css)
  // pick them up via calc(); rem alone wouldn't respond to a settings
  // change the way these var()-based classes do.
  const transcriptScale = useApp((s) => s.settings.transcriptScale);
  const transcriptLeading = useApp((s) => s.settings.transcriptLeading);
  const transcriptStyle = {
    "--ts-scale": TRANSCRIPT_SCALE_VALUE[transcriptScale] ?? 1,
    "--ts-leading": TRANSCRIPT_LEADING_VALUE[transcriptLeading] ?? 1.7,
  } as React.CSSProperties;

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
  // another discards the previous unsaved edit. Mirrored into refs so
  // the handlers passed down to SegmentRow (startEditingSegment etc.)
  // can stay referentially STABLE (empty useCallback deps) — needed
  // for React.memo on SegmentRow to actually hold across a keystroke
  // in the currently-editing row (see the render-split doc comment
  // above SegmentRow).
  const [editingSegmentId, setEditingSegmentIdState] = useState<
    string | null
  >(null);
  const editingSegmentIdRef = useRef<string | null>(null);
  const [editValue, setEditValueState] = useState("");
  const editValueRef = useRef("");

  const setEditingSegmentId = useCallback((id: string | null) => {
    editingSegmentIdRef.current = id;
    setEditingSegmentIdState(id);
  }, []);
  const setEditValue = useCallback((v: string) => {
    editValueRef.current = v;
    setEditValueState(v);
  }, []);

  const startEditingSegment = useCallback(
    (segId: string, text: string) => {
      setEditingSegmentId(segId);
      setEditValue(text);
    },
    [setEditingSegmentId, setEditValue],
  );

  const cancelEditingSegment = useCallback(() => {
    setEditingSegmentId(null);
    setEditValue("");
  }, [setEditingSegmentId, setEditValue]);

  const saveEditingSegment = useCallback(() => {
    const segId = editingSegmentIdRef.current;
    if (!segId) return;
    updateSegmentText(segId, editValueRef.current);
    setEditingSegmentId(null);
    setEditValue("");
  }, [updateSegmentText, setEditingSegmentId, setEditValue]);

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
  // matches its kind. Memoized (not just a plain function) so the
  // handlers below that depend on it — and are themselves passed down
  // to the memoized SegmentRow — stay referentially stable across
  // renders that don't actually change cards/terms.
  const resolveGlossItem = useCallback(
    (hit: HighlightHit): GlossItem | undefined => {
      if (hit.kind === "expression") {
        const card = cardsById.get(hit.id);
        return card ? { kind: "expression", card } : undefined;
      }
      const term = termsById.get(hit.id);
      return term ? { kind: "term", term } : undefined;
    },
    [cardsById, termsById],
  );

  const handleHitEnter = useCallback(
    (hit: HighlightHit, rect: DOMRect) => {
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
    },
    [focusMode, resolveGlossItem],
  );

  const handleHitLeave = useCallback(() => {
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
  }, [focusMode]);

  const handleHitClick = useCallback(
    (hit: HighlightHit, rect: DOMRect) => {
      if (!focusMode) {
        setFocusCard(hit.id);
        return;
      }
      clearTimers();
      const item = resolveGlossItem(hit);
      if (!item) return;
      setGloss({ item, x: rect.left, y: rect.bottom + 6, pinned: true });
    },
    [focusMode, setFocusCard, resolveGlossItem],
  );

  // Speaker-rename popover: SegmentRow reports its own speaker +
  // segment count rather than closing over `speakerCounts` (a Map
  // that gets a new reference on every segments change) so this
  // handler stays stable regardless.
  const handleRenameRequest = useCallback(
    (speaker: string, segmentCount: number, x: number, y: number) => {
      setRenameRequest({ speaker, segmentCount, x, y });
    },
    [],
  );

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

  // Auto-scroll: stick to bottom unless the user scrolled up. Keyed on
  // [segments] only now — interim moved out to its own component
  // (InterimLine), which reports growth via onInterimGrow below
  // instead of this component re-rendering on every partial.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !stickToBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [segments, stickToBottom]);

  const handleInterimGrow = () => {
    const el = containerRef.current;
    if (!el || !stickToBottom) return;
    el.scrollTop = el.scrollHeight;
  };

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
    <div
      className="relative flex h-full flex-col"
      data-testid="transcript-panel"
      style={transcriptStyle}
    >
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
            {segments.map((seg) => (
              <SegmentRow
                key={seg.id}
                seg={seg}
                editable={editable}
                isEditing={editingSegmentId === seg.id}
                editValue={editingSegmentId === seg.id ? editValue : ""}
                matcher={matcher}
                translation={translations[seg.id]}
                speakerCount={seg.speaker ? speakerCounts.get(seg.speaker) ?? 1 : 0}
                onStartEdit={startEditingSegment}
                onChangeEditValue={setEditValue}
                onSaveEdit={saveEditingSegment}
                onCancelEdit={cancelEditingSegment}
                onRenameRequest={handleRenameRequest}
                onHitClick={handleHitClick}
                onHitEnter={handleHitEnter}
                onHitLeave={handleHitLeave}
              />
            ))}

            <InterimLine onGrow={handleInterimGrow} />
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
