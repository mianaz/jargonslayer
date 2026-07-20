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
import { PencilSimple, Play } from "@phosphor-icons/react";
import { useApp, type LookupRequest } from "../lib/store";
import {
  buildHighlightMatcher,
  MAX_HIGHLIGHT_PER_KIND,
  type HighlightHit,
} from "../lib/highlight";
import { formatElapsedClock, segmentElapsedMs } from "../lib/segmentElapsed";
import { resolveTaskCreds } from "../lib/llm/taskConfig";
import { PREVIEW_TIER } from "../lib/deployTier";
import type { ExpressionCard, TermCard, TranscriptSegment } from "@jargonslayer/core/types";
import HoverGlossCard, { type GlossItem } from "./HoverGlossCard";
import SpeakerAssignPopover, { type SpeakerAssignRequest } from "./SpeakerAssignPopover";
import CorrectionReview from "./CorrectionReview";

// Exported (not just module-private) so the render-split regression
// tests (TranscriptPanel.render.test.tsx) can drive exact boundary
// timings/distances instead of guessing at or hardcoding these values.
export const SCROLL_STICKY_THRESHOLD = 80;
const HOVER_ENTER_DELAY_MS = 150;
const HOVER_LEAVE_DELAY_MS = 200;
// Interim growth throttle (render-perf split, see the design doc):
// commits an interim UPDATE at most this often (~8fps) — but a
// transition to null (a final just landed) always commits immediately,
// never throttled, so there's no stale interim flash after a final.
export const INTERIM_THROTTLE_MS = 125;
// S14.1 field fix (item 3, mobile selection lookup): how long the
// touch action-bar waits after the LAST selectionchange event before
// re-reading the selection — iOS fires a burst of these while the
// native grab-handles are being dragged, so a bare (undebounced)
// listener would re-render/re-measure on every intermediate frame.
export const TOUCH_LOOKUP_DEBOUNCE_MS = 400;

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

// Absolute wall-clock time — no longer the segment's VISIBLE timestamp
// (see the elapsed-time fix below), kept as the `title` tooltip value
// on that same span so the original real-world time is still one
// hover away.
function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Term/expression matching for the live transcript now lives in
// src/lib/highlight.ts (buildHighlightMatcher) and covers both kinds.

/** Stable identity for buildHighlightMatcher's ACTUAL inputs (2026-07
 *  VAD-supervisor review finding #8). buildHighlightMatcher only ever
 *  looks at each card/term's `id` + surface text, and only the top
 *  MAX_HIGHLIGHT_PER_KIND-per-kind entries by lastSeenAt participate —
 *  memoizing `matcher` on the raw [cards, terms] ARRAYS instead gives
 *  it (and everything downstream that depends on it — cardsById,
 *  termsById, the hit handlers, and ultimately every SegmentRow's
 *  props) a new identity on every detection update, including a
 *  count-only re-detection bump that can't possibly change what the
 *  matcher matches. This key changes if and only if the matcher's own
 *  output could. Sorted by the key string itself (not lastSeenAt) so a
 *  same-membership REORDER — which the regex is indifferent to, it
 *  sorts candidates by length, not recency — doesn't spuriously
 *  invalidate it either. */
function highlightVocabularyKey(
  cards: ExpressionCard[],
  terms: TermCard[],
): string {
  const cardKey = [...cards]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_HIGHLIGHT_PER_KIND)
    .map((c) => `${c.id}:${c.expression}`)
    .sort()
    .join("|");
  const termKey = [...terms]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_HIGHLIGHT_PER_KIND)
    .map((t) => `${t.id}:${t.term}`)
    .sort()
    .join("|");
  return `${cardKey}::${termKey}`;
}

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
      className="fixed z-50 w-64 border border-edge bg-panel2 p-3 shadow-xl"
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
        className="w-full border border-edge bg-panel px-2.5 py-1.5 text-sm text-fg focus:outline-none"
      />
      <div className="mt-2 text-xs leading-[1.7] text-mut">
        重命名将应用到该说话人的所有 {request.segmentCount} 段发言
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="btn-tactile px-3 py-1.5 text-xs text-mut hover:bg-panel3 hover:text-fg"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          className="btn-terminal bg-act px-3 py-1.5 text-xs font-medium text-ink hover:bg-act/85"
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
        className="w-full resize-none border border-edge bg-panel2 p-2 text-[15px] leading-relaxed text-fg focus:outline-none"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="btn-tactile px-3 py-1 text-xs text-mut hover:bg-panel3 hover:text-fg"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSave}
          className="btn-terminal bg-act px-3 py-1 text-xs font-medium text-ink hover:bg-act/85"
        >
          保存
        </button>
      </div>
    </div>
  );
}

/** v0.5 Wave-1 Feature 1 (live latch, §1 F1 item 4): a compact picker —
 *  a native <select> (rung 4: platform feature over a custom popover)
 *  covers "pick a roster name" / "+ 新建" / "关闭" in one accessible,
 *  mobile-friendly control. Only rendered by the parent while
 *  status==="listening" && no diarized speakers are present. */
function ActiveSpeakerLatch() {
  const activeSpeaker = useApp((s) => s.activeSpeaker);
  const speakerRoster = useApp((s) => s.speakerRoster);
  const setActiveSpeaker = useApp((s) => s.setActiveSpeaker);
  const addSpeakerToRoster = useApp((s) => s.addSpeakerToRoster);

  const OFF_VALUE = "";
  const NEW_VALUE = "__new__";

  return (
    <div className="flex items-center gap-1.5 font-mono text-xs">
      <span className="text-mut2">当前说话人</span>
      <select
        data-testid="active-speaker-latch"
        value={activeSpeaker ?? OFF_VALUE}
        onChange={(e) => {
          const v = e.target.value;
          if (v === NEW_VALUE) {
            setActiveSpeaker(addSpeakerToRoster());
          } else if (v === OFF_VALUE) {
            setActiveSpeaker(null);
          } else {
            setActiveSpeaker(v);
          }
        }}
        className="min-h-10 border border-edge2 bg-panel px-1.5 text-xs text-fg"
      >
        <option value={OFF_VALUE}>关闭</option>
        {speakerRoster.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        <option value={NEW_VALUE}>+ 新建…</option>
      </select>
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
//
// Gated behind NODE_ENV (2026-07 VAD-supervisor review finding #10):
// production builds must not write these globals on every render —
// dev/test both leave RENDER_COUNTERS_ENABLED true (NODE_ENV is
// "development"/"test" there), and bundlers can dead-code-eliminate
// the production branch since the check is a statically-known
// `process.env.NODE_ENV` comparison.
const RENDER_COUNTERS_ENABLED = process.env.NODE_ENV !== "production";
export const renderCounters = { segmentRow: 0, interimLine: 0 };

interface SegmentRowProps {
  seg: TranscriptSegment;
  editable: boolean;
  isEditing: boolean;
  editValue: string;
  matcher: ReturnType<typeof buildHighlightMatcher>;
  translation: string | undefined;
  // Elapsed-time fix: precomputed by the parent (TranscriptPanel) so
  // this memoized row never needs `startedAt`/`pauseIntervals` as
  // props of their own — both are plain strings, so React.memo's
  // default per-prop Object.is comparison still bails out correctly
  // whenever the parent recomputes the SAME value (see the parent's
  // own segmentTimeLabels memo).
  elapsedLabel: string;
  absoluteTitle: string;
  // v0.5 Wave-1 Feature 1 (selection mode, §1 F1 item 2): component-
  // local (never touches the store) — see the parent's own selectedIds
  // Set<string> state.
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (segId: string) => void;
  // Feature 1 item 1/3: chip/"+ 说话人" -> SpeakerAssignPopover.
  // Deliberately NOT `editable` — available whenever a session exists
  // (listening/paused/stopped), a user action rather than an engine
  // mutation (see store.ts's own doc on assignSegmentsSpeaker etc.).
  speakerAssignable: boolean;
  onAssignRequest: (
    segmentId: string,
    currentSpeaker: string | undefined,
    speakerLocked: boolean,
    x: number,
    y: number,
  ) => void;
  onStartEdit: (segId: string, text: string) => void;
  onChangeEditValue: (v: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
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
  elapsedLabel,
  absoluteTitle,
  selectMode,
  selected,
  onToggleSelect,
  speakerAssignable,
  onAssignRequest,
  onStartEdit,
  onChangeEditValue,
  onSaveEdit,
  onCancelEdit,
  onHitClick,
  onHitEnter,
  onHitLeave,
}: SegmentRowProps) {
  if (RENDER_COUNTERS_ENABLED) renderCounters.segmentRow += 1;
  const palette = seg.speaker ? SPEAKER_PALETTE[hashSpeaker(seg.speaker)] : null;

  return (
    <div
      className={`fade-up grid gap-3 border-b border-edge/60 px-4 py-3 ${
        selectMode ? "grid-cols-[40px_64px_1fr]" : "grid-cols-[64px_1fr]"
      }`}
      data-segment-text={seg.text}
    >
      {selectMode && (
        <div className="flex min-h-10 min-w-10 items-start justify-center pt-1">
          <input
            type="checkbox"
            data-testid={`segment-select-${seg.id}`}
            aria-label="选择该段"
            checked={selected}
            onChange={() => onToggleSelect(seg.id)}
            className="h-5 w-5 accent-lab-cyan"
          />
        </div>
      )}
      <div className="select-none pt-0.5 font-mono text-[11px] leading-[1.6] text-mut2">
        {palette && (
          <span className={`block text-sm font-bold ${palette.text}`}>
            {palette.glyph}
          </span>
        )}
        <span className="block whitespace-nowrap" title={absoluteTitle}>
          {elapsedLabel}
        </span>
        {seg.speaker && palette ? (
          <span
            onClick={
              speakerAssignable
                ? (e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    onAssignRequest(seg.id, seg.speaker, !!seg.speakerLocked, rect.left, rect.bottom);
                  }
                : undefined
            }
            className={`group/chip mt-0.5 inline-flex items-center gap-1 ${palette.text} ${
              speakerAssignable
                ? "cursor-pointer hover:underline hover:decoration-dotted hover:underline-offset-2"
                : ""
            }`}
          >
            {seg.speaker}
            {speakerAssignable && (
              <PencilSimple
                size={9}
                weight="regular"
                className="opacity-0 transition-opacity group-hover/chip:opacity-100"
              />
            )}
          </span>
        ) : (
          speakerAssignable && (
            <button
              type="button"
              data-testid={`segment-add-speaker-${seg.id}`}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                onAssignRequest(seg.id, undefined, false, rect.left, rect.bottom);
              }}
              className="mt-0.5 inline-flex items-center whitespace-nowrap text-mut2 hover:text-fg"
            >
              + 说话人
            </button>
          )
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
  if (RENDER_COUNTERS_ENABLED) renderCounters.interimLine += 1;
  const interim = useApp((s) => s.interim);
  const [displayed, setDisplayed] = useState(interim);
  const lastCommitAtRef = useRef(0);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Trailing-edge throttle bugfix (2026-07 VAD-supervisor review
  // finding #6): a burst of updates inside one throttle window used to
  // install a timer only on the FIRST of them (the `pendingTimerRef.
  // current === null` guard below) — that timer's `commit` closure
  // captured `interim` as it was AT SCHEDULING time, so every LATER
  // growth in the same window got silently dropped until the next
  // throttle tick (or indefinitely, during a stall — no further tick
  // ever comes). Reading from this ref at FIRE time instead means the
  // already-scheduled timer always commits whatever is CURRENT.
  const latestInterimRef = useRef(interim);
  latestInterimRef.current = interim;
  // Same fix applied to the scroll-follow callback: route it through a
  // ref read at execution time instead of closing over the `onGrow`
  // prop (and, transitively, the parent's `stickToBottom`) from
  // whenever the timer was scheduled — otherwise a user who scrolled
  // up DURING the pending window could get snapped back to the bottom
  // by a decision made before they scrolled. This also makes it safe
  // that the parent's onGrow (handleInterimGrow) isn't itself
  // memoized — a fresh reference every parent render is fine now.
  const onGrowRef = useRef(onGrow);
  onGrowRef.current = onGrow;

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
      setDisplayed(latestInterimRef.current);
      onGrowRef.current?.();
    };

    // Append-only transcript contract, round 3 fix #A3: a shrink (or
    // any revision that ISN'T a plain prefix-extension of what's
    // already on screen — a retraction, a genuine content swap, not
    // just more words appended) commits immediately too, same as the
    // interim===null path above. Otherwise the throttle could hold a
    // now-STALE, too-long displayed value on screen for up to
    // INTERIM_THROTTLE_MS after Chrome revised it shorter. Growth (a
    // true prefix extension) keeps the existing throttle unchanged.
    // `interim` (not the ref) is what's compared: this check runs
    // SYNCHRONOUSLY inside the effect body itself (unlike commit(),
    // which fires later from a timer and needs the ref to read the
    // LATEST value at fire time) — `interim` is already this render's
    // current value, and TS narrows it non-null here via the early
    // return above (latestInterimRef.current holds the exact same
    // value at this point, just not narrowed).
    const isShrinkOrChange =
      displayed !== null && !interim.text.startsWith(displayed.text);

    const elapsed = Date.now() - lastCommitAtRef.current;
    if (isShrinkOrChange || elapsed >= INTERIM_THROTTLE_MS) {
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

// Selection -> LookupRequest (S14.1 field fix, item 3): shared by the
// desktop mouseup handler AND the touch action-bar debounced
// selectionchange handler below, so the two entry points can never
// silently drift on the length/context-walk rules — same length
// bounds and `data-segment-text` context-walk the original mouseup-only
// version always had. `container` is whatever DOM node the selection
// must live inside (the transcript scroll container) — returns null
// for every case that should be a silent no-op (nothing selected,
// selection collapsed, too short/long, or anchored outside the
// transcript).
function selectionLookupRequest(container: HTMLElement): LookupRequest | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;

  const text = selection.toString().trim();
  if (text.length < 2 || text.length > 120) return null;

  const anchorNode = selection.anchorNode;
  if (!anchorNode || !container.contains(anchorNode)) return null;

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

  return { text, contextText, x: rect.left, y: rect.bottom };
}

export interface TranscriptPanelProps {
  // Empty-state demo CTA (E2E feedback): optional so every existing
  // render-test call site (`<TranscriptPanel />`, no props) keeps
  // working unchanged — the button itself only renders when a handler
  // is actually supplied.
  onDemo?: () => void;
}

export default function TranscriptPanel({ onDemo }: TranscriptPanelProps) {
  const segments = useApp((s) => s.segments);
  const cards = useApp((s) => s.cards);
  const terms = useApp((s) => s.terms);
  const status = useApp((s) => s.status);
  // Elapsed-time fix: same fields loadSession/beginMeeting/resumeMeeting
  // keep in sync for both a live meeting and a loaded history session
  // (loadSession funnels a saved session's own basis into these SAME
  // store fields — see store.ts) — bare selectors, matching segments/
  // cards/terms above (direct store fields, not derived).
  const startedAt = useApp((s) => s.startedAt);
  const pauseIntervals = useApp((s) => s.pauseIntervals);
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
  // v0.5 Wave-1 Feature 1 (§1 F1's own "UX shape"): speaker assignment
  // is a USER action, not an engine mutation — available whenever a
  // session exists (listening/paused/stopped), unlike `editable` above
  // (text edit stays stopped-only, untouched).
  const assignable = status === "listening" || status === "paused" || status === "stopped";
  const correctionBusy = useApp((s) => s.correctionBusy);
  // v0.5 Wave-1 Feature 2: "AI configured" — same signal AiStatusPanel's
  // own zero-config banner uses (resolved per-domain credentials, not
  // just the raw settings.apiKey field, so a taskLlm override or the
  // preview tier's server-proxied key both count). Computed INSIDE the
  // selector (cheap, boolean-only) so an unrelated settings change
  // (theme, font size, …) never re-renders this panel — only an actual
  // flip of the resolved boolean does.
  const aiConfigured = useApp(
    (s) => PREVIEW_TIER || !!resolveTaskCreds(s.settings, "detect").apiKey,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  // Speaker rename popover, anchored at the clicked chip.
  const [renameRequest, setRenameRequest] = useState<RenameRequest | null>(
    null,
  );

  // v0.5 Wave-1 Feature 1 (selection mode, §1 F1 item 2) — component-
  // local, never persisted, never touches the store directly (bulk
  // assign goes through the SAME SpeakerAssignPopover as a per-segment
  // chip click — see handleBulkAssignClick below).
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelectMode = useCallback(() => {
    setSelectMode((v) => !v);
    setSelectedIds(new Set());
  }, []);

  const handleToggleSelect = useCallback((segId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(segId)) next.delete(segId);
      else next.add(segId);
      return next;
    });
  }, []);

  // v0.5 Wave-1 Feature 1 (speaker assignment popover, §1 F1 items 1/3)
  // — replaces the old direct chip -> SpeakerRenamePopover trigger;
  // "重命名该说话人的所有发言" still reaches SpeakerRenamePopover, just via
  // handleAssignRenameAll below instead of a direct chip click.
  const [assignRequest, setAssignRequest] = useState<SpeakerAssignRequest | null>(null);

  const handleAssignRequest = useCallback(
    (
      segmentId: string,
      currentSpeaker: string | undefined,
      speakerLocked: boolean,
      x: number,
      y: number,
    ) => {
      setAssignRequest({ segmentIds: [segmentId], single: { currentSpeaker, speakerLocked }, x, y });
    },
    [],
  );

  const handleBulkAssignClick = useCallback(
    (x: number, y: number) => {
      setAssignRequest({ segmentIds: [...selectedIds], x, y });
    },
    [selectedIds],
  );

  // Selection mode exits automatically once its bulk assign actually
  // lands (SpeakerAssignPopover's onAssigned) — never for the
  // per-segment chip flow, which never passes this prop.
  const handleBulkAssigned = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  // v0.5 Wave-1 Feature 2 (AI 校正 header button).
  const [correctionOpen, setCorrectionOpen] = useState(false);

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

  // Memoized on the SEMANTIC vocabulary key, not [cards, terms]
  // directly (finding #8, see highlightVocabularyKey's doc comment) —
  // a count-only detection bump no longer gives `matcher` a new
  // identity, so SegmentRow's memo (which receives `matcher` as a
  // prop) can actually hold across it.
  const vocabularyKey = useMemo(
    () => highlightVocabularyKey(cards, terms),
    [cards, terms],
  );
  const matcher = useMemo(
    () => buildHighlightMatcher(cards, terms),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vocabularyKey],
  );
  // Elapsed-time fix: one {elapsed, absolute} label pair per segment,
  // index-aligned with `segments` — computed here (not inside
  // SegmentRow) so it stays memoized on the actual inputs that can
  // change it (segments/startedAt/pauseIntervals) rather than
  // recomputing 200 Date constructions on every unrelated re-render
  // (e.g. a cards/terms bump), matching the render-perf care already
  // taken by vocabularyKey/matcher above. `startedAt` falls back to
  // the first segment's own timestamp when the store hasn't set it
  // (shouldn't happen once a meeting/session is loaded, but keeps this
  // from ever computing a bogus negative elapsed against a null zero).
  const elapsedZero = startedAt ?? segments[0]?.startedAt ?? 0;
  const segmentTimeLabels = useMemo(
    () =>
      segments.map((seg) => ({
        elapsed: formatElapsedClock(segmentElapsedMs(elapsedZero, seg.startedAt, pauseIntervals)),
        absolute: formatTime(seg.startedAt),
      })),
    [segments, elapsedZero, pauseIntervals],
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
  // Mirrored into refs so resolveGlossItem below can stay
  // REFERENTIALLY STABLE (empty deps) regardless of how often
  // cardsById/termsById themselves get new identities — it reads the
  // latest map at CALL time instead of closing over one. That in turn
  // keeps handleHitEnter/handleHitClick (both SegmentRow props) stable
  // across a count-only cards/terms bump, same pattern already used
  // for editingSegmentIdRef/editValueRef above.
  const cardsByIdRef = useRef(cardsById);
  cardsByIdRef.current = cardsById;
  const termsByIdRef = useRef(termsById);
  termsByIdRef.current = termsById;

  // Segment count per speaker, for the rename popover's hint copy.
  const speakerCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of segments) {
      if (!s.speaker) continue;
      map.set(s.speaker, (map.get(s.speaker) ?? 0) + 1);
    }
    return map;
  }, [segments]);

  // v0.5 Wave-1 Feature 1 (live latch visibility, §1 F1 item 4): "no
  // diarized speakers present" = no segment currently displays an
  // ENGINE-provided (non-manual) speaker — a manually-assigned/latched
  // segment always carries speakerLocked:true (see store.ts), so it's
  // excluded here regardless of which engine originally produced the
  // meeting (demo/soniox/deepgram label at finalize time; whisper/
  // tabaudio's realtime diarization labels asynchronously via
  // speaker_update) — this one check covers all of them uniformly.
  const hasDiarizedSpeakers = useMemo(
    () => segments.some((s) => s.speaker && !s.speakerLocked),
    [segments],
  );
  const showLatch = status === "listening" && !hasDiarizedSpeakers;

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
        const card = cardsByIdRef.current.get(hit.id);
        return card ? { kind: "expression", card } : undefined;
      }
      const term = termsByIdRef.current.get(hit.id);
      return term ? { kind: "term", term } : undefined;
    },
    [],
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

  // v0.5 Wave-1 Feature 1: "重命名该说话人的所有发言" inside
  // SpeakerAssignPopover hands off to the EXISTING rename-all popover —
  // this is the bridge, closing over `speakerCounts` (unlike the old
  // direct chip->rename trigger, SpeakerAssignPopover only reports the
  // speaker name, not a count, so it's resolved here instead).
  const handleAssignRenameAll = useCallback(
    (speaker: string, x: number, y: number) => {
      setAssignRequest(null);
      setRenameRequest({ speaker, segmentCount: speakerCounts.get(speaker) ?? 1, x, y });
    },
    [speakerCounts],
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
    const req = selectionLookupRequest(container);
    if (req) setLookup(req);
  };

  // S14.1 field fix (item 3): mobile Safari's own text-selection
  // callout (Copy/Look Up/…) owns mouseup-equivalent gestures on touch
  // — there's no reliable, non-fighting way to pop LookupPopover
  // straight off a touch selection the way handleMouseUp does for a
  // mouse. Instead: watch document-level selectionchange (debounced —
  // it fires repeatedly while the native grab-handles are dragged) and,
  // once a selection settles inside this transcript on a coarse
  // (touch) pointer, surface a small fixed action bar above StatusLine
  // that runs the exact same selectionLookupRequest → setLookup flow
  // handleMouseUp uses. Desktop (fine pointer) never sets isCoarsePointer
  // true, so this whole path — listener, state, bar — stays inert
  // there; the mouse path above is untouched.
  const [isCoarsePointer, setIsCoarsePointer] = useState(false);
  const [touchSelection, setTouchSelection] = useState<LookupRequest | null>(
    null,
  );

  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const apply = () => setIsCoarsePointer(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!isCoarsePointer) {
      setTouchSelection(null);
      return;
    }
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const onSelectionChange = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const container = containerRef.current;
        // No editingSegmentId gate here (unlike handleMouseUp): a
        // touch selection made while a segment is mid-edit would be
        // inside the edit <textarea>, not this scroll container, so
        // selectionLookupRequest's own contains() check already
        // excludes it.
        setTouchSelection(container ? selectionLookupRequest(container) : null);
      }, TOUCH_LOOKUP_DEBOUNCE_MS);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [isCoarsePointer]);

  return (
    <div
      className="relative flex h-full flex-col"
      data-testid="transcript-panel"
      style={transcriptStyle}
    >
      {(showLatch || segments.length > 0) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge bg-panel2 px-3 py-2">
          {showLatch && <ActiveSpeakerLatch />}
          <div className="ml-auto flex items-center gap-2">
            {segments.length > 0 && (
              <button
                type="button"
                data-testid="btn-select-mode"
                onClick={toggleSelectMode}
                className={`btn-tactile min-h-10 border px-3 font-mono text-xs ${
                  selectMode ? "border-act bg-act/10 text-act" : "border-edge2 text-fg hover:bg-panel3"
                }`}
              >
                {selectMode ? "退出选择" : "选择"}
              </button>
            )}
            {aiConfigured && status === "stopped" && segments.length > 0 && (
              <button
                type="button"
                data-testid="btn-ai-correct"
                disabled={correctionBusy}
                onClick={() => setCorrectionOpen(true)}
                className="btn-tactile min-h-10 border border-edge2 px-3 font-mono text-xs text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {correctionBusy ? "校正中…" : "AI 校正"}
              </button>
            )}
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        // S14.1 field fix (iPhone Safari, ~390px): the 1st segment's
        // 1st line rendered partially covered by the h-14 fixed page
        // Header above (page.tsx) — this container otherwise starts
        // its content flush at scrollTop:0 with zero clearance, so
        // anything (a mobile-Safari sticky/flex rendering quirk) that
        // makes Header paint over the top edge hides it. pt-14 matches
        // Header's own h-14 exactly (only ever spends space once, at
        // the very top of the whole list — scrolls away immediately
        // after); scroll-pt-14 gives the same clearance to any future
        // scrollIntoView/anchor jump landing near the top.
        data-testid="transcript-scroll"
        className="scroll-thin flex-1 overflow-y-auto pt-14 scroll-pt-14"
        onScroll={handleScroll}
        onMouseUp={handleMouseUp}
      >
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="border border-edge bg-panel2 px-4 py-2 font-mono text-sm text-mut">
              <span className="text-lab-green">$</span>
              <span className="cursor-block ml-1 inline-block h-[1em] w-[0.55em] translate-y-[0.15em] bg-mut align-baseline">
                &nbsp;
              </span>
            </div>
            <div className="mt-3 max-w-sm text-[15px] leading-[26px] text-mut">
              选择下方引擎并点「开始监听」，或先看演示——无需麦克风与 API Key。
            </div>
            {onDemo && (
              <button
                type="button"
                data-testid="btn-demo-empty"
                onClick={onDemo}
                className="mt-4 flex items-center gap-1.5 border border-edge bg-panel2 px-4 py-1.5 font-mono text-sm text-fg hover:bg-panel3"
              >
                <Play size={14} weight="regular" />
                演示
              </button>
            )}
          </div>
        ) : (
          <>
            {segments.map((seg, i) => (
              <SegmentRow
                key={seg.id}
                seg={seg}
                editable={editable}
                isEditing={editingSegmentId === seg.id}
                editValue={editingSegmentId === seg.id ? editValue : ""}
                matcher={matcher}
                translation={translations[seg.id]}
                elapsedLabel={segmentTimeLabels[i]?.elapsed ?? ""}
                absoluteTitle={segmentTimeLabels[i]?.absolute ?? ""}
                selectMode={selectMode}
                selected={selectedIds.has(seg.id)}
                onToggleSelect={handleToggleSelect}
                speakerAssignable={assignable}
                onAssignRequest={handleAssignRequest}
                onStartEdit={startEditingSegment}
                onChangeEditValue={setEditValue}
                onSaveEdit={saveEditingSegment}
                onCancelEdit={cancelEditingSegment}
                onHitClick={handleHitClick}
                onHitEnter={handleHitEnter}
                onHitLeave={handleHitLeave}
              />
            ))}

            <InterimLine onGrow={handleInterimGrow} />
          </>
        )}
      </div>

      {selectMode && (
        <div className="flex shrink-0 items-center gap-3 border-t border-edge bg-panel2 px-3 py-2">
          <span className="font-mono text-xs text-mut2">已选 {selectedIds.size}</span>
          <button
            type="button"
            data-testid="btn-bulk-assign"
            disabled={selectedIds.size === 0}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              handleBulkAssignClick(rect.left, rect.top);
            }}
            className="btn-terminal min-h-10 bg-act px-3 font-mono text-xs font-medium text-ink hover:bg-act/85 disabled:cursor-not-allowed disabled:opacity-50"
          >
            指派给…
          </button>
        </div>
      )}

      {!stickToBottom && !isEmpty && (
        <button
          type="button"
          onClick={scrollToBottom}
          className={`absolute left-1/2 -translate-x-1/2 border border-edge bg-panel2 px-3 py-1 font-mono text-xs text-fg shadow-xl ${
            selectMode ? "bottom-16" : "bottom-3"
          }`}
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

      {assignRequest && (
        <SpeakerAssignPopover
          request={assignRequest}
          onClose={() => setAssignRequest(null)}
          onRenameAll={handleAssignRenameAll}
          onAssigned={selectMode ? handleBulkAssigned : undefined}
        />
      )}

      <CorrectionReview open={correctionOpen} onClose={() => setCorrectionOpen(false)} />

{/* S14.1 field fix (item 3): touch-only selection action bar —
          see the selectionchange effect above. `fixed` (not `absolute`
          like the ↓ 回到底部 button above) since it must sit above
          StatusLine (page.tsx, outside this component's own box, h-7 —
          bottom-7 matches it exactly), not just the bottom of this
          panel's own possibly-mid-page box on mobile. */}
      {touchSelection && (
        <div
          data-testid="touch-lookup-bar"
          className="fixed inset-x-0 bottom-7 z-40 flex justify-center border-t border-edge bg-panel2 px-3 py-2"
        >
          <button
            type="button"
            data-testid="btn-touch-lookup"
            onClick={() => {
              setLookup(touchSelection);
              setTouchSelection(null);
            }}
            className="btn-terminal flex items-center gap-1.5 bg-act px-4 py-1.5 font-mono text-xs font-semibold text-ink hover:bg-act/85"
          >
            解释所选
          </button>
        </div>
      )}

    </div>
  );
}
