import { describe, expect, it } from "vitest";
import { POST } from "../route";
import { PROFILE_HINT_MAX_CHARS } from "@/lib/llm/profileHint";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/summarize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeSegments(count: number, textLen = 10): { index: number; text: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    text: "a".repeat(textLen),
  }));
}

const baseBody = {
  expressions: [],
  terms: [],
};

describe("POST /api/summarize — request size caps", () => {
  it("rejects a body with more than 2000 segments with 413 before any LLM dispatch", async () => {
    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(2001, 1) }));
    expect(res.status).toBe(413);
    const json = await res.json();
    // requestId (diagnostics, item 5) is a fresh id per response — not
    // asserted by value, just that every error response carries one.
    expect(json).toMatchObject({ error: "会议内容过长，超出报告生成上限", code: "bad_request" });
    expect(typeof json.requestId).toBe("string");
  });

  it("rejects a body whose total segment text exceeds 400k chars with 413", async () => {
    // 500 segments * 900 chars = 450,000 > 400,000, segment count well under the cap.
    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(500, 900) }));
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toMatchObject({ error: "会议内容过长，超出报告生成上限", code: "bad_request" });
    expect(typeof json.requestId).toBe("string");
  });

  it("a body within both caps proceeds past the size check (fails later for lack of an API key, not 413)", async () => {
    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(10, 10) }));
    expect(res.status).not.toBe(413);
    // No ANTHROPIC_API_KEY configured in the test env and no BYOK header
    // supplied, so it should fail key resolution instead — confirms the
    // size guard let a normal-sized request pass through.
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("no_key");
  });

  it("exactly at the segment-count cap (2000) is NOT rejected by the size guard", async () => {
    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(2000, 1) }));
    expect(res.status).not.toBe(413);
  });
});

// #48 step 3 — the `profile` wire field (pre-rendered background-
// profile hint, threaded exactly like `lang`, affecting the sweep
// stage only) just needs to survive zod validation and reach
// runSweepStage/buildSweepUserMessage; same no-key-configured
// convention as the size-cap tests above.
describe("POST /api/summarize — profile field passthrough (#48 step 3)", () => {
  it("accepts a request with a profile hint string (fails later for lack of a key, not schema validation)", async () => {
    const res = await POST(
      makeRequest({ ...baseBody, segments: makeSegments(3, 10), profile: "行业：互联网" }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("no_key");
  });

  it("accepts a request with no profile field at all", async () => {
    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(3, 10) }));
    expect(res.status).toBe(401);
  });

  it("rejects a profile string over PROFILE_HINT_MAX_CHARS with 400 bad_request (#48 s1 review item 9)", async () => {
    const res = await POST(
      makeRequest({
        ...baseBody,
        segments: makeSegments(3, 10),
        profile: "x".repeat(PROFILE_HINT_MAX_CHARS + 1),
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("accepts a profile string at exactly PROFILE_HINT_MAX_CHARS", async () => {
    const res = await POST(
      makeRequest({
        ...baseBody,
        segments: makeSegments(3, 10),
        profile: "x".repeat(PROFILE_HINT_MAX_CHARS),
      }),
    );
    expect(res.status).not.toBe(400);
  });
});

// Diagnostics (item 5) — see detect/__tests__/route.test.ts's identical block.
describe("POST /api/summarize — error responses carry requestId (diagnostics)", () => {
  it("a 401 no_key response includes a non-empty requestId string", async () => {
    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(3, 10) }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(typeof json.requestId).toBe("string");
    expect(json.requestId.length).toBeGreaterThan(0);
  });

  it("two error responses get two DIFFERENT requestIds", async () => {
    const res1 = await POST(makeRequest({ ...baseBody, segments: makeSegments(3, 10) }));
    const res2 = await POST(makeRequest({ ...baseBody, segments: makeSegments(3, 10) }));
    const json1 = await res1.json();
    const json2 = await res2.json();
    expect(json1.requestId).not.toBe(json2.requestId);
  });
});
