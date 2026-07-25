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
import {
  callJsonOpenAiCompat,
  sanitizeProviderExcerpt,
  scrubUrlCredentials,
  OpenAiCompatError,
  type CallJsonOptions,
} from "../providerCore";

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

  it("strips Authorization-header-shaped echoes even when the value is NOT an exact secret match (re-cased/re-quoted/different key) — F1 fix: (?i)(authorization|x-api-key)\\s*[:=]\\s*[^\\r\\n,\"']+, i.e. the WHOLE credential expression up to a line end/quote/comma, not just one token", () => {
    const text = 'Your request had header "authorization: some-other-token-we-never-passed-in"';
    const result = sanitizeProviderExcerpt(text, [SECRET]);
    expect(result).not.toContain("some-other-token-we-never-passed-in");
    expect(result).toContain("authorization: [REDACTED]");
  });

  it("F1 fix (Sol HIGH #6 part 1): a 'Bearer <token>' echo of a DIFFERENT (non-exact-match) secret now redacts the ENTIRE credential expression — scheme word AND token — not just the word immediately after the separator. The OLD \\S+ pattern let 'Bearer' consume the redaction spot while the actual token (here standing in for a real key that never exact-matched any known secret) survived in plain text — this is what made the finding's diag-ring leak (client.ts's transportFailureCause, the one call site with NO known-secret list at all) actually exploitable.", () => {
    const text = "Authorization: Bearer some-other-token-we-never-passed-in";
    const result = sanitizeProviderExcerpt(text, [SECRET]);
    expect(result).not.toContain("some-other-token-we-never-passed-in");
    expect(result).toBe("Authorization: [REDACTED]");
  });

  it("F1: redacts a bare credential with no 'Bearer'/scheme prefix at all", () => {
    const text = "Authorization: sk-bare-token-no-scheme-here";
    const result = sanitizeProviderExcerpt(text, []);
    expect(result).not.toContain("sk-bare-token-no-scheme-here");
    expect(result).toBe("Authorization: [REDACTED]");
  });

  it("strips X-Api-Key-shaped echoes case-insensitively, with a `=` separator, redacting the full token", () => {
    const text = "echo: x-api-key=abc123DEF";
    const result = sanitizeProviderExcerpt(text, []);
    expect(result).not.toContain("abc123DEF");
    expect(result).toBe("echo: x-api-key: [REDACTED]");
  });

  it("F1: matches the header name case-insensitively (mixed case) and still redacts the whole value", () => {
    const text = "AuthORIzation: Bearer MiXeD-CaSe-ToKeN-123";
    const result = sanitizeProviderExcerpt(text, []);
    expect(result).not.toContain("MiXeD-CaSe-ToKeN-123");
    expect(result).toBe("AuthORIzation: [REDACTED]");
  });

  it("F1: redacts a token containing dots and dashes in full, not just up to the first one", () => {
    const text = "Authorization: Bearer sk-proj.v2-abc.def-123_XYZ";
    const result = sanitizeProviderExcerpt(text, []);
    expect(result).not.toContain("sk-proj.v2-abc.def-123_XYZ");
    expect(result).toBe("Authorization: [REDACTED]");
  });

  it("F1: stops consuming at a comma, so unrelated trailing content in the same body survives", () => {
    const text = "Authorization: Bearer sk-leaked-token-here, content-type: application/json";
    const result = sanitizeProviderExcerpt(text, []);
    expect(result).not.toContain("sk-leaked-token-here");
    expect(result).toContain("content-type: application/json");
  });

  it("F1: stops consuming at a newline, so unrelated trailing content on the next line survives", () => {
    const text = "Authorization: Bearer sk-leaked-token-here\nnext line is unrelated prose";
    const result = sanitizeProviderExcerpt(text, []);
    expect(result).not.toContain("sk-leaked-token-here");
    expect(result).toContain("next line is unrelated prose");
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

  // -------------------------------------------------------------
  // F2 (Sol HIGH #6 part 2): URL-embedded credentials — userinfo and
  // credential-shaped query params — pass the exact-secret pass and
  // SECRET_HEADER_RE untouched (neither byte-matches a known secret nor
  // looks like an Authorization/X-Api-Key header). sanitizeProviderExcerpt
  // now also runs scrubUrlCredentials internally, so these prove the
  // full seam, not just the helper in isolation (see the dedicated
  // scrubUrlCredentials describe block below for that).
  // -------------------------------------------------------------

  it("F2: strips URL userinfo (user:pass@host) to [REDACTED]@", () => {
    const text = "fetch failed for https://user:pass@api.example.com/v1/chat";
    const result = sanitizeProviderExcerpt(text, []);
    expect(result).not.toContain("user:pass");
    expect(result).toContain("https://[REDACTED]@api.example.com/v1/chat");
  });

  it("F2: redacts credential-shaped query param VALUES (api_key/token/key), keeping the param name", () => {
    const text =
      "GET https://gateway.example.com/v1?api_key=SUPER-SECRET-1 failed; retry https://gateway.example.com/v1?token=SUPER-SECRET-2; also ?foo=bar&key=SUPER-SECRET-3";
    const result = sanitizeProviderExcerpt(text, []);
    expect(result).not.toContain("SUPER-SECRET-1");
    expect(result).not.toContain("SUPER-SECRET-2");
    expect(result).not.toContain("SUPER-SECRET-3");
    expect(result).toContain("?api_key=[REDACTED]");
    expect(result).toContain("?token=[REDACTED]");
    expect(result).toContain("&key=[REDACTED]");
    // non-credential param survives untouched.
    expect(result).toContain("foo=bar");
  });
});

// ---------------------------------------------------------------
// F2 (Sol HIGH #6 part 2) — scrubUrlCredentials in isolation. Exported
// from providerCore.ts so client.ts's transportFailureCause can apply
// it explicitly too (belt-and-suspenders on top of
// sanitizeProviderExcerpt calling it internally above — see that call
// site's own tests in clientTransport.test.ts).
// ---------------------------------------------------------------

describe("scrubUrlCredentials", () => {
  it("strips userinfo (user:pass@) from a URL, leaving the rest of it intact", () => {
    const result = scrubUrlCredentials("https://user:pass@host.example.com/v1/chat/completions");
    expect(result).toBe("https://[REDACTED]@host.example.com/v1/chat/completions");
  });

  it("strips userinfo with no password (bare user@)", () => {
    const result = scrubUrlCredentials("https://onlyuser@host.example.com/v1");
    expect(result).not.toContain("onlyuser");
    expect(result).toBe("https://[REDACTED]@host.example.com/v1");
  });

  it("redacts a `?api_key=` query value", () => {
    const result = scrubUrlCredentials("https://host.example.com/v1?api_key=abc123DEF");
    expect(result).toBe("https://host.example.com/v1?api_key=[REDACTED]");
  });

  it("redacts a `?token=` query value", () => {
    const result = scrubUrlCredentials("https://host.example.com/v1?token=abc.123-DEF");
    expect(result).toBe("https://host.example.com/v1?token=[REDACTED]");
  });

  it("redacts a `&key=` query value that isn't the first param", () => {
    const result = scrubUrlCredentials("https://host.example.com/v1?model=gpt&key=abc123DEF");
    expect(result).toBe("https://host.example.com/v1?model=gpt&key=[REDACTED]");
  });

  it("redacts multiple credential-shaped params (secret/auth/password) in the same URL", () => {
    const result = scrubUrlCredentials(
      "https://host.example.com/v1?client_secret=aaa&auth_token=bbb&password=ccc",
    );
    expect(result).not.toContain("aaa");
    expect(result).not.toContain("bbb");
    expect(result).not.toContain("ccc");
  });

  it("leaves a URL with no credential material completely untouched", () => {
    const url = "https://host.example.com/v1?model=gpt-5&stream=true#section";
    expect(scrubUrlCredentials(url)).toBe(url);
  });

  it("is a no-op on plain text with no URL at all", () => {
    const text = "model overloaded, please retry later";
    expect(scrubUrlCredentials(text)).toBe(text);
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
