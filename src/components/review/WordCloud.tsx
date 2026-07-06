"use client";

// Word cloud: frequency-weighted view over the same expression+term
// aggregation ReviewDashboard already computes for the Top-10 list
// (see useWordFrequency in ReviewDashboard.tsx — single source of
// truth, no second data source). Library-free: font size is scaled
// with plain Tailwind text-size steps, layout is a centered flex-wrap.

import { useMemo } from "react";
import type { WordAgg } from "./ReviewDashboard";

// Count -> Tailwind text-size step. Five tiers from ~text-xs to
// ~text-4xl, matching the v2.1 "no in-between font sizes" spirit
// (big numbers are the display's signature, not gradient scaling).
const SIZE_STEPS = [
  "text-xs",
  "text-sm",
  "text-lg",
  "text-2xl",
  "text-4xl",
] as const;

/** Bucket a count into one of SIZE_STEPS given the observed [min, max]
 *  range. Guards the single-item and all-equal cases (both collapse
 *  to the same range) by always returning the top tier — one word, or
 *  a tie across every word, is by definition the most frequent thing
 *  on screen. */
function sizeClassFor(count: number, min: number, max: number): string {
  if (max === min) return SIZE_STEPS[SIZE_STEPS.length - 1];
  const ratio = (count - min) / (max - min);
  const idx = Math.min(
    SIZE_STEPS.length - 1,
    Math.floor(ratio * (SIZE_STEPS.length - 1) + 0.5),
  );
  return SIZE_STEPS[idx];
}

function WordButton({
  word,
  sizeClass,
  isSelected,
  onSelect,
}: {
  word: WordAgg;
  sizeClass: string;
  isSelected: boolean;
  onSelect: (label: string) => void;
}) {
  const muted = word.count === 1;
  // Color-by-kind rule: gold is the signature annotation layer and is
  // never a button's own text color (docs/DESIGN.md color lock), so
  // expressions get a gold underline accent around an `fg` label —
  // mirroring the gold corner-ornament/badge chrome already used on
  // interactive cards elsewhere (PracticeDeck, CardsPanel). `acc` blue
  // IS used directly as clickable-element text elsewhere (CardsPanel's
  // view-mode toggle), so terms use it as the label color itself.
  const colorClass = muted
    ? "text-mut"
    : word.kind === "expression"
      ? "text-fg underline decoration-gold decoration-2 underline-offset-4"
      : "text-acc";

  return (
    <button
      type="button"
      onClick={() => onSelect(word.label)}
      aria-pressed={isSelected}
      aria-label={`${word.label}，出现 ${word.count} 次`}
      title={`${word.label} · ${word.count} 次`}
      className={`btn-tactile rounded-lg px-1.5 py-0.5 font-medium leading-none transition-colors hover:bg-panel3 ${sizeClass} ${colorClass} ${
        isSelected ? "bg-panel3" : ""
      }`}
    >
      {word.label}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-edge bg-panel p-6 text-center">
      <div className="text-sm font-medium text-fg">词云还是空的</div>
      <div className="mt-2 text-xs leading-[1.7] text-mut">
        装备词典，出门屠龙。会议里检测到的表达和术语积累多了，这里会长出一片词云。
      </div>
    </div>
  );
}

export default function WordCloud({
  words,
  loading,
  selected,
  onSelect,
}: {
  words: WordAgg[];
  loading: boolean;
  selected: string | null;
  onSelect: (label: string) => void;
}) {
  const { min, max } = useMemo(() => {
    const counts = words.map((w) => w.count);
    return {
      min: counts.length ? Math.min(...counts) : 0,
      max: counts.length ? Math.max(...counts) : 0,
    };
  }, [words]);

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="font-display text-lg font-semibold text-fg">
          词云
        </span>
        <span className="text-xs text-gold/40" aria-hidden="true">
          ❖
        </span>
      </div>

      <div className="mt-3">
        {loading ? (
          <div className="text-sm text-mut">加载中…</div>
        ) : words.length === 0 ? (
          <EmptyState />
        ) : (
          <div
            className="scroll-thin max-h-72 overflow-y-auto rounded-xl border border-edge bg-panel p-4"
            data-testid="word-cloud"
          >
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
              {words.map((word) => (
                <WordButton
                  key={`${word.kind}:${word.label}`}
                  word={word}
                  sizeClass={sizeClassFor(word.count, min, max)}
                  isSelected={selected === word.label.toLowerCase()}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
