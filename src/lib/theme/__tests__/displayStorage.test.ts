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
  it("embeds the given theme token maps as inline JSON", () => {
    const script = buildFoucScript({ clarity: { fg: "#ffffff" } });
    expect(script).toContain('"clarity"');
    expect(script).toContain('"#ffffff"');
  });

  it("produces a script that reads the mirror and sets data-fs / data-theme without throwing", () => {
    writeDisplayMirror({ themeId: "clarity", fontSize: "lg" });
    const script = buildFoucScript({ clarity: { ink: "#0a0a0a", fg: "#ffffff" } });

    // eslint-disable-next-line no-new-func -- exercising the exact
    // script string that gets embedded via dangerouslySetInnerHTML in
    // layout.tsx, not evaluating arbitrary user input.
    expect(() => new Function(script)()).not.toThrow();

    expect(document.documentElement.dataset.fs).toBe("lg");
    expect(document.documentElement.dataset.theme).toBe("clarity");
    expect(document.documentElement.style.getPropertyValue("--fg")).toBe("#ffffff");
  });

  it("falls back to terminal/md when localStorage has nothing", () => {
    const script = buildFoucScript({ clarity: { fg: "#ffffff" } });
    new Function(script)();
    expect(document.documentElement.dataset.fs).toBe("md");
    expect(document.documentElement.dataset.theme).toBe("terminal");
  });

  it("never throws even if localStorage access fails inside the script", () => {
    const original = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new Error("blocked");
    };
    try {
      const script = buildFoucScript({ clarity: { fg: "#ffffff" } });
      expect(() => new Function(script)()).not.toThrow();
    } finally {
      window.localStorage.getItem = original;
    }
  });
});
