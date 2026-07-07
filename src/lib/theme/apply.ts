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
// `--bl` is deliberately never touched here (see schema.ts) — it stays
// pinned to the CSS-authored value.

import { THEME_TOKEN_KEYS, type ThemeTokens } from "./schema";

const CSS_VAR_PREFIX = "--";

function cssVarName(token: string): string {
  return `${CSS_VAR_PREFIX}${token}`;
}

/** Apply a theme's tokens onto `document.documentElement` and stamp
 *  `dataset.theme` for CSS selectors keyed off `[data-theme="…"]`.
 *  `themeId` is passed separately from `tokens` (rather than requiring
 *  a full ThemeDefinition) so callers that already have a validated
 *  ThemeTokens map — e.g. the FOUC inline script's own copy — don't
 *  need to reconstruct one. No-ops outside a browser (SSR safety). */
export function applyTheme(themeId: string, tokens: ThemeTokens): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const key of THEME_TOKEN_KEYS) {
    root.style.setProperty(cssVarName(key), tokens[key]);
  }
  root.dataset.theme = themeId;
}

/** Revert to the terminal default: remove every inline token override
 *  (so the CSS-authored `:root, [data-theme="terminal"]` values in
 *  globals.css apply again) and reset `dataset.theme` to "terminal".
 *  Safe to call even if no theme was ever applied (removeProperty on
 *  an unset property is a no-op). */
export function resetToDefaultTheme(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const key of THEME_TOKEN_KEYS) {
    root.style.removeProperty(cssVarName(key));
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
