// Theme application (SECURITY-CRITICAL). Applying a theme means
// setting CSS custom properties one token at a time via the CSSOM
// (`style.setProperty`) — never string-concatenating a `<style>` tag
// or touching `innerHTML`. `CSSStyleDeclaration.setProperty` only
// accepts a property name + a value; there is no way for a value
// string to "escape" into a new declaration, selector, or `<script>`
// the way naive `<style>${css}</style>` interpolation could. Reverting
// to the terminal default is the mirror operation: `removeProperty`
// for every token, letting the CSS-authored `:root, [data-theme=
// "terminal"]` block in globals.css take back over — terminal is
// never "injected", only ever the fallback once the inline overrides
// are gone.
//
// v0.2.1 INTEGRATION FIX: tailwind.config.ts's utilities (text-fg,
// bg-panel, border-edge, ...) do NOT read the hex variable below —
// they resolve through a SIBLING "-rgb" variable holding a bare "R G
// B" triplet (see globals.css's comment + tailwind.config.ts's
// `rgb(var(--*-rgb) / <alpha-value>)` colors). So every token gets
// BOTH variables set together here: the hex form (for hand-written CSS
// in globals.css, e.g. .hl-expr/.btn-terminal) and the "-rgb" triplet
// (for every Tailwind-generated utility class — the vast majority of
// the app's actual colored surface). Only setting the hex one would
// silently leave Tailwind's classes on the old theme's dead colors.
//
// `--bl` is deliberately never touched here (see schema.ts) — it stays
// pinned to the CSS-authored value.

import { THEME_TOKEN_KEYS, type ThemeTokens } from "./schema";

const CSS_VAR_PREFIX = "--";

function cssVarName(token: string): string {
  return `${CSS_VAR_PREFIX}${token}`;
}

function rgbVarName(token: string): string {
  return `${CSS_VAR_PREFIX}${token}-rgb`;
}

/** Expands a validated (schema.ts HEX_COLOR_RE, 3- or 6-digit only —
 *  alpha forms are rejected at validation time, see schema.ts's
 *  comment on why) hex color into a bare "R G B" triplet string, e.g.
 *  "#0a0a0a" -> "10 10 10", "#fff" -> "255 255 255". This is the ONLY
 *  place theme hex values are parsed as numbers; the result is always
 *  handed to `setProperty` as a plain space-separated numeric string,
 *  never interpolated into a larger CSS/HTML string. */
export function hexToRgbTriplet(hex: string): string {
  let h = hex.slice(1); // drop '#'
  if (h.length === 3) {
    // short form "abc" -> "aabbcc" (each digit doubled)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

/** Apply a theme's tokens onto `document.documentElement` and stamp
 *  `dataset.theme` for CSS selectors keyed off `[data-theme="…"]`.
 *  Sets BOTH the hex variable and its "-rgb" triplet sibling for every
 *  token (see module comment above — Tailwind utilities read the
 *  triplet, hand-written CSS reads the hex). `themeId` is passed
 *  separately from `tokens` (rather than requiring a full
 *  ThemeDefinition) so callers that already have a validated
 *  ThemeTokens map — e.g. the FOUC inline script's own copy — don't
 *  need to reconstruct one. No-ops outside a browser (SSR safety). */
export function applyTheme(themeId: string, tokens: ThemeTokens): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const key of THEME_TOKEN_KEYS) {
    const value = tokens[key];
    root.style.setProperty(cssVarName(key), value);
    root.style.setProperty(rgbVarName(key), hexToRgbTriplet(value));
  }
  root.dataset.theme = themeId;
}

/** Revert to the terminal default: remove every inline token override
 *  (both the hex and "-rgb" variables — see module comment) so the
 *  CSS-authored `:root, [data-theme="terminal"]` values in globals.css
 *  apply again, and reset `dataset.theme` to "terminal". Safe to call
 *  even if no theme was ever applied (removeProperty on an unset
 *  property is a no-op). */
export function resetToDefaultTheme(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const key of THEME_TOKEN_KEYS) {
    root.style.removeProperty(cssVarName(key));
    root.style.removeProperty(rgbVarName(key));
  }
  root.dataset.theme = "terminal";
}

/** Convenience dispatcher: applying "terminal" always goes through
 *  resetToDefaultTheme() (clears any prior overrides rather than
 *  re-injecting values CSS already provides); any other theme id goes
 *  through applyTheme() with its tokens. */
export function activateTheme(themeId: string, tokens: ThemeTokens): void {
  if (themeId === "terminal") {
    resetToDefaultTheme();
    return;
  }
  applyTheme(themeId, tokens);
}
