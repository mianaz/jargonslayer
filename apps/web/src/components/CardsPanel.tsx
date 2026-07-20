"use client";

// Live-detected expression cards + terms, merged into one unified list
// (user directive: terms must NOT be small chips). The chinese
// explanation / gloss_zh row is the hero of every card (fg +
// font-medium, leading-[1.7]) — see docs/DESIGN.md color lock.
// v3 terminal reskin (docs/DESIGN.md v3.3/v3.1): cards are flat "blocks"
// — border-l-2 status bar in the category hue + bg-panel + hairline
// separation, radius 0-2px. Every expression category gets its own
// lab-* hue (CATEGORY_COLOR below); all terms share one lab-cyan bar
// regardless of TermType (term-type chip text stays mut, not colored).

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import { CaretUp, CaretUpDown } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { handleButtonKeyDown } from "@/lib/a11y";
import { CATEGORY_LABELS, TERM_TYPE_LABELS } from "@/lib/cardLabels";
import type {
  DetectionSource,
  ExpressionCard,
  ExpressionCategory,
  TermCard,
} from "@jargonslayer/core/types";

// Left-bar + category-chip hue per expression category (docs/DESIGN.md
// v3 spec, exact mapping). "other" has no lab-* hue of its own — it maps
// to neutral `mut`, same as terms' non-colored type chip. Full class
// strings (not bare color names) so Tailwind's static JIT scan can find
// every class literally in source — a template-interpolated color name
// would not be detected.
const CATEGORY_COLOR: Record<
  ExpressionCategory,
  { bar: string; text: string; border: string }
> = {
  idiom: { bar: "border-l-lab-orange", text: "text-lab-orange", border: "border-lab-orange/40" },
  slang: { bar: "border-l-lab-red", text: "text-lab-red", border: "border-lab-red/40" },
  phrase: { bar: "border-l-lab-green", text: "text-lab-green", border: "border-lab-green/40" },
  metaphor: { bar: "border-l-lab-purple", text: "text-lab-purple", border: "border-lab-purple/40" },
  indirect: { bar: "border-l-lab-yellow", text: "text-lab-yellow", border: "border-lab-yellow/40" },
  other: { bar: "border-l-mut", text: "text-mut", border: "border-mut/40" },
};

// All terms share one bar/chip hue regardless of TermType (spec: "ALL
// terms=lab-cyan bar, term-type chip text stays mut").
const TERM_COLOR = { bar: "border-l-lab-cyan", text: "text-mut", border: "border-edge" };

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

// ---------- progressive disclosure ----------
// Precedence (highest first): manual per-card override > all-expanded /
// all-collapsed mode > auto rule (newest 3 by sortAt expanded, rest
// collapsed). Clicking the expand-all toggle resets the manual map so
// the new mode is a clean baseline; per-card clicks after that re-enter
// the map and pin that card regardless of later arrivals or mode
// changes.
const AUTO_EXPANDED_COUNT = 3;

type CardViewMode = "auto" | "all-expanded" | "all-collapsed";
type ManualState = "expanded" | "collapsed";

function nextViewMode(mode: CardViewMode): CardViewMode {
  if (mode === "auto") return "all-expanded";
  if (mode === "all-expanded") return "all-collapsed";
  return "auto";
}

function viewModeTitle(mode: CardViewMode): string {
  if (mode === "all-expanded") return "全部折叠";
  if (mode === "all-collapsed") return "全部展开";
  return "全部展开";
}

function resolveExpanded(
  id: string,
  autoIndex: number,
  viewMode: CardViewMode,
  manual: Map<string, ManualState>,
): boolean {
  const override = manual.get(id);
  if (override) return override === "expanded";
  if (viewMode === "all-expanded") return true;
  if (viewMode === "all-collapsed") return false;
  return autoIndex < AUTO_EXPANDED_COUNT;
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
      <span className="border border-edge px-1.5 py-0 text-[10px] text-mut">
        词典
      </span>
    );
  }
  if (source === "custom") {
    return (
      <span className="border border-edge px-1.5 py-0 text-[10px] text-mut">
        我的词典
      </span>
    );
  }
  if (source === "llm") {
    // AI-detected cards were previously indistinguishable from dictionary
    // ones — no badge at all (E2E feedback: owner explicitly asked for
    // the distinction). Same badge shape, lab-green to match the
    // header/statusline's own "词典+AI 检测" color.
    return (
      <span className="border border-edge px-1.5 py-0 text-[10px] text-lab-green">
        AI
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

/** Small collapse-affordance button on an expanded card, revealed on
 *  hover of the (group-tagged) card container. */
function CollapseAffordance({ onCollapse }: { onCollapse: () => void }) {
  return (
    <button
      type="button"
      onClick={onCollapse}
      title="折叠"
      aria-label="折叠"
      aria-expanded
      className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center text-mut opacity-0 transition-opacity hover:bg-panel3 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
    >
      <CaretUp size={14} weight="regular" />
    </button>
  );
}

function KnownAffordance({
  onVote,
  onSuppress,
  align = "right-2",
}: {
  onVote: () => void;
  onSuppress: () => void;
  align?: string;
}) {
  const run = (
    e: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>,
    action: () => void,
  ) => {
    e.stopPropagation();
    action();
  };

  return (
    <div
      // #48 s1 review item 11: aria-label on a non-interactive div is
      // an a11y nit (labels an element that never receives focus and
      // has no implicit role for the label to attach to) — role="group"
      // instead; the buttons already carry their own visible text, so
      // no group-level label is needed on top of that.
      className={`absolute ${align} top-2 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100`}
      role="group"
    >
      <button
        type="button"
        onClick={(e) => run(e, onVote)}
        onKeyDown={(e) => handleButtonKeyDown(e, () => run(e, onVote))}
        className="border border-edge bg-panel2 px-1.5 py-0.5 font-mono text-[10px] text-mut hover:bg-panel3 hover:text-fg"
      >
        太简单
      </button>
      <button
        type="button"
        onClick={(e) => run(e, onSuppress)}
        onKeyDown={(e) => handleButtonKeyDown(e, () => run(e, onSuppress))}
        className="border border-edge bg-panel2 px-1.5 py-0.5 font-mono text-[10px] text-mut hover:bg-panel3 hover:text-fg"
      >
        别再提示
      </button>
    </div>
  );
}

/** Shared focusCardId scroll+ring behavior for both card kinds: when
 *  `id` becomes the focused card, scroll it into view and flash a ring
 *  for 1.5s, then clear the focus request.
 *
 *  Scroll+ring only ever run against the expanded layout: if this card
 *  is still collapsed when it becomes focused, the panel-level effect
 *  (CardsPanel) expands it first, which re-runs this effect once
 *  `expanded` flips true and the ref points at the real (expanded) row. */
function useFocusRing(
  id: string,
  expanded: boolean,
): { ref: RefObject<HTMLDivElement | null>; ring: boolean } {
  const focusCardId = useApp((s) => s.focusCardId);
  const setFocusCard = useApp((s) => s.setFocusCard);
  const ref = useRef<HTMLDivElement>(null);

  const isFocused = focusCardId === id;
  const [ring, setRing] = useState(false);

  useEffect(() => {
    if (!isFocused || !expanded) return;
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
  }, [isFocused, expanded, setFocusCard]);

  return { ref, ring };
}

// ---------- v0.5 Wave-1 Feature 7: inline card/term edit ----------
// SHIP scope, docs/design-explorations/v05-wave1-blueprint.md §1
// Feature 7: stopped/loaded sessions only (sidesteps the live
// mergeDetections clobber hazard — see the file's own doc). Reuses
// GlossaryPanel's EntryRow local editing+draft+save/cancel PATTERN,
// but keeps each card's existing layout (only the editable text nodes
// themselves swap for inputs) rather than EntryRow's own full-row
// EntryForm swap.

interface CardDraft {
  expression: string;
  chinese_explanation: string;
  plain_english: string;
}

function draftFromCard(card: ExpressionCard): CardDraft {
  return {
    expression: card.expression,
    chinese_explanation: card.chinese_explanation,
    plain_english: card.plain_english,
  };
}

interface TermDraft {
  term: string;
  gloss_en: string;
  gloss_zh: string;
}

function draftFromTerm(term: TermCard): TermDraft {
  return { term: term.term, gloss_en: term.gloss_en, gloss_zh: term.gloss_zh };
}

/** Diffs a draft against its source, returning a patch with only the
 *  fields whose trimmed value actually changed — an emptied field
 *  falls back to the original rather than saving blank (mirrors
 *  EntryRow's own `draft.headword.trim() || entry.headword`). Callers
 *  pass this straight to updateCard/updateTerm, which already merge a
 *  partial patch onto the existing card/term by id. `T extends object`
 *  (not `Record<string, string>`) — CardDraft/TermDraft are plain
 *  interfaces with no index signature, which TS won't structurally
 *  match against a Record constraint even though every field is a
 *  string; the cast below asserts that per-field string-ness instead. */
function buildPatch<T extends object>(draft: T, original: T): Partial<T> {
  const patch: Partial<T> = {};
  (Object.keys(draft) as (keyof T)[]).forEach((key) => {
    const draftValue = draft[key] as unknown as string;
    const originalValue = original[key] as unknown as string;
    const value = (draftValue.trim() || originalValue) as T[typeof key];
    if (value !== original[key]) patch[key] = value;
  });
  return patch;
}

/** Shared 编辑/保存/取消 action row for both card kinds. h-10 buttons =
 *  the app's existing ≥40px touch-target convention (DueReview/
 *  PracticeDeck's own `btn-tactile h-10 ...`); the 编辑 affordance
 *  itself stays visually small (text-xs) with the same 40px hit box. */
function EditActions({
  editing,
  saveDisabled,
  onEdit,
  onSave,
  onCancel,
}: {
  editing: boolean;
  saveDisabled: boolean;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (!editing) {
    return (
      <div className="mt-1 flex items-center text-xs">
        <button
          type="button"
          onClick={onEdit}
          className="btn-tactile inline-flex h-10 items-center px-1 text-mut hover:text-fg"
        >
          编辑
        </button>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-2 text-xs">
      <button
        type="button"
        onClick={onCancel}
        className="btn-tactile inline-flex h-10 items-center px-3 text-mut hover:text-fg"
      >
        取消
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saveDisabled}
        className="btn-terminal inline-flex h-10 items-center bg-act px-3 font-mono font-semibold text-ink hover:bg-act/85 disabled:cursor-not-allowed disabled:opacity-50"
      >
        保存
      </button>
    </div>
  );
}

function ExpressionCardRow({
  card,
  expanded,
  onToggle,
  onKnownVote,
  onKnownSuppress,
}: {
  card: ExpressionCard;
  expanded: boolean;
  onToggle: () => void;
  onKnownVote: () => void;
  onKnownSuppress: () => void;
}) {
  const { ref, ring } = useFocusRing(card.id, expanded);

  const { isNew, isRepulsing } = useCardAnimation(
    card.firstSeenAt,
    card.lastSeenAt,
    card.count,
  );

  // v0.5 Wave-1 Feature 7: edit affordance only for a stopped/loaded
  // session — live meetings show none at all (a live LLM detection
  // merge would otherwise clobber a mid-meeting edit, see the doc
  // comment above EditActions).
  const status = useApp((s) => s.status);
  const updateCard = useApp((s) => s.updateCard);
  const canEdit = status === "stopped";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CardDraft>(() => draftFromCard(card));

  // The panel's 全部折叠/全部展开 cycle (or a focus-ring collapse) can
  // force this card closed out from under an in-progress edit — the
  // collapsed layout has no room for inputs, so treat that the same as
  // Cancel instead of leaving stale editing state around.
  useEffect(() => {
    if (!expanded && editing) setEditing(false);
  }, [expanded, editing]);

  const handleEdit = () => {
    setDraft(draftFromCard(card));
    setEditing(true);
  };
  const handleCancel = () => setEditing(false);
  const handleSave = () => {
    const patch = buildPatch(draft, draftFromCard(card));
    if (Object.keys(patch).length > 0) updateCard(card.id, patch);
    setEditing(false);
  };

  const hue = CATEGORY_COLOR[card.category];

  const badgeRow = (
    <div className="flex flex-wrap items-center gap-2">
      {editing && expanded ? (
        <input
          type="text"
          aria-label="表达"
          value={draft.expression}
          onChange={(e) => setDraft((d) => ({ ...d, expression: e.target.value }))}
          className="w-full border border-edge bg-panel2 px-2 py-1.5 font-mono text-sm font-semibold text-fg focus:outline-none sm:w-auto sm:min-w-[10rem]"
        />
      ) : (
        <span className="font-mono font-semibold text-fg">{card.expression}</span>
      )}
      <span className={`border px-1.5 py-0 text-[12px] ${hue.border} ${hue.text}`}>
        {CATEGORY_LABELS[card.category]}
      </span>
      {card.count > 1 && (
        <span className={`font-mono text-xs ${hue.text}`}>×{card.count}</span>
      )}
      {sourceBadge(card.source)}
    </div>
  );

  if (!expanded) {
    return (
      <div
        ref={ref}
        data-testid="card"
        data-kind="expression"
        role="button"
        tabIndex={0}
        aria-expanded={false}
        onClick={onToggle}
        onKeyDown={(e) => handleButtonKeyDown(e, onToggle)}
        className={`group relative cursor-pointer border-b border-edge border-l-2 bg-panel p-2 transition-colors hover:bg-panel3 ${hue.bar} ${
          isNew ? "diff-flash" : ""
        } ${isRepulsing ? "card-repulse" : ""} ${
          ring ? "ring-1 ring-act" : ""
        }`}
      >
        <KnownAffordance onVote={onKnownVote} onSuppress={onKnownSuppress} />
        {badgeRow}
        <div className="mt-2 truncate text-sm text-mut">
          {card.chinese_explanation}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      data-testid="card"
      data-kind="expression"
      className={`group relative border-b border-edge border-l-2 bg-panel p-3 transition-colors hover:bg-panel3 ${hue.bar} ${
        isNew ? "diff-flash" : ""
      } ${isRepulsing ? "card-repulse" : ""} ${
        ring ? "ring-1 ring-act" : ""
      }`}
    >
      <CollapseAffordance onCollapse={onToggle} />
      <KnownAffordance
        onVote={onKnownVote}
        onSuppress={onKnownSuppress}
        align="right-10"
      />
      {badgeRow}

      <div className="mt-2 text-sm text-fg/90">{card.meaning}</div>

      {editing ? (
        <textarea
          aria-label="中文释义"
          value={draft.chinese_explanation}
          onChange={(e) =>
            setDraft((d) => ({ ...d, chinese_explanation: e.target.value }))
          }
          rows={2}
          className="mt-2 w-full resize-none border border-edge bg-panel2 px-2.5 py-1.5 text-[15px] font-medium leading-[1.7] text-fg focus:outline-none"
        />
      ) : (
        <div className="mt-2 text-[15px] font-medium leading-[26px] text-fg">
          {card.chinese_explanation}
        </div>
      )}

      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-mono text-xs text-mut2">直白说法</span>
        {editing ? (
          <input
            type="text"
            aria-label="直白说法"
            value={draft.plain_english}
            onChange={(e) => setDraft((d) => ({ ...d, plain_english: e.target.value }))}
            className="min-w-0 flex-1 border border-edge bg-panel2 px-2 py-1 text-sm text-fg focus:outline-none"
          />
        ) : (
          <span className="text-sm text-fg/90">{card.plain_english}</span>
        )}
      </div>

      <div className="mt-2 text-xs italic text-mut">{card.tone}</div>

      <div
        className="mt-2 line-clamp-2 border-l-2 border-edge bg-panel2 py-1.5 pl-2 font-mono text-xs text-mut"
        title={card.source_sentence}
      >
        {card.source_sentence}
      </div>

      {canEdit && (
        <EditActions
          editing={editing}
          saveDisabled={!draft.chinese_explanation.trim()}
          onEdit={handleEdit}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      )}
    </div>
  );
}

function TermCardRow({
  term,
  expanded,
  onToggle,
  onKnownVote,
  onKnownSuppress,
}: {
  term: TermCard;
  expanded: boolean;
  onToggle: () => void;
  onKnownVote: () => void;
  onKnownSuppress: () => void;
}) {
  const { ref, ring } = useFocusRing(term.id, expanded);

  const { isNew, isRepulsing } = useCardAnimation(
    term.firstSeenAt,
    term.lastSeenAt,
    term.count,
  );

  // v0.5 Wave-1 Feature 7 — see the identical block in ExpressionCardRow.
  const status = useApp((s) => s.status);
  const updateTerm = useApp((s) => s.updateTerm);
  const canEdit = status === "stopped";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TermDraft>(() => draftFromTerm(term));

  useEffect(() => {
    if (!expanded && editing) setEditing(false);
  }, [expanded, editing]);

  const handleEdit = () => {
    setDraft(draftFromTerm(term));
    setEditing(true);
  };
  const handleCancel = () => setEditing(false);
  const handleSave = () => {
    const patch = buildPatch(draft, draftFromTerm(term));
    if (Object.keys(patch).length > 0) updateTerm(term.id, patch);
    setEditing(false);
  };

  const badgeRow = (
    <div className="flex flex-wrap items-center gap-2">
      {editing && expanded ? (
        <input
          type="text"
          aria-label="词条"
          value={draft.term}
          onChange={(e) => setDraft((d) => ({ ...d, term: e.target.value }))}
          className="w-full border border-edge bg-panel2 px-2 py-1.5 font-mono text-sm font-semibold text-fg focus:outline-none sm:w-auto sm:min-w-[10rem]"
        />
      ) : (
        <span className="font-mono font-semibold text-fg">{term.term}</span>
      )}
      <span className={`border px-1.5 py-0 text-[12px] ${TERM_COLOR.border} ${TERM_COLOR.text}`}>
        术语 · {TERM_TYPE_LABELS[term.type]}
      </span>
      {term.count > 1 && (
        <span className="font-mono text-xs text-lab-cyan">×{term.count}</span>
      )}
      {sourceBadge(term.source)}
    </div>
  );

  if (!expanded) {
    return (
      <div
        ref={ref}
        data-testid="card"
        data-kind="term"
        role="button"
        tabIndex={0}
        aria-expanded={false}
        onClick={onToggle}
        onKeyDown={(e) => handleButtonKeyDown(e, onToggle)}
        className={`group relative cursor-pointer border-b border-edge border-l-2 bg-panel p-2 transition-colors hover:bg-panel3 ${TERM_COLOR.bar} ${
          isNew ? "diff-flash" : ""
        } ${isRepulsing ? "card-repulse" : ""} ${
          ring ? "ring-1 ring-act" : ""
        }`}
      >
        <KnownAffordance onVote={onKnownVote} onSuppress={onKnownSuppress} />
        {badgeRow}
        <div className="mt-2 truncate text-sm text-mut">{term.gloss_zh}</div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      data-testid="card"
      data-kind="term"
      className={`group relative border-b border-edge border-l-2 bg-panel p-3 transition-colors hover:bg-panel3 ${TERM_COLOR.bar} ${
        isNew ? "diff-flash" : ""
      } ${isRepulsing ? "card-repulse" : ""} ${
        ring ? "ring-1 ring-act" : ""
      }`}
    >
      <CollapseAffordance onCollapse={onToggle} />
      <KnownAffordance
        onVote={onKnownVote}
        onSuppress={onKnownSuppress}
        align="right-10"
      />
      {badgeRow}

      {editing ? (
        <textarea
          aria-label="英文释义"
          value={draft.gloss_en}
          onChange={(e) => setDraft((d) => ({ ...d, gloss_en: e.target.value }))}
          rows={2}
          className="mt-2 w-full resize-none border border-edge bg-panel2 px-2.5 py-1.5 text-sm text-fg focus:outline-none"
        />
      ) : (
        <div className="mt-2 text-sm text-fg/90">{term.gloss_en}</div>
      )}

      {editing ? (
        <textarea
          aria-label="中文释义"
          value={draft.gloss_zh}
          onChange={(e) => setDraft((d) => ({ ...d, gloss_zh: e.target.value }))}
          rows={2}
          className="mt-2 w-full resize-none border border-edge bg-panel2 px-2.5 py-1.5 text-[15px] font-medium leading-[1.7] text-fg focus:outline-none"
        />
      ) : (
        <div className="mt-2 text-[15px] font-medium leading-[26px] text-fg">
          {term.gloss_zh}
        </div>
      )}

      {canEdit && (
        <EditActions
          editing={editing}
          saveDisabled={!draft.gloss_zh.trim()}
          onEdit={handleEdit}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      )}
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
          点击右上角菜单里的「演示」立即体验，无需麦克风也无需配置 API Key。
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
          ? "说到内置词典里的习语、缩写或术语会立刻出卡片，命中内容显示在这里。"
          : "内置词典即时出卡，AI 同步分析语境并升级解释，值得解释的术语或表达会显示在这里。"}
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
  const focusCardId = useApp((s) => s.focusCardId);
  const markKnown = useApp((s) => s.markKnown);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");

  // Progressive disclosure: viewMode is the global cycle (auto → all
  // expanded → all collapsed → auto); manualMap holds per-card user
  // overrides that always win, see resolveExpanded() above.
  const [viewMode, setViewMode] = useState<CardViewMode>("auto");
  const [manualMap, setManualMap] = useState<Map<string, ManualState>>(
    new Map(),
  );

  const unified = useMemo(() => toUnified(cards, terms), [cards, terms]);

  // Auto-rule index is computed against the full unwrapped list (sortAt
  // order) so filtering/searching never changes which cards count as
  // "the 3 newest".
  const autoIndexById = useMemo(() => {
    const map = new Map<string, number>();
    unified.forEach((item, i) => map.set(item.id, i));
    return map;
  }, [unified]);

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

  const setManualState = (id: string, state: ManualState) => {
    setManualMap((prev) => {
      const next = new Map(prev);
      next.set(id, state);
      return next;
    });
  };

  const handleToggleCard = (id: string) => {
    const expanded = resolveExpanded(
      id,
      autoIndexById.get(id) ?? Infinity,
      viewMode,
      manualMap,
    );
    setManualState(id, expanded ? "collapsed" : "expanded");
  };

  const handleCycleViewMode = () => {
    setViewMode((prev) => nextViewMode(prev));
    setManualMap(new Map());
  };

  // focusCardId scroll+ring: if the focused card is currently collapsed,
  // expand it first so the scroll target and ring are visible.
  useEffect(() => {
    if (!focusCardId) return;
    const expanded = resolveExpanded(
      focusCardId,
      autoIndexById.get(focusCardId) ?? Infinity,
      viewMode,
      manualMap,
    );
    if (!expanded) {
      setManualState(focusCardId, "expanded");
    }
    // manualMap is intentionally excluded: this effect only reacts to a
    // fresh focus request, not to every manual-map mutation (including
    // the one it itself just made).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCardId, viewMode, autoIndexById]);

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
          className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
        />

        <div className="flex items-center gap-2">
          <div className="flex flex-1 flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`border px-2.5 py-1 font-mono text-xs ${
                  filter === f.key
                    ? "border-edge2 text-act"
                    : "border-edge text-mut hover:bg-panel3"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleCycleViewMode}
            title={viewModeTitle(viewMode)}
            className={`flex h-7 w-7 shrink-0 items-center justify-center border border-edge hover:bg-panel3 ${
              viewMode === "auto" ? "text-mut" : "text-act"
            }`}
          >
            <CaretUpDown size={16} weight="regular" />
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState />
      ) : (
        // S14.1 field fix (item 9): the old pb-3 (12px) let the last
        // card render right up to — and, at phone width, behind —
        // StatusLine (page.tsx, h-7 = 28px, a separate sibling BELOW
        // this whole tab panel, not part of its own box). pb matches
        // that height, plus env(safe-area-inset-bottom) for an iOS
        // home-indicator inset WHENEVER this app's viewport opts into
        // viewport-fit=cover (it doesn't today — see layout.tsx's own
        // `viewport` export — so that term is currently just 0, a
        // forward-compatible no-op, not the active part of this fix).
        <div className="scroll-thin flex-1 space-y-2 overflow-y-auto px-3 pb-[calc(1.75rem+env(safe-area-inset-bottom))] pt-2">
          {filtered.map((item) => {
            const expanded = resolveExpanded(
              item.id,
              autoIndexById.get(item.id) ?? Infinity,
              viewMode,
              manualMap,
            );
            if (item.kind === "expression" && item.expression) {
              const card = item.expression;
              return (
                <ExpressionCardRow
                  key={item.id}
                  card={card}
                  expanded={expanded}
                  onToggle={() => handleToggleCard(item.id)}
                  onKnownVote={() => void markKnown("expression", card.expression, "vote")}
                  onKnownSuppress={() =>
                    void markKnown("expression", card.expression, "suppress")
                  }
                />
              );
            }
            if (item.term) {
              const term = item.term;
              return (
                <TermCardRow
                  key={item.id}
                  term={term}
                  expanded={expanded}
                  onToggle={() => handleToggleCard(item.id)}
                  onKnownVote={() => void markKnown("term", term.term, "vote")}
                  onKnownSuppress={() => void markKnown("term", term.term, "suppress")}
                />
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}
