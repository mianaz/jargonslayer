// @vitest-environment jsdom
//
// The FOUC mirror reads/writes window.localStorage synchronously, so
// this file needs a real DOM global like apply.test.ts does — see that
// file's header comment for why the docblock (not the project-wide
// vitest.config.ts) is the right place for this override.

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildFoucScript,
  DEFAULT_DISPLAY_MIRROR,
  readDisplayMirror,
  writeDisplayMirror,
} from "../displayStorage";

beforeEach(() => {
  window.localStorage.clear();
});

describe("writeDisplayMirror / readDisplayMirror — roundtrip", () => {
  it("writes then reads back the same mirror", () => {
    writeDisplayMirror({ themeId: "clarity", fontSize: "lg" });
    expect(readDisplayMirror()).toEqual({ themeId: "clarity", fontSize: "lg" });
  });

  it("persists under a single JSON key (js-display)", () => {
    writeDisplayMirror({ themeId: "clarity", fontSize: "xl" });
    const raw = window.localStorage.getItem("js-display");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ themeId: "clarity", fontSize: "xl" });
  });

  it("overwrites a previous mirror on a later write", () => {
    writeDisplayMirror({ themeId: "clarity", fontSize: "sm" });
    writeDisplayMirror({ themeId: "terminal", fontSize: "xl" });
    expect(readDisplayMirror()).toEqual({ themeId: "terminal", fontSize: "xl" });
  });
});

describe("readDisplayMirror — fallback safety", () => {
  it("falls back to the default when nothing was ever written", () => {
    expect(readDisplayMirror()).toEqual(DEFAULT_DISPLAY_MIRROR);
  });

  it("falls back to the default on malformed JSON", () => {
    window.localStorage.setItem("js-display", "{not valid json");
    expect(readDisplayMirror()).toEqual(DEFAULT_DISPLAY_MIRROR);
  });

  it("falls back to the default when the stored value is not an object", () => {
    window.localStorage.setItem("js-display", JSON.stringify("just a string"));
    expect(readDisplayMirror()).toEqual(DEFAULT_DISPLAY_MIRROR);
  });

  it("falls back to the default fontSize tier when the stored one is invalid", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({ themeId: "clarity", fontSize: "huge" }),
    );
    expect(readDisplayMirror()).toEqual({ themeId: "clarity", fontSize: "md" });
  });

  it("falls back to the default themeId when the stored one is not a string", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({ themeId: 42, fontSize: "lg" }),
    );
    expect(readDisplayMirror()).toEqual({ themeId: "terminal", fontSize: "lg" });
  });

  it("never throws when localStorage access itself fails", () => {
    const original = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new Error("access denied (e.g. private browsing)");
    };
    try {
      expect(() => readDisplayMirror()).not.toThrow();
      expect(readDisplayMirror()).toEqual(DEFAULT_DISPLAY_MIRROR);
    } finally {
      window.localStorage.getItem = original;
    }
  });

  it("writeDisplayMirror never throws when localStorage access itself fails", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      expect(() => writeDisplayMirror({ themeId: "clarity", fontSize: "md" })).not.toThrow();
    } finally {
      window.localStorage.setItem = original;
    }
  });
});

describe("buildFoucScript", () => {
  it("embeds the given theme token maps as inline JSON, hex AND pre-derived rgb", () => {
    const script = buildFoucScript([{ id: "clarity", scheme: "dark", tokens: { fg: "#ffffff" } }]);
    expect(script).toContain('"clarity"');
    expect(script).toContain('"#ffffff"');
    // v0.2.1: the rgb triplet must be pre-computed into the embedded
    // JSON at build time — the inline script itself does no hex
    // parsing (see module comment on FoucThemePayload).
    expect(script).toContain('"255 255 255"');
  });

  it("produces a script that reads the mirror and sets data-fs / data-theme without throwing", () => {
    writeDisplayMirror({ themeId: "clarity", fontSize: "lg" });
    const script = buildFoucScript([{ id: "clarity", scheme: "dark", tokens: { ink: "#0a0a0a", fg: "#ffffff" } }]);

    // eslint-disable-next-line no-new-func -- exercising the exact
    // script string that gets embedded via dangerouslySetInnerHTML in
    // layout.tsx, not evaluating arbitrary user input.
    expect(() => new Function(script)()).not.toThrow();

    expect(document.documentElement.dataset.fs).toBe("lg");
    expect(document.documentElement.dataset.theme).toBe("clarity");
    expect(document.documentElement.dataset.scheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--fg")).toBe("#ffffff");
  });

  // v0.2.4 light mode: the scheme must be stamped pre-paint too — it
  // gates CSS `color-scheme` and the scheme-aware header icon, so a
  // light-theme user would otherwise flash dark UA chrome + the dark
  // icon rendition on every load.
  it("stamps data-scheme from the mirrored theme's scheme before paint", () => {
    writeDisplayMirror({ themeId: "terminal-light", fontSize: "md" });
    const script = buildFoucScript([
      { id: "terminal-light", scheme: "light", tokens: { fg: "#191919" } },
    ]);
    new Function(script)();
    expect(document.documentElement.dataset.scheme).toBe("light");
  });

  // v0.2.1 ship-blocking fix: the FOUC script must ALSO set the "-rgb"
  // triplet variable for every token — Tailwind's generated utilities
  // (text-fg, bg-panel, ...) resolve through that variable, not the
  // hex one, so skipping it would leave the whole Tailwind-classed UI
  // on the default theme's colors even though dataset.theme/the hex
  // variables correctly show the new theme (exactly the blind spot
  // the previous Playwright verification missed).
  it("ALSO sets the -rgb triplet variable for every token, derived at build time", () => {
    writeDisplayMirror({ themeId: "clarity", fontSize: "md" });
    const script = buildFoucScript([{ id: "clarity", scheme: "dark", tokens: { ink: "#0a0a0a", fg: "#ffffff" } }]);
    new Function(script)();

    expect(document.documentElement.style.getPropertyValue("--ink-rgb")).toBe("10 10 10");
    expect(document.documentElement.style.getPropertyValue("--fg-rgb")).toBe("255 255 255");
  });

  it("falls back to terminal/md/dark when localStorage has nothing", () => {
    // Poison dataset.scheme first: the fallback branch must actively
    // stamp "dark", not just leave whatever a previous load set.
    document.documentElement.dataset.scheme = "light";
    const script = buildFoucScript([{ id: "clarity", scheme: "dark", tokens: { fg: "#ffffff" } }]);
    new Function(script)();
    expect(document.documentElement.dataset.fs).toBe("md");
    expect(document.documentElement.dataset.theme).toBe("terminal");
    expect(document.documentElement.dataset.scheme).toBe("dark");
  });

  it("never throws even if localStorage access fails inside the script", () => {
    const original = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new Error("blocked");
    };
    try {
      const script = buildFoucScript([{ id: "clarity", scheme: "dark", tokens: { fg: "#ffffff" } }]);
      expect(() => new Function(script)()).not.toThrow();
    } finally {
      window.localStorage.getItem = original;
    }
  });
});
