// Most tests here run the accumulator against the REAL
// @jargonslayer/core dictionary (same "circle back" / "ARR" fixtures
// S6's ../../__tests__/dictionarySmoke.test.ts uses) — proves
// createAccumulator's wiring against actual dictionary data, not
// invented fixtures. The confidence-floor test is the one exception:
// every built-in dictionary entry ships at a fixed confidence of 0.9
// (see packages/core/src/detect/dictionary-data.ts), so there is no
// real text that naturally produces a sub-floor (<0.55) expression to
// prove exclusion against. That single test wraps the real
// scanDictionary in a spy (vi.importActual, same partial-mock idiom
// apps/web/src/lib/detect/__tests__/scheduler.test.ts already uses for
// this exact module) and overrides its return value for one call only
// — every other test in this file still exercises the real dictionary.

import { describe, expect, it, vi } from "vitest";

vi.mock("@jargonslayer/core/detect/dictionary", async () => {
  const actual = await vi.importActual<typeof import("@jargonslayer/core/detect/dictionary")>(
    "@jargonslayer/core/detect/dictionary",
  );
  return { ...actual, scanDictionary: vi.fn(actual.scanDictionary) };
});

import { scanDictionary } from "@jargonslayer/core/detect/dictionary";
import { createAccumulator } from "../accumulator";

describe("createAccumulator", () => {
  it("starts with empty cards and terms", () => {
    const acc = createAccumulator();
    expect(acc.snapshot()).toEqual({ cards: [], terms: [] });
  });

  it("accumulates dictionary hits from finalized text", () => {
    const acc = createAccumulator();
    const { cards, terms } = acc.addFinal("Let's circle back on the ARR numbers next week.");

    expect(cards.some((c) => c.expression === "circle back")).toBe(true);
    expect(terms.some((t) => t.term === "ARR")).toBe(true);
    expect(cards.find((c) => c.expression === "circle back")?.count).toBe(1);
    expect(cards.find((c) => c.expression === "circle back")?.source).toBe("dictionary");
  });

  it("bumps count on a repeat mention instead of duplicating the card", () => {
    const acc = createAccumulator();
    acc.addFinal("Let's circle back on this next week.");
    const { cards } = acc.addFinal("We should circle back with the team again tomorrow.");

    const circleBack = cards.filter((c) => c.expression === "circle back");
    expect(circleBack).toHaveLength(1);
    expect(circleBack[0].count).toBe(2);
  });

  it("excludes an expression below the confidence floor (minConfidence 0.55)", () => {
    const acc = createAccumulator();
    vi.mocked(scanDictionary).mockReturnValueOnce({
      expressions: [
        {
          expression: "low confidence phrase",
          category: "phrase",
          meaning: "x",
          chinese_explanation: "x",
          plain_english: "x",
          tone: "x",
          confidence: 0.3,
          source_sentence: "a low confidence phrase appears here.",
        },
      ],
      terms: [],
    });

    const { cards } = acc.addFinal("a low confidence phrase appears here.");
    expect(cards).toHaveLength(0);
  });

  it("does not let a below-floor mock bleed into the next (unmocked) call", () => {
    const acc = createAccumulator();
    vi.mocked(scanDictionary).mockReturnValueOnce({
      expressions: [
        {
          expression: "low confidence phrase",
          category: "phrase",
          meaning: "x",
          chinese_explanation: "x",
          plain_english: "x",
          tone: "x",
          confidence: 0.3,
          source_sentence: "a low confidence phrase appears here.",
        },
      ],
      terms: [],
    });
    acc.addFinal("a low confidence phrase appears here.");

    // mockReturnValueOnce only affects the single call above — this
    // call runs the real (spied-through) scanDictionary again.
    const { cards } = acc.addFinal("Let's circle back on this.");
    expect(cards.some((c) => c.expression === "circle back")).toBe(true);
  });

  it("returns new array instances on each mutating call", () => {
    const acc = createAccumulator();
    const first = acc.addFinal("Let's circle back on this.");
    const second = acc.addFinal("The ARR grew nicely this quarter.");

    expect(second.cards).not.toBe(first.cards);
    expect(second.terms).not.toBe(first.terms);
  });

  it("no-ops on empty or whitespace-only text (same array references, no wasted merge)", () => {
    const acc = createAccumulator();
    acc.addFinal("Let's circle back on this.");
    const before = acc.snapshot();

    const afterEmpty = acc.addFinal("");
    expect(afterEmpty.cards).toBe(before.cards);
    expect(afterEmpty.terms).toBe(before.terms);

    const afterWhitespace = acc.addFinal("   \n\t  ");
    expect(afterWhitespace.cards).toBe(before.cards);
    expect(afterWhitespace.terms).toBe(before.terms);
  });
});
