// @vitest-environment jsdom
//
// Theme injection is CSSOM-only (setProperty/removeProperty on
// document.documentElement.style) — this file needs a real `document`
// to assert against, unlike the rest of the suite (vitest.config.ts's
// default `environment: "node"`). The docblock above overrides the
// environment for just this file; nothing else in the project needs
// jsdom, so the global config is left untouched.

import { beforeEach, describe, expect, it } from "vitest";
import { activateTheme, applyTheme, hexToRgbTriplet, resetToDefaultTheme } from "../apply";
import { THEME_TOKEN_KEYS, type ThemeTokens } from "../schema";
import { CLARITY_THEME, TERMINAL_THEME } from "../themes";

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
  delete document.documentElement.dataset.theme;
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
    applyTheme(CLARITY_THEME.id, CLARITY_THEME.tokens);
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
    applyTheme(CLARITY_THEME.id, CLARITY_THEME.tokens);
    for (const key of THEME_TOKEN_KEYS) {
      expect(cssRgbVar(key)).toBe(hexToRgbTriplet(CLARITY_THEME.tokens[key]));
    }
  });

  it("stamps dataset.theme with the given theme id", () => {
    applyTheme("clarity", CLARITY_THEME.tokens);
    expect(document.documentElement.dataset.theme).toBe("clarity");
  });

  it("overwrites a previously-applied theme's tokens (both hex and -rgb)", () => {
    applyTheme("clarity", CLARITY_THEME.tokens);
    expect(cssVar("panel")).toBe(CLARITY_THEME.tokens.panel);

    const other: ThemeTokens = { ...CLARITY_THEME.tokens, panel: "#ff00ff" };
    applyTheme("custom", other);
    expect(cssVar("panel")).toBe("#ff00ff");
    expect(cssRgbVar("panel")).toBe("255 0 255");
    expect(document.documentElement.dataset.theme).toBe("custom");
  });

  it("is a no-op (does not throw) when document is unavailable", () => {
    const realDocument = globalThis.document;
    // @ts-expect-error — simulating an SSR environment for this assertion only
    delete globalThis.document;
    try {
      expect(() => applyTheme("clarity", CLARITY_THEME.tokens)).not.toThrow();
    } finally {
      globalThis.document = realDocument;
    }
  });
});

describe("resetToDefaultTheme", () => {
  it("removes every inline token override via removeProperty (both hex and -rgb)", () => {
    applyTheme("clarity", CLARITY_THEME.tokens);
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
    applyTheme("clarity", CLARITY_THEME.tokens);
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
    applyTheme("clarity", CLARITY_THEME.tokens);
    activateTheme("terminal", TERMINAL_THEME.tokens);
    for (const key of THEME_TOKEN_KEYS) {
      expect(cssVar(key)).toBe("");
      expect(cssRgbVar(key)).toBe("");
    }
    expect(document.documentElement.dataset.theme).toBe("terminal");
  });

  it("routes any non-terminal id through applyTheme, setting both hex and -rgb", () => {
    activateTheme("clarity", CLARITY_THEME.tokens);
    expect(cssVar("fg")).toBe(CLARITY_THEME.tokens.fg);
    expect(cssRgbVar("fg")).toBe(hexToRgbTriplet(CLARITY_THEME.tokens.fg));
    expect(document.documentElement.dataset.theme).toBe("clarity");
  });
});
