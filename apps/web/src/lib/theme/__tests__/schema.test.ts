import { describe, expect, it } from "vitest";
import { HEX_COLOR_RE, parseTheme, THEME_TOKEN_KEYS } from "../schema";
import { CLARITY_THEME, TERMINAL_LIGHT_THEME, TERMINAL_THEME } from "../themes";

// Baseline: a fully-valid theme built from every required token, so
// individual malicious-input tests below can start from a known-good
// object and corrupt exactly one field.
function validThemeTokens(): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const key of THEME_TOKEN_KEYS) tokens[key] = "#ffffff";
  return tokens;
}

describe("HEX_COLOR_RE", () => {
  it("accepts every strict hex form (3- and 6-digit only)", () => {
    expect(HEX_COLOR_RE.test("#fff")).toBe(true);
    expect(HEX_COLOR_RE.test("#ffffff")).toBe(true);
    expect(HEX_COLOR_RE.test("#0a0A1B")).toBe(true); // mixed case is fine
  });

  it("rejects the 4- and 8-digit alpha hex forms (v0.2.1: alpha is a Tailwind modifier, not part of a token's own value)", () => {
    expect(HEX_COLOR_RE.test("#ffff")).toBe(false);
    expect(HEX_COLOR_RE.test("#ffffffff")).toBe(false);
  });

  it("rejects non-hex color syntax and injection attempts", () => {
    expect(HEX_COLOR_RE.test("rgb(255,255,255)")).toBe(false);
    expect(HEX_COLOR_RE.test("hsl(0, 100%, 50%)")).toBe(false);
    expect(HEX_COLOR_RE.test("url(//evil.com/x.css)")).toBe(false);
    expect(HEX_COLOR_RE.test("expression(alert(1))")).toBe(false);
    expect(HEX_COLOR_RE.test("red")).toBe(false);
    expect(HEX_COLOR_RE.test("")).toBe(false);
    expect(HEX_COLOR_RE.test("#fff;background:url(//evil)")).toBe(false);
    expect(HEX_COLOR_RE.test("#ff")).toBe(false); // wrong length (2 digits)
    expect(HEX_COLOR_RE.test("#fffff")).toBe(false); // wrong length (5 digits)
    expect(HEX_COLOR_RE.test("#fffffg")).toBe(false); // non-hex char
    expect(HEX_COLOR_RE.test(" #ffffff")).toBe(false); // leading whitespace
    expect(HEX_COLOR_RE.test("#ffffff ")).toBe(false); // trailing whitespace
    expect(HEX_COLOR_RE.test("javascript:alert(1)")).toBe(false);
  });
});

describe("parseTheme", () => {
  it("accepts a fully well-formed theme", () => {
    const result = parseTheme({
      id: "custom",
      label: "自定义",
      scheme: "dark",
      tokens: validThemeTokens(),
    });
    expect(result.ok).toBe(true);
  });

  it("accepts every built-in theme", () => {
    expect(parseTheme(TERMINAL_THEME).ok).toBe(true);
    expect(parseTheme(TERMINAL_LIGHT_THEME).ok).toBe(true);
    expect(parseTheme(CLARITY_THEME).ok).toBe(true);
  });

  // v0.2.4: `scheme` is a required structural field — an external
  // theme that omits it would silently inherit the wrong UA chrome
  // (color-scheme) and header-icon rendition, so absence is a hard
  // reject rather than a defaulted "dark".
  it("rejects a theme without a scheme", () => {
    const result = parseTheme({
      id: "custom",
      label: "自定义",
      tokens: validThemeTokens(),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a scheme outside dark|light", () => {
    const result = parseTheme({
      id: "custom",
      label: "自定义",
      scheme: "sepia",
      tokens: validThemeTokens(),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a token with a CSS injection payload", () => {
    const tokens = validThemeTokens();
    tokens.fg = "#fff;background:url(//evil)";
    const result = parseTheme({ id: "evil", label: "evil", scheme: "dark", tokens });
    expect(result.ok).toBe(false);
  });

  it("rejects a token using url()", () => {
    const tokens = validThemeTokens();
    tokens.ink = "url(x)";
    const result = parseTheme({ id: "evil", label: "evil", scheme: "dark", tokens });
    expect(result.ok).toBe(false);
  });

  it("rejects a token using expression()", () => {
    const tokens = validThemeTokens();
    tokens.panel = "expression(alert(document.cookie))";
    const result = parseTheme({ id: "evil", label: "evil", scheme: "dark", tokens });
    expect(result.ok).toBe(false);
  });

  it("rejects a token using rgb()/hsl() (any non-hex CSS color form)", () => {
    const rgbTokens = validThemeTokens();
    rgbTokens.mut = "rgb(154, 154, 154)";
    expect(parseTheme({ id: "x", label: "x", scheme: "dark", tokens: rgbTokens }).ok).toBe(false);

    const hslTokens = validThemeTokens();
    hslTokens.mut = "hsl(0, 0%, 60%)";
    expect(parseTheme({ id: "x", label: "x", scheme: "dark", tokens: hslTokens }).ok).toBe(false);
  });

  it("rejects an empty-string token", () => {
    const tokens = validThemeTokens();
    tokens.act = "";
    const result = parseTheme({ id: "x", label: "x", scheme: "dark", tokens });
    expect(result.ok).toBe(false);
  });

  it("rejects a theme missing a required token", () => {
    const tokens = validThemeTokens();
    delete tokens["lab-cyan"];
    const result = parseTheme({ id: "x", label: "x", scheme: "dark", tokens });
    expect(result.ok).toBe(false);
  });

  it("rejects a theme missing id/label", () => {
    expect(parseTheme({ label: "x", scheme: "dark", tokens: validThemeTokens() }).ok).toBe(false);
    expect(parseTheme({ id: "x", scheme: "dark", tokens: validThemeTokens() }).ok).toBe(false);
  });

  it("rejects non-object input (null, array, string, number)", () => {
    expect(parseTheme(null).ok).toBe(false);
    expect(parseTheme(undefined).ok).toBe(false);
    expect(parseTheme([]).ok).toBe(false);
    expect(parseTheme("not a theme").ok).toBe(false);
    expect(parseTheme(42).ok).toBe(false);
  });

  it("rejects a token carrying a data: URI", () => {
    const tokens = validThemeTokens();
    tokens.edge2 = "data:text/html,<script>alert(1)</script>";
    const result = parseTheme({ id: "x", label: "x", scheme: "dark", tokens });
    expect(result.ok).toBe(false);
  });

  it("rejects a token using the 4- or 8-digit alpha hex form (v0.2.1: alpha belongs to Tailwind's utility-class modifier, not the token value — see schema.ts's HEX_COLOR_RE comment)", () => {
    const shortAlpha = validThemeTokens();
    shortAlpha.fg = "#ffff";
    expect(parseTheme({ id: "x", label: "x", scheme: "dark", tokens: shortAlpha }).ok).toBe(false);

    const longAlpha = validThemeTokens();
    longAlpha.fg = "#ffffffff";
    expect(parseTheme({ id: "x", label: "x", scheme: "dark", tokens: longAlpha }).ok).toBe(false);
  });
});
