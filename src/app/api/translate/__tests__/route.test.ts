import { describe, expect, it } from "vitest";
import { POST } from "../route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeSegments(count: number, textLen = 10): { id: string; text: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `seg-${i}`,
    text: "a".repeat(textLen),
  }));
}

describe("POST /api/translate — request validation", () => {
  it("rejects 0 segments with 400 bad_request", async () => {
    const res = await POST(makeRequest({ segments: [], lang: "zh" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("rejects 7 segments (over the 6-segment batch cap) with 400 bad_request", async () => {
    const res = await POST(makeRequest({ segments: makeSegments(7, 1), lang: "zh" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("accepts exactly 6 segments (NOT rejected by the batch-size guard)", async () => {
    const res = await POST(makeRequest({ segments: makeSegments(6, 1), lang: "zh" }));
    expect(res.status).not.toBe(400);
  });

  it("rejects a segment with 1501-char text with 400 bad_request", async () => {
    const res = await POST(makeRequest({ segments: makeSegments(1, 1501), lang: "zh" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("accepts a segment with exactly 1500-char text (NOT rejected by the length guard)", async () => {
    const res = await POST(makeRequest({ segments: makeSegments(1, 1500), lang: "zh" }));
    expect(res.status).not.toBe(400);
  });

  it("rejects an empty-string segment text with 400 bad_request", async () => {
    const res = await POST(makeRequest({ segments: [{ id: "seg-0", text: "" }], lang: "zh" }));
    expect(res.status).toBe(400);
  });

  it("rejects a missing/empty lang with 400 bad_request", async () => {
    const res = await POST(makeRequest({ segments: makeSegments(1, 5), lang: "" }));
    expect(res.status).toBe(400);
  });

  it("a well-formed body passes validation (fails later for lack of an API key, not 400)", async () => {
    const res = await POST(makeRequest({ segments: makeSegments(3, 20), lang: "zh" }));
    expect(res.status).not.toBe(400);
    // No ANTHROPIC_API_KEY configured in the test env and no BYOK
    // header supplied, so it should fail key resolution instead —
    // confirms the validation guard let a normal request pass through.
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("no_key");
  });
});
