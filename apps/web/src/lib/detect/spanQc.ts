// v0.4.5 detect-span QC — the single shared, CATEGORY-AWARE span filter
// applied at every detect-producing boundary: the live scheduler
// (scheduler.ts's DetectionScheduler), the import pipeline (upload.ts's
// runDetectionPipeline), and the post-meeting missed-item sweep
// (summarize.ts's runSweepStage). Owner field bug: AI detect sometimes
// flagged a whole SENTENCE as jargon — a length-based guard already
// existed, but ONLY on the live path, and it was category-blind (a
// fixed 8-word/64-char/20-CJK cap for every category, including
// "idiom"). That meant a genuine multi-word idiom the model correctly
// tagged category:"idiom" could get clipped just as aggressively as a
// mislabeled run-on sentence, AND the import/sweep paths had no QC at
// all — a jargon-dense sentence riding in as category:"idiom" (see
// prompts.ts's DETECT_SYSTEM_PROMPT rule 10 exception) sailed through
// those two untouched. This module fixes both gaps in one place.
//
// Category-aware caps (owner ruling 2026-07-17):
// - category "idiom"/"slang": a RAISED, user-configurable cap
//   (settings.detectIdiomMaxWords/detectIdiomMaxChars — see types.ts's
//   Settings/DEFAULT_SETTINGS) for genuine multi-word idioms/proverbs.
//   CJK idiom spans get their OWN fixed (NOT configurable) 30-char cap
//   instead — 成语/俗语 are short by nature, no dial needed.
// - every other category (phrase/metaphor/indirect/other/anything
//   unrecognized): the original TIGHT fixed cap (8 words / 64 chars /
//   20 CJK chars), unchanged from the pre-v0.4.5 scheduler-only guard.
// - SENTENCE-TERMINATOR GUARD (all categories, checked FIRST, drops
//   regardless of cap): a genuine idiom/phrase is never itself a full
//   sentence, so a span that still shows sentence-ending shape — a
//   full-width CJK terminator anywhere, or the span ENDING in an ASCII
//   terminator — is dropped outright, even when short enough to pass
//   the word/char caps. v0.4.5 fix-round rewrite: the original guard
//   required whitespace after the terminator (a Latin "two sentences
//   glued together" shape), which real Chinese prose never produces
//   (no space after 。/？/！) and which false-tripped on Latin
//   abbreviations ("Mr. Right", "e.g. x"). See isOversizedDetectSpan's
//   own comment for the two replacement rules and their residual.
//
// Pure function, no store import — settings.detectIdiomMaxWords/Chars
// are read at each CALL SITE and passed in as `caps`, keeping this a
// leaf module (trivially testable, no cycle risk).

import type { DetectResponse } from "@jargonslayer/core/types";

// CJK Unified Ideographs block, U+4E00-U+9FFF (covers the vast
// majority of everyday Chinese characters) — moved here verbatim from
// scheduler.ts's own pre-v0.4.5 guard.
const CJK_RE = /[一-鿿]/;

const TIGHT_MAX_WORDS = 8;
const TIGHT_MAX_CHARS = 64;
const TIGHT_MAX_CJK_CHARS = 20;
// Idiom/slang CJK spans get their OWN fixed (not configurable) cap —
// 成语/俗语 are short by nature; the configurable idiomMaxWords/Chars
// caps below are English/space-delimited only (see
// isOversizedDetectSpan's CJK branch).
const IDIOM_CJK_MAX_CHARS = 30;

// Rule 1: a full-width CJK terminator ANYWHERE in the span. Real
// Chinese prose never puts whitespace after 。/？/！ — "干得好。继续加油"
// (two sentences glued together, no space) is exactly the reported
// bug this catches; the old regex's whitespace requirement missed it
// entirely.
const CJK_TERMINATOR_RE = /[。？！]/;

// Rule 2: the span, once trimmed, ENDS with an ASCII terminator — a
// complete Latin/mixed sentence that kept its terminal punctuation
// ("We should circle back on this next week."). An abbreviation's
// internal period ("Mr. Right", "U.S. Treasury", "e.g. foo") is safe
// as long as it isn't the LAST character of the trimmed span — this
// rule no longer requires a following word (that was the source of
// the old whitespace-masking bug), it only cares whether the span's
// own final character is a terminator.
const ASCII_TERMINAL_RE = /[.?!]\s*$/;

export interface DetectSpanCaps {
  idiomMaxWords: number;
  idiomMaxChars: number;
}

/** True when `expression` is implausibly long/shaped for a detect span
 *  — the shared post-filter every detect-producing boundary (live
 *  scheduler, import pipeline, post-meeting sweep) runs before
 *  accepting an LLM-tagged expression. `category` is read at face
 *  value (not validated against ExpressionCategory) — any value other
 *  than "idiom"/"slang" falls through to the TIGHT non-idiom cap,
 *  never the raised one, so a garbled/unexpected category can never
 *  accidentally unlock the looser limit. */
export function isOversizedDetectSpan(
  expression: string,
  category: string,
  caps: DetectSpanCaps,
): boolean {
  const trimmed = expression.trim();

  // Checked first, regardless of category/cap — see this module's own
  // header comment and the two regexes above for why a span still
  // showing sentence-ending shape is never a genuine idiom no matter
  // how short its word/char count looks.
  //
  // Residual (documented, not solved here): a short single sentence
  // whose terminal punctuation the model STRIPPED ("we should circle
  // back next week", no period) shows NO sentence-shape signal for
  // either regex to catch, and sits under the length caps too — a
  // regex filter can't reliably tell a punctuation-stripped short
  // sentence apart from a legitimate short term without source-segment
  // coverage analysis (deferred). DETECT_SYSTEM_PROMPT's own rule 10
  // ("never a full clause or sentence") is the first-line defense for
  // that case; this filter is only the backstop for spans that still
  // retain sentence shape/punctuation.
  if (CJK_TERMINATOR_RE.test(trimmed) || ASCII_TERMINAL_RE.test(trimmed)) return true;

  const isIdiomLike = category === "idiom" || category === "slang";
  const isCjk = CJK_RE.test(trimmed);

  if (isCjk) {
    const cjkCap = isIdiomLike ? IDIOM_CJK_MAX_CHARS : TIGHT_MAX_CJK_CHARS;
    return trimmed.length > cjkCap;
  }

  // Whitespace-separated word count OR raw character count, whichever
  // is stricter (catches a run-on phrase with few but very long
  // "words" too) — a single-token span (no spaces) still gets a
  // words.length of 1, so the char cap alone is what catches it.
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (isIdiomLike) {
    return words.length > caps.idiomMaxWords || trimmed.length > caps.idiomMaxChars;
  }
  return words.length > TIGHT_MAX_WORDS || trimmed.length > TIGHT_MAX_CHARS;
}

/** Drops oversized/multi-sentence spans from an LLM detect response;
 *  `terms` passes through untouched (never oversized in the way this
 *  guards against — a term is already, by the detect prompt's own rule
 *  4, a short acronym/name/metric). Returns the SAME `res` reference
 *  when nothing was dropped (cheap no-op on the common case, and lets
 *  callers use `!==` as a "did anything change" check). `onDrop`
 *  receives only the COUNT of dropped items, never their text — see
 *  diag/log.ts's PRIVACY RULE. */
export function filterDetectSpans(
  res: DetectResponse,
  caps: DetectSpanCaps,
  onDrop?: (droppedCount: number) => void,
): DetectResponse {
  const kept = res.expressions.filter(
    (e) => !isOversizedDetectSpan(e.expression, e.category, caps),
  );
  const droppedCount = res.expressions.length - kept.length;
  if (droppedCount === 0) return res;
  onDrop?.(droppedCount);
  return { expressions: kept, terms: res.terms };
}
