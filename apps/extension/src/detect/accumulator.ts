// Pure session accumulator over @jargonslayer/core's dictionary
// detection + merge pipeline (S7 blueprint §2 decision B). Mirrors
// apps/web/src/lib/stt/upload.ts's runDetectionPipeline
// dictionary-fallback branch exactly (scanDictionary -> mergeDetections,
// source "dictionary") but dictionary-only — Lite v1 has no LLM/BYOK
// path — and scoped to a single capture session's running cards/terms
// rather than a whole import run. No core code changes needed.

import { mergeDetections } from "@jargonslayer/core/detect/dedupe";
import { scanDictionary } from "@jargonslayer/core/detect/dictionary";
import {
  DEFAULT_SETTINGS,
  type ExpressionCard,
  type TermCard,
} from "@jargonslayer/core/types";

// Same floor the web app's Settings default to (0.55) — dictionary
// entries all ship at confidence 0.9 (see dictionary-data.ts), so this
// only ever bites a future lower-confidence pack entry; kept anyway so
// the accumulator stays byte-identical in spirit to upload.ts's own
// `settings.minConfidence` usage rather than hardcoding a number here.
const MIN_CONFIDENCE = DEFAULT_SETTINGS.minConfidence;

export interface AccumulatorSnapshot {
  cards: ExpressionCard[];
  terms: TermCard[];
}

export interface Accumulator {
  /** Scan one finalized transcript segment and merge any dictionary
   *  hits into the running session state. No-ops on empty/whitespace
   *  text — skips the scan/merge pass entirely and returns the exact
   *  same cards/terms references as the last call (true no-op, not
   *  just a content no-op). `now` defaults to Date.now(), overridable
   *  for deterministic tests. */
  addFinal(text: string, now?: number): AccumulatorSnapshot;
  /** Current cards/terms, unmodified. */
  snapshot(): AccumulatorSnapshot;
}

export function createAccumulator(): Accumulator {
  let cards: ExpressionCard[] = [];
  let terms: TermCard[] = [];

  function snapshot(): AccumulatorSnapshot {
    return { cards, terms };
  }

  function addFinal(text: string, now: number = Date.now()): AccumulatorSnapshot {
    if (!text.trim()) return snapshot();
    const res = scanDictionary(text);
    const merged = mergeDetections(cards, terms, res, "dictionary", MIN_CONFIDENCE, now);
    cards = merged.cards;
    terms = merged.terms;
    return snapshot();
  }

  return { addFinal, snapshot };
}
