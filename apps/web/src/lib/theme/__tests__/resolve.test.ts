import { describe, expect, it } from "vitest";
import { CUSTOM_THEME_CAP, CUSTOM_THEME_ID_PREFIX, mintCustomThemeId, resolveThemeById } from "../resolve";
import { BUILTIN_THEMES, CLARITY_THEME, TERMINAL_THEME } from "../themes";
import type { ThemeDefinition } from "../schema";

function makeCustom(id: string, label = id): ThemeDefinition {
  return { id, label, scheme: "dark", tokens: CLARITY_THEME.tokens };
}

describe("resolveThemeById", () => {
  it("resolves a builtin id, ignoring customThemes entirely", () => {
    expect(resolveThemeById("terminal", [])).toBe(TERMINAL_THEME);
    expect(resolveThemeById("clarity", [])).toBe(CLARITY_THEME);
  });

  it("resolves a custom id from the given array when it isn't a builtin", () => {
    const custom = makeCustom("custom-abc", "我的主题");
    expect(resolveThemeById("custom-abc", [custom])).toBe(custom);
  });

  it("builtin wins over a customThemes entry sharing the same id (builtin-first resolution order)", () => {
    // Not a realistic case (customs can never mint a builtin id — see
    // mintCustomThemeId below), but the resolver's own contract is
    // "builtin first" regardless of how such an entry got there.
    const shadowing = makeCustom("terminal", "冒充终端");
    expect(resolveThemeById("terminal", [shadowing])).toBe(TERMINAL_THEME);
  });

  it("returns undefined for an id that matches neither a builtin nor a custom entry", () => {
    expect(resolveThemeById("does-not-exist", [makeCustom("custom-x")])).toBeUndefined();
  });

  it("returns undefined for an empty id against an empty customThemes array", () => {
    expect(resolveThemeById("", [])).toBeUndefined();
  });
});

describe("CUSTOM_THEME_ID_PREFIX / CUSTOM_THEME_CAP", () => {
  it("prefix is the literal 'custom-'", () => {
    expect(CUSTOM_THEME_ID_PREFIX).toBe("custom-");
  });

  it("cap is a positive integer (soft cap 20 per D1)", () => {
    expect(CUSTOM_THEME_CAP).toBe(20);
  });
});

describe("mintCustomThemeId", () => {
  it("produces an id starting with the custom- prefix for a latin label", () => {
    const id = mintCustomThemeId("My Theme", []);
    expect(id.startsWith(CUSTOM_THEME_ID_PREFIX)).toBe(true);
  });

  it("slugifies a latin label into the id", () => {
    const id = mintCustomThemeId("My Cool Theme 2", []);
    expect(id).toBe("custom-my-cool-theme-2");
  });

  it("produces an id starting with the prefix even for a pure-CJK label (falls back to a random suffix)", () => {
    const id = mintCustomThemeId("我的深色主题", []);
    expect(id.startsWith(CUSTOM_THEME_ID_PREFIX)).toBe(true);
    // Nothing usable survives slugify(CJK) -> empty -> random suffix,
    // so the id is strictly longer than just the bare prefix.
    expect(id.length).toBeGreaterThan(CUSTOM_THEME_ID_PREFIX.length);
  });

  it("is collision-safe against every builtin id", () => {
    for (const builtin of BUILTIN_THEMES) {
      // Strip the "custom-" prefix back off so the label slugifies
      // straight back to the SAME builtin id, forcing a real collision
      // check rather than coincidentally minting something else.
      const label = builtin.id;
      const id = mintCustomThemeId(label, []);
      expect(id).not.toBe(builtin.id);
      expect(BUILTIN_THEMES.some((t) => t.id === id)).toBe(false);
    }
  });

  it("is collision-safe against an existing custom id with the exact same label", () => {
    const first = mintCustomThemeId("我的主题", []);
    const second = mintCustomThemeId("我的主题", [first]);
    expect(second).not.toBe(first);
  });

  it("is collision-safe against an existing custom id for a latin label too", () => {
    const first = mintCustomThemeId("Dracula", []);
    const second = mintCustomThemeId("Dracula", [first]);
    expect(first).toBe("custom-dracula");
    expect(second).not.toBe(first);
    expect(second.startsWith(CUSTOM_THEME_ID_PREFIX)).toBe(true);
  });

  it("never collides even across many re-mints of the identical label", () => {
    const ids = new Set<string>();
    let existing: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = mintCustomThemeId("重复标签", existing);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
      existing = [...existing, id];
    }
  });
});
