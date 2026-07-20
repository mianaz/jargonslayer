"use client";

// S14 floating live caption — one shared presentational view, two hosts
// (see lib/captionWindow.ts's own header comment for the web
// Document-Picture-in-Picture host and the desktop shrink-the-main-
// window host). This component itself is host-agnostic: it reads the
// live meeting state straight from the store (same selectors
// TranscriptPanel/CardsPanel already use) and renders whatever the
// current window happens to be — a 420x160 PiP popup or a 480x150
// desktop strip — via `fixed inset-0`, so it always fills its host
// window regardless of that host's own body/margin defaults.
//
// `data-tauri-drag-region="deep"` on the root: inert outside a Tauri
// webview (an ordinary browser/PiP window ignores the unknown data
// attribute), and on desktop lets the user drag the now-chromeless
// caption strip by clicking ANYWHERE in its body — see
// lib/captionWindow.ts's desktop-host doc for why the strip has no OS
// title bar to drag by otherwise. "deep" (not the bare/"true" self-only
// form) makes the WHOLE subtree a drag region in one shot, no per-child
// attribute needed below: the ✕ button stays clickable on its own,
// since Tauri's own injected drag script excludes clickable tags
// (BUTTON among them) before it ever reaches a drag-region check —
// verified against the vendored crate source (tauri-2.11.5/src/window/
// scripts/drag.js): CLICKABLE_TAGS/the exclusion check (lines 12-20,
// 58), the "deep" subtree branch (line 64), and the
// plugin:window|start_dragging invoke (line 104). Requires
// capabilities/default.json's own core:window:allow-start-dragging
// grant (S14 fix-round finding 6).

import { useApp } from "@/lib/store";
import { X } from "@phosphor-icons/react";
import type { ExpressionCard, TermCard } from "@jargonslayer/core/types";

// Character budget for the two transcript lines. Deliberately NOT a
// CSS `truncate`/`line-clamp` alone: those ellipsize from the END,
// showing the START of a long line — wrong for a live caption, which
// must show the TAIL (the words just spoken). tailText below trims
// from the front instead; `truncate` is still applied in the className
// as a defensive backstop for the rare case a still-too-wide tail
// (e.g. unusually wide glyphs) overflows even after this pre-trim.
const TAIL_MAX_CHARS = 72;

/** Returns the tail (end) of `text`, prefixed with "…" when trimmed.
 *  Exported for direct unit testing (pure, no store/DOM dependency). */
export function tailText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `…${trimmed.slice(trimmed.length - maxChars)}`;
}

/** Most-recently-seen card across BOTH expression cards and terms,
 *  formatted "term — short gloss" — same lastSeenAt-first sort
 *  CardsPanel's own toUnified uses, trimmed to just the single newest
 *  entry (this surface only ever shows one gloss line). Exported for
 *  direct unit testing. */
export function mostRecentGlossLine(
  cards: ExpressionCard[],
  terms: TermCard[],
): string | null {
  const items: { surface: string; gloss: string; sortAt: number }[] = [
    ...cards.map((c) => ({
      surface: c.expression,
      gloss: c.chinese_explanation,
      sortAt: c.lastSeenAt ?? c.firstSeenAt,
    })),
    ...terms.map((t) => ({
      surface: t.term,
      gloss: t.gloss_zh,
      sortAt: t.lastSeenAt ?? t.firstSeenAt,
    })),
  ];
  if (items.length === 0) return null;
  items.sort((a, b) => b.sortAt - a.sortAt);
  return `${items[0].surface} — ${items[0].gloss}`;
}

export interface FloatingCaptionProps {
  onClose: () => void;
}

export default function FloatingCaption({ onClose }: FloatingCaptionProps) {
  const segments = useApp((s) => s.segments);
  const interim = useApp((s) => s.interim);
  const cards = useApp((s) => s.cards);
  const terms = useApp((s) => s.terms);

  const finalTail =
    segments.length > 0 ? tailText(segments[segments.length - 1].text, TAIL_MAX_CHARS) : "";
  const interimTail = interim ? tailText(interim.text, TAIL_MAX_CHARS) : "";
  const glossLine = mostRecentGlossLine(cards, terms);
  const isEmpty = !finalTail && !interimTail && !glossLine;

  return (
    <div
      data-testid="floating-caption"
      data-tauri-drag-region="deep"
      className="fixed inset-0 flex select-none flex-col justify-center gap-1.5 overflow-hidden bg-black px-4 py-3 font-mono text-white"
    >
      <button
        type="button"
        data-testid="floating-caption-close"
        onClick={onClose}
        aria-label="关闭悬浮字幕"
        title="关闭悬浮字幕"
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center text-white/60 hover:text-white"
      >
        <X size={14} weight="bold" />
      </button>

      {isEmpty ? (
        <div className="text-sm text-white/50">等待字幕…</div>
      ) : (
        <>
          <div className="truncate text-[15px] leading-snug text-white/70">
            {finalTail}
          </div>
          <div className="truncate text-[15px] italic leading-snug text-white">
            {interimTail}
          </div>
          {glossLine && (
            <div className="truncate text-sm leading-snug text-lab-green">
              {glossLine}
            </div>
          )}
        </>
      )}
    </div>
  );
}
