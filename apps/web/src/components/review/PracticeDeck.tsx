"use client";

// Light flip-through practice over the personal glossary. No SM-2, no
// due dates — Anki export covers serious spaced repetition; this is a
// quick "did I actually learn this" pass.

import { useEffect, useMemo, useState } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import type { CustomEntry } from "@jargonslayer/core/types";

type Filter = "all" | "unmastered" | "mastered";

const FILTER_OPTIONS: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "unmastered", label: "未掌握" },
  { value: "mastered", label: "已掌握" },
];

export const KIND_LABELS: Record<CustomEntry["kind"], string> = {
  expression: "表达",
  term: "术语",
};

function shuffle<T>(arr: T[]): T[] {
  const next = [...arr];
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function EmptyState() {
  return (
    <div className="rounded-none border border-edge bg-panel p-6 text-center">
      <div className="text-sm font-medium text-fg">词库还是空的</div>
      <div className="mt-2 text-xs leading-[1.7] text-mut">
        在会议里划词收藏，或回到会议页的纪要里点「收藏本场卡片」。
      </div>
    </div>
  );
}

// Generic front/back content for the flip-card visual — shared between
// this (personal-glossary) deck and the SRS due-review deck
// (DueReview.tsx), which sources its content from session cards/terms
// and the glossary rather than CustomEntry directly.
export interface FlashCardContent {
  kindLabel: string;
  kindBorderCls: string;
  headword: string;
  chineseExplanation: string;
  meaning?: string;
  example?: string;
  context?: string;
}

export function FlashCard({
  content,
  flipped,
  onFlip,
}: {
  content: FlashCardContent;
  flipped: boolean;
  onFlip: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onFlip}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFlip();
        }
      }}
      className={`relative mx-auto flex min-h-[220px] w-full max-w-md cursor-pointer flex-col justify-center rounded-none border-l-2 ${content.kindBorderCls} border-y border-r border-edge bg-panel p-6`}
    >
      {!flipped ? (
        <div className="text-center">
          <span className="mb-3 inline-block border border-edge px-2 py-0.5 text-[10px] text-mut">
            {content.kindLabel}
          </span>
          <div className="font-mono text-3xl font-semibold text-fg">
            {content.headword}
          </div>
          <div className="mt-4 text-xs text-mut2">点击卡片查看解释</div>
        </div>
      ) : (
        <div className="space-y-2 text-center">
          <div className="text-[15px] font-medium leading-[26px] text-fg">
            {content.chineseExplanation}
          </div>
          {content.meaning && (
            <div className="text-sm text-mut">{content.meaning}</div>
          )}
          {content.example && (
            <div className="text-sm italic text-mut">{content.example}</div>
          )}
          {content.context && (
            <div className="border-l-2 border-edge pl-2 text-left text-xs text-mut2">
              {content.context}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function customEntryToFlashCardContent(entry: CustomEntry): FlashCardContent {
  return {
    kindLabel: KIND_LABELS[entry.kind],
    kindBorderCls: entry.kind === "expression" ? "border-l-lab-orange" : "border-l-lab-cyan",
    headword: entry.headword,
    chineseExplanation: entry.chinese_explanation,
    meaning: entry.meaning ?? entry.gloss_en,
    example: entry.example,
    context: entry.context,
  };
}

export default function PracticeDeck() {
  const customEntries = useApp((s) => s.customEntries);
  const updateCustomEntry = useApp((s) => s.updateCustomEntry);

  const [filter, setFilter] = useState<Filter>("all");
  const [deck, setDeck] = useState<CustomEntry[]>([]);
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const filteredSource = useMemo(() => {
    if (filter === "mastered") return customEntries.filter((e) => e.mastered);
    if (filter === "unmastered") return customEntries.filter((e) => !e.mastered);
    return customEntries;
  }, [customEntries, filter]);

  // Reshuffle whenever the filter changes (or the source set changes
  // shape, e.g. new entries collected while this page is open).
  useEffect(() => {
    setDeck(shuffle(filteredSource));
    setPos(0);
    setFlipped(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, filteredSource.length]);

  const total = deck.length;
  const masteredCount = customEntries.filter((e) => e.mastered).length;

  const advance = () => {
    setFlipped(false);
    setPos((p) => (total === 0 ? 0 : (p + 1) % total));
  };

  const handleReshuffle = () => {
    setDeck(shuffle(filteredSource));
    setPos(0);
    setFlipped(false);
  };

  const handleKnown = async (known: boolean) => {
    const entry = deck[pos];
    if (!entry) return;
    await updateCustomEntry({
      ...entry,
      mastered: known,
      reviewCount: (entry.reviewCount ?? 0) + 1,
      lastReviewedAt: Date.now(),
    });
    advance();
  };

  if (customEntries.length === 0) {
    return <EmptyState />;
  }

  const current = deck[pos] ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-none border border-edge bg-panel2 p-0.5">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFilter(opt.value)}
              className={`px-2.5 py-1 text-xs transition-colors ${
                filter === opt.value
                  ? "bg-panel3 text-fg"
                  : "text-mut hover:text-fg"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={handleReshuffle}
          className="btn-tactile flex items-center gap-2 border border-edge2 px-3 py-1.5 text-xs text-fg hover:bg-panel3"
        >
          <ArrowsClockwise size={16} weight="regular" />
          重新洗牌
        </button>
      </div>

      {total === 0 || !current ? (
        filter === "unmastered" ? (
          <div className="rounded-none border border-edge bg-panel p-6 text-center">
            <div className="text-sm font-medium text-fg">
              本轮的龙都屠完了。
            </div>
            <div className="mt-2 text-xs leading-[26px] text-mut">
              全部词条都已标记为掌握，换个筛选复习一遍，或者重新洗牌再来一轮。
            </div>
            <button
              type="button"
              onClick={handleReshuffle}
              className="btn-tactile mt-4 inline-flex items-center gap-2 border border-edge2 px-3 py-1.5 text-xs text-fg hover:bg-panel3"
            >
              <ArrowsClockwise size={16} weight="regular" />
              重新洗牌
            </button>
          </div>
        ) : (
          <div className="rounded-none border border-edge bg-panel p-6 text-center">
            <div className="text-sm font-medium text-fg">这一类还没有词条</div>
            <div className="mt-2 text-xs leading-[26px] text-mut">
              换个筛选试试，或者继续在会议里收藏新表达。
            </div>
          </div>
        )
      ) : (
        <>
          <FlashCard
            content={customEntryToFlashCardContent(current)}
            flipped={flipped}
            onFlip={() => setFlipped((v) => !v)}
          />

          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => void handleKnown(false)}
              className="btn-tactile h-10 rounded-none border border-warn-soft/50 px-5 text-sm text-warn-soft hover:bg-panel3"
            >
              不认识
            </button>
            <button
              type="button"
              onClick={() => void handleKnown(true)}
              className="btn-tactile h-10 rounded-none border border-lab-green/50 px-5 text-sm font-medium text-lab-green hover:bg-panel3"
            >
              认识
            </button>
          </div>

          <div className="text-center font-mono text-xs tabular-nums text-mut">
            {pos + 1} / {total} · 已掌握 {masteredCount}
          </div>
        </>
      )}
    </div>
  );
}
