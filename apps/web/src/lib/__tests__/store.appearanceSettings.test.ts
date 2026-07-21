// @vitest-environment jsdom
//
// v0.5.1 appearance sprint — DOM-observing side effects of hydrate()/
// updateSettings() (custom theme resolution, uiFont/monoFont CSS vars,
// overlayGlass dataset) needs a real `document`, same docblock-override
// posture as lib/theme/__tests__/apply.test.ts. buildDisplayMirror
// itself is pure and doesn't strictly need jsdom, but is tested here
// alongside its two callers for one shared setup.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDisplayMirror, useApp } from "../store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import * as storageModule from "../history/storage";
import { CLARITY_THEME, TERMINAL_THEME } from "../theme/themes";
import type { ThemeDefinition } from "../theme/schema";

function cssVar(name: string): string {
  return document.documentElement.style.getPropertyValue(`--${name}`);
}

const CUSTOM: ThemeDefinition = {
  id: "custom-abc",
  label: "我的主题",
  scheme: "dark",
  tokens: CLARITY_THEME.tokens,
};

beforeEach(() => {
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.scheme;
  delete document.documentElement.dataset.glass;
  useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildDisplayMirror (pure)", () => {
  it("omits `custom` for a resolved builtin theme", () => {
    const mirror = buildDisplayMirror({ ...DEFAULT_SETTINGS, themeId: "clarity" }, CLARITY_THEME);
    expect(mirror.custom).toBeUndefined();
    expect(mirror.themeId).toBe("clarity");
  });

  it("includes hex + pre-derived rgb + scheme for a resolved custom theme", () => {
    const mirror = buildDisplayMirror(
      { ...DEFAULT_SETTINGS, themeId: CUSTOM.id, customThemes: [CUSTOM] },
      CUSTOM,
    );
    expect(mirror.custom?.hex).toEqual(CUSTOM.tokens);
    expect(mirror.custom?.rgb.ink).toBe("10 10 10"); // #0a0a0a
    expect(mirror.custom?.rgb.fg).toBe("255 255 255"); // #ffffff
    expect(mirror.custom?.scheme).toBe("dark");
  });

  it("omits uiFont/monoFont when both settings are \"default\"", () => {
    const mirror = buildDisplayMirror(DEFAULT_SETTINGS, TERMINAL_THEME);
    expect(mirror.uiFont).toBeUndefined();
    expect(mirror.monoFont).toBeUndefined();
  });

  it("includes a resolved uiFont/monoFont stack for a non-default preset", () => {
    const mirror = buildDisplayMirror(
      { ...DEFAULT_SETTINGS, uiFont: "serif", monoFont: "system" },
      TERMINAL_THEME,
    );
    expect(mirror.uiFont).toContain("Songti SC");
    expect(mirror.monoFont).toContain("Cascadia Mono");
  });

  it("builds a mirror with no custom payload when theme is unresolved (undefined)", () => {
    const mirror = buildDisplayMirror({ ...DEFAULT_SETTINGS, themeId: "custom-gone" }, undefined);
    expect(mirror.themeId).toBe("custom-gone");
    expect(mirror.custom).toBeUndefined();
  });
});

describe("updateSettings — v0.5.1 theme/font/glass side effects", () => {
  it("activates a custom theme's tokens when themeId patches to it", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, customThemes: [CUSTOM] } });
    useApp.getState().updateSettings({ themeId: CUSTOM.id });
    expect(cssVar("ink")).toBe(CUSTOM.tokens.ink);
    expect(document.documentElement.dataset.theme).toBe(CUSTOM.id);
  });

  it("resets to terminal when themeId patches to an unresolvable id (D2)", () => {
    useApp.getState().updateSettings({ themeId: "custom-does-not-exist" });
    expect(document.documentElement.dataset.theme).toBe("terminal");
    expect(cssVar("ink")).toBe("");
  });

  it("re-activates with new tokens when customThemes patches the CURRENTLY ACTIVE theme's own entry (edited in place)", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, themeId: CUSTOM.id, customThemes: [CUSTOM] } });
    useApp.getState().updateSettings({ themeId: CUSTOM.id }); // land it live first
    expect(cssVar("ink")).toBe(CUSTOM.tokens.ink);

    const edited: ThemeDefinition = { ...CUSTOM, tokens: { ...CUSTOM.tokens, ink: "#222222" } };
    useApp.getState().updateSettings({ customThemes: [edited] });
    expect(cssVar("ink")).toBe("#222222");
  });

  it("falls back to terminal when customThemes patches WITHOUT the currently-active custom theme (deleted)", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, themeId: CUSTOM.id, customThemes: [CUSTOM] } });
    useApp.getState().updateSettings({ themeId: CUSTOM.id });
    expect(cssVar("ink")).toBe(CUSTOM.tokens.ink);

    useApp.getState().updateSettings({ customThemes: [] });
    expect(document.documentElement.dataset.theme).toBe("terminal");
    expect(cssVar("ink")).toBe("");
  });

  it("leaves an unaffected active BUILTIN theme alone when customThemes patches (harmless re-apply)", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, themeId: "clarity" } });
    useApp.getState().updateSettings({ customThemes: [CUSTOM] });
    expect(document.documentElement.dataset.theme).toBe("clarity");
    expect(cssVar("fg")).toBe(CLARITY_THEME.tokens.fg);
  });

  it("sets --font-ui for a non-default uiFont patch", () => {
    useApp.getState().updateSettings({ uiFont: "serif" });
    expect(cssVar("font-ui")).toContain("Songti SC");
  });

  it("removes --font-ui when uiFont patches back to \"default\"", () => {
    useApp.getState().updateSettings({ uiFont: "serif" });
    useApp.getState().updateSettings({ uiFont: "default" });
    expect(cssVar("font-ui")).toBe("");
  });

  it("sets --font-mono-user for a non-default monoFont patch", () => {
    useApp.getState().updateSettings({ monoFont: "system" });
    expect(cssVar("font-mono-user")).toContain("Cascadia Mono");
  });

  it("stamps data-glass=1 when overlayGlass patches true, and removes it when patched back to false", () => {
    useApp.getState().updateSettings({ overlayGlass: true });
    expect(document.documentElement.dataset.glass).toBe("1");

    useApp.getState().updateSettings({ overlayGlass: false });
    expect(document.documentElement.dataset.glass).toBeUndefined();
  });

  it("an unrelated patch (e.g. language) touches none of the theme/font/glass DOM state", () => {
    useApp.getState().updateSettings({ themeId: "clarity" });
    const before = cssVar("fg");
    useApp.getState().updateSettings({ language: "en-GB" });
    expect(cssVar("fg")).toBe(before);
    expect(document.documentElement.dataset.theme).toBe("clarity");
  });
});

describe("hydrate — v0.5.1 theme/font/glass side effects", () => {
  it("activates a persisted custom theme on hydrate", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue({
      ...DEFAULT_SETTINGS,
      themeId: CUSTOM.id,
      customThemes: [CUSTOM],
    });
    await useApp.getState().hydrate();
    expect(cssVar("ink")).toBe(CUSTOM.tokens.ink);
    expect(document.documentElement.dataset.theme).toBe(CUSTOM.id);
  });

  it("resets to terminal on hydrate when the persisted themeId is unresolvable (D2)", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue({
      ...DEFAULT_SETTINGS,
      themeId: "custom-gone",
      customThemes: [],
    });
    await useApp.getState().hydrate();
    expect(document.documentElement.dataset.theme).toBe("terminal");
    expect(cssVar("ink")).toBe("");
  });

  it("applies uiFont/monoFont/overlayGlass on hydrate", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue({
      ...DEFAULT_SETTINGS,
      uiFont: "serif",
      monoFont: "system",
      overlayGlass: true,
    });
    await useApp.getState().hydrate();
    expect(cssVar("font-ui")).toContain("Songti SC");
    expect(cssVar("font-mono-user")).toContain("Cascadia Mono");
    expect(document.documentElement.dataset.glass).toBe("1");
  });

  it("leaves overlayGlass dataset absent on hydrate when the persisted setting is false", async () => {
    document.documentElement.dataset.glass = "1"; // simulate a stale attribute from a previous session
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue({
      ...DEFAULT_SETTINGS,
      overlayGlass: false,
    });
    await useApp.getState().hydrate();
    expect(document.documentElement.dataset.glass).toBeUndefined();
  });
});
