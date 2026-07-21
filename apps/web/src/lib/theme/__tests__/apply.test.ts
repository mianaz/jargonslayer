// @vitest-environment jsdom
//
// Theme injection is CSSOM-only (setProperty/removeProperty on
// document.documentElement.style) — this file needs a real `document`
// to assert against, unlike the rest of the suite (vitest.config.ts's
// default `environment: "node"`). The docblock above overrides the
// environment for just this file; nothing else in the project needs
// jsdom, so the global config is left untouched.

import { beforeEach, describe, expect, it } from "vitest";
import { activateTheme, applyTheme, darkenHex, hexToRgbTriplet, resetToDefaultTheme } from "../apply";
import { THEME_TOKEN_KEYS, type ThemeTokens } from "../schema";
import { CLARITY_THEME, TERMINAL_LIGHT_THEME, TERMINAL_THEME } from "../themes";

function cssVar(name: string): string {
  return document.documentElement.style.getPropertyValue(`--${name}`);
}

function cssRgbVar(name: string): string {
  return document.documentElement.style.getPropertyValue(`--${name}-rgb`);
}

beforeEach(() => {
  // Clean slate: strip any inline tokens/dataset a previous test left
  // behind, since all tests share the same jsdom `document`.
  for (const key of THEME_TOKEN_KEYS) {
    document.documentElement.style.removeProperty(`--${key}`);
    document.documentElement.style.removeProperty(`--${key}-rgb`);
  }
  // v0.5.1 D7: Bit's phosphor vars, same cleanup posture as every
  // token above.
  document.documentElement.style.removeProperty("--bit-phos");
  document.documentElement.style.removeProperty("--bit-phos-dim");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.scheme;
  document.querySelector('meta[name="theme-color"]')?.remove();
});

describe("hexToRgbTriplet", () => {
  it("expands a 6-digit hex to a bare 'R G B' triplet", () => {
    expect(hexToRgbTriplet("#0a0a0a")).toBe("10 10 10");
    expect(hexToRgbTriplet("#ffffff")).toBe("255 255 255");
    expect(hexToRgbTriplet("#ededed")).toBe("237 237 237");
  });

  it("expands a 3-digit short hex by doubling each digit", () => {
    expect(hexToRgbTriplet("#fff")).toBe("255 255 255");
    expect(hexToRgbTriplet("#000")).toBe("0 0 0");
    expect(hexToRgbTriplet("#0a1")).toBe("0 170 17"); // 00 aa 11
  });

  it("is case-insensitive", () => {
    expect(hexToRgbTriplet("#FFFFFF")).toBe("255 255 255");
    expect(hexToRgbTriplet("#AbC")).toBe(hexToRgbTriplet("#aabbcc"));
  });
});

describe("applyTheme", () => {
  it("sets every token's hex variable via CSSOM setProperty, not a <style> string", () => {
    applyTheme(CLARITY_THEME.id, CLARITY_THEME.tokens, CLARITY_THEME.scheme);
    for (const key of THEME_TOKEN_KEYS) {
      expect(cssVar(key)).toBe(CLARITY_THEME.tokens[key]);
    }
    // No <style> tag was ever created by applyTheme itself.
    expect(document.head.querySelector("style[data-theme-injected]")).toBeNull();
  });

  // v0.2.1 integration fix: Tailwind's generated utilities (text-fg,
  // bg-panel, ...) read the "-rgb" triplet variable, NOT the hex one —
  // applyTheme must set both or the entire Tailwind-classed UI stays
  // on the previous theme's dead colors while only hand-written CSS
  // recolors. This is the regression the ship-blocking review caught.
  it("ALSO sets every token's -rgb triplet variable, derived from the same hex value", () => {
    applyTheme(CLARITY_THEME.id, CLARITY_THEME.tokens, CLARITY_THEME.scheme);
    for (const key of THEME_TOKEN_KEYS) {
      expect(cssRgbVar(key)).toBe(hexToRgbTriplet(CLARITY_THEME.tokens[key]));
    }
  });

  it("stamps dataset.theme with the given theme id", () => {
    applyTheme("clarity", CLARITY_THEME.tokens, "dark");
    expect(document.documentElement.dataset.theme).toBe("clarity");
  });

  it("overwrites a previously-applied theme's tokens (both hex and -rgb)", () => {
    applyTheme("clarity", CLARITY_THEME.tokens, "dark");
    expect(cssVar("panel")).toBe(CLARITY_THEME.tokens.panel);

    const other: ThemeTokens = { ...CLARITY_THEME.tokens, panel: "#ff00ff" };
    applyTheme("custom", other, "dark");
    expect(cssVar("panel")).toBe("#ff00ff");
    expect(cssRgbVar("panel")).toBe("255 0 255");
    expect(document.documentElement.dataset.theme).toBe("custom");
  });

  it("is a no-op (does not throw) when document is unavailable", () => {
    const realDocument = globalThis.document;
    // @ts-expect-error — simulating an SSR environment for this assertion only
    delete globalThis.document;
    try {
      expect(() => applyTheme("clarity", CLARITY_THEME.tokens, "dark")).not.toThrow();
    } finally {
      globalThis.document = realDocument;
    }
  });
});

describe("resetToDefaultTheme", () => {
  it("removes every inline token override via removeProperty (both hex and -rgb)", () => {
    applyTheme("clarity", CLARITY_THEME.tokens, "dark");
    for (const key of THEME_TOKEN_KEYS) {
      expect(cssVar(key)).not.toBe("");
      expect(cssRgbVar(key)).not.toBe("");
    }

    resetToDefaultTheme();
    for (const key of THEME_TOKEN_KEYS) {
      expect(cssVar(key)).toBe("");
      expect(cssRgbVar(key)).toBe("");
    }
  });

  it("resets dataset.theme back to terminal", () => {
    applyTheme("clarity", CLARITY_THEME.tokens, "dark");
    resetToDefaultTheme();
    expect(document.documentElement.dataset.theme).toBe("terminal");
  });

  it("is safe to call when no theme was ever applied", () => {
    expect(() => resetToDefaultTheme()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("terminal");
  });
});

describe("activateTheme", () => {
  it("routes 'terminal' through resetToDefaultTheme (clears overrides, no injection)", () => {
    applyTheme("clarity", CLARITY_THEME.tokens, "dark");
    activateTheme("terminal", TERMINAL_THEME.tokens, "dark");
    for (const key of THEME_TOKEN_KEYS) {
      expect(cssVar(key)).toBe("");
      expect(cssRgbVar(key)).toBe("");
    }
    expect(document.documentElement.dataset.theme).toBe("terminal");
  });

  it("routes any non-terminal id through applyTheme, setting both hex and -rgb", () => {
    activateTheme("clarity", CLARITY_THEME.tokens, "dark");
    expect(cssVar("fg")).toBe(CLARITY_THEME.tokens.fg);
    expect(cssRgbVar("fg")).toBe(hexToRgbTriplet(CLARITY_THEME.tokens.fg));
    expect(document.documentElement.dataset.theme).toBe("clarity");
  });
});

// v0.2.4 light mode: `data-scheme` drives CSS `color-scheme` (native
// form controls/scrollbars) and the scheme-aware icon swap in
// globals.css — a theme applying without it would render light tokens
// under dark UA chrome and the wrong header icon.
describe("scheme stamping (v0.2.4 light mode)", () => {
  it("applyTheme stamps dataset.scheme with the theme's scheme", () => {
    applyTheme(TERMINAL_LIGHT_THEME.id, TERMINAL_LIGHT_THEME.tokens, "light");
    expect(document.documentElement.dataset.scheme).toBe("light");
  });

  it("resetToDefaultTheme restores dataset.scheme to dark", () => {
    applyTheme(TERMINAL_LIGHT_THEME.id, TERMINAL_LIGHT_THEME.tokens, "light");
    resetToDefaultTheme();
    expect(document.documentElement.dataset.scheme).toBe("dark");
  });

  it("activateTheme threads the scheme through to applyTheme", () => {
    activateTheme(TERMINAL_LIGHT_THEME.id, TERMINAL_LIGHT_THEME.tokens, "light");
    expect(document.documentElement.dataset.scheme).toBe("light");
    activateTheme("terminal", TERMINAL_THEME.tokens, "dark");
    expect(document.documentElement.dataset.scheme).toBe("dark");
  });

  it("keeps <meta name=theme-color> in step with the active theme's ink", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", "#0A0A0A");
    document.head.appendChild(meta);

    applyTheme(TERMINAL_LIGHT_THEME.id, TERMINAL_LIGHT_THEME.tokens, "light");
    expect(meta.getAttribute("content")).toBe(TERMINAL_LIGHT_THEME.tokens.ink);

    resetToDefaultTheme();
    expect(meta.getAttribute("content")).toBe("#0a0a0a");
  });

  it("syncing is a silent no-op when the meta tag is absent", () => {
    expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
    expect(() =>
      applyTheme(TERMINAL_LIGHT_THEME.id, TERMINAL_LIGHT_THEME.tokens, "light"),
    ).not.toThrow();
  });
});

describe("darkenHex", () => {
  it("scales each channel by the given factor, rounded", () => {
    // 0x4a=74, 0xde=222, 0x80=128; ×0.55 -> 40.7/122.1/70.4 -> 41/122/70
    expect(darkenHex("#4ade80", 0.55)).toBe("#297a46");
  });

  it("factor 1 is a no-op (identity)", () => {
    expect(darkenHex("#4ade80", 1)).toBe("#4ade80");
  });

  it("factor 0 always yields black", () => {
    expect(darkenHex("#4ade80", 0)).toBe("#000000");
  });

  it("expands a 3-digit short hex before scaling", () => {
    expect(darkenHex("#fff", 0.5)).toBe(darkenHex("#ffffff", 0.5));
  });

  it("clamps each channel to 0-255 even for a factor outside 0..1", () => {
    expect(darkenHex("#ffffff", 2)).toBe("#ffffff");
    expect(darkenHex("#000000", -1)).toBe("#000000");
  });

  it("is case-insensitive on input, always lowercase on output", () => {
    expect(darkenHex("#FFFFFF", 0.5)).toBe(darkenHex("#ffffff", 0.5));
    expect(darkenHex("#ffffff", 0.5)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

// v0.5.1 D7: Bit (PixelDragon.tsx) reads --bit-phos/--bit-phos-dim
// directly rather than a lab-* token — applyTheme/resetToDefaultTheme
// now carry that pair through the same lifecycle as every other token.
describe("applyTheme / resetToDefaultTheme — Bit phosphor vars (D7)", () => {
  it("applyTheme sets --bit-phos to the theme's own lab-green, verbatim", () => {
    applyTheme(CLARITY_THEME.id, CLARITY_THEME.tokens, CLARITY_THEME.scheme);
    expect(cssVar("bit-phos")).toBe(CLARITY_THEME.tokens["lab-green"]);
  });

  it("applyTheme sets --bit-phos-dim to lab-green darkened ×0.55", () => {
    applyTheme(CLARITY_THEME.id, CLARITY_THEME.tokens, CLARITY_THEME.scheme);
    expect(cssVar("bit-phos-dim")).toBe(darkenHex(CLARITY_THEME.tokens["lab-green"], 0.55));
  });

  it("switching themes updates both vars to the new theme's lab-green", () => {
    applyTheme(CLARITY_THEME.id, CLARITY_THEME.tokens, CLARITY_THEME.scheme);
    applyTheme(TERMINAL_LIGHT_THEME.id, TERMINAL_LIGHT_THEME.tokens, TERMINAL_LIGHT_THEME.scheme);
    expect(cssVar("bit-phos")).toBe(TERMINAL_LIGHT_THEME.tokens["lab-green"]);
  });

  it("resetToDefaultTheme removes both vars, letting globals.css's own defaults take back over", () => {
    applyTheme(CLARITY_THEME.id, CLARITY_THEME.tokens, CLARITY_THEME.scheme);
    expect(cssVar("bit-phos")).not.toBe("");

    resetToDefaultTheme();
    expect(cssVar("bit-phos")).toBe("");
    expect(cssVar("bit-phos-dim")).toBe("");
  });

  it("activateTheme('terminal', ...) removes both vars via the resetToDefaultTheme dispatch", () => {
    applyTheme(CLARITY_THEME.id, CLARITY_THEME.tokens, CLARITY_THEME.scheme);
    activateTheme("terminal", TERMINAL_THEME.tokens, "dark");
    expect(cssVar("bit-phos")).toBe("");
    expect(cssVar("bit-phos-dim")).toBe("");
  });
});
