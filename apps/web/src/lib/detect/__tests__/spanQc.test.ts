import { describe, expect, it, vi } from "vitest";
import type { DetectedExpression, DetectResponse } from "@jargonslayer/core/types";
import { filterDetectSpans, isOversizedDetectSpan, type DetectSpanCaps } from "../spanQc";

// Matches DEFAULT_SETTINGS' own detectIdiomMaxWords/Chars (types.ts) —
// duplicated as a literal here rather than importing DEFAULT_SETTINGS
// so these tests pin the CONTRACT (whatever caps a caller passes in)
// rather than silently riding along with whatever the default happens
// to be at any given time.
const DEFAULT_CAPS: DetectSpanCaps = { idiomMaxWords: 12, idiomMaxChars: 90 };

function makeExpr(
  expression: string,
  category: DetectedExpression["category"] = "phrase",
): DetectedExpression {
  return {
    expression,
    category,
    meaning: "m",
    chinese_explanation: "z",
    plain_english: "p",
    tone: "t",
    confidence: 0.9,
    source_sentence: expression,
  };
}

describe("isOversizedDetectSpan — non-idiom categories (phrase/metaphor/indirect/other/unknown): TIGHT fixed cap, unchanged from pre-v0.4.5", () => {
  const nonIdiomCategories = ["phrase", "metaphor", "indirect", "other", "unrecognized-garbage"];

  for (const category of nonIdiomCategories) {
    it(`${category}: exactly 8 words is NOT oversized`, () => {
      expect(
        isOversizedDetectSpan("one two three four five six seven eight", category, DEFAULT_CAPS),
      ).toBe(false);
    });

    it(`${category}: 9 words IS oversized`, () => {
      expect(
        isOversizedDetectSpan(
          "one two three four five six seven eight nine",
          category,
          DEFAULT_CAPS,
        ),
      ).toBe(true);
    });
  }

  it("Latin: exactly 64 characters (few long words) is NOT oversized", () => {
    const expr = "a".repeat(64);
    expect(isOversizedDetectSpan(expr, "phrase", DEFAULT_CAPS)).toBe(false);
  });

  it("Latin: 65 characters IS oversized, even as a single 'word' with no spaces", () => {
    const expr = "a".repeat(65);
    expect(isOversizedDetectSpan(expr, "phrase", DEFAULT_CAPS)).toBe(true);
  });

  it("CJK: exactly 20 characters is NOT oversized", () => {
    expect(isOversizedDetectSpan("把".repeat(20), "phrase", DEFAULT_CAPS)).toBe(false);
  });

  it("CJK: 21 characters IS oversized", () => {
    expect(isOversizedDetectSpan("把".repeat(21), "phrase", DEFAULT_CAPS)).toBe(true);
  });

  it("mixed CJK+Latin uses the stricter CJK cap (20 chars), not the Latin word/char caps", () => {
    const expr = "ARR 拉起来" + "把".repeat(15);
    expect(expr.length).toBeGreaterThan(20);
    expect(isOversizedDetectSpan(expr, "phrase", DEFAULT_CAPS)).toBe(true);
  });

  it("a whole sentence (the reported bug) is correctly flagged oversized", () => {
    const wholeSentence =
      "The referee made a controversial offside call in the final minute of the match";
    expect(isOversizedDetectSpan(wholeSentence, "phrase", DEFAULT_CAPS)).toBe(true);
  });

  it("a genuine short phrase is not flagged", () => {
    expect(isOversizedDetectSpan("circle back", "phrase", DEFAULT_CAPS)).toBe(false);
    expect(isOversizedDetectSpan("table this", "metaphor", DEFAULT_CAPS)).toBe(false);
  });
});

describe("isOversizedDetectSpan — idiom/slang categories: RAISED, configurable cap", () => {
  // 8/9/12/13-word phrase-vs-idiom boundary table (task's own naming).
  it("8 words: oversized for phrase (tight cap), NOT oversized for idiom (raised cap)", () => {
    const eightWords = "one two three four five six seven eight";
    expect(isOversizedDetectSpan(eightWords, "phrase", DEFAULT_CAPS)).toBe(false); // exactly at tight cap
    expect(isOversizedDetectSpan(eightWords, "idiom", DEFAULT_CAPS)).toBe(false);
  });

  it("9 words: oversized for phrase (exceeds tight cap of 8), NOT oversized for idiom (well under raised cap of 12)", () => {
    const nineWords = "one two three four five six seven eight nine";
    expect(isOversizedDetectSpan(nineWords, "phrase", DEFAULT_CAPS)).toBe(true);
    expect(isOversizedDetectSpan(nineWords, "idiom", DEFAULT_CAPS)).toBe(false);
  });

  it("12 words: exactly at the raised idiom cap — NOT oversized for idiom or slang", () => {
    const twelveWords = "one two three four five six seven eight nine ten eleven twelve";
    expect(twelveWords.split(" ")).toHaveLength(12);
    expect(isOversizedDetectSpan(twelveWords, "idiom", DEFAULT_CAPS)).toBe(false);
    expect(isOversizedDetectSpan(twelveWords, "slang", DEFAULT_CAPS)).toBe(false);
  });

  it("13 words: exceeds the raised idiom cap — oversized for idiom and slang alike", () => {
    const thirteenWords =
      "one two three four five six seven eight nine ten eleven twelve thirteen";
    expect(thirteenWords.split(" ")).toHaveLength(13);
    expect(isOversizedDetectSpan(thirteenWords, "idiom", DEFAULT_CAPS)).toBe(true);
    expect(isOversizedDetectSpan(thirteenWords, "slang", DEFAULT_CAPS)).toBe(true);
  });

  it("respects a caller-supplied idiomMaxWords different from the default", () => {
    const nineWords = "one two three four five six seven eight nine";
    expect(isOversizedDetectSpan(nineWords, "idiom", { idiomMaxWords: 8, idiomMaxChars: 90 })).toBe(
      true,
    );
    expect(isOversizedDetectSpan(nineWords, "idiom", { idiomMaxWords: 9, idiomMaxChars: 90 })).toBe(
      false,
    );
  });

  it("idiomMaxChars: a single long no-space token exceeding it is oversized despite a words.length of 1", () => {
    const expr = "a".repeat(91);
    expect(isOversizedDetectSpan(expr, "idiom", DEFAULT_CAPS)).toBe(true);
    expect(isOversizedDetectSpan("a".repeat(90), "idiom", DEFAULT_CAPS)).toBe(false);
  });

  it("CJK idiom spans use the FIXED 30-char cap, NOT caps.idiomMaxChars — 30 is fine, 31 is not", () => {
    expect(isOversizedDetectSpan("把".repeat(30), "idiom", DEFAULT_CAPS)).toBe(false);
    expect(isOversizedDetectSpan("把".repeat(31), "idiom", DEFAULT_CAPS)).toBe(true);
  });

  it("the CJK idiom cap ignores caps.idiomMaxChars entirely (a very tight caller value has no effect on the CJK path)", () => {
    const tightCaps: DetectSpanCaps = { idiomMaxWords: 12, idiomMaxChars: 5 };
    // 25 CJK chars: over the tight cap.idiomMaxChars(5) if it were
    // (wrongly) applied, but under the fixed 30-char CJK idiom cap.
    expect(isOversizedDetectSpan("把".repeat(25), "idiom", tightCaps)).toBe(false);
  });
});

describe("isOversizedDetectSpan — sentence-terminator guard (all categories, drops regardless of cap)", () => {
  it("drops a CJK span with a full-width terminator glued mid-span with NO whitespace after it — the reported bug: real Chinese prose never spaces after 。/？/！", () => {
    expect(isOversizedDetectSpan("干得好。继续加油", "idiom", DEFAULT_CAPS)).toBe(true);
    expect(isOversizedDetectSpan("真的吗？还有呢", "idiom", DEFAULT_CAPS)).toBe(true);
  });

  it("drops a CJK span that ends with a full-width terminator", () => {
    expect(isOversizedDetectSpan("我们下周再讨论这个问题吧。", "idiom", DEFAULT_CAPS)).toBe(true);
  });

  it("drops a short whole Latin sentence that kept its terminal period, well under the raised idiom word cap (Sol's reported examples)", () => {
    expect(
      isOversizedDetectSpan("We should circle back on this next week.", "idiom", DEFAULT_CAPS),
    ).toBe(true);
    expect(
      isOversizedDetectSpan(
        "I think we should circle back on that tomorrow.",
        "phrase",
        DEFAULT_CAPS,
      ),
    ).toBe(true);
  });

  it("does NOT trigger on \"Mr. Right\" / \"U.S. Treasury\" — the internal period is never the span's LAST character", () => {
    expect(isOversizedDetectSpan("Mr. Right", "idiom", DEFAULT_CAPS)).toBe(false);
    expect(isOversizedDetectSpan("U.S. Treasury", "idiom", DEFAULT_CAPS)).toBe(false);
  });

  it('does NOT trigger on "e.g. foo" mid-span, for the same reason', () => {
    expect(isOversizedDetectSpan("e.g. foo", "phrase", DEFAULT_CAPS)).toBe(false);
  });

  it('does NOT trigger on "0.5x speedup" — the internal decimal point is never the span\'s LAST character', () => {
    expect(isOversizedDetectSpan("0.5x speedup", "phrase", DEFAULT_CAPS)).toBe(false);
  });

  it('does NOT trigger on an ellipsis with no terminal .?! and no full-width terminator ("well... anyway")', () => {
    expect(isOversizedDetectSpan("well... anyway", "idiom", DEFAULT_CAPS)).toBe(false);
  });

  it("does NOT trigger on a genuine short idiom with no sentence-ending shape at all, Latin or CJK", () => {
    expect(isOversizedDetectSpan("circle back", "idiom", DEFAULT_CAPS)).toBe(false);
    expect(isOversizedDetectSpan("burning the midnight oil", "idiom", DEFAULT_CAPS)).toBe(false);
    expect(isOversizedDetectSpan("raining cats and dogs", "idiom", DEFAULT_CAPS)).toBe(false);
    expect(isOversizedDetectSpan("画蛇添足", "idiom", DEFAULT_CAPS)).toBe(false);
  });
});

describe("filterDetectSpans — pure post-filter", () => {
  it("drops only the oversized/multi-sentence spans, keeping short ones and genuine idioms untouched", () => {
    const res: DetectResponse = {
      expressions: [
        makeExpr("circle back", "phrase"),
        makeExpr("one two three four five six seven eight nine ten", "phrase"), // tight cap exceeded
        makeExpr("burning the midnight oil", "idiom"), // short, genuine idiom, kept
        makeExpr("We should circle back on this next week.", "idiom"), // sentence-terminator guard drops it
      ],
      terms: [],
    };
    const filtered = filterDetectSpans(res, DEFAULT_CAPS);
    expect(filtered.expressions.map((e) => e.expression)).toEqual([
      "circle back",
      "burning the midnight oil",
    ]);
  });

  it("terms always pass through untouched, regardless of length", () => {
    const res: DetectResponse = {
      expressions: [],
      terms: [
        {
          term: "a very long term that would be oversized if it were an expression",
          type: "other",
          gloss_en: "e",
          gloss_zh: "z",
        },
      ],
    };
    const filtered = filterDetectSpans(res, DEFAULT_CAPS);
    expect(filtered.terms).toEqual(res.terms);
  });

  it("returns the SAME object reference when nothing was dropped (cheap no-op path)", () => {
    const res: DetectResponse = { expressions: [makeExpr("circle back")], terms: [] };
    expect(filterDetectSpans(res, DEFAULT_CAPS)).toBe(res);
  });

  it("calls onDrop with the exact dropped count, and never calls it when nothing was dropped", () => {
    const onDrop = vi.fn();
    const res: DetectResponse = {
      expressions: [
        makeExpr("circle back", "phrase"),
        makeExpr("one two three four five six seven eight nine ten", "phrase"),
        makeExpr("another one two three four five six seven eight nine", "phrase"),
      ],
      terms: [],
    };
    filterDetectSpans(res, DEFAULT_CAPS, onDrop);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(2);

    onDrop.mockClear();
    filterDetectSpans({ expressions: [makeExpr("circle back")], terms: [] }, DEFAULT_CAPS, onDrop);
    expect(onDrop).not.toHaveBeenCalled();
  });
});
