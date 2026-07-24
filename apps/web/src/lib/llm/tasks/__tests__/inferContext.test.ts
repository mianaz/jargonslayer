// Auto meeting-context detection (field request: "need AI to auto
// detect the context for better detection") — runInferContextTask
// coverage: happy path, empty-context passthrough, and the sanitize
// step (trim + hard-cap at 80 chars). Mirrors tasks/correct.ts's own
// test shape (makeCall/baseInput helpers).
import { describe, expect, it } from "vitest";
import type { CallJsonOptions, ProviderCaller } from "../../providerCore";
import { DEFAULT_INFER_CONTEXT_MODEL, runInferContextTask, type InferContextTaskInput } from "../inferContext";
import type { InferContextResponse } from "@jargonslayer/core/types";

function baseInput(overrides: Partial<InferContextTaskInput> = {}): InferContextTaskInput {
  return {
    apiKey: "key",
    model: "model",
    provider: "anthropic",
    baseUrl: "",
    excerpt: "We're kicking off the single-cell RNA-seq analysis for the new cohort.",
    ...overrides,
  };
}

function makeCall(response: InferContextResponse): ProviderCaller {
  return (async <T>(_opts: CallJsonOptions<T>): Promise<T> => response as T) as ProviderCaller;
}

describe("runInferContextTask — happy path", () => {
  it("returns the trimmed context unchanged when well within budget", async () => {
    const res = await runInferContextTask(
      baseInput(),
      makeCall({ context: "生物信息学组会（单细胞转录组方向），面向研究生" }),
    );
    expect(res.context).toBe("生物信息学组会（单细胞转录组方向），面向研究生");
  });

  it("forwards the excerpt into the provider call's user message via EXCERPT:", async () => {
    let capturedUser = "";
    const call: ProviderCaller = (async <T>(opts: CallJsonOptions<T>): Promise<T> => {
      capturedUser = opts.user;
      return { context: "" } as T;
    }) as ProviderCaller;

    await runInferContextTask(baseInput({ excerpt: "some early transcript text" }), call);

    expect(capturedUser).toBe("EXCERPT:\nsome early transcript text");
  });

  it("defaults lang to zh (Chinese system prompt) when omitted", async () => {
    let capturedSystem = "";
    const call: ProviderCaller = (async <T>(opts: CallJsonOptions<T>): Promise<T> => {
      capturedSystem = opts.system;
      return { context: "" } as T;
    }) as ProviderCaller;

    await runInferContextTask(baseInput(), call);

    expect(capturedSystem).toContain("生物信息学");
  });

  it("uses the English system prompt when lang is 'en'", async () => {
    let capturedSystem = "";
    const call: ProviderCaller = (async <T>(opts: CallJsonOptions<T>): Promise<T> => {
      capturedSystem = opts.system;
      return { context: "" } as T;
    }) as ProviderCaller;

    await runInferContextTask(baseInput({ lang: "en" }), call);

    expect(capturedSystem).toContain("bioinformatics");
  });
});

describe("runInferContextTask — empty-context passthrough", () => {
  it("a genuinely empty model reply passes through as an empty string (caller's job to treat as 'no result')", async () => {
    const res = await runInferContextTask(baseInput(), makeCall({ context: "" }));
    expect(res.context).toBe("");
  });

  it("a whitespace-only model reply trims down to empty", async () => {
    const res = await runInferContextTask(baseInput(), makeCall({ context: "   " }));
    expect(res.context).toBe("");
  });
});

describe("runInferContextTask — overlong sanitize (trim + hard-cap at 80 chars)", () => {
  it("trims leading/trailing whitespace", async () => {
    const res = await runInferContextTask(baseInput(), makeCall({ context: "  生物信息学组会  " }));
    expect(res.context).toBe("生物信息学组会");
  });

  it("hard-caps a reply over 80 chars at exactly 80", async () => {
    const overlong = "a".repeat(120);
    const res = await runInferContextTask(baseInput(), makeCall({ context: overlong }));
    expect(res.context).toBe("a".repeat(80));
    expect(res.context.length).toBe(80);
  });

  it("leaves a reply at exactly 80 chars unchanged", async () => {
    const exact = "a".repeat(80);
    const res = await runInferContextTask(baseInput(), makeCall({ context: exact }));
    expect(res.context).toBe(exact);
  });

  it("trims THEN caps (a padded-then-overlong reply is trimmed before the 80-char slice)", async () => {
    const padded = `  ${"b".repeat(90)}  `;
    const res = await runInferContextTask(baseInput(), makeCall({ context: padded }));
    expect(res.context).toBe("b".repeat(80));
  });
});

describe("DEFAULT_INFER_CONTEXT_MODEL", () => {
  it("rides the same DeepSeek OpenRouter slug the detect/define/correct tasks default to", () => {
    expect(DEFAULT_INFER_CONTEXT_MODEL).toBe("deepseek/deepseek-v4-flash");
  });
});
