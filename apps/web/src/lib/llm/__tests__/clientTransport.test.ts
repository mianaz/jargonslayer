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
import { MAX_SEGMENTS, MAX_TOTAL_SEGMENT_CHARS, SUMMARIZE_TOO_LARGE_MESSAGE } from "../tasks/summarize";

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

// ---------------------------------------------------------------
// F4 (codex v04-integration review) — the Next.js route enforces
// MAX_SEGMENTS/MAX_TOTAL_SEGMENT_CHARS as an HTTP-input-validation
// guard (app/api/summarize/route.ts); the client (BYOK) path had none
// at all, so an unbounded marathon meeting could freeze the UI thread
// building unbounded strings/chunk lists. Both caps are enforced
// BEFORE requireApiKey (matching the route's own ordering — see
// summarizeViaClient) and BEFORE any network dispatch, so these tests
// assert zero fetch calls too, not just the thrown error shape.
// ---------------------------------------------------------------

describe("summarizeApi — client transport — request-size caps (F4)", () => {
  it(`rejects more than ${MAX_SEGMENTS} segments with the route's exact user-facing message, no provider call dispatched`, async () => {
    const segments = Array.from({ length: MAX_SEGMENTS + 1 }, (_, i) => ({ index: i, text: "a" }));

    const err = await summarizeApi(
      { segments, expressions: [], terms: [] },
      makeSettings(),
    ).catch((e) => e);

    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toBe(SUMMARIZE_TOO_LARGE_MESSAGE);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it(`exactly ${MAX_SEGMENTS} segments is NOT rejected by the segment-count cap (dispatches normally)`, async () => {
    // mockImplementation (fresh Response per call), not
    // mockResolvedValue (same Response instance reused) — summarize
    // dispatches 3 concurrent-ish upstream calls per attempt, and a
    // shared Response's body can only be read once.
    mockFetch.mockImplementation(async () =>
      anthropicMessage('{"topic":{"en":"t","zh":"t"},"key_points":[],"decisions":[],"action_items":[]}'),
    );
    const segments = Array.from({ length: MAX_SEGMENTS }, (_, i) => ({ index: i, text: "a" }));

    // Not rejected by THIS cap: the size guard runs BEFORE any
    // dispatch (see summarizeViaClient), so "the guard didn't block
    // it" is provable directly — mockFetch WAS reached — regardless of
    // whatever happens afterward (success/some other unrelated error).
    await summarizeApi({ segments, expressions: [], terms: [] }, makeSettings()).catch(() => {});

    expect(mockFetch).toHaveBeenCalled();
  });

  it(`rejects a total segment length over ${MAX_TOTAL_SEGMENT_CHARS} chars with the route's exact user-facing message, no provider call dispatched`, async () => {
    // 500 segments * 900 chars = 450,000 > 400,000, segment COUNT well
    // under MAX_SEGMENTS — isolates the char-total cap specifically.
    const segments = Array.from({ length: 500 }, (_, i) => ({ index: i, text: "a".repeat(900) }));

    const err = await summarizeApi(
      { segments, expressions: [], terms: [] },
      makeSettings(),
    ).catch((e) => e);

    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toBe(SUMMARIZE_TOO_LARGE_MESSAGE);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects even when no apiKey is configured — the size guard fires BEFORE key resolution, matching the route's own order", async () => {
    const segments = Array.from({ length: MAX_SEGMENTS + 1 }, (_, i) => ({ index: i, text: "a" }));

    const err = await summarizeApi(
      { segments, expressions: [], terms: [] },
      makeSettings({ apiKey: "" }),
    ).catch((e) => e);

    // NOT NoKeyError — the size cap is checked first (see
    // summarizeViaClient's own ordering comment).
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toBe(SUMMARIZE_TOO_LARGE_MESSAGE);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("logs a diag entry for the rejection, tagged llm-summary", async () => {
    const segments = Array.from({ length: MAX_SEGMENTS + 1 }, (_, i) => ({ index: i, text: "a" }));

    await summarizeApi({ segments, expressions: [], terms: [] }, makeSettings()).catch(() => {});

    const entries = getDiagEntries().filter((e) => e.tag === "llm-summary");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[entries.length - 1].message).toBe(SUMMARIZE_TOO_LARGE_MESSAGE);
  });

  it("a well-under-cap request is never rejected by either cap (sanity check the guard isn't overly aggressive)", async () => {
    // mockImplementation (fresh Response per call), not
    // mockResolvedValue (same Response instance reused) — summarize
    // dispatches 3 concurrent-ish upstream calls per attempt, and a
    // shared Response's body can only be read once.
    mockFetch.mockImplementation(async () =>
      anthropicMessage('{"topic":{"en":"t","zh":"t"},"key_points":[],"decisions":[],"action_items":[]}'),
    );

    const result = await summarizeApi(
      { segments: [{ index: 0, text: "a small meeting" }], expressions: [], terms: [] },
      makeSettings(),
    );

    expect(result.summary.topic).toEqual({ en: "t", zh: "t" });
    expect(mockFetch).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// F1 (codex v04-integration review) — an echoing/hostile endpoint on
// the client (BYOK) path must never leak the caller's own API key
// through ANY observable surface: the thrown error's message (user-
// facing toast), the diag ring buffer, or a fail-soft console.warn.
// Complements clientProvider.test.ts/providerCore.test.ts, which prove
// the sanitation at its actual construction seam — this proves it
// holds end-to-end through client.ts's real error-mapping/diag-logging
// glue and tasks/summarize.ts's real fail-soft catches, not just at
// the seam in isolation.
// ---------------------------------------------------------------

describe("detectApi — client transport — echoing endpoint never leaks the BYOK key (F1)", () => {
  const SECRET = "sk-ant-BYOK-key-that-must-never-leak";

  it("thrown UpstreamError.message never contains the key, and no diag entry (message or detail) contains it either", async () => {
    mockFetch.mockResolvedValue(
      anthropicErrorResponse(502, `upstream said your header was: Authorization: Bearer ${SECRET}`),
    );

    const err = await detectApi(
      { context: "", new_text: "hi" },
      makeSettings({ apiKey: SECRET }),
    ).catch((e) => e);

    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).not.toContain(SECRET);

    const entries = getDiagEntries().filter((e) => e.tag === "llm-detect");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.message).not.toContain(SECRET);
      expect(entry.detail ?? "").not.toContain(SECRET);
    }
  });
});

describe("summarizeApi — client transport — echoing endpoint never leaks the BYOK key into console.warn (F1, tasks/summarize.ts's fail-soft catches)", () => {
  const SECRET = "sk-ant-BYOK-summarize-key-must-never-leak";

  it("translation-chunk + repair-pass + sweep stage failures still resolve (fail-soft, unchanged behavior) and never put the key into any console.warn call", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { system: string };
        if (body.system === SUMMARY_SYSTEM_PROMPT) {
          return anthropicMessage(
            '{"topic":{"en":"t","zh":"t"},"key_points":[],"decisions":[],"action_items":[]}',
          );
        }
        // Translation (both the main pass and its repair pass) and
        // sweep all hit an echoing 502 — every one of tasks/
        // summarize.ts's three console.warn(..., err) fail-soft sites
        // fires for this single call.
        return anthropicErrorResponse(502, `leaked header: X-Api-Key: ${SECRET}`);
      });

      const result = await summarizeApi(
        {
          segments: [{ index: 0, text: "We shipped the feature." }],
          expressions: [],
          terms: [],
        },
        makeSettings({ apiKey: SECRET }),
      );

      // Fail-soft, unchanged behavior: still resolves despite
      // translation/sweep failing entirely.
      expect(result.summary.topic).toEqual({ en: "t", zh: "t" });
      expect(result.translations).toEqual([{ index: 0, zh: "（翻译缺失）" }]);
      expect(result.flashcards).toEqual([]);

      expect(warnSpy).toHaveBeenCalled();
      for (const call of warnSpy.mock.calls) {
        for (const arg of call) {
          const rendered = arg instanceof Error ? `${arg.message} ${arg.stack ?? ""}` : String(arg);
          expect(rendered).not.toContain(SECRET);
        }
      }
    } finally {
      warnSpy.mockRestore();
    }
  });
});
