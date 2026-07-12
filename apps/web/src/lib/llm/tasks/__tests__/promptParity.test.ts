// v0.4 S2 design constraint #4 (prompt-cache preservation, PLAN-v0.4
// risk #4): proves the Next.js route and the client-side callProvider
// path produce BYTE-IDENTICAL system prompt + user/messages for
// identical fixture inputs, for every task — detect especially, since
// it is the only task with cacheSystem: true (Anthropic prompt
// caching keys on an exact system-string match; see providerCore.ts's
// buildSystemParam).
//
// This is not merely "call the same pure function twice and compare"
// (packages/core's own prompts.test.ts already proves the builders
// are deterministic) — it captures the CallJsonOptions each of TWO
// DIFFERENTLY-SHAPED ProviderCallers receives: one modeled on how
// app/api/*/route.ts injects anthropic.ts's withFallback(fallbackModel)
// wrapper (server-only concerns already resolved), the other modeled
// on how lib/llm/client.ts injects clientProvider.ts's
// callProviderDirect (BYOK-only, different apiKey/model/timeoutMs) —
// deliberately varying apiKey/model between the two so the assertion
// that system/user STILL match isn't vacuous. In practice route.ts and
// client.ts call the exact same tasks/*.ts function (not two forked
// implementations), so this is as much a regression guard against a
// future edit accidentally splitting that sharing as it is a parity
// proof today.
import { describe, expect, it } from "vitest";
import {
  buildDefineSystemPrompt,
  buildDefineUserMessage,
  buildDetectSystemPrompt,
  buildDetectUserMessage,
  buildSweepSystemPrompt,
  buildSweepUserMessage,
  buildTranslateSystemPrompt,
  buildTranslateUserMessage,
  SUMMARY_SYSTEM_PROMPT,
  TRANSLATE_SYSTEM_PROMPT,
} from "@jargonslayer/core/llm/prompts";
import type { CallJsonOptions, ProviderCaller } from "../../providerCore";
import { runDetectTask } from "../detect";
import { runDefineTask } from "../define";
import { runTranslateTask } from "../translate";
import { runSummarizeTask, type SummarizeLlmConfig } from "../summarize";

/** A ProviderCaller that records every CallJsonOptions it receives and
 *  answers with `fixtureFor(opts)` — modeling the SHAPE of a real
 *  caller (route-side withFallback(...) / client-side
 *  callProviderDirect) without any real network/SDK call. */
function capturingCaller(
  captured: CallJsonOptions<unknown>[],
  fixtureFor: (opts: CallJsonOptions<unknown>) => unknown,
): ProviderCaller {
  return async function capture<T>(opts: CallJsonOptions<T>): Promise<T> {
    captured.push(opts as CallJsonOptions<unknown>);
    return fixtureFor(opts as CallJsonOptions<unknown>) as T;
  };
}

describe("detect — route-shaped vs client-shaped caller: byte-identical system + user", () => {
  it("system is byte-identical to buildDetectSystemPrompt AND carries cacheSystem: true on BOTH sides (the actual prompt-cache guarantee)", async () => {
    const routeCalls: CallJsonOptions<unknown>[] = [];
    const clientCalls: CallJsonOptions<unknown>[] = [];
    const fixture = () => ({ expressions: [], terms: [] });

    await runDetectTask(
      {
        apiKey: "server-side-key-irrelevant",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        baseUrl: "",
        context: "previous context",
        new_text: "let's circle back on this",
        lang: "zh",
        profile: "行业：互联网",
      },
      capturingCaller(routeCalls, fixture),
    );

    await runDetectTask(
      {
        apiKey: "byok-user-key-DIFFERENT",
        model: "claude-sonnet-5", // deliberately a different model
        provider: "anthropic",
        baseUrl: "",
        context: "previous context",
        new_text: "let's circle back on this",
        lang: "zh",
        profile: "行业：互联网",
      },
      capturingCaller(clientCalls, fixture),
    );

    expect(routeCalls).toHaveLength(1);
    expect(clientCalls).toHaveLength(1);

    // system: byte-identical across both AND matches the shared
    // prompt-builder directly.
    expect(routeCalls[0].system).toBe(buildDetectSystemPrompt("zh"));
    expect(clientCalls[0].system).toBe(buildDetectSystemPrompt("zh"));
    expect(routeCalls[0].system).toBe(clientCalls[0].system);

    // cacheSystem: true on BOTH — the literal prompt-cache-survival
    // assertion (risk #4). A regression that dropped this on only the
    // client side would silently degrade caching for every desktop
    // user without changing the system TEXT at all.
    expect(routeCalls[0].cacheSystem).toBe(true);
    expect(clientCalls[0].cacheSystem).toBe(true);

    // user: byte-identical across both AND matches the shared builder.
    const expectedUser = buildDetectUserMessage(
      "previous context",
      "let's circle back on this",
      "行业：互联网",
    );
    expect(routeCalls[0].user).toBe(expectedUser);
    expect(clientCalls[0].user).toBe(expectedUser);

    // Sanity: model/apiKey (deliberately varied above) do NOT need to
    // match — only system/user are the shared-prompt-assembly contract.
    expect(routeCalls[0].model).not.toBe(clientCalls[0].model);
  });
});

describe("define — route-shaped vs client-shaped caller: byte-identical system + user", () => {
  it("matches buildDefineSystemPrompt/buildDefineUserMessage on both sides", async () => {
    const routeCalls: CallJsonOptions<unknown>[] = [];
    const clientCalls: CallJsonOptions<unknown>[] = [];
    const fixture = () => ({
      kind: "expression",
      headword: "circle back",
      variants: [],
      chinese_explanation: "z",
      example: "e",
    });

    const input = {
      phrase: "circle back",
      context: "We should circle back later.",
      lang: "en" as const,
      profile: "角色：工程师",
    };

    await runDefineTask(
      { apiKey: "server-key", model: "claude-haiku-4-5", provider: "anthropic" as const, baseUrl: "", ...input },
      capturingCaller(routeCalls, fixture),
    );
    await runDefineTask(
      { apiKey: "byok-key", model: "claude-opus-4-5", provider: "anthropic" as const, baseUrl: "", ...input },
      capturingCaller(clientCalls, fixture),
    );

    const expectedSystem = buildDefineSystemPrompt("en");
    const expectedUser = buildDefineUserMessage(input.phrase, input.context, input.profile);

    expect(routeCalls[0].system).toBe(expectedSystem);
    expect(clientCalls[0].system).toBe(expectedSystem);
    expect(routeCalls[0].user).toBe(expectedUser);
    expect(clientCalls[0].user).toBe(expectedUser);
  });
});

describe("translate — route-shaped vs client-shaped caller: byte-identical system + user", () => {
  it("matches buildTranslateSystemPrompt/buildTranslateUserMessage on both sides", async () => {
    const routeCalls: CallJsonOptions<unknown>[] = [];
    const clientCalls: CallJsonOptions<unknown>[] = [];
    const fixture = () => ({ translations: [] });

    const segments = [{ id: "seg-0", text: "We shipped it." }];

    await runTranslateTask(
      { apiKey: "server-key", model: "claude-haiku-4-5", provider: "anthropic" as const, baseUrl: "", segments, lang: "zh" },
      capturingCaller(routeCalls, fixture),
    );
    await runTranslateTask(
      { apiKey: "byok-key", model: "claude-sonnet-5", provider: "anthropic" as const, baseUrl: "", segments, lang: "zh" },
      capturingCaller(clientCalls, fixture),
    );

    const expectedSystem = buildTranslateSystemPrompt("zh");
    const expectedUser = buildTranslateUserMessage(segments);

    expect(routeCalls[0].system).toBe(expectedSystem);
    expect(clientCalls[0].system).toBe(expectedSystem);
    expect(routeCalls[0].user).toBe(expectedUser);
    expect(clientCalls[0].user).toBe(expectedUser);
  });
});

describe("summarize — route-shaped vs client-shaped caller: byte-identical system + user for all 3 stages", () => {
  it("summary stage matches SUMMARY_SYSTEM_PROMPT verbatim on both sides", async () => {
    const routeCalls: CallJsonOptions<unknown>[] = [];
    const clientCalls: CallJsonOptions<unknown>[] = [];
    const fixture = (opts: CallJsonOptions<unknown>) => {
      if (opts.system === SUMMARY_SYSTEM_PROMPT) {
        return { topic: { en: "", zh: "" }, key_points: [], decisions: [], action_items: [] };
      }
      if (opts.system === TRANSLATE_SYSTEM_PROMPT) return { translations: [] };
      return { expressions: [], terms: [] }; // sweep
    };

    const llm: SummarizeLlmConfig = { provider: "anthropic", baseUrl: "" };
    const segments = [{ index: 0, text: "We shipped the ARR dashboard." }];

    await runSummarizeTask(
      { apiKey: "server-key", model: "claude-sonnet-5", llm, segments, expressions: [], terms: [], lang: "zh", profile: "行业：互联网" },
      capturingCaller(routeCalls, fixture),
    );
    await runSummarizeTask(
      { apiKey: "byok-key", model: "claude-opus-5", llm, segments, expressions: [], terms: [], lang: "zh", profile: "行业：互联网" },
      capturingCaller(clientCalls, fixture),
    );

    const routeSummaryCall = routeCalls.find((c) => c.system === SUMMARY_SYSTEM_PROMPT);
    const clientSummaryCall = clientCalls.find((c) => c.system === SUMMARY_SYSTEM_PROMPT);
    expect(routeSummaryCall).toBeDefined();
    expect(clientSummaryCall).toBeDefined();
    expect(routeSummaryCall!.user).toBe(clientSummaryCall!.user);
  });

  it("translation-chunk stage matches TRANSLATE_SYSTEM_PROMPT verbatim, and the chunk user payload is byte-identical, on both sides", async () => {
    const routeCalls: CallJsonOptions<unknown>[] = [];
    const clientCalls: CallJsonOptions<unknown>[] = [];
    const fixture = (opts: CallJsonOptions<unknown>) => {
      if (opts.system === SUMMARY_SYSTEM_PROMPT) {
        return { topic: { en: "", zh: "" }, key_points: [], decisions: [], action_items: [] };
      }
      if (opts.system === TRANSLATE_SYSTEM_PROMPT) return { translations: [] };
      return { expressions: [], terms: [] };
    };

    const llm: SummarizeLlmConfig = { provider: "anthropic", baseUrl: "" };
    const segments = [
      { index: 0, text: "We shipped the ARR dashboard." },
      { index: 1, text: "Next up is the churn model." },
    ];

    await runSummarizeTask(
      { apiKey: "server-key", model: "claude-sonnet-5", llm, segments, expressions: [], terms: [], lang: "zh" },
      capturingCaller(routeCalls, fixture),
    );
    await runSummarizeTask(
      { apiKey: "byok-key", model: "claude-opus-5", llm, segments, expressions: [], terms: [], lang: "zh" },
      capturingCaller(clientCalls, fixture),
    );

    const routeChunk = routeCalls.find((c) => c.system === TRANSLATE_SYSTEM_PROMPT);
    const clientChunk = clientCalls.find((c) => c.system === TRANSLATE_SYSTEM_PROMPT);
    expect(routeChunk).toBeDefined();
    expect(clientChunk).toBeDefined();
    expect(routeChunk!.user).toBe(clientChunk!.user);
    expect(routeChunk!.user).toBe(JSON.stringify(segments.map((s) => ({ i: s.index, en: s.text }))));
  });

  it("sweep stage matches buildSweepSystemPrompt/buildSweepUserMessage verbatim on both sides", async () => {
    const routeCalls: CallJsonOptions<unknown>[] = [];
    const clientCalls: CallJsonOptions<unknown>[] = [];
    const fixture = (opts: CallJsonOptions<unknown>) => {
      if (opts.system === SUMMARY_SYSTEM_PROMPT) {
        return { topic: { en: "", zh: "" }, key_points: [], decisions: [], action_items: [] };
      }
      if (opts.system === TRANSLATE_SYSTEM_PROMPT) return { translations: [] };
      return { expressions: [], terms: [] };
    };

    const llm: SummarizeLlmConfig = { provider: "anthropic", baseUrl: "" };
    const segments = [{ index: 0, text: "We discussed circling back on pricing." }];
    const expressions = [
      {
        expression: "circle back",
        category: "phrase" as const,
        meaning: "m",
        chinese_explanation: "z",
        plain_english: "p",
        tone: "t",
        confidence: 0.9,
        source_sentence: "s",
      },
    ];

    await runSummarizeTask(
      { apiKey: "server-key", model: "claude-sonnet-5", llm, segments, expressions, terms: [], lang: "en", profile: "英语水平：初级" },
      capturingCaller(routeCalls, fixture),
    );
    await runSummarizeTask(
      { apiKey: "byok-key", model: "claude-opus-5", llm, segments, expressions, terms: [], lang: "en", profile: "英语水平：初级" },
      capturingCaller(clientCalls, fixture),
    );

    const expectedSystem = buildSweepSystemPrompt("en");
    const expectedUser = buildSweepUserMessage(
      "We discussed circling back on pricing.",
      ["circle back"],
      "英语水平：初级",
    );

    const routeSweep = routeCalls.find((c) => c.system === expectedSystem);
    const clientSweep = clientCalls.find((c) => c.system === expectedSystem);
    expect(routeSweep).toBeDefined();
    expect(clientSweep).toBeDefined();
    expect(routeSweep!.user).toBe(expectedUser);
    expect(clientSweep!.user).toBe(expectedUser);
  });
});
