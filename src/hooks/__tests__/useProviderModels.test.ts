// #56 model-dropdown fetch helpers. No hook-rendering harness exists
// in this repo (vitest.config.ts only picks up src/**/*.test.ts, and
// every existing test in this codebase exercises plain functions —
// see JARGONSLAYER-HANDOFF's own convention), so this file tests the
// two exported network-facing functions directly: the exact request
// shape (URL/headers/timeout) each sends, and how each parses/tolerates
// a real-world response shape. The React state machine around them
// (debounce/cache/enabled-gating) is exercised indirectly by manual
// browser verification per the task's gate — see task report.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAnthropicModels, fetchOpenAiCompatModels } from "../useProviderModels";

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchOpenAiCompatModels", () => {
  it("GETs {baseUrl}/models with an Authorization: Bearer header, normalizing a trailing slash", async () => {
    mockFetch.mockResolvedValue(jsonRes({ data: [{ id: "deepseek-chat" }] }));

    await fetchOpenAiCompatModels("https://api.deepseek.com/", "sk-key");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/models");
    expect(init.headers).toEqual({ Authorization: "Bearer sk-key" });
  });

  it("omits the Authorization header entirely when apiKey is blank (Ollama-style local endpoints need no key)", async () => {
    mockFetch.mockResolvedValue(jsonRes({ data: [{ id: "qwen3:8b" }] }));

    await fetchOpenAiCompatModels("http://localhost:11434/v1", "");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers).toEqual({});
  });

  it("parses the OpenAI-shaped {data:[{id}]} response into a flat id list", async () => {
    mockFetch.mockResolvedValue(
      jsonRes({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }),
    );

    const models = await fetchOpenAiCompatModels("https://api.deepseek.com", "sk-key");

    expect(models).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });

  it("throws on a non-ok response (caller/hook maps this to the quiet 无法自动获取模型列表 message)", async () => {
    mockFetch.mockResolvedValue(jsonRes({ error: "unauthorized" }, 401));

    await expect(fetchOpenAiCompatModels("https://api.deepseek.com", "bad-key")).rejects.toThrow();
  });

  it("propagates a network/CORS failure (fetch itself rejects) as a thrown error, never a silent empty array", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch")); // the real shape a CORS block takes in a browser

    await expect(fetchOpenAiCompatModels("https://api.anthropic-like-cors-blocked.example.com", "k")).rejects.toThrow();
  });

  it("tolerates malformed entries in `data` (missing/non-string id) by dropping them, not crashing", async () => {
    mockFetch.mockResolvedValue(
      jsonRes({ data: [{ id: "good-model" }, {}, { id: 123 }, { id: null }] }),
    );

    const models = await fetchOpenAiCompatModels("https://api.deepseek.com", "sk-key");

    expect(models).toEqual(["good-model"]);
  });

  it("returns an empty array (not a throw) when `data` is absent from an otherwise-ok response", async () => {
    mockFetch.mockResolvedValue(jsonRes({}));

    const models = await fetchOpenAiCompatModels("https://api.deepseek.com", "sk-key");

    expect(models).toEqual([]);
  });
});

describe("fetchAnthropicModels", () => {
  it("GETs https://api.anthropic.com/v1/models with x-api-key + the documented anthropic-version header", async () => {
    mockFetch.mockResolvedValue(jsonRes({ data: [{ id: "claude-sonnet-5" }] }));

    await fetchAnthropicModels("sk-ant-key");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(init.headers).toEqual({
      "x-api-key": "sk-ant-key",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });
  });

  it("skips the network entirely for a keyless call — empty result, fetch never invoked", async () => {
    const models = await fetchAnthropicModels("");

    expect(models).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("parses the Anthropic {data:[{id}]} response shape identically to the OpenAI-compat one", async () => {
    mockFetch.mockResolvedValue(
      jsonRes({ data: [{ id: "claude-haiku-4-5" }, { id: "claude-sonnet-5" }] }),
    );

    const models = await fetchAnthropicModels("sk-ant-key");

    expect(models).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);
  });

  it("throws on a non-ok response", async () => {
    mockFetch.mockResolvedValue(jsonRes({ error: "invalid key" }, 401));

    await expect(fetchAnthropicModels("bad-key")).rejects.toThrow();
  });

  it("never sends a baseUrl-derived URL — always the fixed api.anthropic.com endpoint, regardless of any Settings.baseUrl value (that field is openai-compat only)", async () => {
    mockFetch.mockResolvedValue(jsonRes({ data: [] }));

    await fetchAnthropicModels("sk-ant-key");

    const [url] = mockFetch.mock.calls[0];
    expect(url).not.toContain("undefined");
    expect(url).toBe("https://api.anthropic.com/v1/models");
  });
});
