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
  FONT_STACK_RE,
  readDisplayMirror,
  RGB_TRIPLET_RE,
  writeDisplayMirror,
} from "../displayStorage";
import { HEX_COLOR_RE, THEME_TOKEN_KEYS } from "../schema";
import { darkenHex } from "../apply";

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

  // F9 (adversarial review): --bit-phos/--bit-phos-dim were only ever
  // set by apply.ts's applyTheme at hydrate, never by this pre-paint
  // script — a themed reload flashed the terminal-default mascot green
  // for one frame. The build-time payload must embed a derived pair per
  // builtin (same darkenHex ×0.55 apply.ts's own applyTheme uses) and
  // the script must set them when a builtin theme actually activates.
  it("embeds a pre-derived --bit-phos/--bit-phos-dim pair for a builtin theme and sets them on activation", () => {
    writeDisplayMirror({ themeId: "clarity", fontSize: "md" });
    const script = buildFoucScript([
      { id: "clarity", scheme: "dark", tokens: { ink: "#0a0a0a", fg: "#ffffff", "lab-green": "#137038" } },
    ]);
    new Function(script)();
    expect(document.documentElement.style.getPropertyValue("--bit-phos")).toBe("#137038");
    expect(document.documentElement.style.getPropertyValue("--bit-phos-dim")).toBe(darkenHex("#137038", 0.55));
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

  // F9: the terminal default path must NEVER set --bit-phos/-dim — the
  // CSS-authored fallback (PixelDragon.tsx's own `var(--bit-phos,
  // #4ADE80)` default plus globals.css's [data-scheme="light"]
  // override) must take over untouched, matching resetToDefaultTheme's
  // own removeProperty contract in apply.ts.
  it("does not set --bit-phos/--bit-phos-dim on the terminal fallback branch", () => {
    document.documentElement.style.removeProperty("--bit-phos");
    document.documentElement.style.removeProperty("--bit-phos-dim");
    const script = buildFoucScript([
      { id: "clarity", scheme: "dark", tokens: { fg: "#ffffff", "lab-green": "#137038" } },
    ]);
    new Function(script)(); // localStorage empty -> terminal fallback branch
    expect(document.documentElement.style.getPropertyValue("--bit-phos")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--bit-phos-dim")).toBe("");
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

// v0.5.1 appearance sprint — custom theme payload + font stacks on the
// mirror (D3).
describe("DisplayMirror — custom theme payload", () => {
  it("round-trips a custom theme's hex/rgb/scheme through write+read", () => {
    const mirror = {
      themeId: "custom-abc",
      fontSize: "md" as const,
      custom: { hex: { ink: "#111111" }, rgb: { ink: "17 17 17" }, scheme: "dark" as const },
    };
    writeDisplayMirror(mirror);
    expect(readDisplayMirror()).toEqual(mirror);
  });

  it("drops a malformed custom payload (non-string hex value) but keeps the rest of the mirror intact", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({
        themeId: "custom-abc",
        fontSize: "lg",
        custom: { hex: { ink: 42 }, rgb: { ink: "17 17 17" }, scheme: "dark" },
      }),
    );
    const mirror = readDisplayMirror();
    expect(mirror.themeId).toBe("custom-abc");
    expect(mirror.fontSize).toBe("lg");
    expect(mirror.custom).toBeUndefined();
  });

  it("drops a custom payload with an invalid scheme value", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({
        themeId: "custom-abc",
        fontSize: "md",
        custom: { hex: { ink: "#111111" }, rgb: { ink: "17 17 17" }, scheme: "sepia" },
      }),
    );
    expect(readDisplayMirror().custom).toBeUndefined();
  });

  it("drops a custom payload whose hex/rgb are arrays, not plain objects", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({
        themeId: "custom-abc",
        fontSize: "md",
        custom: { hex: ["#111111"], rgb: { ink: "17 17 17" }, scheme: "dark" },
      }),
    );
    expect(readDisplayMirror().custom).toBeUndefined();
  });

  it("drops a custom payload missing rgb entirely", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({
        themeId: "custom-abc",
        fontSize: "md",
        custom: { hex: { ink: "#111111" }, scheme: "dark" },
      }),
    );
    expect(readDisplayMirror().custom).toBeUndefined();
  });

  // F8 (adversarial review): a hand-tampered localStorage payload can
  // carry keys outside the 17-token allowlist — readCustomPayload must
  // drop them from both hex and rgb rather than passing them through.
  it("drops a key outside the 17-token allowlist from a tampered custom payload's hex/rgb maps", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({
        themeId: "custom-abc",
        fontSize: "md",
        custom: {
          hex: { ink: "#111111", "font-mono-brand": "#ffffff" },
          rgb: { ink: "17 17 17", "font-mono-brand": "255 255 255" },
          scheme: "dark",
        },
      }),
    );
    const mirror = readDisplayMirror();
    expect(mirror.custom?.hex).toEqual({ ink: "#111111" });
    expect(mirror.custom?.rgb).toEqual({ ink: "17 17 17" });
  });

  // F9: phos/phosDim round-trip through the same write+read path as
  // hex/rgb/scheme; a mirror written before this landed simply omits
  // them (self-heals — no whole-payload rejection over their absence).
  it("round-trips phos/phosDim on the custom payload", () => {
    const mirror = {
      themeId: "custom-abc",
      fontSize: "md" as const,
      custom: {
        hex: { ink: "#111111" },
        rgb: { ink: "17 17 17" },
        scheme: "dark" as const,
        phos: "#137038",
        phosDim: "#0b3d1f",
      },
    };
    writeDisplayMirror(mirror);
    expect(readDisplayMirror()).toEqual(mirror);
  });

  it("omits phos/phosDim from the read mirror when absent from the payload (pre-F9 persisted mirror)", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({
        themeId: "custom-abc",
        fontSize: "md",
        custom: { hex: { ink: "#111111" }, rgb: { ink: "17 17 17" }, scheme: "dark" },
      }),
    );
    const mirror = readDisplayMirror();
    expect(mirror.custom?.phos).toBeUndefined();
    expect(mirror.custom?.phosDim).toBeUndefined();
  });
});

describe("DisplayMirror — uiFont/monoFont", () => {
  it("round-trips uiFont/monoFont strings", () => {
    writeDisplayMirror({
      themeId: "terminal",
      fontSize: "md",
      uiFont: '"Songti SC", serif',
      monoFont: "Menlo, monospace",
    });
    const mirror = readDisplayMirror();
    expect(mirror.uiFont).toBe('"Songti SC", serif');
    expect(mirror.monoFont).toBe("Menlo, monospace");
  });

  it("drops a non-string uiFont/monoFont value", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({ themeId: "terminal", fontSize: "md", uiFont: 42, monoFont: null }),
    );
    const mirror = readDisplayMirror();
    expect(mirror.uiFont).toBeUndefined();
    expect(mirror.monoFont).toBeUndefined();
  });

  it("drops a uiFont value longer than the 256-char cap", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({ themeId: "terminal", fontSize: "md", uiFont: "a".repeat(257) }),
    );
    expect(readDisplayMirror().uiFont).toBeUndefined();
  });

  it("keeps a uiFont value exactly at the 256-char cap", () => {
    const value = "a".repeat(256);
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({ themeId: "terminal", fontSize: "md", uiFont: value }),
    );
    expect(readDisplayMirror().uiFont).toBe(value);
  });
});

describe("RGB_TRIPLET_RE / FONT_STACK_RE", () => {
  it("RGB_TRIPLET_RE matches a bare 'R G B' triplet only", () => {
    expect(RGB_TRIPLET_RE.test("255 255 0")).toBe(true);
    expect(RGB_TRIPLET_RE.test("10 10 10")).toBe(true);
    expect(RGB_TRIPLET_RE.test("rgb(1,2,3)")).toBe(false);
    expect(RGB_TRIPLET_RE.test("1,2,3")).toBe(false);
  });

  it("FONT_STACK_RE accepts a real resolved stack and rejects one with parens", () => {
    expect(FONT_STACK_RE.test('"Songti SC", "STSong", "SimSun", Georgia, serif')).toBe(true);
    expect(FONT_STACK_RE.test("var(--font-mono-brand), monospace")).toBe(false);
  });
});

describe("buildFoucScript — custom theme branch", () => {
  it("embeds the hex guard regex source in the generated script (defense in depth)", () => {
    const script = buildFoucScript([]);
    expect(script).toContain(HEX_COLOR_RE.source);
  });

  // F8: the script must embed the 17-token allowlist and iterate IT
  // (never the payload's own keys) — this is what closes the
  // arbitrary-persistent-property gap below.
  it("embeds the 17-token allowlist in the generated script (defense in depth)", () => {
    const script = buildFoucScript([]);
    expect(script).toContain(JSON.stringify(THEME_TOKEN_KEYS));
  });

  it("never sets a CSS property for a key outside the allowlist, even with a schema-valid hex/rgb value (F8 — hand-tampered localStorage payload)", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({
        themeId: "custom-abc",
        fontSize: "md",
        custom: {
          hex: { ink: "#111111", "font-mono-brand": "#ffffff" },
          rgb: { ink: "17 17 17", "font-mono-brand": "255 255 255" },
          scheme: "dark",
        },
      }),
    );
    document.documentElement.style.removeProperty("--font-mono-brand");
    document.documentElement.style.removeProperty("--font-mono-brand-rgb");
    const script = buildFoucScript([]);
    new Function(script)();
    expect(document.documentElement.style.getPropertyValue("--ink")).toBe("#111111");
    expect(document.documentElement.style.getPropertyValue("--font-mono-brand")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--font-mono-brand-rgb")).toBe("");
  });

  it("applies a custom theme's tokens (hex + rgb) when themeId starts with custom- and mirror.custom is present", () => {
    writeDisplayMirror({
      themeId: "custom-abc",
      fontSize: "md",
      custom: {
        hex: { ink: "#111111", fg: "#eeeeee" },
        rgb: { ink: "17 17 17", fg: "238 238 238" },
        scheme: "dark",
      },
    });
    const script = buildFoucScript([]); // no builtins needed for this branch
    new Function(script)();
    expect(document.documentElement.style.getPropertyValue("--ink")).toBe("#111111");
    expect(document.documentElement.style.getPropertyValue("--ink-rgb")).toBe("17 17 17");
    expect(document.documentElement.style.getPropertyValue("--fg")).toBe("#eeeeee");
    expect(document.documentElement.dataset.theme).toBe("custom-abc");
    expect(document.documentElement.dataset.scheme).toBe("dark");
  });

  it("skips a single non-matching hex value in the custom payload without throwing, still applying the others", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({
        themeId: "custom-abc",
        fontSize: "md",
        custom: {
          hex: { ink: "not-a-hex", fg: "#eeeeee" },
          rgb: { ink: "17 17 17", fg: "238 238 238" },
          scheme: "dark",
        },
      }),
    );
    document.documentElement.style.removeProperty("--ink");
    const script = buildFoucScript([]);
    expect(() => new Function(script)()).not.toThrow();
    expect(document.documentElement.style.getPropertyValue("--ink")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--fg")).toBe("#eeeeee");
  });

  it("skips a non-matching rgb value for one key while still setting its hex sibling", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({
        themeId: "custom-abc",
        fontSize: "md",
        custom: { hex: { ink: "#111111" }, rgb: { ink: "rgb(1,2,3)" }, scheme: "dark" },
      }),
    );
    document.documentElement.style.removeProperty("--ink-rgb");
    const script = buildFoucScript([]);
    new Function(script)();
    expect(document.documentElement.style.getPropertyValue("--ink")).toBe("#111111");
    expect(document.documentElement.style.getPropertyValue("--ink-rgb")).toBe("");
  });

  it("falls through to the terminal fallback when themeId starts with custom- but mirror.custom is absent (self-heals on next hydrate)", () => {
    writeDisplayMirror({ themeId: "custom-gone", fontSize: "md" });
    const script = buildFoucScript([]);
    new Function(script)();
    expect(document.documentElement.dataset.theme).toBe("terminal");
    expect(document.documentElement.dataset.scheme).toBe("dark");
  });

  // F9: the custom branch reads its own phos/phosDim off the mirror
  // payload (written by store.ts's buildDisplayMirror), each guarded by
  // the same HEX_RE the hex/rgb token values already go through.
  it("sets --bit-phos/--bit-phos-dim from the custom payload's phos/phosDim fields", () => {
    writeDisplayMirror({
      themeId: "custom-abc",
      fontSize: "md",
      custom: {
        hex: { ink: "#111111" },
        rgb: { ink: "17 17 17" },
        scheme: "dark",
        phos: "#137038",
        phosDim: "#0b3d1f",
      },
    });
    const script = buildFoucScript([]);
    new Function(script)();
    expect(document.documentElement.style.getPropertyValue("--bit-phos")).toBe("#137038");
    expect(document.documentElement.style.getPropertyValue("--bit-phos-dim")).toBe("#0b3d1f");
  });

  it("skips an invalid phos value in the custom payload without throwing (hex-regex guard)", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({
        themeId: "custom-abc",
        fontSize: "md",
        custom: { hex: { ink: "#111111" }, rgb: { ink: "17 17 17" }, scheme: "dark", phos: "not-a-hex" },
      }),
    );
    document.documentElement.style.removeProperty("--bit-phos");
    const script = buildFoucScript([]);
    expect(() => new Function(script)()).not.toThrow();
    expect(document.documentElement.style.getPropertyValue("--bit-phos")).toBe("");
  });
});

describe("buildFoucScript — font vars", () => {
  it("sets --font-ui/--font-mono-user from the mirror when they pass the embedded font guard", () => {
    writeDisplayMirror({
      themeId: "terminal",
      fontSize: "md",
      uiFont: '"Songti SC", serif',
      monoFont: "Menlo, monospace",
    });
    const script = buildFoucScript([]);
    new Function(script)();
    expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe('"Songti SC", serif');
    expect(document.documentElement.style.getPropertyValue("--font-mono-user")).toBe("Menlo, monospace");
  });

  it("skips a font value that fails the embedded guard (e.g. contains parens) without throwing", () => {
    window.localStorage.setItem(
      "js-display",
      JSON.stringify({ themeId: "terminal", fontSize: "md", uiFont: "var(--evil)" }),
    );
    document.documentElement.style.removeProperty("--font-ui");
    const script = buildFoucScript([]);
    expect(() => new Function(script)()).not.toThrow();
    expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe("");
  });
});
