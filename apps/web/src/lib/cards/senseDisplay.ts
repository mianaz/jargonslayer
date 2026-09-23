import type { TermCard } from "@jargonslayer/core/types";

/** Sense-picker plan, Lane 1: the runner-up sense for a term card's 或
 *  line. Only ambiguous cards (the picker's own top-two-within-margin /
 *  domain-mismatch flag, DetectedTerm.ambiguous) and already-pinned
 *  cards (TermCard.pinnedSenseId — so the user can switch back) show
 *  it; a confident single pick stays one line, and a card is never
 *  shown more than TWO glosses live (the popover keeps the full list).
 *  The runner-up is the highest-ranked sense that is NOT the one
 *  currently displayed — after a hysteresis-blocked swap (dedupe.ts's
 *  AMBIGUOUS_MARGIN gate) or a pin, that may be ranked[0] itself.
 *  Shared by CardsPanel, CardStrip and HoverGlossCard so the three
 *  surfaces can never disagree about when the line appears. */
export function runnerUpSense(
  term: Pick<TermCard, "ambiguous" | "pinnedSenseId" | "senses" | "senseId">,
): NonNullable<TermCard["senses"]>[number] | null {
  if (!term.ambiguous && term.pinnedSenseId === undefined) return null;
  const senses = term.senses;
  if (!senses || senses.length < 2) return null;
  return senses.find((s) => s.senseId !== term.senseId) ?? null;
}
