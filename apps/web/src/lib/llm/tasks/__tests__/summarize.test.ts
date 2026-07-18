// v0.4.5 detect-span QC (item 6, field bug follow-up): the post-
// meeting missed-item sweep (runSweepStage) had NO span-length QC at
// all before this fix — an oversized/whole-sentence expression the
// sweep LLM call tagged despite the prompt-level constraint reached
// buildFlashcards untouched. RED against the pre-fix code (no
// filterDetectSpans call in runSweepStage at all): the oversized
// expression below would have survived into the returned flashcards.
import { afterEach, describe, expect, it } from "vitest";
import { SUMMARY_SYSTEM_PROMPT, TRANSLATE_SYSTEM_PROMPT } from "@jargonslayer/core/llm/prompts";
import type { DetectedExpression } from "@jargonslayer/core/types";
import { runSummarizeTask, type SummarizeTaskInput } from "../summarize";
import type { CallJsonOptions, ProviderCaller } from "../../providerCore";
import { resetLlmTelemetry, useLlmTelemetry } from "../../telemetry";

const OVERSIZED_SENTENCE =
  "The referee made a controversial offside call in the final minute of the match";

function sweepExpr(
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

/** Routes by system prompt, mirroring promptParity.test.ts's own
 *  `fixtureFor` — summary/translate get minimal valid fixtures, and
 *  every other system (i.e. the sweep stage's) returns
 *  `sweepExpressions` untouched, exactly what a real LLM call would
 *  hand back before this fix's post-filter runs. */
function makeCall(sweepExpressions: DetectedExpression[]): ProviderCaller {
  return (async <T>(opts: CallJsonOptions<T>): Promise<T> => {
    if (opts.system === SUMMARY_SYSTEM_PROMPT) {
      return { topic: { en: "t", zh: "t" }, key_points: [], decisions: [], action_items: [] } as T;
    }
    if (opts.system === TRANSLATE_SYSTEM_PROMPT) {
      return { translations: [] } as T;
    }
    return { expressions: sweepExpressions, terms: [] } as T;
  }) as ProviderCaller;
}

function baseInput(overrides: Partial<SummarizeTaskInput> = {}): SummarizeTaskInput {
  return {
    apiKey: "key",
    model: "model",
    llm: { provider: "anthropic", baseUrl: "" },
    segments: [{ index: 0, text: "We shipped the ARR dashboard." }],
    expressions: [],
    terms: [],
    ...overrides,
  };
}

afterEach(() => resetLlmTelemetry());

describe("runSummarizeTask — sweep-stage detect-span QC (v0.4.5 item 6, the sweep gap)", () => {
  it("drops an oversized sweep-tagged expression before it reaches the returned flashcards, keeping a short one", async () => {
    const call = makeCall([sweepExpr("circle back"), sweepExpr(OVERSIZED_SENTENCE)]);

    const result = await runSummarizeTask(baseInput(), call);

    expect(result.flashcards.map((f) => f.front)).toEqual(["circle back"]);
  });

  it("returns the sweep's drop count as sweepQcDropped, WITHOUT recording it to telemetry itself (F4: client.ts is the single place that records — see its own comment)", async () => {
    const call = makeCall([sweepExpr(OVERSIZED_SENTENCE)]);

    const result = await runSummarizeTask(baseInput(), call);

    expect(result.sweepQcDropped).toBe(1);
    expect(useLlmTelemetry.getState().summary.qcDropped).toBe(0);
  });

  it("sweepQcDropped is 0 when nothing was dropped", async () => {
    const call = makeCall([sweepExpr("circle back")]);

    const result = await runSummarizeTask(baseInput(), call);

    expect(result.sweepQcDropped).toBe(0);
  });

  it("a genuine short idiom from the sweep survives untouched (no false-positive drop)", async () => {
    const call = makeCall([sweepExpr("burning the midnight oil", "idiom")]);

    const result = await runSummarizeTask(baseInput(), call);

    expect(result.flashcards.map((f) => f.front)).toEqual(["burning the midnight oil"]);
  });

  it("honors a caller-supplied spanQcCaps override rather than always falling back to the default", async () => {
    // 9 words, category "idiom": within the default idiom cap (12
    // words) but NOT within a caller-supplied tighter cap of 8.
    const nineWordIdiom = "one two three four five six seven eight nine";
    const call = makeCall([sweepExpr(nineWordIdiom, "idiom")]);

    const result = await runSummarizeTask(
      baseInput({ spanQcCaps: { idiomMaxWords: 8, idiomMaxChars: 90 } }),
      call,
    );

    expect(result.flashcards.map((f) => f.front)).toEqual([]);
  });
});
