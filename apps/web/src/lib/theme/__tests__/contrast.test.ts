import { describe, expect, it } from "vitest";
import { contrastRatio, luminance } from "../contrast";

describe("luminance", () => {
  it("black is 0, white is 1", () => {
    expect(luminance("#000000")).toBeCloseTo(0, 5);
    expect(luminance("#ffffff")).toBeCloseTo(1, 5);
  });
});

describe("contrastRatio", () => {
  it("black vs white is exactly 21 (the WCAG maximum)", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("is order-independent (a,b) === (b,a)", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(contrastRatio("#ffffff", "#000000"));
  });

  it("identical colors have a ratio of exactly 1", () => {
    expect(contrastRatio("#4ade80", "#4ade80")).toBeCloseTo(1, 5);
  });

  it("matches a known reference pair (terminal fg vs ink, >= 4.5)", () => {
    // #ededed on #0a0a0a — pinned to a concrete floor rather than an
    // exact literal so this doesn't become a change-detector on any
    // future hand-tuning of these two builtin values.
    expect(contrastRatio("#ededed", "#0a0a0a")).toBeGreaterThanOrEqual(4.5);
  });
});
