// D2 (preview strict mode) — rejectClientCreds unit tests, plus an
// end-to-end pass through every one of the five real routes. detect
// (requestId-stamped errorBody) and translate (not stamped — see that
// route's own errorBody, which skips the {...body, requestId} spread
// the other four routes use) get bespoke coverage below (casing, a
// real-key-reaches-the-provider proof, exact body-shape pins); the
// five-route table further down additionally pins the guard's decision
// against the REAL taskHeaders() shape for all five routes — closing
// the exact gap adversarial review flagged: a keyless DEFAULT_SETTINGS
// request was never exercised against define/summarize/correct at all,
// only asserted by reading their source (see this file's own prior
// header comment, since replaced by this one).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, PROVIDER_HEADERS, type LlmTaskDomain } from "@jargonslayer/core/types";
import { CLIENT_CREDS_REJECTED_BODY, rejectClientCreds } from "../anthropic";
import { taskHeaders } from "../client";
import { resetRateLimiter } from "../rateLimit";
import { POST as detectPOST } from "../../../app/api/detect/route";
import { POST as definePOST } from "../../../app/api/define/route";
import { POST as translatePOST } from "../../../app/api/translate/route";
import { POST as summarizePOST } from "../../../app/api/summarize/route";
import { POST as correctPOST } from "../../../app/api/correct/route";

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
// rejectClientCreds — pure decision logic. Key-only semantics (FIX 1):
// gates on the key header's PRESENCE (`.has`) alone — base-url is no
// longer part of the check at all.
// ---------------------------------------------------------------

describe("rejectClientCreds", () => {
  it("env unset: always false, even with both cred headers present", () => {
    expect(
      rejectClientCreds(
        reqWithHeaders({ "x-jargonslayer-key": "k", "x-jargonslayer-base-url": "https://evil.example.com" }),
      ),
    ).toBe(false);
  });

  it("env set to a value that isn't '1' or 'true': false (e.g. accidental '0')", () => {
    vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "0");
    expect(rejectClientCreds(reqWithHeaders({ "x-jargonslayer-key": "k" }))).toBe(false);
  });

  describe.each(["1", "true"] as const)("env = '%s'", (envValue) => {
    beforeEach(() => {
      vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", envValue);
    });

    it("no cred headers at all: false — a keyless trial request is never rejected", () => {
      expect(rejectClientCreds(reqWithHeaders())).toBe(false);
    });

    it("the provider header ALONE (no key): false — only the key header gates this now", () => {
      expect(rejectClientCreds(reqWithHeaders({ "x-jargonslayer-provider": "openai-compat" }))).toBe(
        false,
      );
    });

    it("the REAL keyless default-client shape — taskHeaders(DEFAULT_SETTINGS, domain): provider + base-url, no key — passes the guard for every domain, since DEFAULT_SETTINGS is keyless openai-compat pointed at openrouter.ai and taskHeaders always sends the base-url header for an openai-compat provider (this is exactly the shape FIX 1 exists for — the old base-url-gates-too guard 400'd every keyless trial request under strict mode)", () => {
      for (const domain of ["detect", "translate", "summary"] as LlmTaskDomain[]) {
        const headers = taskHeaders(DEFAULT_SETTINGS, domain);
        expect(headers[PROVIDER_HEADERS.baseUrl]).toBeTruthy();
        expect(headers[PROVIDER_HEADERS.key]).toBeUndefined();
        expect(rejectClientCreds(reqWithHeaders(headers))).toBe(false);
      }
    });

    it("key header only: true", () => {
      expect(rejectClientCreds(reqWithHeaders({ "x-jargonslayer-key": "user-key" }))).toBe(true);
    });

    it("base-url header only: false — base-url alone can never reach resolveLlmConfig's BYOK branch (only a key header does — see that function), so it's provably harmless and must NOT reject; this is the FIX-1 flip from the old (broken) behavior", () => {
      expect(
        rejectClientCreds(reqWithHeaders({ "x-jargonslayer-base-url": "https://evil.example.com/v1" })),
      ).toBe(false);
    });

    it("both headers: true — the key header alone is sufficient, base-url along for the ride doesn't change the outcome", () => {
      expect(
        rejectClientCreds(
          reqWithHeaders({ "x-jargonslayer-key": "k", "x-jargonslayer-base-url": "https://evil.example.com" }),
        ),
      ).toBe(true);
    });

    it("key header name in a different casing: still true — the Headers API normalizes lookups case-insensitively, and `.has` follows the same rule as `.get`", () => {
      expect(rejectClientCreds(reqWithHeaders({ "X-JargonSlayer-Key": "user-key" }))).toBe(true);
    });

    it("base-url header name in a different casing, alone: still false", () => {
      expect(
        rejectClientCreds(reqWithHeaders({ "X-Jargonslayer-Base-Url": "https://evil.example.com" })),
      ).toBe(false);
    });

    it("an empty-string key header value: true — `.has` is presence-based, not truthiness, so a present-but-blank header still counts as attacker-supplied input (flips the old `.get`-truthiness pin, which read a blank header as absent)", () => {
      expect(rejectClientCreds(reqWithHeaders({ "x-jargonslayer-key": "" }))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------
// End-to-end: detect (requestId-stamped errorBody) + translate
// (no requestId) — see header comment for why these two get bespoke
// coverage beyond the five-route table below.
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

  it("JARGONSLAYER_SHARED_KEY_ONLY=1, ONLY a base-url header: passes the guard (FIX 1 — base-url alone is harmless and no longer 400s)", async () => {
    vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "1");
    const res = await detectPOST(
      postRequest("/api/detect", body, { "x-jargonslayer-base-url": "https://evil.example.com/v1" }),
    );
    // No server env key configured either — resolveLlmConfig legitimately
    // returns null past the guard, the same signal the keyless test below
    // uses to prove the 400 guard did NOT fire.
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("no_key");
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

  it("JARGONSLAYER_SHARED_KEY_ONLY=1, ONLY a base-url header: passes the guard (FIX 1 flip, same as detect's)", async () => {
    vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "1");
    const res = await translatePOST(
      postRequest("/api/translate", body, { "x-jargonslayer-base-url": "https://evil.example.com/v1" }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("no_key");
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

// ---------------------------------------------------------------
// Five-route strict-mode table (FIX 3 / adversarial review): the REAL
// taskHeaders() output built from keyless DEFAULT_SETTINGS is the
// exact shape every unconfigured preview trial tab sends — and it must
// pass every one of the five routes' guards, not just detect/
// translate's bespoke coverage above. Each row's domain matches what
// client.ts's own *ViaNext functions actually pass to taskHeaders for
// that route (detect/define/correct all ride the "detect" domain —
// see defineViaNext/correctViaNext's own comments on why; translate
// and summarize ride their own domains).
// ---------------------------------------------------------------

const ROUTE_TABLE: {
  name: string;
  post: (req: Request) => Promise<Response>;
  path: string;
  domain: LlmTaskDomain;
  body: unknown;
}[] = [
  { name: "detect", post: detectPOST, path: "/api/detect", domain: "detect", body: { context: "", new_text: "hi" } },
  {
    name: "define",
    post: definePOST,
    path: "/api/define",
    domain: "detect",
    body: { phrase: "circle back", context: "" },
  },
  {
    name: "translate",
    post: translatePOST,
    path: "/api/translate",
    domain: "translate",
    body: { segments: [{ id: "1", text: "hi" }], lang: "zh" },
  },
  {
    name: "summarize",
    post: summarizePOST,
    path: "/api/summarize",
    domain: "summary",
    body: { segments: [], expressions: [], terms: [] },
  },
  {
    name: "correct",
    post: correctPOST,
    path: "/api/correct",
    domain: "detect",
    body: { segments: [{ id: "1", text: "hi" }], context: "", lexicon: [] },
  },
];

describe.each(ROUTE_TABLE)("$name — strict-mode, real taskHeaders() shape", ({ post, path, domain, body }) => {
  beforeEach(() => {
    vi.stubEnv("JARGONSLAYER_SHARED_KEY_ONLY", "1");
  });

  it("keyless DEFAULT_SETTINGS taskHeaders() passes the guard (reaches resolveLlmConfig, not the strict-mode 400)", async () => {
    const headers = taskHeaders(DEFAULT_SETTINGS, domain);
    expect(headers[PROVIDER_HEADERS.key]).toBeUndefined();
    expect(headers[PROVIDER_HEADERS.baseUrl]).toBeTruthy(); // the exact FIX-1 shape
    const res = await post(postRequest(path, body, headers));
    // No server env key is configured in this test process, so a
    // request that legitimately passed the guard resolves to 401
    // no_key — the same downstream signal the bespoke detect/translate
    // suites above use to distinguish "guard let it through" from
    // "guard rejected it".
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("no_key");
  });

  it("the same keyless shape plus a key header: 400s", async () => {
    const headers = { ...taskHeaders(DEFAULT_SETTINGS, domain), [PROVIDER_HEADERS.key]: "user-key" };
    const res = await post(postRequest(path, body, headers));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject(CLIENT_CREDS_REJECTED_BODY);
  });
});
