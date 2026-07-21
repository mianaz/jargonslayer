import { describe, expect, it } from "vitest";
import {
  CUSTOM_FONT_PREFIX,
  MONO_FONT_PRESETS,
  resolveFontStack,
  sanitizeFontFamily,
  UI_FONT_PRESETS,
} from "../fonts";

describe("sanitizeFontFamily", () => {
  it("trims surrounding whitespace", () => {
    expect(sanitizeFontFamily("  Fira Code  ")).toBe("Fira Code");
  });

  it("strips quotes (so a wrapped \"${family}\" can never close early)", () => {
    expect(sanitizeFontFamily(`"Fira" 'Code'`)).toBe("Fira Code");
  });

  it("strips semicolons, braces, parens, angle brackets, backslashes", () => {
    expect(sanitizeFontFamily("Evil;{}()<>\\Font")).toBe("EvilFont");
  });

  it("strips a CSS-injection-shaped payload down to something harmless", () => {
    // Only ";", "(", ")" are present in this input among the unsafe
    // set — colons/slashes/periods aren't stripped (they have no
    // CSS-breaking meaning inside a font-family value).
    expect(sanitizeFontFamily("Arial; background:url(//evil.com)")).toBe(
      "Arial background:url//evil.com",
    );
  });

  it("caps length at 60 characters", () => {
    const long = "A".repeat(100);
    const result = sanitizeFontFamily(long);
    expect(result).not.toBeNull();
    expect(result?.length).toBe(60);
  });

  it("rejects (returns null) an empty string", () => {
    expect(sanitizeFontFamily("")).toBeNull();
  });

  it("rejects a string that is nothing but unsafe characters", () => {
    expect(sanitizeFontFamily(`;;;"""`)).toBeNull();
  });

  it("rejects a whitespace-only string", () => {
    expect(sanitizeFontFamily("   ")).toBeNull();
  });

  it("is idempotent — re-sanitizing an already-clean value is a no-op", () => {
    const once = sanitizeFontFamily("Fira Code");
    expect(sanitizeFontFamily(once as string)).toBe(once);
  });
});

describe("resolveFontStack", () => {
  const uiDefault = UI_FONT_PRESETS[0].stack;

  it("returns null for the \"default\" sentinel (remove override)", () => {
    expect(resolveFontStack(uiDefault, "default")).toBeNull();
  });

  it("resolves a known UI preset id to its stack", () => {
    const serif = UI_FONT_PRESETS.find((p) => p.id === "serif")!;
    expect(resolveFontStack(uiDefault, "serif")).toBe(serif.stack);
  });

  it("resolves a known mono preset id to its stack", () => {
    const system = MONO_FONT_PRESETS.find((p) => p.id === "system")!;
    expect(resolveFontStack(uiDefault, "system")).toBe(system.stack);
  });

  it("resolves a custom:<family> value to a quoted family + the slot default appended", () => {
    expect(resolveFontStack(uiDefault, `${CUSTOM_FONT_PREFIX}Fira Code`)).toBe(
      `"Fira Code", ${uiDefault}`,
    );
  });

  it("re-sanitizes the custom family (strips unsafe characters) even if the caller didn't", () => {
    // Only the quote/semicolon/parens are stripped — colon isn't in
    // the unsafe set (no CSS-breaking meaning inside a family value).
    expect(resolveFontStack(uiDefault, `${CUSTOM_FONT_PREFIX}Evil";background:url(x)`)).toBe(
      `"Evilbackground:urlx", ${uiDefault}`,
    );
  });

  it("falls back to null when the custom family sanitizes to nothing", () => {
    expect(resolveFontStack(uiDefault, `${CUSTOM_FONT_PREFIX};;;`)).toBeNull();
  });

  it("falls back to null for an unrecognized preset id (future-removed preset, corrupt restore)", () => {
    expect(resolveFontStack(uiDefault, "some-preset-that-never-existed")).toBeNull();
  });

  it("falls back to null for an empty string", () => {
    expect(resolveFontStack(uiDefault, "")).toBeNull();
  });
});
