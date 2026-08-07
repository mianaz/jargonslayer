// tasks/define.ts was the only module in lib/llm/tasks/ without a
// sibling test. finalizeDefineResult enforces its length ceilings in
// CODE rather than zod .max() precisely so an over-budget model reply
// still saves — which means nothing but these tests pins what actually
// gets clipped or defaulted before an entry lands in the user's
// glossary.
import { describe, expect, it } from "vitest";
import {
  buildDefineSystemPrompt,
  buildDefineUserMessage,
} from "@jargonslayer/core/llm/prompts";
import type { DefineResult } from "@jargonslayer/core/types";
import type { CallJsonOptions, ProviderCaller } from "../../providerCore";
import {
  DEFAULT_DEFINE_MODEL,
  runDefineTask,
  type DefineTaskInput,
} from "../define";

function baseInput(overrides: Partial<DefineTaskInput> = {}): DefineTaskInput {
  return {
    apiKey: "key",
    model: "model",
    provider: "anthropic",
    baseUrl: "",
    phrase: "circle back",
    context: "Let's circle back on this next week.",
    ...overrides,
  };
}

function baseRaw(overrides: Partial<DefineResult> = {}): DefineResult {
  return {
    kind: "expression",
    headword: "circle back",
    variants: [],
    chinese_explanation: "回头再聊",
    example: "Let's circle back after the demo.",
    ...overrides,
  };
}

function makeCall(response: DefineResult): ProviderCaller {
  return (async <T>(_opts: CallJsonOptions<T>): Promise<T> => response as T) as ProviderCaller;
}

/** Caller that records the options it was invoked with. */
function capturingCall(response: DefineResult): {
  call: ProviderCaller;
  seen: () => CallJsonOptions<DefineResult>;
} {
  let captured: CallJsonOptions<DefineResult> | undefined;
  const call = (async <T>(opts: CallJsonOptions<T>): Promise<T> => {
    captured = opts as unknown as CallJsonOptions<DefineResult>;
    return response as T;
  }) as ProviderCaller;
  return {
    call,
    seen: () => {
      if (!captured) throw new Error("provider caller never invoked");
      return captured;
    },
  };
}

describe("runDefineTask — provider wiring", () => {
  it("defaults lang to zh and sends the core prompt builders' exact output", async () => {
    const { call, seen } = capturingCall(baseRaw());
    await runDefineTask(baseInput({ profile: "biotech founder" }), call);

    const opts = seen();
    expect(opts.system).toBe(buildDefineSystemPrompt("zh"));
    expect(opts.user).toBe(
      buildDefineUserMessage("circle back", "Let's circle back on this next week.", "biotech founder"),
    );
    expect(opts.maxTokens).toBe(900);
    expect(opts.model).toBe("model");
    expect(opts.provider).toBe("anthropic");
  });

  it("passes lang 'en' through to the system prompt", async () => {
    const { call, seen } = capturingCall(baseRaw());
    await runDefineTask(baseInput({ lang: "en" }), call);
    expect(seen().system).toBe(buildDefineSystemPrompt("en"));
  });

  it("keeps the documented OpenRouter-safe default model", () => {
    expect(DEFAULT_DEFINE_MODEL).toBe("deepseek/deepseek-v4-flash");
  });
});

describe("runDefineTask — expression defaults", () => {
  it("fills category/meaning/plain_english/tone when the model omits them", async () => {
    const res = await runDefineTask(baseInput(), makeCall(baseRaw()));
    expect(res.category).toBe("other");
    expect(res.meaning).toBe("回头再聊"); // falls back to chinese_explanation
    expect(res.plain_english).toBe("circle back"); // falls back to headword
    expect(res.tone).toBe("neutral");
  });

  it("keeps model-provided expression fields, trimmed", async () => {
    const res = await runDefineTask(
      baseInput(),
      makeCall(
        baseRaw({
          category: "idiom",
          meaning: " revisit later ",
          plain_english: " talk again ",
          tone: " softened ",
        }),
      ),
    );
    expect(res.category).toBe("idiom");
    expect(res.meaning).toBe("revisit later");
    expect(res.plain_english).toBe("talk again");
    expect(res.tone).toBe("softened");
  });
});

describe("runDefineTask — term defaults", () => {
  it("fills termType/gloss_en and leaves expression-only fields unset", async () => {
    const res = await runDefineTask(
      baseInput({ phrase: "ARR" }),
      makeCall(baseRaw({ kind: "term", headword: "ARR", chinese_explanation: "年度经常性收入" })),
    );
    expect(res.kind).toBe("term");
    expect(res.termType).toBe("other");
    expect(res.gloss_en).toBe("年度经常性收入"); // falls back to chinese_explanation
    expect(res.category).toBeUndefined();
    expect(res.meaning).toBeUndefined();
    expect(res.plain_english).toBeUndefined();
    expect(res.tone).toBeUndefined();
  });
});

describe("runDefineTask — clamps and fallbacks", () => {
  it("falls back to the requested phrase when the model returns a blank headword", async () => {
    const res = await runDefineTask(
      baseInput({ phrase: "  table this  " }),
      makeCall(baseRaw({ headword: "   " })),
    );
    expect(res.headword).toBe("table this");
  });

  it("clips over-budget fields instead of failing the request", async () => {
    const res = await runDefineTask(
      baseInput(),
      makeCall(
        baseRaw({
          headword: "h".repeat(200),
          chinese_explanation: "解".repeat(120),
          example: "e".repeat(400),
        }),
      ),
    );
    expect(res.headword).toBe("h".repeat(120));
    expect(res.chinese_explanation).toBe("解".repeat(90));
    expect(res.example).toBe("e".repeat(300));
  });

  it("meaning's fallback uses the ALREADY-CLAMPED chinese_explanation", async () => {
    const res = await runDefineTask(
      baseInput(),
      makeCall(baseRaw({ chinese_explanation: "解".repeat(120), meaning: undefined })),
    );
    expect(res.meaning).toBe(res.chinese_explanation);
    expect(res.meaning).toHaveLength(90);
  });

  it("trims variants, drops blanks, and caps the list at 8", async () => {
    const variants = [
      " one ",
      "",
      "  ",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
    ];
    const res = await runDefineTask(baseInput(), makeCall(baseRaw({ variants })));
    expect(res.variants).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
    ]);
  });
});
