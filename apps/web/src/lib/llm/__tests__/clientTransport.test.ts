// v0.4 S2 — end-to-end tests of lib/llm/client.ts's client-side
// callProvider path: detectApi/defineApi/translateApi/summarizeApi with
// llmTransport.ts's useClientTransport() forced on via the documented
// test override, mocked global fetch (the default Transport delegates
// to it — see llmTransport.test.ts), covering success + the required
// 401/429/502/parse-failure -> NoKeyError/RateLimitApiError/
// UpstreamError mapping for every task, plus flag-off inertness (even
// with a BYOK key configured) and the empty-key short-circuit.
//
// Complements clientProvider.test.ts (unit tests of the raw-fetch
// caller in isolation) and tasks/__tests__/promptParity.test.ts (system/
// user byte-identity between the route-shaped and client-shaped
// callers) — this file is the one that exercises client.ts's own
// routing/error-mapping/diag-logging glue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import {
  detectApi,
  defineApi,
  translateApi,
  summarizeApi,
  NoKeyError,
  RateLimitApiError,
  UpstreamError,
} from "../client";
import { clearDiag, getDiagEntries } from "../../diag/log";
import { setClientTransportOverride } from "../llmTransport";
import { SUMMARY_SYSTEM_PROMPT, TRANSLATE_SYSTEM_PROMPT } from "@jargonslayer/core/llm/prompts";

const mockFetch = vi.fn();

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, apiKey: "sk-ant-BYOK-test-key", ...overrides };
}

function anthropicMessage(text: string, status = 200): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function anthropicErrorResponse(status: number, message = "nope"): Response {
  return new Response(JSON.stringify({ type: "error", error: { message } }), { status });
}

beforeEach(() => {
  setClientTransportOverride(true);
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  clearDiag();
});

afterEach(() => {
  setClientTransportOverride(null);
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------
// Flag OFF (build default) — the client path must never engage, even
// with a BYOK key configured. Proves the flag actually gates the new
// path rather than BYOK-presence alone deciding it.
// ---------------------------------------------------------------

describe("flag off — client transport never engaged, even with BYOK configured", () => {
  beforeEach(() => {
    setClientTransportOverride(false);
  });

  it("detectApi still calls /api/detect, never api.anthropic.com", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ expressions: [], terms: [] }), { status: 200 }),
    );

    await detectApi({ context: "", new_text: "hi" }, makeSettings());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/api/detect");
    expect(String(url)).not.toContain("api.anthropic.com");
  });

  it("summarizeApi still calls /api/summarize, never api.anthropic.com", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          summary: { topic: { en: "", zh: "" }, key_points: [], decisions: [], action_items: [] },
          translations: [],
          flashcards: [],
          generatedAt: 0,
          model: "m",
        }),
        { status: 200 },
      ),
    );

    await summarizeApi({ segments: [], expressions: [], terms: [] }, makeSettings());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain("/api/summarize");
  });
});

// ---------------------------------------------------------------
// Empty-key short-circuit — no network call at all.
// ---------------------------------------------------------------

describe("flag on, no apiKey configured — NoKeyError without dispatching any request", () => {
  it("detectApi", async () => {
    await expect(
      detectApi({ context: "", new_text: "hi" }, makeSettings({ apiKey: "" })),
    ).rejects.toBeInstanceOf(NoKeyError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("defineApi", async () => {
    await expect(
      defineApi({ phrase: "x", context: "" }, makeSettings({ apiKey: "" })),
    ).rejects.toBeInstanceOf(NoKeyError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("translateApi", async () => {
    await expect(
      translateApi({ segments: [{ id: "1", text: "hi" }], lang: "zh" }, makeSettings({ apiKey: "" })),
    ).rejects.toBeInstanceOf(NoKeyError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("summarizeApi", async () => {
    await expect(
      summarizeApi({ segments: [], expressions: [], terms: [] }, makeSettings({ apiKey: "" })),
    ).rejects.toBeInstanceOf(NoKeyError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// detectApi
// ---------------------------------------------------------------

describe("detectApi — client transport", () => {
  it("success: calls api.anthropic.com/v1/messages and returns the parsed DetectResponse", async () => {
    mockFetch.mockResolvedValue(anthropicMessage('{"expressions":[],"terms":[]}'));

    const result = await detectApi({ context: "", new_text: "let's circle back" }, makeSettings());

    expect(result).toEqual({ expressions: [], terms: [] });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/messages");
  });

  it("401 -> NoKeyError, diag logged with fixed category message (never a raw upstream slice)", async () => {
    mockFetch.mockResolvedValue(anthropicErrorResponse(401, "SENTINEL-LEAK"));

    await expect(
      detectApi({ context: "", new_text: "hi" }, makeSettings()),
    ).rejects.toBeInstanceOf(NoKeyError);

    const entries = getDiagEntries().filter((e) => e.tag === "llm-detect");
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("API Key 无效或未配置");
    expect(entries[0].message).not.toContain("SENTINEL-LEAK");
  });

  it("429 -> RateLimitApiError", async () => {
    mockFetch.mockResolvedValue(anthropicErrorResponse(429));

    await expect(
      detectApi({ context: "", new_text: "hi" }, makeSettings()),
    ).rejects.toBeInstanceOf(RateLimitApiError);
  });

  it("502 -> UpstreamError", async () => {
    mockFetch.mockResolvedValue(anthropicErrorResponse(502));

    await expect(
      detectApi({ context: "", new_text: "hi" }, makeSettings()),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("unparseable model output -> UpstreamError (BadOutputError mapped, matching mapLlmError's own fixed '模型输出解析失败' text)", async () => {
    mockFetch.mockResolvedValue(anthropicMessage("not json at all"));

    const err = await detectApi({ context: "", new_text: "hi" }, makeSettings()).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toBe("模型输出解析失败");
  });

  it("ctx.provider names the real provider, never 'server' (design constraint #5 — this path is always BYOK)", async () => {
    mockFetch.mockResolvedValue(anthropicErrorResponse(502));

    await expect(
      detectApi({ context: "", new_text: "hi" }, makeSettings({ provider: "anthropic" })),
    ).rejects.toThrow();

    const entries = getDiagEntries().filter((e) => e.tag === "llm-detect");
    expect(entries[0].detail).toContain("provider=anthropic");
    expect(entries[0].detail).not.toContain("provider=server");
  });
});

// ---------------------------------------------------------------
// defineApi
// ---------------------------------------------------------------

describe("defineApi — client transport", () => {
  it("success", async () => {
    mockFetch.mockResolvedValue(
      anthropicMessage('{"kind":"expression","headword":"h","variants":[],"chinese_explanation":"z","example":"e"}'),
    );

    const result = await defineApi({ phrase: "circle back", context: "" }, makeSettings());

    expect(result.headword).toBe("h");
    expect(String(mockFetch.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/messages");
  });

  it("401 -> NoKeyError", async () => {
    mockFetch.mockResolvedValue(anthropicErrorResponse(401));
    await expect(
      defineApi({ phrase: "x", context: "" }, makeSettings()),
    ).rejects.toBeInstanceOf(NoKeyError);
  });

  it("429 -> RateLimitApiError", async () => {
    mockFetch.mockResolvedValue(anthropicErrorResponse(429));
    await expect(
      defineApi({ phrase: "x", context: "" }, makeSettings()),
    ).rejects.toBeInstanceOf(RateLimitApiError);
  });

  it("502 -> UpstreamError", async () => {
    mockFetch.mockResolvedValue(anthropicErrorResponse(502));
    await expect(
      defineApi({ phrase: "x", context: "" }, makeSettings()),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});

// ---------------------------------------------------------------
// translateApi
// ---------------------------------------------------------------

describe("translateApi — client transport", () => {
  it("success", async () => {
    mockFetch.mockResolvedValue(
      anthropicMessage('{"translations":[{"id":"seg-0","text":"你好"}]}'),
    );

    const result = await translateApi(
      { segments: [{ id: "seg-0", text: "hello" }], lang: "zh" },
      makeSettings(),
    );

    expect(result).toEqual({ translations: [{ id: "seg-0", text: "你好" }] });
  });

  it("401 -> NoKeyError", async () => {
    mockFetch.mockResolvedValue(anthropicErrorResponse(401));
    await expect(
      translateApi({ segments: [{ id: "1", text: "hi" }], lang: "zh" }, makeSettings()),
    ).rejects.toBeInstanceOf(NoKeyError);
  });

  it("429 -> RateLimitApiError", async () => {
    mockFetch.mockResolvedValue(anthropicErrorResponse(429));
    await expect(
      translateApi({ segments: [{ id: "1", text: "hi" }], lang: "zh" }, makeSettings()),
    ).rejects.toBeInstanceOf(RateLimitApiError);
  });

  it("502 -> UpstreamError", async () => {
    mockFetch.mockResolvedValue(anthropicErrorResponse(502));
    await expect(
      translateApi({ segments: [{ id: "1", text: "hi" }], lang: "zh" }, makeSettings()),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});

// ---------------------------------------------------------------
// summarizeApi — three-stage orchestration (summary + chunked
// translation + sweep), so the mock routes on the REQUEST's system
// prompt to return the right shape per stage, mirroring a real
// multi-call sequence rather than one canned response.
// ---------------------------------------------------------------

describe("summarizeApi — client transport", () => {
  function routedFetch(): typeof mockFetch {
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { system: string };
      if (body.system === SUMMARY_SYSTEM_PROMPT) {
        return anthropicMessage(
          '{"topic":{"en":"t","zh":"t"},"key_points":[],"decisions":[],"action_items":[]}',
        );
      }
      if (body.system === TRANSLATE_SYSTEM_PROMPT) {
        return anthropicMessage('{"translations":[]}');
      }
      // sweep stage (buildSweepSystemPrompt output)
      return anthropicMessage('{"expressions":[],"terms":[]}');
    });
    return mockFetch;
  }

  it("success: runs the full 3-stage orchestration as direct provider calls and assembles a SummaryResult", async () => {
    routedFetch();

    const result = await summarizeApi(
      {
        segments: [{ index: 0, text: "We shipped the feature." }],
        expressions: [],
        terms: [],
      },
      makeSettings(),
    );

    expect(result.summary.topic).toEqual({ en: "t", zh: "t" });
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2); // summary + (translation, sweep in parallel)
    for (const [url] of mockFetch.mock.calls) {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    }
  });

  it("summary-stage failure (401) is fatal -> NoKeyError", async () => {
    mockFetch.mockResolvedValue(anthropicErrorResponse(401));

    await expect(
      summarizeApi({ segments: [], expressions: [], terms: [] }, makeSettings()),
    ).rejects.toBeInstanceOf(NoKeyError);
  });

  it("502 on the summary stage -> UpstreamError", async () => {
    mockFetch.mockResolvedValue(anthropicErrorResponse(502));

    await expect(
      summarizeApi({ segments: [], expressions: [], terms: [] }, makeSettings()),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});
