// tasks/translate.ts (the id-keyed live per-segment path) had no
// sibling unit test — its whole job beyond prompt wiring is postFilter:
// silently dropping any model-returned row whose id wasn't requested,
// so a hallucinated id can never inject a row and a missing one
// surfaces as failed-soft in translate/queue.ts rather than an error.
import { describe, expect, it } from "vitest";
import {
  buildTranslateSystemPrompt,
  buildTranslateUserMessage,
} from "@jargonslayer/core/llm/prompts";
import type { TranslateResponse } from "@jargonslayer/core/types";
import type { CallJsonOptions, ProviderCaller } from "../../providerCore";
import {
  DEFAULT_TRANSLATE_MODEL,
  runTranslateTask,
  type TranslateTaskInput,
} from "../translate";

function baseInput(overrides: Partial<TranslateTaskInput> = {}): TranslateTaskInput {
  return {
    apiKey: "key",
    model: "model",
    provider: "anthropic",
    baseUrl: "",
    segments: [
      { id: "s1", text: "we need more runway" },
      { id: "s2", text: "let's table this" },
    ],
    lang: "zh",
    ...overrides,
  };
}

function makeCall(response: TranslateResponse): ProviderCaller {
  return (async <T>(_opts: CallJsonOptions<T>): Promise<T> => response as T) as ProviderCaller;
}

describe("runTranslateTask — provider wiring", () => {
  it("sends the core prompt builders' exact output and the bare-array tolerance key", async () => {
    let captured: CallJsonOptions<TranslateResponse> | undefined;
    const call = (async <T>(opts: CallJsonOptions<T>): Promise<T> => {
      captured = opts as unknown as CallJsonOptions<TranslateResponse>;
      return { translations: [] } as T;
    }) as ProviderCaller;

    const input = baseInput();
    await runTranslateTask(input, call);

    expect(captured?.system).toBe(buildTranslateSystemPrompt("zh"));
    expect(captured?.user).toBe(buildTranslateUserMessage(input.segments));
    expect(captured?.maxTokens).toBe(2000);
    // The hosted models commonly return a bare top-level array; this is
    // the key providerCore uses to re-wrap it before schema validation.
    expect(captured?.arrayKey).toBe("translations");
  });

  it("keeps the documented OpenRouter-safe default model", () => {
    expect(DEFAULT_TRANSLATE_MODEL).toBe("deepseek/deepseek-v4-flash");
  });
});

describe("runTranslateTask — postFilter", () => {
  it("passes through a well-formed response in the model's own order", async () => {
    const res = await runTranslateTask(
      baseInput(),
      makeCall({
        translations: [
          { id: "s2", text: "先搁置这个" },
          { id: "s1", text: "我们需要更多资金缓冲" },
        ],
      }),
    );
    expect(res.translations).toEqual([
      { id: "s2", text: "先搁置这个" },
      { id: "s1", text: "我们需要更多资金缓冲" },
    ]);
  });

  it("drops a row whose id was never requested (hallucinated id)", async () => {
    const res = await runTranslateTask(
      baseInput(),
      makeCall({
        translations: [
          { id: "s1", text: "我们需要更多资金缓冲" },
          { id: "s99", text: "不存在的段落" },
        ],
      }),
    );
    expect(res.translations).toEqual([{ id: "s1", text: "我们需要更多资金缓冲" }]);
  });

  it("omits a segment the model skipped instead of failing the batch (failed-soft contract)", async () => {
    const res = await runTranslateTask(
      baseInput(),
      makeCall({ translations: [{ id: "s2", text: "先搁置这个" }] }),
    );
    expect(res.translations).toEqual([{ id: "s2", text: "先搁置这个" }]);
  });

  it("tolerates an entirely empty translations list", async () => {
    const res = await runTranslateTask(baseInput(), makeCall({ translations: [] }));
    expect(res.translations).toEqual([]);
  });
});
