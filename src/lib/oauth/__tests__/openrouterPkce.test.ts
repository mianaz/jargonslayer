import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_URL,
  buildAuthUrl,
  codeChallengeS256,
  exchangeCodeForKey,
  generateCodeVerifier,
} from "../openrouterPkce";

const VERIFIER_CHARSET_RE = /^[A-Za-z0-9\-._~]+$/;

describe("generateCodeVerifier", () => {
  it("defaults to 128 chars (RFC 7636 max)", () => {
    expect(generateCodeVerifier()).toHaveLength(128);
  });

  it("clamps below-minimum lengths up to 43 (RFC 7636 min)", () => {
    expect(generateCodeVerifier(10)).toHaveLength(43);
  });

  it("clamps above-maximum lengths down to 128", () => {
    expect(generateCodeVerifier(200)).toHaveLength(128);
  });

  it("only uses the RFC 7636 unreserved charset", () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(VERIFIER_CHARSET_RE);
  });

  it("produces different verifiers on successive calls (random, not fixed)", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });
});

describe("codeChallengeS256", () => {
  it("matches base64url(SHA-256(verifier)) computed independently via node:crypto", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const actual = await codeChallengeS256(verifier);
    expect(actual).toBe(expected);
  });

  it("is deterministic for the same input", async () => {
    const verifier = "same-verifier-value-used-twice-for-determinism-check-1234567890";
    const a = await codeChallengeS256(verifier);
    const b = await codeChallengeS256(verifier);
    expect(a).toBe(b);
  });

  it("contains no base64 padding or unsafe URL chars", async () => {
    const challenge = await codeChallengeS256(generateCodeVerifier());
    expect(challenge).not.toMatch(/[+/=]/);
  });
});

describe("buildAuthUrl", () => {
  it("targets the documented https://openrouter.ai/auth endpoint", () => {
    const url = new URL(
      buildAuthUrl({ callbackUrl: "https://example.com/oauth/openrouter", codeChallenge: "abc" }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(AUTH_URL);
  });

  it("sets callback_url, code_challenge, and code_challenge_method=S256", () => {
    const url = new URL(
      buildAuthUrl({
        callbackUrl: "https://example.com/jargonslayer/oauth/openrouter",
        codeChallenge: "test-challenge-value",
      }),
    );
    expect(url.searchParams.get("callback_url")).toBe(
      "https://example.com/jargonslayer/oauth/openrouter",
    );
    expect(url.searchParams.get("code_challenge")).toBe("test-challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("URL-encodes a callback_url containing query-breaking characters", () => {
    const raw = buildAuthUrl({
      callbackUrl: "https://example.com/cb?x=1&y=2",
      codeChallenge: "c",
    });
    // Encoded, so the callback's own & doesn't fracture the outer query string.
    expect(raw).toContain("callback_url=https%3A%2F%2Fexample.com%2Fcb%3Fx%3D1%26y%3D2");
    const url = new URL(raw);
    expect(url.searchParams.get("callback_url")).toBe("https://example.com/cb?x=1&y=2");
  });
});

describe("exchangeCodeForKey", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs code/code_verifier/code_challenge_method to the same-origin proxy route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ key: "sk-or-v1-abc" }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await exchangeCodeForKey({ code: "auth-code", codeVerifier: "verifier-value" });

    expect(result).toEqual({ key: "sk-or-v1-abc" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/openrouter/exchange");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      code: "auth-code",
      code_verifier: "verifier-value",
      code_challenge_method: "S256",
    });
  });

  it("throws with the upstream error message on a non-2xx response", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "invalid code" }), { status: 400 }));

    await expect(
      exchangeCodeForKey({ code: "bad-code", codeVerifier: "v" }),
    ).rejects.toThrow("invalid code");
  });

  it("throws when the response is missing the key field", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await expect(exchangeCodeForKey({ code: "c", codeVerifier: "v" })).rejects.toThrow(/key/);
  });
});
