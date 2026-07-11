import { describe, expect, it } from "vitest";
import type { DetectResponse } from "@jargonslayer/core/types";
import { filterSuppressed } from "../suppress";
import type { LearnRecord } from "@jargonslayer/core/learn/types";

function makeRecord(key: string, overrides: Partial<LearnRecord> = {}): LearnRecord {
  return {
    learnKey: key,
    kind: key.startsWith("term:") ? "term" : "expression",
    surface: key.replace(/^(expression|term):/, ""),
    familiarity: 1,
    suppressed: true,
    suppressedAt: 1000,
    reps: 0,
    intervalDays: 0,
    ease: 2.5,
    dueAt: 1000,
    lapses: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

const response: DetectResponse = {
  expressions: [
    {
      expression: "circle back",
      category: "phrase",
      meaning: "return to this topic",
      chinese_explanation: "回头再聊",
      plain_english: "talk later",
      tone: "neutral",
      confidence: 0.9,
      source_sentence: "Let's circle back.",
    },
    {
      expression: "touch base",
      category: "phrase",
      meaning: "check in",
      chinese_explanation: "碰一下",
      plain_english: "check in",
      tone: "neutral",
      confidence: 0.9,
      source_sentence: "Let's touch base.",
    },
  ],
  terms: [
    {
      term: "ARR",
      type: "metric",
      gloss_en: "Annual Recurring Revenue",
      gloss_zh: "年度经常性收入",
    },
    {
      term: "runway",
      type: "metric",
      gloss_en: "cash remaining duration",
      gloss_zh: "现金可支撑时间",
    },
  ],
};

describe("filterSuppressed", () => {
  it("returns the same response for an empty learnset", () => {
    expect(filterSuppressed(response, "dictionary", {})).toEqual(response);
  });

  it("does not suppress custom-source detections", () => {
    const learnset = {
      "expression:circle back": makeRecord("expression:circle back"),
      "term:ARR": makeRecord("term:ARR"),
    };

    expect(filterSuppressed(response, "custom", learnset)).toBe(response);
  });

  it("drops suppressed expressions and terms for dictionary/llm sources", () => {
    const learnset = {
      "expression:circle back": makeRecord("expression:circle back"),
      "term:ARR": makeRecord("term:ARR"),
    };

    expect(filterSuppressed(response, "dictionary", learnset)).toEqual({
      expressions: [response.expressions[1]],
      terms: [response.terms[1]],
    });
    expect(filterSuppressed(response, "llm", learnset)).toEqual({
      expressions: [response.expressions[1]],
      terms: [response.terms[1]],
    });
  });

  it("keeps matching records that are not currently suppressed", () => {
    const learnset = {
      "expression:circle back": makeRecord("expression:circle back", {
        suppressed: false,
      }),
    };

    expect(filterSuppressed(response, "dictionary", learnset)).toEqual(response);
  });
});
