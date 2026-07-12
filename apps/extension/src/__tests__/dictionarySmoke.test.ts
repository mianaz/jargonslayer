// Proves @jargonslayer/core resolves and runs correctly under this
// app's own tsconfig + Vite/vitest bundler resolution (npm workspace
// symlink + core's package.json "exports": {"./*": "./src/*.ts"}
// subpath-pattern map, consumed here exactly like apps/web does — see
// PLAN-v0.4 S6 requirement 7). NOT a re-test of scanDictionary's own
// matching logic — packages/core/src/detect/__tests__/dictionary.test.ts
// already covers that exhaustively; this only needs to prove the
// import resolves and returns real data in this workspace.

import { describe, expect, it } from "vitest";

import { scanDictionary } from "@jargonslayer/core/detect/dictionary";

describe("@jargonslayer/core resolution smoke test", () => {
  it("scans pasted text and finds a built-in expression and a built-in term", () => {
    const { expressions, terms } = scanDictionary(
      "Let's circle back on the ARR numbers next week.",
    );
    expect(expressions.some((e) => e.expression === "circle back")).toBe(true);
    expect(terms.some((t) => t.term === "ARR")).toBe(true);
    // Real dictionary data, not a stub — zh explanation is non-empty.
    const circleBack = expressions.find((e) => e.expression === "circle back");
    expect(circleBack?.chinese_explanation.length).toBeGreaterThan(0);
  });

  it("returns empty arrays for plain text with no jargon", () => {
    const { expressions, terms } = scanDictionary("The cat sat on the mat.");
    expect(expressions).toEqual([]);
    expect(terms).toEqual([]);
  });
});
