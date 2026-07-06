"use client";

// Live-detected expression cards + terms. The chinese_explanation row
// is the hero of every card (fg + font-medium, leading-[1.7]) — see
// docs/DESIGN.md color lock.

import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/lib/store";
import type {
  DetectionSource,
  ExpressionCard,
  ExpressionCategory,
  TermCard,
} from "@/lib/types";

const CATEGORY_LABELS: Record<ExpressionCategory, string> = {
  idiom: "习语",
  slang: "俚语",
  phrase: "短语",
  metaphor: "隐喻",
  indirect: "委婉",
  other: "其他",
};

const NEW_GLOW_MS = 4500;
const REPULSE_MS = 2500;

function sourceBadge(source: DetectionSource) {
  if (source === "dictionary") {
    return (
      <span className="rounded-full border border-gold/30 px-1.5 py-0 text-[10px] text-gold/80">
        词典
      </span>
    );
  }
  if (source === "custom") {
    return (
      <span className="rounded-full border border-gold/30 px-1.5 py-0 text-[10px] text-gold/80">
        我的词典
      </span>
    );
  }
  return null;
}

function TermChip({ term }: { term: TermCard }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        data-testid="term-chip"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full border border-edge bg-panel2 px-2.5 py-1 text-xs text-fg hover:bg-panel3"
      >
        <span className="font-medium">{term.term}</span>
        <span className="text-mut2">{term.type}</span>
        {term.count > 1 && (
          <span className="font-mono text-gold">×{term.count}</span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 w-64 rounded-xl border border-edge bg-panel2 p-3 shadow-xl">
          <div className="text-xs text-mut">{term.gloss_en}</div>
          <div className="mt-1 text-sm font-medium leading-[1.7] text-fg">
            {term.gloss_zh}
          </div>
        </div>
      )}
    </div>
  );
}

function ExpressionCardRow({ card }: { card: ExpressionCard }) {
  const focusCardId = useApp((s) => s.focusCardId);
  const setFocusCard = useApp((s) => s.setFocusCard);
  const ref = useRef<HTMLDivElement>(null);

  const [isNew] = useState(() => Date.now() - card.firstSeenAt < NEW_GLOW_MS);
  const [isRepulsing, setIsRepulsing] = useState(
    () => card.count > 1 && Date.now() - card.lastSeenAt < REPULSE_MS,
  );

  // Re-detection re-triggers the pulse: keyed off lastSeenAt below via
  // the effect, since a fresh lastSeenAt on an already-mounted card
  // needs a fresh animation run.
  useEffect(() => {
    if (card.count > 1 && Date.now() - card.lastSeenAt < REPULSE_MS) {
      setIsRepulsing(true);
      const t = setTimeout(() => setIsRepulsing(false), REPULSE_MS);
      return () => clearTimeout(t);
    }
  }, [card.count, card.lastSeenAt]);

  const isFocused = focusCardId === card.id;
  const [ring, setRing] = useState(false);

  useEffect(() => {
    if (!isFocused) return;
    const el = ref.current;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setRing(true);
      const t = setTimeout(() => {
        setRing(false);
        setFocusCard(null);
      }, 1500);
      return () => clearTimeout(t);
    }
    setFocusCard(null);
  }, [isFocused, setFocusCard]);

  return (
    <div
      ref={ref}
      data-testid="card"
      className={`rounded-xl border border-edge bg-panel p-3 transition-colors hover:bg-panel3 ${
        isNew ? "card-new" : ""
      } ${isRepulsing ? "card-repulse" : ""} ${
        ring ? "ring-1 ring-gold" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-fg">{card.expression}</span>
        <span className="rounded-full border border-edge px-1.5 py-0 text-[10px] text-mut">
          {CATEGORY_LABELS[card.category]}
        </span>
        {card.count > 1 && (
          <span className="font-mono text-xs text-gold">×{card.count}</span>
        )}
        {sourceBadge(card.source)}
      </div>

      <div className="mt-1.5 text-sm text-fg/90">{card.meaning}</div>

      <div className="mt-1.5 text-[15px] font-medium leading-[1.7] text-fg">
        {card.chinese_explanation}
      </div>

      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-xs text-mut2">直白说法</span>
        <span className="text-sm text-fg/90">{card.plain_english}</span>
      </div>

      <div className="mt-1 text-xs italic text-mut">{card.tone}</div>

      <div
        className="mt-2 line-clamp-2 border-l-2 border-edge pl-2 text-xs text-mut"
        title={card.source_sentence}
      >
        {card.source_sentence}
      </div>
    </div>
  );
}

function EmptyState() {
  const detectMode = useApp((s) => s.detectMode);
  const status = useApp((s) => s.status);

  if (status === "idle") {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="text-sm font-medium text-fg">还没有开始会议</div>
        <div className="mt-2 max-w-xs text-xs leading-[1.7] text-mut">
          点击左上角「演示」立即体验，无需麦克风也无需配置 API Key。
        </div>
      </div>
    );
  }

  if (detectMode === "off") {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="text-sm font-medium text-fg">实时检测已关闭</div>
        <div className="mt-2 max-w-xs text-xs leading-[1.7] text-mut">
          在设置里打开「实时检测」，会议里出现的英文表达会自动变成卡片。
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="text-sm font-medium text-fg">还没有检测到表达</div>
      <div className="mt-2 max-w-xs text-xs leading-[1.7] text-mut">
        {detectMode === "dictionary"
          ? "词典模式下，说到内置词典里的习语或缩写会立刻出卡片。"
          : "AI 正在听会议内容，检测到值得解释的表达会立刻出现在这里。"}
      </div>
    </div>
  );
}

export default function CardsPanel() {
  const cards = useApp((s) => s.cards);
  const terms = useApp((s) => s.terms);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? cards.filter(
          (c) =>
            c.expression.toLowerCase().includes(q) ||
            c.chinese_explanation.toLowerCase().includes(q),
        )
      : cards;
    return [...list].sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  }, [cards, query]);

  return (
    <div className="flex h-full flex-col" data-testid="cards-panel">
      <div className="shrink-0 space-y-2 px-3 pt-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg">实时解释</span>
          <span className="font-mono text-xs tabular-nums text-mut2">
            {cards.length}
          </span>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="筛选表达或中文解释…"
          className="w-full rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
        />

        {terms.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-1">
            {terms.map((t) => (
              <TermChip key={t.id} term={t} />
            ))}
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="scroll-thin flex-1 space-y-2 overflow-y-auto px-3 pb-3 pt-2">
          {filtered.map((card) => (
            <ExpressionCardRow key={card.id} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}
