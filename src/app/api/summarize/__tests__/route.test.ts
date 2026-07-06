import { describe, expect, it } from "vitest";
import { POST } from "../route";

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
    expect(json).toEqual({ error: "会议内容过长，超出报告生成上限", code: "bad_request" });
  });

  it("rejects a body whose total segment text exceeds 400k chars with 413", async () => {
    // 500 segments * 900 chars = 450,000 > 400,000, segment count well under the cap.
    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(500, 900) }));
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toEqual({ error: "会议内容过长，超出报告生成上限", code: "bad_request" });
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
