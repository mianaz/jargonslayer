import { describe, expect, it } from "vitest";
import { POST } from "../route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/context", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Auto meeting-context detection (field request: "need AI to auto
// detect the context for better detection") — mirrors define/route.
// test.ts's own shape (no key configured in this test env, so every
// well-formed request fails at resolveLlmConfig with 401 no_key rather
// than a schema error — that's exactly what proves the body PASSED
// validation).
describe("POST /api/context — zod validation", () => {
  it("accepts a well-formed body (fails later for lack of a key, not schema validation)", async () => {
    const res = await POST(makeRequest({ excerpt: "some early transcript text", lang: "zh" }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("no_key");
  });

  it("accepts an optional model field", async () => {
    const res = await POST(
      makeRequest({ excerpt: "some early transcript text", lang: "en", model: "some/model" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a missing excerpt with 400 bad_request", async () => {
    const res = await POST(makeRequest({ lang: "zh" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("rejects an empty-string excerpt (min(1)) with 400 bad_request", async () => {
    const res = await POST(makeRequest({ excerpt: "", lang: "zh" }));
    expect(res.status).toBe(400);
  });

  it("rejects a missing lang with 400 bad_request (unlike detect's optional lang, this one is required)", async () => {
    const res = await POST(makeRequest({ excerpt: "some text" }));
    expect(res.status).toBe(400);
  });

  it("rejects a lang outside zh/en with 400 bad_request", async () => {
    const res = await POST(makeRequest({ excerpt: "some text", lang: "fr" }));
    expect(res.status).toBe(400);
  });

  it("rejects an excerpt over the 8000-char cap with 400 bad_request", async () => {
    const res = await POST(makeRequest({ excerpt: "x".repeat(8001), lang: "zh" }));
    expect(res.status).toBe(400);
  });

  it("accepts an excerpt at exactly the 8000-char cap (covers the 7000-char refresh window plus slack)", async () => {
    const res = await POST(makeRequest({ excerpt: "x".repeat(8000), lang: "zh" }));
    expect(res.status).not.toBe(400);
  });

  it("rejects a non-JSON body with 400 bad_request", async () => {
    const res = await POST(
      new Request("http://localhost/api/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });
});

// Diagnostics (item 5) — see detect/__tests__/route.test.ts's identical block.
describe("POST /api/context — error responses carry requestId (diagnostics)", () => {
  it("a 401 no_key response includes a non-empty requestId string", async () => {
    const res = await POST(makeRequest({ excerpt: "some text", lang: "zh" }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(typeof json.requestId).toBe("string");
    expect(json.requestId.length).toBeGreaterThan(0);
  });

  it("two error responses get two DIFFERENT requestIds", async () => {
    const res1 = await POST(makeRequest({ excerpt: "some text", lang: "zh" }));
    const res2 = await POST(makeRequest({ excerpt: "some text", lang: "zh" }));
    const json1 = await res1.json();
    const json2 = await res2.json();
    expect(json1.requestId).not.toBe(json2.requestId);
  });
});
