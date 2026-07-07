import { describe, expect, it } from "vitest";
import { HEX_COLOR_RE, THEME_TOKEN_KEYS } from "../schema";
import { BUILTIN_THEMES, CLARITY_THEME, getBuiltinTheme, TERMINAL_THEME } from "../themes";

// WCAG 2.x relative luminance / contrast ratio — same formula as the
// project's contrast-audit scratch script, kept minimal and
// dependency-free (no color library) since it's used for exactly one
// thing: asserting the shipped token values actually clear the bars
// documented in themes.ts's comments.
function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe("BUILTIN_THEMES", () => {
  it("contains exactly terminal and clarity", () => {
    expect(BUILTIN_THEMES.map((t) => t.id)).toEqual(["terminal", "clarity"]);
  });

  it("every built-in theme defines all 17 tokens as strict hex", () => {
    for (const theme of BUILTIN_THEMES) {
      for (const key of THEME_TOKEN_KEYS) {
        expect(theme.tokens[key], `${theme.id}.${key}`).toMatch(HEX_COLOR_RE);
      }
      expect(Object.keys(theme.tokens)).toHaveLength(THEME_TOKEN_KEYS.length);
    }
  });

  it("getBuiltinTheme resolves known ids and returns undefined otherwise", () => {
    expect(getBuiltinTheme("terminal")?.id).toBe("terminal");
    expect(getBuiltinTheme("clarity")?.id).toBe("clarity");
    expect(getBuiltinTheme("nonexistent")).toBeUndefined();
  });
});

describe("terminal theme mirrors globals.css exactly", () => {
  it("keeps the pre-v0.2.1 palette untouched except the mut2 contrast fix", () => {
    expect(TERMINAL_THEME.tokens).toMatchObject({
      ink: "#0a0a0a",
      panel: "#121212",
      panel2: "#1a1a1a",
      panel3: "#202020",
      edge: "#262626",
      edge2: "#333333",
      fg: "#ededed",
      mut: "#9a9a9a",
      "lab-red": "#ff5f56",
      "lab-orange": "#ffaa44",
      "lab-yellow": "#f7d51d",
      "lab-green": "#4ade80",
      "lab-purple": "#c084fc",
      "lab-cyan": "#22d3ee",
      act: "#ffffff",
      "warn-soft": "#ff8a80",
    });
  });

  it("mut2 clears >=4.5:1 against every panel level (ink/panel/panel2/panel3)", () => {
    const mut2 = TERMINAL_THEME.tokens.mut2;
    for (const bg of ["ink", "panel", "panel2", "panel3"] as const) {
      expect(
        contrastRatio(mut2, TERMINAL_THEME.tokens[bg]),
        `mut2 vs ${bg}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("mut2 stays visibly darker than mut (hierarchy: fg > mut > mut2)", () => {
    const { fg, mut, mut2 } = TERMINAL_THEME.tokens;
    expect(luminance(fg)).toBeGreaterThan(luminance(mut));
    expect(luminance(mut)).toBeGreaterThan(luminance(mut2));
  });
});

describe("clarity theme contrast requirements", () => {
  it("mut clears >=7:1 against ink and panel", () => {
    const { mut, ink, panel } = CLARITY_THEME.tokens;
    expect(contrastRatio(mut, ink)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(mut, panel)).toBeGreaterThanOrEqual(7);
  });

  it("mut2 clears >=5:1 against ink and panel", () => {
    const { mut2, ink, panel } = CLARITY_THEME.tokens;
    expect(contrastRatio(mut2, ink)).toBeGreaterThanOrEqual(5);
    expect(contrastRatio(mut2, panel)).toBeGreaterThanOrEqual(5);
  });

  it("edge2 clears >=3:1 against panel (WCAG 1.4.11 UI-component contrast)", () => {
    const { edge2, panel } = CLARITY_THEME.tokens;
    expect(contrastRatio(edge2, panel)).toBeGreaterThanOrEqual(3);
  });

  it("keeps the fg > mut > mut2 legibility hierarchy", () => {
    const { fg, mut, mut2 } = CLARITY_THEME.tokens;
    expect(luminance(fg)).toBeGreaterThan(luminance(mut));
    expect(luminance(mut)).toBeGreaterThan(luminance(mut2));
  });

  it("every text tier clears WCAG AA body-text contrast (>=4.5:1) against ink/panel", () => {
    const { fg, mut, mut2, ink, panel } = CLARITY_THEME.tokens;
    for (const tier of [fg, mut, mut2]) {
      expect(contrastRatio(tier, ink)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tier, panel)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
