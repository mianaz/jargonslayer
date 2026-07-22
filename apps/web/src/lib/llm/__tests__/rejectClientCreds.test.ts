// D2 (preview strict mode) — rejectClientCreds unit tests, plus an
// end-to-end pass through two real routes (detect: stamps a
// requestId onto every error body; translate: does not — see that
// route's own errorBody, which skips the {...body, requestId} spread
// the other four routes use) so both errorBody shapes get pinned
// against the shared rejection body. The other three routes
// (define/summarize/correct) wire the identical
// `if (rejectClientCreds(req)) return errorBody(CLIENT_CREDS_REJECTED_
// BODY, 400)` guard as their very first line — verified by reading
// each route's source — so the helper's own unit tests below cover
// their decision logic without needing a fifth/sixth copy of this
// same end-to-end scaffolding.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_CREDS_REJECTED_BODY, rejectClientCreds } from "../anthropic";
import { resetRateLimiter } from "../rateLimit";
import { POST as detectPOST } from "../../../app/api/detect/route";
import { POST as translatePOST } from "../../../app/api/translate/route";

function reqWithHeaders(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/detect", { headers });
}

function postRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  resetRateLimiter();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimiter();
});

// ---------------------------------------------------------------
// rejectClientCreds — pure decision logic.
// ---------------------------------------------------------------

describe("rejectClientCreds", () => {
  it("env unset: always false, even with both cred headers present", () => {
    expect(
      rejectClientCreds(
        reqWithHeaders({ "x-jargonslayer-key": "k", "x-jargonslayer-base-url": "https://evil.example.com" }),
      ),
    ).toBe(false);
  });

  it("env set to something other than the literal string '1': false (e.g. accidental '0'/'true')", () => {
    vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "0");
    expect(rejectClientCreds(reqWithHeaders({ "x-jargonslayer-key": "k" }))).toBe(false);
    vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "true");
    expect(rejectClientCreds(reqWithHeaders({ "x-jargonslayer-key": "k" }))).toBe(false);
  });

  describe("env = '1'", () => {
    beforeEach(() => {
      vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "1");
    });

    it("no cred headers at all: false — a keyless trial request is never rejected", () => {
      expect(rejectClientCreds(reqWithHeaders())).toBe(false);
    });

    it("the provider header ALONE (no key, no baseUrl): false — only key/baseUrl gate this", () => {
      expect(rejectClientCreds(reqWithHeaders({ "x-jargonslayer-provider": "openai-compat" }))).toBe(
        false,
      );
    });

    it("key header only: true", () => {
      expect(rejectClientCreds(reqWithHeaders({ "x-jargonslayer-key": "user-key" }))).toBe(true);
    });

    it("base-url header only: true — this is the SSRF/open-proxy vector the guard exists for", () => {
      expect(
        rejectClientCreds(reqWithHeaders({ "x-jargonslayer-base-url": "https://evil.example.com/v1" })),
      ).toBe(true);
    });

    it("both headers: true", () => {
      expect(
        rejectClientCreds(
          reqWithHeaders({ "x-jargonslayer-key": "k", "x-jargonslayer-base-url": "https://evil.example.com" }),
        ),
      ).toBe(true);
    });

    it("header name in a different casing: still true — the Headers API normalizes lookups case-insensitively", () => {
      expect(rejectClientCreds(reqWithHeaders({ "X-JargonSlayer-Key": "user-key" }))).toBe(true);
      expect(
        rejectClientCreds(reqWithHeaders({ "X-Jargonslayer-Base-Url": "https://evil.example.com" })),
      ).toBe(true);
    });

    it("an empty-string header value: false — Headers.get treats a present-but-blank header as falsy here, same as absent", () => {
      expect(rejectClientCreds(reqWithHeaders({ "x-jargonslayer-key": "" }))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------
// End-to-end: detect (requestId-stamped errorBody) + translate
// (no requestId) — see header comment for why these two.
// ---------------------------------------------------------------

describe("POST /api/detect — strict mode", () => {
  const body = { context: "", new_text: "hi" };

  it("JARGONSLAYER_SHARED_KEY_ONLY=1, key header present: 400 with the shared rejection body", async () => {
    vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "1");
    const res = await detectPOST(postRequest("/api/detect", body, { "x-jargonslayer-key": "k" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject(CLIENT_CREDS_REJECTED_BODY);
    expect(typeof json.requestId).toBe("string");
    expect(json.requestId.length).toBeGreaterThan(0);
  });

  it("JARGONSLAYER_SHARED_KEY_ONLY=1, ONLY a base-url header: 400", async () => {
    vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "1");
    const res = await detectPOST(
      postRequest("/api/detect", body, { "x-jargonslayer-base-url": "https://evil.example.com/v1" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject(CLIENT_CREDS_REJECTED_BODY);
  });

  it("JARGONSLAYER_SHARED_KEY_ONLY=1, header sent in different casing: still 400", async () => {
    vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "1");
    const res = await detectPOST(postRequest("/api/detect", body, { "X-JargonSlayer-Key": "k" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject(CLIENT_CREDS_REJECTED_BODY);
  });

  it("JARGONSLAYER_SHARED_KEY_ONLY=1, keyless request: proceeds past the guard (reaches resolveLlmConfig, not the strict-mode 400)", async () => {
    vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "1");
    // No server env key configured either — resolveLlmConfig legitimately
    // returns null past the guard, giving a status/code pair (401/
    // "no_key") that could only be reached if the 400 guard above did
    // NOT fire.
    const res = await detectPOST(postRequest("/api/detect", body));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("no_key");
  });

  it("env unset: a real key header is honored exactly as today (BYOK reaches the provider call, unaffected by the guard)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ expressions: [], terms: [] }) }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);
    try {
      const res = await detectPOST(postRequest("/api/detect", body, { "x-jargonslayer-key": "user-key" }));
      expect(res.status).toBe(200);
      // The key header made it all the way to the outgoing provider
      // call — proof the guard let a legitimate BYOK request straight
      // through untouched.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      // The Anthropic SDK issues this fetch itself (not our own code),
      // so `init.headers` may be a Headers instance rather than a plain
      // object — normalize through Headers.get for a case-insensitive
      // read regardless of which shape it is.
      expect(new Headers(init.headers).get("x-api-key")).toBe("user-key");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("POST /api/translate — strict mode (errorBody has no requestId, unlike detect's)", () => {
  const body = { segments: [{ id: "1", text: "hi" }], lang: "zh" };

  it("JARGONSLAYER_SHARED_KEY_ONLY=1, key header present: 400, body EXACTLY the shared rejection body (no requestId field on this route)", async () => {
    vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "1");
    const res = await translatePOST(postRequest("/api/translate", body, { "x-jargonslayer-key": "k" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(CLIENT_CREDS_REJECTED_BODY);
  });

  it("JARGONSLAYER_SHARED_KEY_ONLY=1, ONLY a base-url header: 400", async () => {
    vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "1");
    const res = await translatePOST(
      postRequest("/api/translate", body, { "x-jargonslayer-base-url": "https://evil.example.com/v1" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(CLIENT_CREDS_REJECTED_BODY);
  });

  it("JARGONSLAYER_SHARED_KEY_ONLY=1, keyless request: proceeds past the guard", async () => {
    vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "1");
    const res = await translatePOST(postRequest("/api/translate", body));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("no_key");
  });

  it("env unset: a real key header is honored exactly as today", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ translations: [{ id: "1", text: "你好" }] }) }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", mockFetch);
    try {
      const res = await translatePOST(postRequest("/api/translate", body, { "x-jargonslayer-key": "user-key" }));
      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
