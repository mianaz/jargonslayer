"use client";

// Floating read-only mini gloss card for a highlighted expression in
// the transcript (focus mode). Hover shows it, click pins it. Same
// viewport-clamp pattern as LookupPopover.

import { useLayoutEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import type { ExpressionCard } from "@/lib/types";

const CATEGORY_LABELS: Record<ExpressionCard["category"], string> = {
  idiom: "习语",
  slang: "俚语",
  phrase: "短语",
  metaphor: "隐喻",
  indirect: "委婉",
  other: "其他",
};

const CARD_WIDTH = 288; // w-72
const CARD_MAX_HEIGHT = 320;
const VIEWPORT_MARGIN = 8;

export interface HoverGlossCardProps {
  card: ExpressionCard;
  x: number;
  y: number;
  pinned: boolean;
  onClose: () => void;
}

export default function HoverGlossCard({
  card,
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

  return (
    <div
      className="fixed z-50 w-72 rounded-sm border border-edge border-l-2 border-l-lab-orange bg-panel2 p-3 shadow-xl"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono font-semibold text-fg">{card.expression}</span>
          <span className="rounded-sm border border-lab-orange/40 px-1.5 py-0 text-[10px] text-lab-orange">
            {CATEGORY_LABELS[card.category]}
          </span>
        </div>
        {pinned && (
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-mut hover:bg-panel3 hover:text-fg"
          >
            <X size={14} weight="regular" />
          </button>
        )}
      </div>

      <div className="mt-2 text-[15px] font-medium leading-[26px] text-fg">
        {card.chinese_explanation}
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-mono text-xs text-mut2">直白说法</span>
        <span className="text-sm text-fg/90">{card.plain_english}</span>
      </div>

      <div className="mt-2 text-xs italic text-mut">{card.tone}</div>
    </div>
  );
}
