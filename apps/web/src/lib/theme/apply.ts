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

import { THEME_TOKEN_KEYS, type ThemeScheme, type ThemeTokens } from "./schema";

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

/** Scale a validated (schema.ts HEX_COLOR_RE, 3- or 6-digit) hex
 *  color's RGB channels toward black by `factor` (0..1 — 0.55 keeps
 *  55% of each channel's original value) and re-encode as a 6-digit
 *  lowercase hex string, each channel individually rounded then
 *  clamped to 0-255 (defensive — a factor outside 0..1 can't corrupt
 *  the output width). Pure, no DOM involvement, same posture as
 *  hexToRgbTriplet above — used by applyTheme below to derive
 *  `--bit-phos-dim` from a theme's own lab-green (D7) without adding a
 *  second color to the 17-token contract. */
export function darkenHex(hex: string, factor: number): string {
  let h = hex.slice(1);
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const scale = (channel: number) =>
    Math.max(0, Math.min(255, Math.round(channel * factor)));
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  const r = scale(parseInt(h.slice(0, 2), 16));
  const g = scale(parseInt(h.slice(2, 4), 16));
  const b = scale(parseInt(h.slice(4, 6), 16));
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
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
export function applyTheme(themeId: string, tokens: ThemeTokens, scheme: ThemeScheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const key of THEME_TOKEN_KEYS) {
    const value = tokens[key];
    root.style.setProperty(cssVarName(key), value);
    root.style.setProperty(rgbVarName(key), hexToRgbTriplet(value));
  }
  root.dataset.theme = themeId;
  root.dataset.scheme = scheme;
  syncThemeColorMeta(tokens.ink);
  // D7 (v0.5.1): Bit (PixelDragon.tsx) reads `var(--bit-phos, #4ADE80)`/
  // `--bit-phos-dim` directly rather than a lab-* token — it predates
  // the theme engine, and globals.css's own [data-scheme="light"]
  // override hand-tunes exactly these two CSS-authored values for
  // terminal-light only. Every theme (builtin or custom) now gets a
  // pair derived HERE instead: --bit-phos is the theme's own lab-green
  // verbatim, --bit-phos-dim is that same hue darkened toward black
  // (darkenHex, ×0.55). Since this setProperty call is inline style, it
  // wins over globals.css's rule for terminal-light too — its derived
  // pair (from lab-green #137038) is only an "acceptable drift" cousin
  // of that CSS-authored #15803d/#86b598 (blueprint D7), not identical;
  // the CSS rule itself is left in place as the pre-hydration/no-JS
  // fallback, same relationship every other token has with globals.css.
  root.style.setProperty("--bit-phos", tokens["lab-green"]);
  root.style.setProperty("--bit-phos-dim", darkenHex(tokens["lab-green"], 0.55));
}

/** Keep the mobile browser-chrome color (<meta name="theme-color">,
 *  emitted by layout.tsx's viewport export) in step with the active
 *  theme's page background — without this, a light theme renders under
 *  a stranded dark address bar on mobile. setAttribute with a schema-
 *  validated hex only (never interpolated into markup); silently a
 *  no-op if the tag is absent. */
function syncThemeColorMeta(ink: string): void {
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", ink);
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
  // D7 (v0.5.1): mirror of applyTheme's own --bit-phos/--bit-phos-dim
  // setProperty pair — removing them lets globals.css's CSS-authored
  // defaults (the dark-scheme fallback baked into PixelDragon.tsx's own
  // `var(--bit-phos, #4ADE80)` plus the [data-scheme="light"] override)
  // take back over, same "terminal keeps CSS defaults" contract every
  // other token already has.
  root.style.removeProperty("--bit-phos");
  root.style.removeProperty("--bit-phos-dim");
  root.dataset.theme = "terminal";
  root.dataset.scheme = "dark";
  // Terminal's ink is CSS-authored in globals.css, never injected —
  // mirror that one value here (same 1:1 posture as themes.ts's
  // TERMINAL_THEME declaration) so the meta tag can follow the reset.
  syncThemeColorMeta("#0a0a0a");
}

/** Convenience dispatcher: applying "terminal" always goes through
 *  resetToDefaultTheme() (clears any prior overrides rather than
 *  re-injecting values CSS already provides); any other theme id goes
 *  through applyTheme() with its tokens + scheme. */
export function activateTheme(
  themeId: string,
  tokens: ThemeTokens,
  scheme: ThemeScheme,
): void {
  if (themeId === "terminal") {
    resetToDefaultTheme();
    return;
  }
  applyTheme(themeId, tokens, scheme);
}
