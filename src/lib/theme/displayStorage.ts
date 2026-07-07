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

/** Source string for the inline pre-hydration <script> in layout.tsx.
 *  Kept as a template string (not a bundled module import) because it
 *  must run synchronously in <head>, before any JS bundle loads —
 *  see layout.tsx for how this is embedded via dangerouslySetInnerHTML.
 *  Re-implements the same read-key/parse/try-catch logic as
 *  readDisplayMirror() above (can't import a TS module into a raw
 *  inline script) and additionally imports the two built-in themes'
 *  token maps inline so it can call setProperty before paint without
 *  waiting for the app bundle. */
export function buildFoucScript(themeTokensById: Record<string, Record<string, string>>): string {
  const themesJson = JSON.stringify(themeTokensById);
  return `(function(){try{
    var raw = window.localStorage.getItem(${JSON.stringify(DISPLAY_STORAGE_KEY)});
    var mirror = raw ? JSON.parse(raw) : null;
    var themeId = (mirror && typeof mirror.themeId === "string") ? mirror.themeId : "terminal";
    var fontSize = (mirror && ["sm","md","lg","xl"].indexOf(mirror.fontSize) !== -1) ? mirror.fontSize : "md";
    var root = document.documentElement;
    root.dataset.fs = fontSize;
    var themes = ${themesJson};
    if (themeId !== "terminal" && themes[themeId]) {
      var tokens = themes[themeId];
      for (var key in tokens) {
        if (Object.prototype.hasOwnProperty.call(tokens, key)) {
          root.style.setProperty("--" + key, tokens[key]);
        }
      }
      root.dataset.theme = themeId;
    } else {
      root.dataset.theme = "terminal";
    }
  }catch(e){}})();`;
}
