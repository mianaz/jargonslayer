// Unified expression-card + term-card model shared by CardsPanel (the
// full-screen list) and CardStrip (the mobile horizontal strip) — moved
// out of CardsPanel.tsx so both can import the same merge/sort logic
// without one depending on the other's module.

import type { ExpressionCard, TermCard } from "@jargonslayer/core/types";

type Kind = "expression" | "term";

export interface UnifiedItem {
  kind: Kind;
  id: string;
  firstSeenAt: number;
  lastSeenAt: number;
  sortAt: number;
  expression?: ExpressionCard;
  term?: TermCard;
}

export function toUnified(cards: ExpressionCard[], terms: TermCard[]): UnifiedItem[] {
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
