import { describe, expect, it } from "vitest";
import type { DetectResponse } from "@jargonslayer/core/types";
import type { CallJsonOptions, ProviderCaller } from "../../providerCore";
import { runDetectTask, type DetectTaskInput } from "../detect";

function makeCall(response: DetectResponse): ProviderCaller {
  return (async <T>(_opts: CallJsonOptions<T>): Promise<T> => response as T) as ProviderCaller;
}

function input(new_text: string): DetectTaskInput {
  return {
    apiKey: "key",
    model: "model",
    provider: "anthropic",
    baseUrl: "",
    context: "",
    new_text,
  };
}

describe("runDetectTask — source sentence post-filter", () => {
  it("replaces a sprawling LLM context with the source clause containing the expression", async () => {
    const runOn = "Now, as for the 2nd deliverable, I helped co-facilitate, uh, a face-to-face workshop for 3 days alongside our project manager, Hannah here, and assisted with event logistics and created a system in order to track and follow up on post-meeting tasks to make sure that the team was aligned post-meeting.";
    const res = await runDetectTask(
      input(runOn),
      makeCall({
        expressions: [
          {
            expression: "align",
            category: "phrase",
            meaning: "agree",
            chinese_explanation: "达成一致",
            plain_english: "agree",
            tone: "neutral",
            confidence: 0.9,
            source_sentence: runOn,
          },
        ],
        terms: [],
      }),
    );

    expect(res.expressions[0].source_sentence).toBe(
      "and assisted with event logistics and created a system in order to track and follow up on post-meeting tasks to make sure that the team was aligned post-meeting.",
    );
    expect(res.expressions[0].source_sentence.length).toBeLessThan(runOn.length);
  });
});
