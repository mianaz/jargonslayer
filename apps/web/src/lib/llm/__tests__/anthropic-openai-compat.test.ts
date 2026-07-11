import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallJsonOptions } from "../anthropic";
import {
  BadOutputError,
  callJson,
  DetectResponseSchema,
  extractJsonValue,
  OpenAiCompatError,
  TranslationsSchema,
} from "../anthropic";

// ---------------------------------------------------------------
// Shared mock helpers — build a minimal OpenAI-compat
// chat/completions Response carrying `content` as the assistant
// message text, mirroring the real wire shape closely enough for
// callJsonOpenAiCompat's parsing.
// ---------------------------------------------------------------

function chatCompletionResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function baseOpts<T>(
  overrides: Pick<CallJsonOptions<T>, "schema"> & Partial<CallJsonOptions<T>>,
): CallJsonOptions<T> {
  return {
    apiKey: "test-key",
    model: "test-model",
    system: "you are a translation assistant",
    user: "translate this",
    maxTokens: 1000,
    provider: "openai-compat" as const,
    baseUrl: "https://example.com/v1",
    ...overrides,
  };
}

/** Pull the parsed JSON body off a fetch call recorded by the mock. */
function requestBodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------
// 1. Bare top-level array + arrayKey — the exact production failure.
// ---------------------------------------------------------------

describe("callJson (openai-compat) — bare array + arrayKey", () => {
  it("wraps a bare top-level array into { translations: [...] } and validates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      chatCompletionResponse(JSON.stringify([{ i: 0, zh: "你好" }, { i: 1, zh: "世界" }])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callJson(
      baseOpts({ schema: TranslationsSchema, arrayKey: "translations" }),
    );

    expect(result).toEqual({
      translations: [
        { i: 0, zh: "你好" },
        { i: 1, zh: "世界" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------
// 2. <think> preamble before real JSON — detect schema.
// ---------------------------------------------------------------

describe("callJson (openai-compat) — <think> block preamble", () => {
  it("ignores a <think>...</think> block containing braces and parses the real JSON after it", async () => {
    const content = `<think>let me reason about this { "not": "real json" } and consider braces {}</think>{"expressions":[],"terms":[]}`;
    const fetchMock = vi.fn().mockResolvedValue(chatCompletionResponse(content));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callJson(baseOpts({ schema: DetectResponseSchema }));

    expect(result).toEqual({ expressions: [], terms: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------
// 3. Markdown-fenced JSON object.
// ---------------------------------------------------------------

describe("callJson (openai-compat) — markdown-fenced object", () => {
  it("parses a ```json fenced object", async () => {
    const content = '```json\n{"expressions":[],"terms":[]}\n```';
    const fetchMock = vi.fn().mockResolvedValue(chatCompletionResponse(content));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callJson(baseOpts({ schema: DetectResponseSchema }));

    expect(result).toEqual({ expressions: [], terms: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------
// 4. First attempt junk, repair retry succeeds.
// ---------------------------------------------------------------

describe("callJson (openai-compat) — single repair retry", () => {
  it("retries once with a hardened system reminder after a parse failure, then resolves", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatCompletionResponse("no json here at all, sorry"))
      .mockResolvedValueOnce(chatCompletionResponse('{"expressions":[],"terms":[]}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callJson(baseOpts({ schema: DetectResponseSchema }));

    expect(result).toEqual({ expressions: [], terms: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondBody = requestBodyOf(fetchMock.mock.calls[1]);
    const secondSystemMessage = (
      secondBody.messages as { role: string; content: string }[]
    ).find((m) => m.role === "system");
    expect(secondSystemMessage?.content).toContain(
      "Respond with ONLY a raw JSON value",
    );
  });
});

// ---------------------------------------------------------------
// 5. Both attempts junk — throws BadOutputError, fetch called twice.
// ---------------------------------------------------------------

describe("callJson (openai-compat) — repair retry exhausted", () => {
  it("throws BadOutputError when both attempts fail to produce parseable JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatCompletionResponse("still no json"))
      .mockResolvedValueOnce(chatCompletionResponse("nope, still nothing"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callJson(baseOpts({ schema: DetectResponseSchema })),
    ).rejects.toBeInstanceOf(BadOutputError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------
// 6. Non-2xx HTTP is not retried as a parse failure.
// ---------------------------------------------------------------

describe("callJson (openai-compat) — non-2xx propagates without a parse retry", () => {
  it("throws OpenAiCompatError with status 401 after a single fetch call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await callJson(baseOpts({ schema: DetectResponseSchema })).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(OpenAiCompatError);
    expect((error as OpenAiCompatError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------
// 7. Direct unit tests of extractJsonValue.
// ---------------------------------------------------------------

describe("extractJsonValue", () => {
  it("extracts a bare top-level array", () => {
    const text = '[{"i":0,"zh":"你好"},{"i":1,"zh":"世界"}]';
    expect(extractJsonValue(text)).toBe(text);
  });

  it("extracts JSON from a ```json fenced block, ignoring surrounding prose", () => {
    const text = 'Sure, here you go:\n```json\n{"a":1}\n```\nHope that helps!';
    expect(extractJsonValue(text)).toBe('{"a":1}');
  });

  it("strips a <think>...</think> block (even one containing braces) before extracting", () => {
    const text = '<think>hmm, { "maybe": "this" } or maybe not {}</think>{"a":1}';
    expect(extractJsonValue(text)).toBe('{"a":1}');
  });

  it("strips a case-insensitive <thinking>...</thinking> block", () => {
    const text = "<THINKING>reasoning { here }</THINKING>\n\n{\"a\":1}";
    expect(extractJsonValue(text)).toBe('{"a":1}');
  });

  it("handles nested braces inside a string value (a literal '}' character in 'zh')", () => {
    const text = '{"i":0,"zh":"函数 f(x) { return x }"}';
    expect(extractJsonValue(text)).toBe(text);
  });

  it("throws BadOutputError when no { or [ is present", () => {
    expect(() => extractJsonValue("just some prose, no json")).toThrow(BadOutputError);
  });

  it("throws BadOutputError when the JSON is never balanced", () => {
    expect(() => extractJsonValue('{"a": [1, 2, 3]')).toThrow(BadOutputError);
  });
});
