// v0.4 S2 — unit tests for clientProvider.ts's callProviderDirect: the
// raw-fetch ProviderCaller the client-side callProvider path uses
// (lib/llm/client.ts's *ViaClient functions, via tasks/*.ts). Exercises
// the wire contract directly (mocked Transport, no real network) —
// separate from clientTransport.test.ts, which exercises the same
// machinery end-to-end through client.ts's public *Api functions.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { callProviderDirect, ProviderHttpError } from "../clientProvider";
import { BadOutputError, type CallJsonOptions } from "../providerCore";
import { resetTransport, setTransport } from "../llmTransport";

afterEach(() => {
  resetTransport();
});

const TrivialSchema = z.object({ ok: z.boolean() });

function baseAnthropicOpts(
  overrides: Partial<CallJsonOptions<{ ok: boolean }>> = {},
): CallJsonOptions<{ ok: boolean }> {
  return {
    apiKey: "sk-ant-test-key",
    model: "claude-haiku-4-5",
    system: "you are a test assistant",
    user: "say ok",
    schema: TrivialSchema,
    maxTokens: 100,
    provider: "anthropic",
    ...overrides,
  };
}

function anthropicMessageResponse(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text }] }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------
// Anthropic-direct wire contract — verified against the installed
// @anthropic-ai/sdk (0.110.0) source (node_modules/@anthropic-ai/sdk/
// client.mjs's buildHeaders/authHeaders + resources/messages.mjs's
// '/v1/messages' path); see clientProvider.ts's header comment.
// ---------------------------------------------------------------

describe("callProviderDirect (anthropic) — wire contract", () => {
  it("POSTs to https://api.anthropic.com/v1/messages", async () => {
    const mockTransport = vi.fn().mockResolvedValue(anthropicMessageResponse('{"ok":true}'));
    setTransport(mockTransport);

    await callProviderDirect(baseAnthropicOpts());

    expect(mockTransport).toHaveBeenCalledTimes(1);
    const [url] = mockTransport.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("sends X-Api-Key, anthropic-version: 2023-06-01, and anthropic-dangerous-direct-browser-access: true", async () => {
    const mockTransport = vi.fn().mockResolvedValue(anthropicMessageResponse('{"ok":true}'));
    setTransport(mockTransport);

    await callProviderDirect(baseAnthropicOpts({ apiKey: "sk-ant-SENTINEL" }));

    const [, init] = mockTransport.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("sk-ant-SENTINEL");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("body: plain string system + single user message when cacheSystem is unset", async () => {
    const mockTransport = vi.fn().mockResolvedValue(anthropicMessageResponse('{"ok":true}'));
    setTransport(mockTransport);

    await callProviderDirect(baseAnthropicOpts({ system: "SYSTEM TEXT", user: "USER TEXT" }));

    const [, init] = mockTransport.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.max_tokens).toBe(100);
    expect(body.system).toBe("SYSTEM TEXT");
    expect(body.messages).toEqual([{ role: "user", content: "USER TEXT" }]);
  });

  it("body: cacheSystem true wraps system in a single ephemeral cache_control text block (prompt-cache preservation, risk #4)", async () => {
    const mockTransport = vi.fn().mockResolvedValue(anthropicMessageResponse('{"ok":true}'));
    setTransport(mockTransport);

    await callProviderDirect(baseAnthropicOpts({ system: "CACHED SYSTEM", cacheSystem: true }));

    const [, init] = mockTransport.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.system).toEqual([
      { type: "text", text: "CACHED SYSTEM", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("never sends a baseUrl override for the anthropic provider — always the fixed api.anthropic.com URL (matches server: anthropic.ts's callJson constructs `new Anthropic({apiKey})` with no baseUrl)", async () => {
    const mockTransport = vi.fn().mockResolvedValue(anthropicMessageResponse('{"ok":true}'));
    setTransport(mockTransport);

    await callProviderDirect(baseAnthropicOpts({ baseUrl: "https://attacker.example.com" }));

    const [url] = mockTransport.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("goes through llmTransport.ts's getTransport() — respects setTransport injection (S3's registration point)", async () => {
    const injected = vi.fn().mockResolvedValue(anthropicMessageResponse('{"ok":true}'));
    setTransport(injected);

    await callProviderDirect(baseAnthropicOpts());

    expect(injected).toHaveBeenCalledTimes(1);
  });

  it("sets an AbortSignal on the request when timeoutMs is provided", async () => {
    const mockTransport = vi.fn().mockResolvedValue(anthropicMessageResponse('{"ok":true}'));
    setTransport(mockTransport);

    await callProviderDirect(baseAnthropicOpts({ timeoutMs: 20000 }));

    const [, init] = mockTransport.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends no signal at all when timeoutMs is unset", async () => {
    const mockTransport = vi.fn().mockResolvedValue(anthropicMessageResponse('{"ok":true}'));
    setTransport(mockTransport);

    await callProviderDirect(baseAnthropicOpts());

    const [, init] = mockTransport.mock.calls[0];
    expect(init.signal).toBeUndefined();
  });
});

// ---------------------------------------------------------------
// Anthropic-direct — success / error-mapping surface.
// ---------------------------------------------------------------

describe("callProviderDirect (anthropic) — success", () => {
  it("extracts the text block, parses JSON, and schema-validates it", async () => {
    setTransport(vi.fn().mockResolvedValue(anthropicMessageResponse('{"ok":true}')));

    const result = await callProviderDirect(baseAnthropicOpts());

    expect(result).toEqual({ ok: true });
  });

  it("tolerates a ```json fenced / <think> preamble exactly like the server path (shared extractJsonValue)", async () => {
    setTransport(
      vi.fn().mockResolvedValue(
        anthropicMessageResponse('<think>reasoning...</think>```json\n{"ok":true}\n```'),
      ),
    );

    const result = await callProviderDirect(baseAnthropicOpts());

    expect(result).toEqual({ ok: true });
  });
});

describe("callProviderDirect (anthropic) — 401/403/429/5xx map to ProviderHttpError with the right status", () => {
  it.each([401, 403, 429, 500, 529])("status %d -> ProviderHttpError with that status, single call, no retry", async (status) => {
    const mockTransport = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ type: "error", error: { message: "nope" } }), { status }),
    );
    setTransport(mockTransport);

    const err = await callProviderDirect(baseAnthropicOpts()).catch((e) => e);

    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(status);
    expect(mockTransport).toHaveBeenCalledTimes(1);
  });
});

describe("callProviderDirect (anthropic) — malformed output maps to BadOutputError", () => {
  it("no text block in content -> BadOutputError", async () => {
    setTransport(vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "tool_use" }] }), { status: 200 }),
    ));

    await expect(callProviderDirect(baseAnthropicOpts())).rejects.toBeInstanceOf(BadOutputError);
  });

  it("text block present but contains no parseable JSON -> BadOutputError", async () => {
    setTransport(vi.fn().mockResolvedValue(anthropicMessageResponse("no json here at all")));

    await expect(callProviderDirect(baseAnthropicOpts())).rejects.toBeInstanceOf(BadOutputError);
  });

  it("text parses to JSON but fails schema validation -> BadOutputError", async () => {
    setTransport(vi.fn().mockResolvedValue(anthropicMessageResponse('{"ok":"not a boolean"}')));

    await expect(callProviderDirect(baseAnthropicOpts())).rejects.toBeInstanceOf(BadOutputError);
  });

  it("the HTTP response body itself isn't valid JSON -> BadOutputError", async () => {
    setTransport(vi.fn().mockResolvedValue(new Response("<html>not json</html>", { status: 200 })));

    await expect(callProviderDirect(baseAnthropicOpts())).rejects.toBeInstanceOf(BadOutputError);
  });
});

// ---------------------------------------------------------------
// openai-compat-direct — callProviderDirect routes to the SAME
// providerCore.callJsonOpenAiCompat the server path uses (fully
// shared, see clientProvider.ts's header comment); anthropic-openai-
// compat.test.ts already covers that function's own edge cases
// thoroughly, so this just confirms the dispatch + Transport
// injection, not re-testing every parse edge case again.
// ---------------------------------------------------------------

describe("callProviderDirect (openai-compat) — dispatch", () => {
  function compatOpts(
    overrides: Partial<CallJsonOptions<{ ok: boolean }>> = {},
  ): CallJsonOptions<{ ok: boolean }> {
    return {
      apiKey: "compat-key",
      model: "deepseek-chat",
      system: "sys",
      user: "usr",
      schema: TrivialSchema,
      maxTokens: 100,
      provider: "openai-compat",
      baseUrl: "https://api.deepseek.com",
      ...overrides,
    };
  }

  function chatCompletionResponse(content: string, status = 200): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  }

  it("POSTs to {baseUrl}/chat/completions with a Bearer Authorization header, through the injected Transport", async () => {
    const mockTransport = vi.fn().mockResolvedValue(chatCompletionResponse('{"ok":true}'));
    setTransport(mockTransport);

    const result = await callProviderDirect(compatOpts());

    expect(result).toEqual({ ok: true });
    const [url, init] = mockTransport.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer compat-key");
  });

  it("non-2xx maps to OpenAiCompatError (the SAME class the server path throws — mapLlmError-compatible)", async () => {
    const { OpenAiCompatError } = await import("../providerCore");
    setTransport(vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));

    const err = await callProviderDirect(compatOpts()).catch((e) => e);
    expect(err).toBeInstanceOf(OpenAiCompatError);
    expect((err as InstanceType<typeof OpenAiCompatError>).status).toBe(401);
  });
});
