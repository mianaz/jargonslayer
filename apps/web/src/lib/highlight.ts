// Transcript term/expression highlight matcher — shared by
// TranscriptPanel.tsx (live highlighting, `.hl-expr` / `.hl-term`).
// Builds one combined regex across ExpressionCard[] and TermCard[] so
// the transcript can highlight both kinds in a single pass, longest
// surface first so multi-word phrases win over their substrings.
//
// cornell.ts intentionally keeps its own variant of this matcher
// (different sort key, first-registration-wins, lang-dependent gloss
// payload, and a frozen post-meeting artifact contract) — see the
// comment at the top of that file.

import type { ExpressionCard, TermCard } from "@jargonslayer/core/types";

export type HighlightKind = "expression" | "term";

export interface HighlightHit {
  kind: HighlightKind;
  id: string;
}

export interface HighlightMatcher {
  regex: RegExp | null;
  resolve: (matched: string) => HighlightHit | undefined;
}

export const MAX_HIGHLIGHT_PER_KIND = 30;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface MatchEntry {
  kind: HighlightKind;
  id: string;
  surface: string;
}

/** True when `surface` is an all-caps acronym-shaped string (contains
 *  at least one A-Z letter and no lowercase letters). Terms shaped
 *  like this ("IT", "US", "REST") must match case-sensitively — a
 *  case-insensitive hit would false-positive on everyday words like
 *  "it"/"its"/"us"/"rest". Mixed-case terms ("iPhone", "Kubernetes")
 *  are unaffected and stay case-insensitive. */
function isAllCapsSurface(surface: string): boolean {
  return /[A-Z]/.test(surface) && surface === surface.toUpperCase();
}

/** Build one combined regex from the most recent cards+terms, longest
 * surface first (across both kinds) so multi-word phrases win over
 * their substrings. The last word of each expression may carry an
 * optional trailing inflection (s|ed|ing|d), e.g. "raise eyebrows"
 * also matches "raised eyebrows"; terms only ever get an optional
 * trailing plural "s" (never ed/ing/d — a term is a name, not a verb).
 * "Most recent" is by lastSeenAt, not insertion order — a card/term
 * re-detected recently stays eligible even if many others were newly
 * inserted after it. The recency budget (MAX_HIGHLIGHT_PER_KIND) is
 * applied independently per kind so a flood of one kind never starves
 * the other. */
export function buildHighlightMatcher(
  cards: ExpressionCard[],
  terms: TermCard[],
): HighlightMatcher {
  const recentCards = [...cards]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_HIGHLIGHT_PER_KIND);
  const recentTerms = [...terms]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_HIGHLIGHT_PER_KIND);

  // lower(surface) -> entry. On a collision between an expression and a
  // term, the expression wins: it is the richer learning object (full
  // idiom/slang gloss vs. a plain term definition), so it should claim
  // the shared surface form. Same-kind collisions keep the existing
  // "last one wins, purely cosmetic" behavior.
  const byLower = new Map<string, MatchEntry>();

  interface Part {
    pattern: string;
    length: number;
  }
  const parts: Part[] = [];

  const expressionParts: { entry: MatchEntry; length: number }[] = [];
  for (const card of recentCards) {
    const expr = card.expression.trim();
    if (!expr) continue;
    expressionParts.push({
      entry: { kind: "expression", id: card.id, surface: expr },
      length: expr.length,
    });
  }

  const termParts: { entry: MatchEntry; length: number }[] = [];
  for (const term of recentTerms) {
    const surface = term.term.trim();
    if (!surface) continue;
    termParts.push({
      entry: { kind: "term", id: term.id, surface },
      length: surface.length,
    });
  }

  // Register into byLower: expressions first, terms second, but since
  // Map.set overwrites, register expressions LAST so an expression
  // always wins a lower-key collision against a term, regardless of
  // array order above.
  for (const { entry } of termParts) {
    byLower.set(entry.surface.toLowerCase(), entry);
  }
  for (const { entry } of expressionParts) {
    byLower.set(entry.surface.toLowerCase(), entry);
  }

  for (const { entry, length } of [...expressionParts, ...termParts]) {
    const words = entry.surface.split(/\s+/);
    const escapedWords = words.map((w, i) => {
      const escaped = escapeRegExp(w);
      const isLast = i === words.length - 1;
      if (!isLast) return escaped;
      return entry.kind === "expression"
        ? `${escaped}(?:s|ed|ing|d)?`
        : `${escaped}(?:s)?`;
    });
    parts.push({ pattern: escapedWords.join("\\s+"), length });
  }

  if (parts.length === 0) {
    return { regex: null, resolve: () => undefined };
  }

  const sorted = [...parts].sort((a, b) => b.length - a.length);
  const regex = new RegExp(`\\b(${sorted.map((p) => p.pattern).join("|")})\\b`, "giu");

  const resolve = (matched: string): HighlightHit | undefined => {
    const lower = matched.toLowerCase();

    // Direct exact-lower hit (covers expressions, and terms matched
    // with no trailing "s" at all).
    const direct = byLower.get(lower);
    if (direct && entryAcceptsMatch(direct, matched)) {
      return { kind: direct.kind, id: direct.id };
    }

    // Term exact-lower + trailing plural "s": the regex only ever
    // appends an optional "s" for terms, so byLower holds the
    // un-suffixed surface only — strip one trailing "s" and re-check
    // against a TERM entry specifically (an expression must not gain a
    // plural fallback it never had before). Terms never fall through
    // to the expression-only fuzzy fallbacks below.
    if (lower.endsWith("s")) {
      const singular = byLower.get(lower.slice(0, -1));
      if (singular && singular.kind === "term" && entryAcceptsMatch(singular, matched)) {
        return { kind: singular.kind, id: singular.id };
      }
    }
    if (direct && direct.kind === "term") return undefined;

    // Expression-only fuzzy fallbacks: strip a trailing inflection,
    // then a startsWith scan. These may only ever resolve to an
    // expression entry (a term's stored surface never participates).
    const stripped = lower.replace(/(?:ing|ed|s|d)$/u, "");
    for (const [key, entry] of byLower) {
      if (entry.kind !== "expression") continue;
      if (key === stripped || key.replace(/(?:ing|ed|s|d)$/u, "") === stripped) {
        return { kind: entry.kind, id: entry.id };
      }
      if (lower.startsWith(key)) return { kind: entry.kind, id: entry.id };
    }
    return undefined;
  };

  return { regex, resolve };
}

/** Final acceptance check applied to a direct byLower hit. Expressions
 *  always accept (case-insensitive by design). Terms accept unless the
 *  stored surface is all-caps, in which case the raw matched text must
 *  equal the surface case-sensitively (optionally + trailing "s") — see
 *  isAllCapsSurface. */
function entryAcceptsMatch(entry: MatchEntry, matched: string): boolean {
  if (entry.kind === "expression") return true;
  if (!isAllCapsSurface(entry.surface)) return true;
  return matched === entry.surface || matched === `${entry.surface}s`;
}
