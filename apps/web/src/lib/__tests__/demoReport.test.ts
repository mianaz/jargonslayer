import { describe, expect, it } from "vitest";
import type { ExpressionCard, TermCard, TranscriptSegment } from "@jargonslayer/core/types";
import { buildDemoReport, isDemoReport } from "../demoReport";

const FIRST_LINE =
  "Okay everyone, let's get the ball rolling. Thanks for joining, I know Q3 planning snuck up on us fast.";

function seg(index: number, text: string): TranscriptSegment {
  return { id: `s${index}`, index, startedAt: 0, endedAt: 0, text, engine: "demo" };
}

const card = (expression: string, count: number) =>
  ({
    id: expression,
    expression,
    category: "idiom",
    meaning: `${expression} meaning`,
    chinese_explanation: `${expression} 中文`,
    plain_english: "",
    tone: "",
    source_sentence: `a sentence with ${expression}`,
    count,
    source: "dictionary",
  }) as unknown as ExpressionCard;

const term = (t: string) =>
  ({ id: t, term: t, type: "acronym", gloss_en: `${t} en`, gloss_zh: `${t} 中文`, count: 1, source: "dictionary" }) as unknown as TermCard;

describe("buildDemoReport", () => {
  it("is marked as the demo report and never passes for an LLM result", () => {
    const r = buildDemoReport([], [], [], 42);
    expect(isDemoReport(r)).toBe(true);
    expect(r.generatedAt).toBe(42);
    expect(isDemoReport({ ...r, model: "claude-sonnet" })).toBe(false);
    expect(isDemoReport(null)).toBe(false);
  });

  it("aligns the bilingual transcript to the segments actually played, skipping unscripted text", () => {
    const r = buildDemoReport([seg(0, FIRST_LINE), seg(1, "an edited line")], [], []);
    expect(r.translations).toHaveLength(1);
    expect(r.translations[0].index).toBe(0);
    expect(r.translations[0].zh).toMatch(/^好，大家开始吧/);
  });

  it("builds flashcards from the run's own cards, most frequent expressions first, terms after", () => {
    const r = buildDemoReport([], [card("circle back", 1), card("boil the ocean", 3)], [term("ARR")]);
    expect(r.flashcards.map((f) => f.front)).toEqual(["boil the ocean", "circle back", "ARR"]);
    expect(r.flashcards[0]).toMatchObject({
      back_zh: "boil the ocean 中文",
      back_en: "boil the ocean meaning",
      example: "a sentence with boil the ocean",
    });
  });

  it("caps flashcards at 12", () => {
    const many = Array.from({ length: 20 }, (_, i) => card(`e${i}`, 1));
    expect(buildDemoReport([], many, []).flashcards).toHaveLength(12);
  });
});
