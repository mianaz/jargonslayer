import { describe, expect, it } from "vitest";
import { POST } from "../route";

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

  it("rejects a profile string over 500 chars with 400 bad_request", async () => {
    const res = await POST(
      makeRequest({
        context: "",
        new_text: "hi",
        profile: "x".repeat(501),
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("accepts a profile string at exactly 500 chars", async () => {
    const res = await POST(
      makeRequest({ context: "", new_text: "hi", profile: "x".repeat(500) }),
    );
    expect(res.status).not.toBe(400);
  });
});
