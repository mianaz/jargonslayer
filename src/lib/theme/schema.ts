// Theme engine v0 (v0.2.1 "可读性与主题机制") — schema + validation.
// SECURITY-CRITICAL: this is the safety foundation for a future
// community theme-pack pipeline (mirrors detect/remotePacks.ts's own
// "validate untrusted external JSON" precedent). Color VALUES only —
// a theme is nothing but a flat token->hex map, so there is no shape
// for CSS injection, url()/expression()/@import, or any other CSS
// value form to hide in. Every token is validated against a strict
// hex regex; anything else (rgb()/hsl()/named colors/CSS functions/
// bare strings) is rejected outright.
//
// `--bl` (baseline grid unit) is intentionally NOT part of the token
// contract — it's a layout primitive, not a themeable color, and stays
// pinned in globals.css. Font stacks are also out of the external
// contract for now (only built-in themes may ever carry one; see
// themes.ts) — kept out of ThemeTokens/ThemeSchema entirely so no
// external JSON can smuggle one in.

import * as z from "zod";

// Strict hex-only pattern: #RGB or #RRGGBB. Deliberately excludes
// every other CSS color syntax (rgb()/rgba()/hsl()/hsla()/named
// colors/CSS variables) — those are exactly the shapes a malicious
// "theme" would need to smuggle in url()/expression()/other unsafe
// constructs, so the regex simply never matches them.
//
// v0.2.1: also deliberately excludes the 4- and 8-digit alpha forms
// (#RGBA/#RRGGBBAA) that a strictly-hex reading of CSS Color Module 4
// would otherwise allow. Alpha is a Tailwind utility-class MODIFIER
// (text-fg/50, bg-panel/80, ...), not part of a theme token's own
// value — apply.ts derives each token's "-rgb" triplet straight from
// its hex digits (see hexToRgbTriplet), and an alpha suffix baked into
// the token itself would make that derivation ambiguous (is the 4th
// hex pair alpha, or would it silently corrupt the RGB triplet?).
// Rejecting alpha-bearing hex at the schema boundary is a free
// tightening now (no existing theme has ever used one) and a
// backwards-compatible loosening later if a real need appears.
export const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const HexColor = z.string().regex(HEX_COLOR_RE, "必须是严格的 hex 颜色值");

// The 17 color tokens a theme must define (docs/DESIGN.md v3.1 table).
// Order here is the canonical token order used by apply.ts when
// iterating — kept as a const array (not just object keys) so tests
// and applyTheme can both rely on a single source of truth.
export const THEME_TOKEN_KEYS = [
  "ink",
  "panel",
  "panel2",
  "panel3",
  "edge",
  "edge2",
  "fg",
  "mut",
  "mut2",
  "lab-red",
  "lab-orange",
  "lab-yellow",
  "lab-green",
  "lab-purple",
  "lab-cyan",
  "act",
  "warn-soft",
] as const;

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];

export type ThemeTokens = Record<ThemeTokenKey, string>;

const ThemeTokensSchema = z.object({
  ink: HexColor,
  panel: HexColor,
  panel2: HexColor,
  panel3: HexColor,
  edge: HexColor,
  edge2: HexColor,
  fg: HexColor,
  mut: HexColor,
  mut2: HexColor,
  "lab-red": HexColor,
  "lab-orange": HexColor,
  "lab-yellow": HexColor,
  "lab-green": HexColor,
  "lab-purple": HexColor,
  "lab-cyan": HexColor,
  act: HexColor,
  "warn-soft": HexColor,
}) satisfies z.ZodType<ThemeTokens>;

export interface ThemeDefinition {
  id: string;
  label: string; // zh display name for the settings picker
  tokens: ThemeTokens;
}

export const ThemeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  tokens: ThemeTokensSchema,
}) satisfies z.ZodType<ThemeDefinition>;

/** Validate an unknown value as a ThemeDefinition. Never throws — a
 *  malformed/malicious theme is rejected via the returned union
 *  instead of an exception, matching the fetch-then-validate pattern
 *  external theme sources will eventually use (remotePacks.ts's
 *  validateManifest is the precedent, though that one throws; a theme
 *  has no partial/lenient-drop mode — one bad token fails the whole
 *  theme, since a half-applied color set is worse than none). */
export function parseTheme(
  raw: unknown,
): { ok: true; theme: ThemeDefinition } | { ok: false; error: string } {
  const result = ThemeSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, theme: result.data };
  }
  return { ok: false, error: result.error.issues[0]?.message ?? "主题格式不正确" };
}
