import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";
import { PROFILE_HINT_MAX_CHARS } from "@jargonslayer/core/llm/profileHint";
import { allowDailyBudget, resetRateLimiter } from "@/lib/llm/rateLimit";

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/detect", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// #48 step 3 — the `profile` wire field (pre-rendered background-
// profile hint, threaded exactly like `lang`) just needs to survive
// zod validation and reach buildDetectUserMessage; no ANTHROPIC_API_KEY
// is configured in the test env, so a well-formed request always fails
// at key resolution (401 no_key), never at schema validation — the
// same convention translate/route.test.ts and summarize/route.test.ts
// already use to prove a field threads through without a real LLM call.
describe("POST /api/detect — profile field passthrough (#48 step 3)", () => {
  it("accepts a request with a profile hint string (fails later for lack of a key, not schema validation)", async () => {
    const res = await POST(
      makeRequest({
        context: "",
        new_text: "We need to circle back on this.",
        profile: "行业：互联网；角色：产品经理",
      }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("no_key");
  });

  it("accepts a request with no profile field at all (field is optional, same as `lang`)", async () => {
    const res = await POST(
      makeRequest({ context: "", new_text: "We need to circle back on this." }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a profile string over PROFILE_HINT_MAX_CHARS with 400 bad_request (#48 s1 review item 9 — shared constant, not a separately-hardcoded 500)", async () => {
    const res = await POST(
      makeRequest({
        context: "",
        new_text: "hi",
        profile: "x".repeat(PROFILE_HINT_MAX_CHARS + 1),
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("accepts a profile string at exactly PROFILE_HINT_MAX_CHARS", async () => {
    const res = await POST(
      makeRequest({ context: "", new_text: "hi", profile: "x".repeat(PROFILE_HINT_MAX_CHARS) }),
    );
    expect(res.status).not.toBe(400);
  });
});

// Diagnostics (item 5): every 4xx/5xx error response carries a fresh
// requestId so a user's diag ref (client-side) can chain to this
// exact server-side response — see lib/diag/requestId.ts.
describe("POST /api/detect — error responses carry requestId (diagnostics)", () => {
  it("a 401 no_key response includes a non-empty requestId string", async () => {
    const res = await POST(makeRequest({ context: "", new_text: "hi" }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(typeof json.requestId).toBe("string");
    expect(json.requestId.length).toBeGreaterThan(0);
  });

  it("a 400 bad_request response also includes a requestId", async () => {
    const res = await POST(makeRequest({ context: "", new_text: "" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.requestId).toBe("string");
  });

  it("two error responses get two DIFFERENT requestIds", async () => {
    const res1 = await POST(makeRequest({ context: "", new_text: "hi" }));
    const res2 = await POST(makeRequest({ context: "", new_text: "hi" }));
    const json1 = await res1.json();
    const json2 = await res2.json();
    expect(json1.requestId).not.toBe(json2.requestId);
  });
});

// Global daily budget — server-key-only gap the per-IP limiter above
// can't close (distributed IPs / slow burn). See rateLimit.ts's
// allowDailyBudget doc for the mechanism; this exercises just the
// route-level wiring (detect stands in for all four routes, which all
// wire it identically).
describe("POST /api/detect — global daily budget (server-key only)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetRateLimiter();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetRateLimiter();
  });

  it("once the daily task cap is spent, a server-key request gets 429 with the exhausted-budget copy", async () => {
    vi.stubEnv("JARGONSLAYER_API_KEY", "server-secret");
    for (let i = 0; i < 1500; i++) allowDailyBudget("detect"); // detect's own daily cap

    const res = await POST(
      makeRequest({ context: "", new_text: "We need to circle back on this." }),
    );
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json).toMatchObject({
      error: "体验版今日 AI 额度已用完，请明日再试，或使用本地版 / 自备 API Key",
      code: "rate_limit",
    });
  });

  it("BYOK requests (client-supplied key) bypass the daily budget entirely, even fully exhausted", async () => {
    vi.stubEnv("JARGONSLAYER_API_KEY", "server-secret");
    for (let i = 0; i < 1500; i++) allowDailyBudget("detect"); // exhaust it as if server-key traffic had spent it all

    const fixture = { expressions: [], terms: [] };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(fixture) }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      makeRequest(
        { context: "", new_text: "We need to circle back on this." },
        { "x-jargonslayer-key": "user-key" },
      ),
    );
    // Reaches the real (mocked) provider call and succeeds — proves
    // the budget check never ran for this request, not just that it
    // didn't happen to 429.
    expect(res.status).toBe(200);
  });
});
