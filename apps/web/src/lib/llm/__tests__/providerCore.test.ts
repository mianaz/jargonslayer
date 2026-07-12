// F1 (codex v04-integration review) — sanitizeProviderExcerpt (BYOK/
// server-key leak via an echoing upstream) + the openai-compat
// call site that applies it (callJsonOpenAiCompat's requestChatContent
// — shared verbatim by the server route path, via anthropic.ts's
// re-export, and the client-side callProvider path, via
// clientProvider.ts). See clientProvider.test.ts for the Anthropic-
// direct call site's equivalent coverage, and clientTransport.test.ts
// for the end-to-end (client.ts) + tasks/summarize.ts fail-soft-log
// coverage.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { callJsonOpenAiCompat, sanitizeProviderExcerpt, OpenAiCompatError, type CallJsonOptions } from "../providerCore";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SECRET = "sk-test-SUPER-SECRET-key-123";

describe("sanitizeProviderExcerpt", () => {
  it("replaces every occurrence of a non-empty secret with [REDACTED]", () => {
    const text = `first use: ${SECRET}, second use: ${SECRET}`;
    const result = sanitizeProviderExcerpt(text, [SECRET]);
    expect(result).not.toContain(SECRET);
    expect(result).toBe("first use: [REDACTED], second use: [REDACTED]");
  });

  it("ignores empty-string secrets (never redacts everything to [REDACTED])", () => {
    const text = "totally normal error body, no secret here";
    const result = sanitizeProviderExcerpt(text, ["", SECRET]);
    expect(result).toBe(text);
  });

  it("redacts multiple distinct secrets in the same text", () => {
    const secretA = "key-AAA";
    const secretB = "key-BBB";
    const result = sanitizeProviderExcerpt(`a=${secretA} b=${secretB}`, [secretA, secretB]);
    expect(result).toBe("a=[REDACTED] b=[REDACTED]");
  });

  it("strips Authorization-header-shaped echoes even when the value is NOT an exact secret match (re-cased/re-quoted/different key) — matches the finding's exact (?i)(authorization|x-api-key)\\s*[:=]\\s*\\S+ pattern, i.e. the ONE token immediately after the separator", () => {
    const text = 'Your request had header "authorization: some-other-token-we-never-passed-in"';
    const result = sanitizeProviderExcerpt(text, [SECRET]);
    expect(result).not.toContain("some-other-token-we-never-passed-in");
    expect(result).toContain("authorization: [REDACTED]");
  });

  it("a 'Bearer <token>' echo of a DIFFERENT (non-exact-match) secret only strips the word immediately after the separator ('Bearer') — a known scope limit of the finding's literal \\S+ pattern; the exact-secret pass (rule a) is what fully covers the realistic case (OUR OWN key, prefixed or not — see the callJsonOpenAiCompat tests below)", () => {
    const text = "Authorization: Bearer some-other-token-we-never-passed-in";
    const result = sanitizeProviderExcerpt(text, [SECRET]);
    expect(result).toBe("Authorization: [REDACTED] some-other-token-we-never-passed-in");
  });

  it("strips X-Api-Key-shaped echoes case-insensitively, with a `=` separator", () => {
    const text = "echo: x-api-key=abc123DEF";
    const result = sanitizeProviderExcerpt(text, []);
    expect(result).not.toContain("abc123DEF");
  });

  it("handles a secret containing regex metacharacters safely (plain string split/join, not RegExp)", () => {
    const weirdSecret = "sk-(test).[key]+*?^$";
    const text = `leaked: ${weirdSecret}`;
    const result = sanitizeProviderExcerpt(text, [weirdSecret]);
    expect(result).toBe("leaked: [REDACTED]");
  });

  it("is a no-op on text containing neither a known secret nor a header-shaped pattern", () => {
    const text = "upstream said: model overloaded, try again later";
    expect(sanitizeProviderExcerpt(text, [SECRET])).toBe(text);
  });
});

// ---------------------------------------------------------------
// The real call site: an echoing-endpoint fixture proves the key
// never reaches OpenAiCompatError.message — this is what BOTH
// mapLlmError's HTTP error body (server path) and client.ts's thrown
// UpstreamError (both paths) build their message from, so sanitizing
// here is what actually closes the leak everywhere downstream (see
// providerCore.ts's own header comment on sanitizeProviderExcerpt).
// ---------------------------------------------------------------

const TrivialSchema = z.object({ ok: z.boolean() });

function baseOpts(overrides: Partial<CallJsonOptions<{ ok: boolean }>> = {}): CallJsonOptions<{ ok: boolean }> {
  return {
    apiKey: SECRET,
    model: "test-model",
    system: "sys",
    user: "usr",
    schema: TrivialSchema,
    maxTokens: 100,
    provider: "openai-compat",
    baseUrl: "https://echoing-endpoint.example.com/v1",
    ...overrides,
  };
}

describe("callJsonOpenAiCompat — echoing endpoint never leaks the API key into OpenAiCompatError.message", () => {
  it("a non-2xx response that echoes back the Authorization header verbatim in its body never surfaces the key in the thrown error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        `Bad request. You sent: Authorization: Bearer ${SECRET}\n` +
          `Full headers dump: {"authorization":"Bearer ${SECRET}","content-type":"application/json"}`,
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const err = await callJsonOpenAiCompat(baseOpts()).catch((e) => e);

    expect(err).toBeInstanceOf(OpenAiCompatError);
    const message = (err as OpenAiCompatError).message;
    expect(message).not.toContain(SECRET);
    expect(message).toContain("[REDACTED]");
  });

  it("a non-2xx response that echoes the raw key with NO header framing at all (just embedded in prose) still never leaks it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(`upstream rejected credentials: ${SECRET} is not authorized for this model`, {
        status: 403,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const err = await callJsonOpenAiCompat(baseOpts()).catch((e) => e);

    expect(err).toBeInstanceOf(OpenAiCompatError);
    expect((err as OpenAiCompatError).status).toBe(403);
    expect((err as OpenAiCompatError).message).not.toContain(SECRET);
  });

  it("still caps the sanitized message at 500 chars (unchanged cap behavior)", async () => {
    const longBody = `${SECRET} ` + "x".repeat(1000);
    const fetchMock = vi.fn().mockResolvedValue(new Response(longBody, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const err = await callJsonOpenAiCompat(baseOpts()).catch((e) => e);

    expect(err).toBeInstanceOf(OpenAiCompatError);
    const message = (err as OpenAiCompatError).message;
    expect(message.length).toBeLessThanOrEqual(500);
    expect(message).not.toContain(SECRET);
  });

  it("a normal (non-leaking) upstream error body is unaffected — still surfaces for genuine debugging", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("model is currently overloaded, please retry", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const err = await callJsonOpenAiCompat(baseOpts()).catch((e) => e);

    expect(err).toBeInstanceOf(OpenAiCompatError);
    expect((err as OpenAiCompatError).message).toBe("model is currently overloaded, please retry");
  });
});
