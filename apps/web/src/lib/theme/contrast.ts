// WCAG 2.x relative luminance / contrast ratio (v0.5.1 ThemeEditor
// contrast hints, D4). Same formula as themes.test.ts's own private
// copy (that file's own comment: "same formula as the project's
// contrast-audit scratch script") — kept as an independent, minimal,
// dependency-free implementation here rather than importing from a
// test file into shipped app code. This module is ADVISORY only: it
// powers the editor's live ✓/⚠ hints, never a hard gate on saving a
// custom theme (unlike themes.test.ts's own AA suite, which DOES gate
// every BUILTIN theme — a user's own custom theme is her call).

/** WCAG relative luminance of a 6-digit hex color (0..1). */
export function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio between two hex colors, 1 (identical) to 21
 *  (black vs white) — order of the two arguments doesn't matter, the
 *  lighter/darker pair is sorted internally per the spec formula. */
export function contrastRatio(hexA: string, hexB: string): number {
  const [l1, l2] = [luminance(hexA), luminance(hexB)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
