"use client";

// Live-detected expression cards + terms, merged into one unified list
// (user directive: terms must NOT be small chips). The chinese
// explanation / gloss_zh row is the hero of every card (fg +
// font-medium, leading-[1.7]) — see docs/DESIGN.md color lock.
// Expressions stay in the gold family (category badge, no left bar);
// terms are visually distinguished by a blue accent left bar + badge,
// same card chrome otherwise (docs/DESIGN.md shape lock: rounded-xl).

import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/lib/store";
import type {
  DetectionSource,
  ExpressionCard,
  ExpressionCategory,
  TermCard,
  TermType,
} from "@/lib/types";

const CATEGORY_LABELS: Record<ExpressionCategory, string> = {
  idiom: "习语",
  slang: "俚语",
  phrase: "短语",
  metaphor: "隐喻",
  indirect: "委婉",
  other: "其他",
};

const TERM_TYPE_LABELS: Record<TermType, string> = {
  acronym: "缩写",
  company: "公司",
  product: "产品",
  tech: "技术",
  metric: "指标",
  person: "人名",
  other: "其他",
};

const NEW_GLOW_MS = 4500;
const REPULSE_MS = 2500;

type Kind = "expression" | "term";

interface UnifiedItem {
  kind: Kind;
  id: string;
  firstSeenAt: number;
  lastSeenAt: number;
  sortAt: number;
  expression?: ExpressionCard;
  term?: TermCard;
}

function toUnified(cards: ExpressionCard[], terms: TermCard[]): UnifiedItem[] {
  const fromCards: UnifiedItem[] = cards.map((c) => ({
    kind: "expression",
    id: c.id,
    firstSeenAt: c.firstSeenAt,
    lastSeenAt: c.lastSeenAt,
    sortAt: c.lastSeenAt ?? c.firstSeenAt,
    expression: c,
  }));
  const fromTerms: UnifiedItem[] = terms.map((t) => ({
    kind: "term",
    id: t.id,
    firstSeenAt: t.firstSeenAt,
    lastSeenAt: t.lastSeenAt,
    sortAt: t.lastSeenAt ?? t.firstSeenAt,
    term: t,
  }));
  return [...fromCards, ...fromTerms].sort((a, b) => b.sortAt - a.sortAt);
}

function matchesQuery(item: UnifiedItem, q: string): boolean {
  if (item.kind === "expression" && item.expression) {
    const c = item.expression;
    return (
      c.expression.toLowerCase().includes(q) ||
      c.chinese_explanation.toLowerCase().includes(q)
    );
  }
  if (item.kind === "term" && item.term) {
    const t = item.term;
    return (
      t.term.toLowerCase().includes(q) || t.gloss_zh.toLowerCase().includes(q)
    );
  }
  return false;
}

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

/** Shared new/repulse animation state, keyed off the same
 *  firstSeenAt/lastSeenAt/count bookkeeping both card kinds share. */
function useCardAnimation(firstSeenAt: number, lastSeenAt: number, count: number) {
  const [isNew] = useState(() => Date.now() - firstSeenAt < NEW_GLOW_MS);
  const [isRepulsing, setIsRepulsing] = useState(
    () => count > 1 && Date.now() - lastSeenAt < REPULSE_MS,
  );

  // Re-detection re-triggers the pulse: keyed off lastSeenAt below via
  // the effect, since a fresh lastSeenAt on an already-mounted card
  // needs a fresh animation run.
  useEffect(() => {
    if (count > 1 && Date.now() - lastSeenAt < REPULSE_MS) {
      setIsRepulsing(true);
      const t = setTimeout(() => setIsRepulsing(false), REPULSE_MS);
      return () => clearTimeout(t);
    }
  }, [count, lastSeenAt]);

  return { isNew, isRepulsing };
}

function ExpressionCardRow({ card }: { card: ExpressionCard }) {
  const focusCardId = useApp((s) => s.focusCardId);
  const setFocusCard = useApp((s) => s.setFocusCard);
  const ref = useRef<HTMLDivElement>(null);

  const { isNew, isRepulsing } = useCardAnimation(
    card.firstSeenAt,
    card.lastSeenAt,
    card.count,
  );

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
      data-kind="expression"
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

function TermCardRow({ term }: { term: TermCard }) {
  const { isNew, isRepulsing } = useCardAnimation(
    term.firstSeenAt,
    term.lastSeenAt,
    term.count,
  );

  return (
    <div
      data-testid="card"
      data-kind="term"
      className={`rounded-xl border border-edge border-l-2 border-l-acc/60 bg-panel p-3 transition-colors hover:bg-panel3 ${
        isNew ? "card-new" : ""
      } ${isRepulsing ? "card-repulse" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-fg">{term.term}</span>
        <span className="rounded-full border border-acc/30 px-1.5 py-0 text-[10px] text-acc">
          术语 · {TERM_TYPE_LABELS[term.type]}
        </span>
        {term.count > 1 && (
          <span className="font-mono text-xs text-gold">×{term.count}</span>
        )}
        {sourceBadge(term.source)}
      </div>

      <div className="mt-1.5 text-sm text-fg/90">{term.gloss_en}</div>

      <div className="mt-1.5 text-[15px] font-medium leading-[1.7] text-fg">
        {term.gloss_zh}
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
      <div className="text-sm font-medium text-fg">还没有检测到内容</div>
      <div className="mt-2 max-w-xs text-xs leading-[1.7] text-mut">
        {detectMode === "dictionary"
          ? "词典模式下，说到内置词典里的习语、缩写或术语会立刻出卡片，表达与术语都会出现在这里。"
          : "AI 正在听会议内容，检测到值得解释的表达或术语会立刻出现在这里。"}
      </div>
    </div>
  );
}

type FilterKind = "all" | "expression" | "term";

const FILTERS: { key: FilterKind; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "expression", label: "表达" },
  { key: "term", label: "术语" },
];

export default function CardsPanel() {
  const cards = useApp((s) => s.cards);
  const terms = useApp((s) => s.terms);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");

  const unified = useMemo(() => toUnified(cards, terms), [cards, terms]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = unified;
    if (filter !== "all") {
      list = list.filter((item) => item.kind === filter);
    }
    if (q) {
      list = list.filter((item) => matchesQuery(item, q));
    }
    return list;
  }, [unified, query, filter]);

  return (
    <div className="flex h-full flex-col" data-testid="cards-panel">
      <div className="shrink-0 space-y-2 px-3 pt-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg">实时解释</span>
          <span className="font-mono text-xs tabular-nums text-mut2">
            {unified.length}
          </span>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="筛选表达或术语…"
          className="w-full rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
        />

        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                filter === f.key
                  ? "border-edge bg-panel3 text-fg"
                  : "border-edge text-mut hover:bg-panel3"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="scroll-thin flex-1 space-y-2 overflow-y-auto px-3 pb-3 pt-2">
          {filtered.map((item) =>
            item.kind === "expression" && item.expression ? (
              <ExpressionCardRow key={item.id} card={item.expression} />
            ) : item.term ? (
              <TermCardRow key={item.id} term={item.term} />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
