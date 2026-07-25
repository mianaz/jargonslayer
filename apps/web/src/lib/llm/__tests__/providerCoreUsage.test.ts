// Usage-ledger instrumentation (v0.6 T2) — the local, private ledger
// (lib/usage/ledger.ts) that lets a BYOK user see what their own keys
// are being spent on. Covers both provider families providerCore.ts can
// observe a completed call for: openai-compat (full response, real
// token counts, recorded in callJsonOpenAiCompat) and the Anthropic
// family (recorded in anthropic.ts's own callJson at its messages.parse
// success point — S6 fix, v0.6 round-2 review — plus generically in
// parseJsonContent for the manual-extraction fallback path; see each
// site's own doc comment). Kept separate from providerCore.test.ts
// (sanitizeProviderExcerpt/key-leak focused) so this file's own
// idb-keyval mock + `indexedDB` global stub never perturbs that one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import type { CallJsonOptions } from "../providerCore";

const memStore = new Map<string, unknown>();

vi.mock("idb-keyval", () => ({
  get: vi.fn(async (key: string) => memStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    memStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    memStore.delete(key);
  }),
}));

// S6 fix (v0.6 round-2 review) — no existing test in this repo mocks
// @anthropic-ai/sdk at all, so anthropic.ts's own callJson (the
// messages.parse primary path) had zero unit coverage of its own
// internal logic. Minimal mock: a constructable default export whose
// `.messages.parse`/`.messages.create` are plain vi.fn()s, plus
// placeholder AuthenticationError/RateLimitError classes (callJson's
// own catch block does `instanceof` checks against them — undefined
// would throw a TypeError there instead of falling through to the
// fallback path). zodOutputFormat is left real/un-mocked — it's a pure
// schema transform with no network/side effects.
const { mockMessagesParse, mockMessagesCreate } = vi.hoisted(() => ({
  mockMessagesParse: vi.fn(),
  mockMessagesCreate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class AuthenticationError extends Error {}
  class RateLimitError extends Error {}
  class MockAnthropic {
    messages = { parse: mockMessagesParse, create: mockMessagesCreate };
    constructor(_opts: { apiKey: string }) {}
  }
  return {
    default: Object.assign(MockAnthropic, { AuthenticationError, RateLimitError }),
  };
});

// Every recordUsage() call is deliberately fire-and-forget (T2 — never
// awaited by callJsonOpenAiCompat/parseJsonContent, so a ledger write
// never adds latency to a real provider call) — its whole async chain
// (storage.loadSettings -> ensureLoaded -> persist) runs entirely on the
// microtask queue via the mocked idb-keyval above, so a single queued
// macrotask (setTimeout 0) is enough to guarantee it has fully settled
// by the time this resolves, no matter how many awaits deep the chain
// is (microtasks always fully drain before the next macrotask runs).
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function chatCompletionResponse(
  content: string,
  opts: {
    status?: number;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } = {},
): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      ...(opts.usage ? { usage: opts.usage } : {}),
    }),
    { status: opts.status ?? 200, headers: { "Content-Type": "application/json" } },
  );
}

const TrivialSchema = z.object({ ok: z.boolean() });

function baseOpts(
  overrides: Partial<CallJsonOptions<{ ok: boolean }>> = {},
): CallJsonOptions<{ ok: boolean }> {
  return {
    apiKey: "test-key",
    model: "test-model",
    system: "sys",
    user: "usr",
    schema: TrivialSchema,
    maxTokens: 100,
    provider: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    ...overrides,
  };
}

describe("providerCore.ts — usage-ledger instrumentation (T2)", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  describe("openai-compat — callJsonOpenAiCompat", () => {
    it("records exactly one `calls` row plus real token counts on a first-try success", async () => {
      const { callJsonOpenAiCompat } = await import("../providerCore");
      const ledger = await import("../../usage/ledger");
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            chatCompletionResponse('{"ok":true}', { usage: { prompt_tokens: 120, completion_tokens: 30 } }),
          ),
      );

      const result = await callJsonOpenAiCompat(baseOpts());
      expect(result).toEqual({ ok: true });
      await flush();

      const records = await ledger.getUsage();
      const byMetric = Object.fromEntries(records.map((r) => [r.metric, r.value]));
      expect(byMetric).toEqual({ calls: 1, inputTokens: 120, outputTokens: 30 });
      expect(records.every((r) => r.provider === "openrouter.ai" && r.kind === "llm")).toBe(true);
    });

    // S6 fix (v0.6 round-2 review): records BOTH completed HTTP
    // responses — the first (billable-but-malformed) attempt AND the
    // retry — not just the retry's. Fails against pre-fix
    // callJsonOpenAiCompat, which only recorded usage inside the
    // try's SUCCESS path: a parse failure on the first attempt used to
    // discard its already-billed usage entirely, undercounting by
    // exactly one completed call every time a repair retry fired. This
    // is not double-counting — two separate provider requests really
    // were made and really were billed.
    it("records BOTH completed calls when a repair retry was needed — the first attempt's usage is never dropped", async () => {
      const { callJsonOpenAiCompat } = await import("../providerCore");
      const ledger = await import("../../usage/ledger");
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          chatCompletionResponse("no json here at all", {
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        )
        .mockResolvedValueOnce(
          chatCompletionResponse('{"ok":true}', { usage: { prompt_tokens: 40, completion_tokens: 8 } }),
        );
      vi.stubGlobal("fetch", fetchMock);

      await callJsonOpenAiCompat(baseOpts());
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await flush();

      const records = await ledger.getUsage();
      expect(records.find((r) => r.metric === "calls")?.value).toBe(2);
      // Both attempts' token counts SUM into the same bucket (10+40,
      // 5+8) — the ledger aggregates by (day, provider, kind, metric),
      // not per-call.
      expect(records.find((r) => r.metric === "inputTokens")?.value).toBe(50);
      expect(records.find((r) => r.metric === "outputTokens")?.value).toBe(13);
    });

    // S6 fix: a response that never produces valid JSON is still TWO
    // real, completed, billable provider calls — "failed to parse" is
    // not "never happened". Fails against pre-fix code, which recorded
    // nothing at all here (both attempts' usage was discarded, since
    // neither one's own try-block success path was ever reached).
    it("still records both completed calls even when BOTH attempts fail to parse (the overall call still throws)", async () => {
      const { callJsonOpenAiCompat, BadOutputError } = await import("../providerCore");
      const ledger = await import("../../usage/ledger");
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(chatCompletionResponse("still no json"))
          .mockResolvedValueOnce(chatCompletionResponse("nope, still nothing")),
      );

      await expect(callJsonOpenAiCompat(baseOpts())).rejects.toBeInstanceOf(BadOutputError);
      await flush();
      const records = await ledger.getUsage();
      expect(records.find((r) => r.metric === "calls")?.value).toBe(2);
    });

    it("records only `calls` (no token rows) when the response carries no usage block", async () => {
      const { callJsonOpenAiCompat } = await import("../providerCore");
      const ledger = await import("../../usage/ledger");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(chatCompletionResponse('{"ok":true}')));

      await callJsonOpenAiCompat(baseOpts());
      await flush();
      const records = await ledger.getUsage();
      expect(records.map((r) => r.metric)).toEqual(["calls"]);
    });

    it("attributes usage to the base URL's hostname rather than a generic 'openai-compat' bucket", async () => {
      const { callJsonOpenAiCompat } = await import("../providerCore");
      const ledger = await import("../../usage/ledger");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(chatCompletionResponse('{"ok":true}')));

      await callJsonOpenAiCompat(baseOpts({ baseUrl: "https://api.deepseek.com/v1" }));
      await flush();
      const records = await ledger.getUsage();
      expect(records[0].provider).toBe("api.deepseek.com");
    });

    it("falls back to the literal 'openai-compat' bucket when baseUrl fails to parse", async () => {
      const { callJsonOpenAiCompat } = await import("../providerCore");
      const ledger = await import("../../usage/ledger");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(chatCompletionResponse('{"ok":true}')));

      await callJsonOpenAiCompat(baseOpts({ baseUrl: "not-a-valid-url" }));
      await flush();
      const records = await ledger.getUsage();
      expect(records[0].provider).toBe("openai-compat");
    });

    it("never throws (and still returns the parsed result) when the ledger's IDB write rejects", async () => {
      const idb = await import("idb-keyval");
      vi.mocked(idb.set).mockRejectedValue(new Error("boom"));
      const { callJsonOpenAiCompat } = await import("../providerCore");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(chatCompletionResponse('{"ok":true}')));

      await expect(callJsonOpenAiCompat(baseOpts())).resolves.toEqual({ ok: true });
      await flush(); // the rejected persist() must not surface as an unhandled rejection
    });
  });

  describe("Anthropic family — parseJsonContent's own generic hook", () => {
    it("records a call-only (no tokens) row, attributed to 'anthropic'", async () => {
      const { parseJsonContent } = await import("../providerCore");
      const ledger = await import("../../usage/ledger");

      parseJsonContent('{"ok":true}', baseOpts({ provider: "anthropic", baseUrl: undefined }));
      await flush();

      const records = await ledger.getUsage();
      expect(records).toEqual([
        expect.objectContaining({ provider: "anthropic", kind: "llm", metric: "calls", value: 1 }),
      ]);
    });

    it("defaults to 'anthropic' when opts.provider is left unset (CallJsonOptions' own default)", async () => {
      const { parseJsonContent } = await import("../providerCore");
      const ledger = await import("../../usage/ledger");

      const opts = baseOpts({ baseUrl: undefined });
      delete (opts as { provider?: unknown }).provider;
      parseJsonContent('{"ok":true}', opts);
      await flush();

      const records = await ledger.getUsage();
      expect(records[0].provider).toBe("anthropic");
    });

    it("never fires for an openai-compat call (would double-count callJsonOpenAiCompat's own recording)", async () => {
      const { parseJsonContent } = await import("../providerCore");
      const ledger = await import("../../usage/ledger");

      parseJsonContent('{"ok":true}', baseOpts());
      await flush();

      expect(await ledger.getUsage()).toEqual([]);
    });
  });

  // S6 fix (v0.6 round-2 review): anthropic.ts's callJson — the
  // messages.parse() PRIMARY path (the common case: every normal
  // Anthropic structured-output call that doesn't need the manual-
  // extraction fallback) used to return message.parsed_output directly
  // on success WITHOUT ever reaching parseJsonContent (the SDK already
  // validated it server-side) — so it recorded NOTHING at all. Only the
  // rarer fallback path (callJsonViaFallback, which DOES funnel through
  // parseJsonContent) ever recorded anything. Fails against pre-fix
  // anthropic.ts: ledger.getUsage() would be empty after a successful
  // call here.
  describe("Anthropic family — anthropic.ts's own messages.parse() primary-path recording", () => {
    beforeEach(() => {
      mockMessagesParse.mockReset();
      mockMessagesCreate.mockReset();
    });

    it("records real token counts (not just call-count) at the messages.parse() success point", async () => {
      mockMessagesParse.mockResolvedValue({
        parsed_output: { ok: true },
        usage: { input_tokens: 200, output_tokens: 50 },
      });
      const { callJson } = await import("../anthropic");
      const ledger = await import("../../usage/ledger");

      const result = await callJson(baseOpts({ provider: "anthropic", baseUrl: undefined }));

      expect(result).toEqual({ ok: true });
      expect(mockMessagesCreate).not.toHaveBeenCalled(); // fallback never engaged
      await flush();

      const records = await ledger.getUsage();
      const byMetric = Object.fromEntries(records.map((r) => [r.metric, r.value]));
      expect(byMetric).toEqual({ calls: 1, inputTokens: 200, outputTokens: 50 });
      expect(records.every((r) => r.provider === "anthropic")).toBe(true);
    });

    it("a null parsed_output falls through to the manual-extraction fallback, which records itself via parseJsonContent (no double-count from the primary path)", async () => {
      mockMessagesParse.mockResolvedValue({
        parsed_output: null,
        usage: { input_tokens: 999, output_tokens: 999 }, // must NOT be recorded — this path never reaches the primary success point
      });
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: "text", text: '{"ok":true}' }],
      });
      const { callJson } = await import("../anthropic");
      const ledger = await import("../../usage/ledger");

      const result = await callJson(baseOpts({ provider: "anthropic", baseUrl: undefined }));

      expect(result).toEqual({ ok: true });
      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
      await flush();

      // Exactly ONE calls:1 row (the fallback's own, via parseJsonContent)
      // — never the primary path's 999/999 tokens.
      const records = await ledger.getUsage();
      expect(records).toEqual([
        expect.objectContaining({ provider: "anthropic", kind: "llm", metric: "calls", value: 1 }),
      ]);
    });
  });
});
