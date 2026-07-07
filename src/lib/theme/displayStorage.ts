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
// try/catch everywhere: localStorage can throw (private browsing,
// disabled storage, quota) — every read/write here fails silently
// back to the built-in default rather than crashing the app.

import { hexToRgbTriplet } from "./apply";

const DISPLAY_STORAGE_KEY = "js-display";

export interface DisplayMirror {
  themeId: string;
  fontSize: "sm" | "md" | "lg" | "xl";
}

export const DEFAULT_DISPLAY_MIRROR: DisplayMirror = {
  themeId: "terminal",
  fontSize: "md",
};

function isFontSizeTier(v: unknown): v is DisplayMirror["fontSize"] {
  return v === "sm" || v === "md" || v === "lg" || v === "xl";
}

/** Best-effort read of the mirror; any failure (missing key, disabled
 *  storage, malformed JSON, wrong shape) silently falls back to the
 *  default rather than throwing — this is read on every page load
 *  before hydration, so it must never be the thing that breaks paint. */
export function readDisplayMirror(): DisplayMirror {
  try {
    const raw = window.localStorage.getItem(DISPLAY_STORAGE_KEY);
    if (!raw) return DEFAULT_DISPLAY_MIRROR;
    const parsed = JSON.parse(raw) as Partial<DisplayMirror> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_DISPLAY_MIRROR;
    return {
      themeId: typeof parsed.themeId === "string" ? parsed.themeId : DEFAULT_DISPLAY_MIRROR.themeId,
      fontSize: isFontSizeTier(parsed.fontSize) ? parsed.fontSize : DEFAULT_DISPLAY_MIRROR.fontSize,
    };
  } catch {
    return DEFAULT_DISPLAY_MIRROR;
  }
}

/** Best-effort write, called from store.ts's updateSettings whenever
 *  themeId/fontSize change. Never throws. */
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
}

/** Source string for the inline pre-hydration <script> in layout.tsx.
 *  Kept as a template string (not a bundled module import) because it
 *  must run synchronously in <head>, before any JS bundle loads —
 *  see layout.tsx for how this is embedded via dangerouslySetInnerHTML.
 *  Re-implements the same read-key/parse/try-catch logic as
 *  readDisplayMirror() above (can't import a TS module into a raw
 *  inline script) and additionally embeds the two built-in themes'
 *  token maps (hex + pre-derived rgb triplets, see FoucThemePayload)
 *  inline so it can call setProperty before paint without waiting for
 *  the app bundle. */
export function buildFoucScript(themeTokensById: Record<string, Record<string, string>>): string {
  const payload: Record<string, FoucThemePayload> = {};
  for (const [themeId, tokens] of Object.entries(themeTokensById)) {
    const rgb: Record<string, string> = {};
    for (const [key, hex] of Object.entries(tokens)) {
      rgb[key] = hexToRgbTriplet(hex);
    }
    payload[themeId] = { hex: tokens, rgb };
  }
  const themesJson = JSON.stringify(payload);
  return `(function(){try{
    var raw = window.localStorage.getItem(${JSON.stringify(DISPLAY_STORAGE_KEY)});
    var mirror = raw ? JSON.parse(raw) : null;
    var themeId = (mirror && typeof mirror.themeId === "string") ? mirror.themeId : "terminal";
    var fontSize = (mirror && ["sm","md","lg","xl"].indexOf(mirror.fontSize) !== -1) ? mirror.fontSize : "md";
    var root = document.documentElement;
    root.dataset.fs = fontSize;
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
      root.dataset.theme = themeId;
    } else {
      root.dataset.theme = "terminal";
    }
  }catch(e){}})();`;
}
