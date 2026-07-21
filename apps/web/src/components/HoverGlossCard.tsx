"use client";

// Floating read-only mini gloss card for a highlighted expression or
// term in the transcript (focus mode). Hover shows it, click pins it.
// Same viewport-clamp pattern as LookupPopover. Term rendering mirrors
// CardsPanel's expanded TermCardRow styling exactly (see that file).

import { useLayoutEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import { CATEGORY_LABELS, TERM_TYPE_LABELS } from "@/lib/cardLabels";
import type { ExpressionCard, TermCard } from "@jargonslayer/core/types";

export type GlossItem =
  | { kind: "expression"; card: ExpressionCard }
  | { kind: "term"; term: TermCard };

const CARD_WIDTH = 288; // w-72
const CARD_MAX_HEIGHT = 320;
const VIEWPORT_MARGIN = 8;

export interface HoverGlossCardProps {
  item: GlossItem;
  x: number;
  y: number;
  pinned: boolean;
  onClose: () => void;
}

export default function HoverGlossCard({
  item,
  x,
  y,
  pinned,
  onClose,
}: HoverGlossCardProps) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Clamp position to viewport.
  useLayoutEffect(() => {
    const maxLeft = window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - CARD_MAX_HEIGHT - VIEWPORT_MARGIN;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, x),
      Math.max(VIEWPORT_MARGIN, maxLeft),
    );
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, y),
      Math.max(VIEWPORT_MARGIN, maxTop),
    );
    setPos({ left, top });
  }, [x, y]);

  if (!pos) return null;

  // Left-bar color must be a full static class literal (Tailwind JIT
  // scan) — two complete conditional strings, not an interpolated hue.
  const containerClassName =
    item.kind === "expression"
      ? "fixed z-50 w-72 border border-edge border-l-2 border-l-lab-orange bg-panel2 glassable p-3 shadow-xl"
      : "fixed z-50 w-72 border border-edge border-l-2 border-l-lab-cyan bg-panel2 glassable p-3 shadow-xl";

  return (
    <div className={containerClassName} style={{ left: pos.left, top: pos.top }}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {item.kind === "expression" ? (
            <>
              <span className="font-mono font-semibold text-fg">{item.card.expression}</span>
              <span className="border border-lab-orange/40 px-1.5 py-0 text-[10px] text-lab-orange">
                {CATEGORY_LABELS[item.card.category]}
              </span>
            </>
          ) : (
            <>
              <span className="font-mono font-semibold text-fg">{item.term.term}</span>
              <span className="border border-edge px-1.5 py-0 text-[10px] text-mut">
                术语 · {TERM_TYPE_LABELS[item.term.type]}
              </span>
            </>
          )}
        </div>
        {pinned && (
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-6 w-6 shrink-0 items-center justify-center text-mut hover:bg-panel3 hover:text-fg"
          >
            <X size={14} weight="regular" />
          </button>
        )}
      </div>

      {item.kind === "expression" ? (
        <>
          <div className="mt-2 text-[15px] font-medium leading-[26px] text-fg">
            {item.card.chinese_explanation}
          </div>

          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-xs text-mut2">直白说法</span>
            <span className="text-sm text-fg/90">{item.card.plain_english}</span>
          </div>

          <div className="mt-2 text-xs italic text-mut">{item.card.tone}</div>
        </>
      ) : (
        <>
          {item.term.gloss_en && (
            <div className="mt-2 text-sm text-fg/90">{item.term.gloss_en}</div>
          )}

          <div className="mt-2 text-[15px] font-medium leading-[26px] text-fg">
            {item.term.gloss_zh}
          </div>
        </>
      )}
    </div>
  );
}
