import { describe, expect, it } from "vitest";
import { POST } from "../route";
import { PROFILE_HINT_MAX_CHARS } from "@/lib/llm/profileHint";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/detect", {
    method: "POST",
    headers: { "content-type": "application/json" },
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
