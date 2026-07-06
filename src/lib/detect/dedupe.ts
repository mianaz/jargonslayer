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

import type {
  DetectResponse,
  DetectionSource,
  ExpressionCard,
  TermCard,
} from "../types";

export const EXPRESSION_TTL_MS = 8 * 60 * 1000;

export function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export interface MergeResult {
  cards: ExpressionCard[];
  terms: TermCard[];
}

export function mergeDetections(
  existingCards: ExpressionCard[],
  existingTerms: TermCard[],
  res: DetectResponse,
  source: DetectionSource,
  minConfidence: number,
  now: number = Date.now(),
): MergeResult {
  // STUB — worker B replaces this with the real implementation.
  void res;
  void source;
  void minConfidence;
  void now;
  return { cards: existingCards, terms: existingTerms };
}
