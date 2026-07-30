// Pure merge/dedup logic for detection results.
// OWNER: worker B. Signature is contract — do not change it.
// Rules to implement:
//  - normKey: lowercase, trim, collapse whitespace, strip edge punctuation
//  - expression TTL: if same normKey seen < EXPRESSION_TTL_MS ago →
//    bump count + lastSeenAt on the existing card (no new card)
//  - if same normKey but older than TTL → also just bump (cards are
//    unique per session; re-surfacing is signaled via lastSeenAt)
//  - terms dedup for the whole session (always bump, never duplicate)
//  - drop expressions with confidence < minConfidence
//  - returned arrays are NEW array instances (zustand immutability)

import {
  newId,
  type DetectedExpression,
  type DetectResponse,
  type DetectionSource,
  type ExpressionCard,
  type TermCard,
} from "../types";
import { AMBIGUOUS_MARGIN } from "./dictionary";
import { narrowSourceSentence } from "./sourceSentence";

export const EXPRESSION_TTL_MS = 8 * 60 * 1000;

export function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Expression dedup key: normalizeKey() then light-lemma the LAST
 *  word only (strip a trailing ing/ed/es/s/d when that word is
 *  longer than 4 chars). Multi-word phrases only flex on their
 *  final token — by design this leaves e.g. "circling back" and
 *  "circle back" as distinct keys (acceptable per spec). */
export function expressionNormKey(expression: string): string {
  const base = normalizeKey(expression);
  if (!base) return base;
  const words = base.split(" ");
  const last = words[words.length - 1];
  if (last.length > 4) {
    const stripped = last.replace(/(ing|ed|es|s|d)$/, "");
    // Guard against stripping down to nothing/too little.
    if (stripped.length >= 2) {
      words[words.length - 1] = stripped;
    }
  }
  return words.join(" ");
}

/** Term dedup key: trimmed; short (<=6 chars) all-letters terms are
 *  treated as acronyms and uppercased, everything else lowercased. */
export function termNormKey(term: string): string {
  const trimmed = term.trim();
  const isShortLettersOnly = trimmed.length <= 6 && /^[A-Za-z]+$/.test(trimmed);
  return isShortLettersOnly ? trimmed.toUpperCase() : trimmed.toLowerCase();
}

export interface MergeResult {
  cards: ExpressionCard[];
  terms: TermCard[];
}

export interface MergeOptions {
  // #54 dictionary-instant floor: when the scheduler applies an LLM
  // batch, every occurrence inside that batch's accumulation window
  // was ALREADY floor-scanned (and counted) by the dictionary at
  // segment-push time. An llm hit on a card whose lastDictSeenAt falls
  // at/after this timestamp is therefore the SAME occurrence — its
  // count bump is skipped (content upgrade + lastSeenAt still apply).
  // Cards the dictionary never bumped (llm-only expressions) have no
  // lastDictSeenAt and are never suppressed. Only meaningful for
  // source === "llm"; dictionary/custom merges ignore it.
  llmCountSuppressSince?: number;
}

function shouldSuppressLlmBump(
  card: { lastDictSeenAt?: number },
  source: DetectionSource,
  opts: MergeOptions | undefined,
): boolean {
  return (
    source === "llm" &&
    opts?.llmCountSuppressSince !== undefined &&
    card.lastDictSeenAt !== undefined &&
    card.lastDictSeenAt >= opts.llmCountSuppressSince
  );
}

function mergeExpressions(
  existingCards: ExpressionCard[],
  incoming: DetectedExpression[],
  source: DetectionSource,
  minConfidence: number,
  now: number,
  opts?: MergeOptions,
): ExpressionCard[] {
  const cards = existingCards.map((c) => ({ ...c }));
  const byKey = new Map<string, ExpressionCard>();
  for (const c of cards) byKey.set(c.normKey, c);

  for (const det of incoming) {
    if (det.confidence < minConfidence) continue;
    const normKey = expressionNormKey(det.expression);
    const existing = byKey.get(normKey);

    if (existing) {
      // Custom (personal glossary) cards are the user's own curated
      // truth — never touched by a later llm/dictionary hit on the
      // same word. Their count only moves via the store's addFinal
      // custom-scan path, so this incoming detection is dropped
      // entirely (no bump, no overwrite).
      if (existing.source === "custom" && source !== "custom") {
        continue;
      }
      if (!shouldSuppressLlmBump(existing, source, opts)) {
        existing.count += 1;
      }
      existing.lastSeenAt = now;
      if (source === "dictionary") existing.lastDictSeenAt = now;
      // Keep the most recently observed local surface so transcript
      // highlighting follows dictionary/custom variants while the card
      // title and normKey remain canonical. An LLM hit has no
      // matched_surface and must not erase the local value.
      if (det.matched_surface) existing.matched_surface = det.matched_surface;
      // LLM knows the live context better than the built-in dictionary —
      // upgrade content + source when a dictionary card gets a live hit.
      if (existing.source === "dictionary" && source === "llm") {
        existing.meaning = det.meaning;
        existing.chinese_explanation = det.chinese_explanation;
        existing.plain_english = det.plain_english;
        existing.tone = det.tone;
        existing.category = det.category;
        existing.confidence = det.confidence;
        existing.source_sentence = narrowSourceSentence(det.source_sentence, det.expression);
        existing.source = "llm";
      }
      continue;
    }

    const card: ExpressionCard = {
      ...det,
      id: newId(),
      normKey,
      firstSeenAt: now,
      lastSeenAt: now,
      count: 1,
      source,
      ...(source === "dictionary" ? { lastDictSeenAt: now } : {}),
    };
    cards.push(card);
    byKey.set(normKey, card);
  }

  return cards;
}

function mergeTerms(
  existingTerms: TermCard[],
  incoming: DetectResponse["terms"],
  source: DetectionSource,
  now: number,
  opts?: MergeOptions,
): TermCard[] {
  const terms = existingTerms.map((t) => ({ ...t }));
  const byKey = new Map<string, TermCard>();
  for (const t of terms) byKey.set(t.normKey, t);

  for (const det of incoming) {
    const normKey = termNormKey(det.term);
    const existing = byKey.get(normKey);

    if (existing) {
      // Same custom-glossary protection as mergeExpressions above.
      if (existing.source === "custom" && source !== "custom") {
        continue;
      }
      if (!shouldSuppressLlmBump(existing, source, opts)) {
        existing.count += 1;
      }
      existing.lastSeenAt = now;
      if (source === "dictionary") existing.lastDictSeenAt = now;
      if (existing.source === "dictionary" && source === "llm") {
        existing.gloss_en = det.gloss_en;
        existing.gloss_zh = det.gloss_zh;
        existing.type = det.type;
        existing.source = "llm";
        // v0.6 T4 (multi-sense terms): the LLM saw the real sentence —
        // its judgement supersedes the dictionary's context-scored
        // heuristic, so that heuristic's own ambiguity bookkeeping no
        // longer applies once upgraded. This is the existing keyed
        // disambiguation branch; only these two lines are new.
        existing.senses = undefined;
        existing.ambiguous = undefined;
      }
      if (existing.source === "dictionary" && source === "dictionary" && det.senses !== undefined) {
        // MEDIUM-4 fix (v0.6 round-2 review): captured BEFORE the S12
        // refresh below overwrites existing.senses — the score the
        // card's CURRENT senseId held under the OLD context, not the
        // new one.
        const oldScore = existing.senses?.find((s) => s.senseId === existing.senseId)?.score;
        const newScore = det.senses.find((s) => s.senseId === det.senseId)?.score;

        // S12 fix (v0.6 round-2 review): refresh the ranked snapshot +
        // ambiguous flag on EVERY dictionary hit, even when the winning
        // sense doesn't change — a context change can shift scores or
        // flip `ambiguous` while the top pick stays the same, and the
        // old snapshot must not go stale just because identity didn't
        // move.
        existing.senses = det.senses;
        existing.ambiguous = det.ambiguous;

        // MEDIUM-4 fix: only swap the WINNER (gloss/type/senseId — same
        // card, same id/count/firstSeenAt, per v0.6 T4's original
        // in-place-replace design) when the new top score beats the
        // card's PREVIOUS sense by at least AMBIGUOUS_MARGIN. Without a
        // margin, senseContext.ts's own cooccurrence denominator grows
        // all meeting, so a borderline call could flip A->B->A as
        // unrelated terms accumulate — a card whose meaning oscillates
        // is worse than one that's simply wrong. No old score to
        // compare against (a first-ever dictionary hit for this
        // surface, or the entry didn't carry senses before) never
        // blocks the swap — there is nothing to protect against
        // oscillating FROM yet.
        const winnerChanged = det.senseId !== undefined && det.senseId !== existing.senseId;
        const marginClears =
          oldScore === undefined || newScore === undefined || newScore - oldScore >= AMBIGUOUS_MARGIN;
        if (winnerChanged && marginClears) {
          existing.gloss_en = det.gloss_en;
          existing.gloss_zh = det.gloss_zh;
          existing.type = det.type;
          existing.senseId = det.senseId;
        }
      }
      continue;
    }

    const card: TermCard = {
      ...det,
      id: newId(),
      normKey,
      firstSeenAt: now,
      lastSeenAt: now,
      count: 1,
      source,
      ...(source === "dictionary" ? { lastDictSeenAt: now } : {}),
    };
    terms.push(card);
    byKey.set(normKey, card);
  }

  return terms;
}

export function mergeDetections(
  existingCards: ExpressionCard[],
  existingTerms: TermCard[],
  res: DetectResponse,
  source: DetectionSource,
  minConfidence: number,
  now: number = Date.now(),
  opts?: MergeOptions,
): MergeResult {
  return {
    cards: mergeExpressions(existingCards, res.expressions, source, minConfidence, now, opts),
    terms: mergeTerms(existingTerms, res.terms, source, now, opts),
  };
}
