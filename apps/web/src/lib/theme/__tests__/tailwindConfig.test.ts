// Structural regression guard (v0.2.1 ship-blocking fix): a prior
// version of tailwind.config.ts declared its 17 color tokens as
// literal hex strings (e.g. fg: "#EDEDED"). Tailwind compiles those
// directly into every generated utility class (text-fg, bg-panel,
// border-edge, ...), so lib/theme/apply.ts's applyTheme() —
// setProperty on a CSS variable — had ZERO effect on them: switching
// to "clarity" only recolored hand-written CSS selectors in
// globals.css (.hl-expr, .btn-terminal, ...), leaving the vast
// majority of the actual UI on dead terminal-theme colors. This test
// asserts every token is instead the `rgb(var(--*-rgb) / <alpha-
// value>)` indirection the theme engine depends on, so that
// regression can't silently reappear.

import { describe, expect, it } from "vitest";
import tailwindConfig from "../../../../tailwind.config";
import { THEME_TOKEN_KEYS } from "../schema";

// Matches exactly `rgb(var(--<token>-rgb) / <alpha-value>)` — the
// Tailwind-recognized shape that lets opacity modifiers (text-fg/90,
// border-lab-orange/30, ...) substitute their alpha into the rgb()
// call at build time.
const RGB_VAR_ALPHA_RE = /^rgb\(var\(--[a-z0-9-]+-rgb\) \/ <alpha-value>\)$/;

describe("tailwind.config.ts colors — theme-engine integration contract", () => {
  const colors = (tailwindConfig.theme?.extend?.colors ?? {}) as Record<string, string>;

  it("defines all 17 theme tokens", () => {
    for (const key of THEME_TOKEN_KEYS) {
      expect(colors[key], `missing color: ${key}`).toBeDefined();
    }
  });

  it("every token value matches rgb(var(--*-rgb) / <alpha-value>) — never a literal hex", () => {
    for (const key of THEME_TOKEN_KEYS) {
      expect(colors[key], `${key} = ${JSON.stringify(colors[key])}`).toMatch(RGB_VAR_ALPHA_RE);
    }
  });

  it("each token's rgb(var(...)) variable name matches the token's own key", () => {
    for (const key of THEME_TOKEN_KEYS) {
      expect(colors[key]).toBe(`rgb(var(--${key}-rgb) / <alpha-value>)`);
    }
  });

  it("no token value is a bare literal hex string (regression guard)", () => {
    const hexLike = /^#[0-9a-fA-F]{3,8}$/;
    for (const key of THEME_TOKEN_KEYS) {
      expect(hexLike.test(colors[key]), `${key} looks like a literal hex value`).toBe(false);
    }
  });
});
