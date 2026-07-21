// Display-settings localStorage mirror (v0.2.1 FOUC fix). The
// authoritative copy of themeId/fontSize lives in Settings, persisted
// through IndexedDB via lib/history/storage.ts like every other
// setting — but IndexedDB reads are async, so the very first paint
// would otherwise flash the default (terminal / md) before hydrate()
// resolves. This module keeps a tiny synchronous SHADOW copy in
// localStorage under one JSON key, written every time updateSettings
// touches themeId/fontSize (see store.ts) and read by the inline
// pre-hydration script in layout.tsx (next-themes-style pattern, hand-
// rolled — see that file for why no library is used).
//
// v0.5.1 appearance sprint: the mirror now ALSO carries a custom
// theme's own token map (when the active theme is a `custom-`-prefixed
// one — the FOUC script has no access to the async-loaded
// Settings.customThemes, so the active custom theme's tokens are
// duplicated here, same reasoning as the builtin registry being
// embedded into buildFoucScript at build time) and pre-resolved
// uiFont/monoFont CSS font-family stacks (NOT preset ids — the FOUC
// script never needs lib/theme/fonts.ts's preset registry at all this
// way). Every one of these is USER-INFLUENCED data (a custom theme's
// hex values, a free-typed custom font family) reaching a raw inline
// <script>, so every value is guarded by a strict pattern immediately
// before its one and only use (setProperty) — belt-and-suspenders on
// top of the fact that setProperty itself can never be escaped into a
// new declaration/selector (see apply.ts's own module comment); a
// value that fails its guard is simply skipped, never thrown on.
//
// try/catch everywhere: localStorage can throw (private browsing,
// disabled storage, quota) — every read/write here fails silently
// back to the built-in default rather than crashing the app.

import { darkenHex, hexToRgbTriplet } from "./apply";
import { HEX_COLOR_RE, THEME_TOKEN_KEYS, type ThemeDefinition } from "./schema";

const DISPLAY_STORAGE_KEY = "js-display";

// Conservative allowlist for a resolved font-family CSS value (see
// lib/theme/fonts.ts's resolveFontStack, which is what actually
// produces these strings before they ever reach the mirror): plain
// ASCII letters/digits/space/comma/hyphen/quote only — enough for
// every preset stack and a sanitizeFontFamily-cleaned custom family
// wrapped in quotes, deliberately NOT enough for `var(--font-mono-
// brand)`'s parens (the one resolved shape this rejects: a CUSTOM
// monoFont's fallback chain, which threads through the brand var —
// see fonts.ts's own doc). That specific combination just skips the
// FOUC pre-paint set and renders one frame of the CSS-authored default
// mono stack (itself `var(--font-mono-brand), …`, i.e. visually
// almost the same thing minus the user's own family prepended) until
// hydrate() applies the real value — an acceptable, self-healing
// trade for keeping this allowlist simple. Cap 256 (not the 60 a
// single sanitizeFontFamily family name is capped to) — a resolved
// stack is a QUOTED family plus a full fallback chain appended, which
// can run past 200 chars in the worst case (60-char family + the
// ~140-char UI default chain), so the cap here is sized for the
// resolved OUTPUT, not the raw family input.
export const FONT_STACK_RE = /^[a-zA-Z0-9 ,\-"]{1,256}$/;

// Bare "R G B" triplet only (hexToRgbTriplet's own output shape) — see
// module comment above on why this exists at all despite setProperty
// being injection-proof either way.
export const RGB_TRIPLET_RE = /^\d{1,3} \d{1,3} \d{1,3}$/;

export interface DisplayMirror {
  themeId: string;
  fontSize: "sm" | "md" | "lg" | "xl";
  /** Present only when themeId is a `custom-`-prefixed theme — see
   *  module comment above. rgb is pre-derived at WRITE time
   *  (store.ts, via hexToRgbTriplet) so the FOUC script itself never
   *  parses a hex value, same "dumb script" posture as the builtin
   *  FoucThemePayload below. `phos`/`phosDim` (F9, v0.5.1): the same
   *  --bit-phos/--bit-phos-dim pair apply.ts's applyTheme derives from
   *  a theme's own lab-green (D7), pre-derived here at write time (via
   *  darkenHex — same helper, no duplicated math) so a themed reload
   *  doesn't flash the terminal-default mascot green pre-hydration.
   *  Both optional: a mirror written before this landed simply omits
   *  them (self-heals on the next hydrate — never a reason to reject
   *  the rest of the payload). */
  custom?: {
    hex: Record<string, string>;
    rgb: Record<string, string>;
    scheme: ThemeDefinition["scheme"];
    phos?: string;
    phosDim?: string;
  };
  /** Pre-resolved CSS font-family stacks (never a preset id) for a
   *  non-"default" uiFont/monoFont — see lib/theme/fonts.ts's
   *  resolveFontStack. Absent = no override (the "default" preset). */
  uiFont?: string;
  monoFont?: string;
}

export const DEFAULT_DISPLAY_MIRROR: DisplayMirror = {
  themeId: "terminal",
  fontSize: "md",
};

function isFontSizeTier(v: unknown): v is DisplayMirror["fontSize"] {
  return v === "sm" || v === "md" || v === "lg" || v === "xl";
}

/** A plain (non-array) object whose own values are all strings — the
 *  shape both custom.hex and custom.rgb must have. Deliberately loose
 *  about the KEYS (a custom theme's token set is whatever schema.ts's
 *  THEME_TOKEN_KEYS was at save time; this mirror doesn't re-validate
 *  that list, only that nothing here could smuggle a non-string value
 *  through to the hex/rgb regex guards downstream, which operate on
 *  strings). */
function isPlainStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every((entry) => typeof entry === "string");
}

/** Keep only the 17 legitimate theme-token keys from an untrusted
 *  string record, dropping everything else (F8 adversarial review): a
 *  hand-tampered `js-display` localStorage payload could otherwise
 *  smuggle an arbitrary key — e.g. `--font-mono-brand`, a REAL CSS
 *  variable this app already uses elsewhere — through to setProperty.
 *  Chosen posture: drop the unknown keys rather than reject the whole
 *  payload (matching schema.ts's own ThemeTokensSchema, whose default
 *  zod `strip` behavior already does exactly this for every OTHER
 *  entry point a theme's tokens flow through) — a payload with one
 *  stray key alongside otherwise-legitimate tokens still themes
 *  correctly, just without the stray property. */
function pickAllowedTokenKeys(v: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of THEME_TOKEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(v, key)) out[key] = v[key];
  }
  return out;
}

/** Validate an untrusted `custom` payload from the mirror's raw JSON:
 *  hex/rgb must both be plain string-valued objects, scheme must be
 *  exactly "dark"|"light" — any deviation drops the WHOLE payload
 *  (undefined) rather than keeping a partially-shaped one, same "one
 *  bad field fails the whole thing" posture as schema.ts's parseTheme
 *  (a half-applied custom theme is worse than none: the FOUC script's
 *  fallback for "no custom payload" is the builtin lookup, which for a
 *  `custom-` id just renders terminal for one frame — self-heals the
 *  moment hydrate() re-derives and re-writes the mirror from the
 *  authoritative Settings.customThemes). Keys within an otherwise-sane
 *  hex/rgb shape are separately allow-listed (pickAllowedTokenKeys,
 *  F8) rather than gated here — that's a per-KEY filter, not a
 *  shape check. `phos`/`phosDim` (F9) are independently optional: kept
 *  only when present as a string, never a reason to reject hex/rgb/
 *  scheme — the actual hex-format check happens at the FOUC script's
 *  own setProperty guard (belt-and-suspenders, same posture as every
 *  other value here), not this shape-level reader. */
function readCustomPayload(raw: unknown): DisplayMirror["custom"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  if (!isPlainStringRecord(c.hex) || !isPlainStringRecord(c.rgb)) return undefined;
  if (c.scheme !== "dark" && c.scheme !== "light") return undefined;
  const custom: DisplayMirror["custom"] = {
    hex: pickAllowedTokenKeys(c.hex),
    rgb: pickAllowedTokenKeys(c.rgb),
    scheme: c.scheme,
  };
  if (typeof c.phos === "string") custom.phos = c.phos;
  if (typeof c.phosDim === "string") custom.phosDim = c.phosDim;
  return custom;
}

/** Best-effort read of the mirror; any failure (missing key, disabled
 *  storage, malformed JSON, wrong shape) silently falls back to the
 *  default rather than throwing — this is read on every page load
 *  before hydration, so it must never be the thing that breaks paint.
 *  `custom` gets its own shape validation (readCustomPayload); uiFont/
 *  monoFont are only kept when they're a string within FONT_STACK_RE's
 *  length budget (256 — see that const's own doc; NOT content-matched
 *  against FONT_STACK_RE here, only length-capped — the regex content
 *  check is buildFoucScript's own job, run again there since this
 *  reader and the embedded script are two independent implementations
 *  of "read the same localStorage key", per this module's existing
 *  "can't import a TS module into a raw inline script" constraint). */
export function readDisplayMirror(): DisplayMirror {
  try {
    const raw = window.localStorage.getItem(DISPLAY_STORAGE_KEY);
    if (!raw) return DEFAULT_DISPLAY_MIRROR;
    const parsed = JSON.parse(raw) as Partial<DisplayMirror> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_DISPLAY_MIRROR;
    const mirror: DisplayMirror = {
      themeId: typeof parsed.themeId === "string" ? parsed.themeId : DEFAULT_DISPLAY_MIRROR.themeId,
      fontSize: isFontSizeTier(parsed.fontSize) ? parsed.fontSize : DEFAULT_DISPLAY_MIRROR.fontSize,
    };
    const custom = readCustomPayload(parsed.custom);
    if (custom) mirror.custom = custom;
    if (typeof parsed.uiFont === "string" && parsed.uiFont.length <= 256) {
      mirror.uiFont = parsed.uiFont;
    }
    if (typeof parsed.monoFont === "string" && parsed.monoFont.length <= 256) {
      mirror.monoFont = parsed.monoFont;
    }
    return mirror;
  } catch {
    return DEFAULT_DISPLAY_MIRROR;
  }
}

/** Best-effort write, called from store.ts's updateSettings whenever
 *  themeId/fontSize/customThemes/uiFont/monoFont change. Never throws. */
export function writeDisplayMirror(mirror: DisplayMirror): void {
  try {
    window.localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(mirror));
  } catch {
    // non-fatal — the mirror is a fast-path optimization, not the
    // source of truth (IndexedDB-backed Settings still hydrates
    // normally and will re-render with the correct value regardless).
  }
}

/** Per-theme payload embedded in the FOUC script: the original hex
 *  token map (for the "--token" variables hand-written CSS reads) plus
 *  its pre-derived "-rgb" triplet sibling map (for the "--token-rgb"
 *  variables tailwind.config.ts's `rgb(var(--*-rgb) / <alpha-value>)`
 *  colors resolve through — see apply.ts's module comment for why
 *  BOTH must be set). Computed once at buildFoucScript() call time
 *  (module scope in layout.tsx, i.e. build/server-render time, not
 *  inside the emitted browser script) so the inline <script> itself
 *  only ever does property lookups + setProperty calls — no hex
 *  parsing/arithmetic at runtime, keeping it as small and "dumb" as
 *  possible for something that must run before first paint. */
interface FoucThemePayload {
  hex: Record<string, string>;
  rgb: Record<string, string>;
  scheme: ThemeDefinition["scheme"];
  /** F9: pre-derived --bit-phos/--bit-phos-dim pair (Bit's phosphor
   *  green, D7), same darkenHex(...,0.55) apply.ts's applyTheme uses.
   *  Optional: `themes` here is a minimal structural type (not a full
   *  ThemeTokens), so a caller (chiefly tests) may pass a token map
   *  with no "lab-green" key at all — computing this is skipped rather
   *  than crashing on a missing key, and the emitted script's own
   *  hex-regex guard (same guard the custom branch already uses) is
   *  what actually keeps a missing/undefined value from ever reaching
   *  setProperty at runtime. */
  phos?: string;
  phosDim?: string;
}

/** Source string for the inline pre-hydration <script> in layout.tsx.
 *  Kept as a template string (not a bundled module import) because it
 *  must run synchronously in <head>, before any JS bundle loads —
 *  see layout.tsx for how this is embedded via dangerouslySetInnerHTML.
 *  Re-implements the same read-key/parse/try-catch logic as
 *  readDisplayMirror() above (can't import a TS module into a raw
 *  inline script) and additionally embeds every built-in theme's
 *  token map (hex + pre-derived rgb triplets + scheme, see
 *  FoucThemePayload) inline so it can call setProperty and stamp
 *  data-theme/data-scheme before paint without waiting for the app
 *  bundle.
 *
 *  v0.5.1: two more branches, both reading straight off the mirror
 *  (never the embedded builtin payload): (1) a `custom-`-prefixed
 *  themeId with a present `mirror.custom` payload sets every token
 *  from custom.hex/rgb INSTEAD of the builtin lookup — each value
 *  individually re-validated against the embedded hex/rgb regexes
 *  (HEX_RE/RGB_RE below, sourced from this module's own HEX_COLOR_RE/
 *  RGB_TRIPLET_RE so the pattern can never drift from the one
 *  readCustomPayload-adjacent code elsewhere relies on) before
 *  setProperty — a value that fails is just skipped, matching
 *  readCustomPayload's "don't trust, don't throw" posture one layer
 *  further in. The custom branch iterates the embedded 17-token
 *  allowlist (TOKEN_KEYS below, sourced from schema.ts's own
 *  THEME_TOKEN_KEYS) rather than the payload's own keys (F8
 *  adversarial review) — a hand-tampered localStorage payload can
 *  carry an arbitrary key alongside legitimate ones, and iterating the
 *  payload's keys directly would call setProperty for that key too
 *  regardless of the value regex passing; reading `chex[key]` for each
 *  ALLOWLISTED key instead means an unknown key never gets looked up,
 *  let alone set. Any OTHER themeId (including a `custom-` one with no
 *  mirror.custom at all — see readCustomPayload's own doc on why that
 *  self-heals) falls through to the existing builtin-only path
 *  unchanged. (2) mirror.uiFont/monoFont, each independently
 *  setProperty'd only if it passes the embedded FONT_RE (this
 *  module's FONT_STACK_RE) — orthogonal to which theme branch ran
 *  above, since fonts are a separate setting from theme (schema.ts's
 *  own "fonts are never part of a theme" boundary). */
export function buildFoucScript(
  // Structurally just id + scheme + a token map (not Pick<ThemeDefinition>,
  // whose `tokens` would demand every key): the builder iterates whatever
  // tokens it's handed, which also keeps tests free to pass minimal maps.
  themes: ReadonlyArray<{
    id: string;
    scheme: ThemeDefinition["scheme"];
    tokens: Record<string, string>;
  }>,
): string {
  const payload: Record<string, FoucThemePayload> = {};
  for (const { id, scheme, tokens } of themes) {
    const rgb: Record<string, string> = {};
    for (const [key, hex] of Object.entries(tokens)) {
      rgb[key] = hexToRgbTriplet(hex);
    }
    const entry: FoucThemePayload = { hex: tokens, rgb, scheme };
    const labGreen = tokens["lab-green"];
    if (typeof labGreen === "string") {
      entry.phos = labGreen;
      entry.phosDim = darkenHex(labGreen, 0.55);
    }
    payload[id] = entry;
  }
  const themesJson = JSON.stringify(payload);
  return `(function(){try{
    var raw = window.localStorage.getItem(${JSON.stringify(DISPLAY_STORAGE_KEY)});
    var mirror = raw ? JSON.parse(raw) : null;
    var themeId = (mirror && typeof mirror.themeId === "string") ? mirror.themeId : "terminal";
    var fontSize = (mirror && ["sm","md","lg","xl"].indexOf(mirror.fontSize) !== -1) ? mirror.fontSize : "md";
    var root = document.documentElement;
    root.dataset.fs = fontSize;
    var HEX_RE = new RegExp(${JSON.stringify(HEX_COLOR_RE.source)});
    var RGB_RE = new RegExp(${JSON.stringify(RGB_TRIPLET_RE.source)});
    var FONT_RE = new RegExp(${JSON.stringify(FONT_STACK_RE.source)});
    var TOKEN_KEYS = ${JSON.stringify(THEME_TOKEN_KEYS)};
    if (themeId.indexOf("custom-") === 0 && mirror && mirror.custom && mirror.custom.hex && typeof mirror.custom.hex === "object") {
      var chex = mirror.custom.hex, crgb = mirror.custom.rgb || {};
      for (var ti = 0; ti < TOKEN_KEYS.length; ti++) {
        var ckey = TOKEN_KEYS[ti];
        if (Object.prototype.hasOwnProperty.call(chex, ckey) && HEX_RE.test(chex[ckey])) {
          root.style.setProperty("--" + ckey, chex[ckey]);
          if (RGB_RE.test(crgb[ckey])) root.style.setProperty("--" + ckey + "-rgb", crgb[ckey]);
        }
      }
      if (HEX_RE.test(mirror.custom.phos)) root.style.setProperty("--bit-phos", mirror.custom.phos);
      if (HEX_RE.test(mirror.custom.phosDim)) root.style.setProperty("--bit-phos-dim", mirror.custom.phosDim);
      root.dataset.theme = themeId;
      root.dataset.scheme = mirror.custom.scheme === "light" ? "light" : "dark";
    } else {
      var themes = ${themesJson};
      if (themeId !== "terminal" && themes[themeId]) {
        var theme = themes[themeId];
        var hex = theme.hex, rgb = theme.rgb;
        for (var key in hex) {
          if (Object.prototype.hasOwnProperty.call(hex, key)) {
            root.style.setProperty("--" + key, hex[key]);
            root.style.setProperty("--" + key + "-rgb", rgb[key]);
          }
        }
        if (HEX_RE.test(theme.phos)) root.style.setProperty("--bit-phos", theme.phos);
        if (HEX_RE.test(theme.phosDim)) root.style.setProperty("--bit-phos-dim", theme.phosDim);
        root.dataset.theme = themeId;
        root.dataset.scheme = theme.scheme === "light" ? "light" : "dark";
      } else {
        root.dataset.theme = "terminal";
        root.dataset.scheme = "dark";
      }
    }
    if (mirror && typeof mirror.uiFont === "string" && FONT_RE.test(mirror.uiFont)) {
      root.style.setProperty("--font-ui", mirror.uiFont);
    }
    if (mirror && typeof mirror.monoFont === "string" && FONT_RE.test(mirror.monoFont)) {
      root.style.setProperty("--font-mono-user", mirror.monoFont);
    }
  }catch(e){}})();`;
}
