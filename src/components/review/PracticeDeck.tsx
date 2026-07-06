"use client";

// Light flip-through practice over the personal glossary. No SM-2, no
// due dates — Anki export covers serious spaced repetition; this is a
// quick "did I actually learn this" pass.

import { useEffect, useMemo, useState } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import type { CustomEntry } from "@/lib/types";

type Filter = "all" | "unmastered" | "mastered";

const FILTER_OPTIONS: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "unmastered", label: "未掌握" },
  { value: "mastered", label: "已掌握" },
];

const KIND_LABELS: Record<CustomEntry["kind"], string> = {
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
    <div className="rounded-xl border border-edge bg-panel p-6 text-center">
      <div className="text-sm font-medium text-fg">词库还是空的</div>
      <div className="mt-2 text-xs leading-[1.7] text-mut">
        在会议里划词收藏，或回到会议页的纪要里点「收藏本场卡片」。
      </div>
    </div>
  );
}

function FlashCard({
  entry,
  flipped,
  onFlip,
}: {
  entry: CustomEntry;
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
      className="mx-auto flex min-h-[220px] w-full max-w-md cursor-pointer flex-col justify-center rounded-xl border border-edge bg-panel p-6"
    >
      {!flipped ? (
        <div className="text-center">
          <span className="mb-3 inline-block rounded-full border border-edge px-2 py-0.5 text-[10px] text-mut">
            {KIND_LABELS[entry.kind]}
          </span>
          <div className="text-2xl font-semibold text-fg">{entry.headword}</div>
          <div className="mt-4 text-xs text-mut2">点击卡片查看解释</div>
        </div>
      ) : (
        <div className="space-y-2 text-center">
          <div className="text-[15px] font-medium leading-[1.7] text-fg">
            {entry.chinese_explanation}
          </div>
          {(entry.meaning || entry.gloss_en) && (
            <div className="text-sm text-mut">{entry.meaning ?? entry.gloss_en}</div>
          )}
          {entry.example && (
            <div className="text-sm italic text-mut">{entry.example}</div>
          )}
          {entry.context && (
            <div className="border-l-2 border-edge pl-2 text-left text-xs text-mut2">
              {entry.context}
            </div>
          )}
        </div>
      )}
    </div>
  );
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
        <div className="flex items-center gap-1 rounded-lg border border-edge bg-panel2 p-0.5">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFilter(opt.value)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
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
          className="btn-tactile flex items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-xs text-fg hover:bg-panel3"
        >
          <ArrowsClockwise size={16} weight="regular" />
          重新洗牌
        </button>
      </div>

      {total === 0 || !current ? (
        <div className="rounded-xl border border-edge bg-panel p-6 text-center">
          <div className="text-sm font-medium text-fg">这一类还没有词条</div>
          <div className="mt-2 text-xs leading-[1.7] text-mut">
            换个筛选试试，或者继续在会议里收藏新表达。
          </div>
        </div>
      ) : (
        <>
          <FlashCard
            entry={current}
            flipped={flipped}
            onFlip={() => setFlipped((v) => !v)}
          />

          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => void handleKnown(false)}
              className="btn-tactile h-10 rounded-lg border border-warn/40 px-5 text-sm text-warn hover:bg-panel3"
            >
              不认识
            </button>
            <button
              type="button"
              onClick={() => void handleKnown(true)}
              className="btn-tactile h-10 rounded-lg bg-acc px-5 text-sm font-medium text-white hover:bg-acchover"
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
