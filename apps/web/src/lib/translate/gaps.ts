import type { TranscriptSegment } from "@jargonslayer/core/types";

// Mirrors TranslateQueue's MAX_TEXT_CHARS (queue.ts) — segments above this are
// never translated live, so gap-fill must skip them too or it would "complete"
// into a state the live path can't reach.
export const GAP_MAX_TEXT_CHARS = 1500;

/** Segments that have no landed translation and are eligible for one. */
export function untranslatedSegments(
  segments: TranscriptSegment[],
  translations: Record<string, string>,
): TranscriptSegment[] {
  return segments.filter(
    (s) =>
      !translations[s.id] &&
      s.text.trim().length > 0 &&
      s.text.length <= GAP_MAX_TEXT_CHARS,
  );
}

/** F6 fix (v0.7.1 train-2 adversarial review): untranslated segments too
 *  long for gap-fill (or the live queue) to EVER pick up — the mirror
 *  image of untranslatedSegments' own `<= GAP_MAX_TEXT_CHARS` filter.
 *  Lets SummaryPanel's export gate tell "will get filled" apart from
 *  "permanently stuck, only 直接导出 will ever clear this" instead of
 *  the oversized segments simply vanishing from every count. */
export function oversizedUntranslated(
  segments: TranscriptSegment[],
  translations: Record<string, string>,
): TranscriptSegment[] {
  return segments.filter(
    (s) =>
      !translations[s.id] &&
      s.text.trim().length > 0 &&
      s.text.length > GAP_MAX_TEXT_CHARS,
  );
}
