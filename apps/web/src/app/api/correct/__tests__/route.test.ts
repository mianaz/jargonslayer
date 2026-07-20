import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";
import { allowDailyBudget, resetRateLimiter } from "@/lib/llm/rateLimit";
import {
  CORRECT_MAX_LEXICON_CHARS,
  CORRECT_MAX_SEGMENTS_PER_CALL,
  CORRECT_MAX_TOTAL_CHARS_PER_CALL,
} from "@/lib/llm/tasks/correct";

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/correct", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function makeSegments(count: number, textLen = 10): { id: string; text: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `seg-${i}`,
    text: "a".repeat(textLen),
  }));
}

const baseBody = { context: "", lexicon: [] as string[] };

describe("POST /api/correct — request validation", () => {
  it("rejects 0 segments with 400 bad_request", async () => {
    const res = await POST(makeRequest({ ...baseBody, segments: [] }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  // Finding 1 fix (pre-merge review): the route's segment-count cap is
  // now the PER-CALL cap tasks/correct.ts single-sources (a whole
  // meeting no longer arrives as one HTTP body — see CorrectionReview.
  // tsx's own chunking comment) — was 300 (whole-meeting) before.
  it("rejects over CORRECT_MAX_SEGMENTS_PER_CALL segments with 400 bad_request", async () => {
    const res = await POST(
      makeRequest({ ...baseBody, segments: makeSegments(CORRECT_MAX_SEGMENTS_PER_CALL + 1, 1) }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("accepts exactly CORRECT_MAX_SEGMENTS_PER_CALL segments (NOT rejected by the batch-size guard)", async () => {
    const res = await POST(
      makeRequest({ ...baseBody, segments: makeSegments(CORRECT_MAX_SEGMENTS_PER_CALL, 1) }),
    );
    expect(res.status).not.toBe(400);
  });

  // Finding 1c — total-char-budget refinement (zod .superRefine, since
  // no single field's .max() can express a sum across the array).
  // textLen stays <= 1500 (SegmentSchema's own per-segment cap) on
  // every case below, so these isolate the NEW sum-across-the-array
  // check rather than incidentally tripping the pre-existing per-field
  // one.
  it("rejects a body whose total segment text exceeds CORRECT_MAX_TOTAL_CHARS_PER_CALL with 400 bad_request", async () => {
    // 20 * 1300 = 26,000 > 24,000, each segment (1300) well under 1500.
    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(20, 1300) }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("accepts a body whose total segment text is exactly at CORRECT_MAX_TOTAL_CHARS_PER_CALL (NOT rejected by the char-budget guard)", async () => {
    // 16 * 1500 = 24,000 exactly.
    const textLen = CORRECT_MAX_TOTAL_CHARS_PER_CALL / 16;
    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(16, textLen) }));
    expect(res.status).not.toBe(400);
  });

  // lexicon term length stays <= 200 (the existing per-term cap) on
  // every case below, same isolation rationale as above.
  it("rejects a lexicon whose total characters exceed CORRECT_MAX_LEXICON_CHARS with 400 bad_request, even under the 500-term array cap", async () => {
    // 21 terms * 200 = 4,200 > 4,000.
    const res = await POST(
      makeRequest({
        ...baseBody,
        segments: makeSegments(1, 5),
        lexicon: Array.from({ length: 21 }, () => "x".repeat(200)),
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("accepts a lexicon at exactly CORRECT_MAX_LEXICON_CHARS total characters", async () => {
    // 20 terms * 200 = 4,000 exactly.
    const termLen = 200;
    const termCount = CORRECT_MAX_LEXICON_CHARS / termLen;
    const res = await POST(
      makeRequest({
        ...baseBody,
        segments: makeSegments(1, 5),
        lexicon: Array.from({ length: termCount }, () => "x".repeat(termLen)),
      }),
    );
    expect(res.status).not.toBe(400);
  });

  it("rejects a segment with 1501-char text with 400 bad_request", async () => {
    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(1, 1501) }));
    expect(res.status).toBe(400);
  });

  it("rejects an empty-string segment text with 400 bad_request", async () => {
    const res = await POST(
      makeRequest({ ...baseBody, segments: [{ id: "seg-0", text: "" }] }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a lexicon over 500 terms with 400 bad_request", async () => {
    const res = await POST(
      makeRequest({
        ...baseBody,
        segments: makeSegments(1, 5),
        lexicon: Array.from({ length: 501 }, (_, i) => `term-${i}`),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("meetingTitle/model are optional — a body without them still passes validation", async () => {
    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(1, 5) }));
    expect(res.status).not.toBe(400);
  });

  it("a well-formed body passes validation (fails later for lack of an API key, not 400)", async () => {
    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(3, 20) }));
    expect(res.status).not.toBe(400);
    // No ANTHROPIC_API_KEY configured in the test env and no BYOK
    // header supplied, so it should fail key resolution instead —
    // confirms the validation guard let a normal request pass through.
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("no_key");
  });
});

// Diagnostics (item 5): every error response carries a requestId — see
// detect/route.test.ts's identical coverage (translate's own route
// deliberately has none; correction rides the requestId-stamping
// pattern instead, same as detect/define/summarize).
describe("POST /api/correct — error responses carry requestId (diagnostics)", () => {
  it("a 401 no_key response includes a non-empty requestId string", async () => {
    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(1, 5) }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(typeof json.requestId).toBe("string");
    expect(json.requestId.length).toBeGreaterThan(0);
  });

  it("a 400 bad_request response also includes a requestId", async () => {
    const res = await POST(makeRequest({ ...baseBody, segments: [] }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.requestId).toBe("string");
  });
});

// Global daily budget (§5 A5's own "add EXACTLY that addition" to
// rateLimit.ts's DAILY_TASK_CAPS) + BYOK bypass — mirrors detect/
// route.test.ts's identical coverage.
describe("POST /api/correct — global daily budget (server-key only) + BYOK bypass", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetRateLimiter();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetRateLimiter();
  });

  it("once the daily task cap (100) is spent, a server-key request gets 429 with the exhausted-budget copy", async () => {
    vi.stubEnv("JARGONSLAYER_API_KEY", "server-secret");
    for (let i = 0; i < 100; i++) allowDailyBudget("correct"); // correct's own daily cap

    const res = await POST(makeRequest({ ...baseBody, segments: makeSegments(1, 5) }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json).toMatchObject({
      error: "体验版今日 AI 额度已用完，请明日再试，或使用本地版 / 自备 API Key",
      code: "rate_limit",
    });
  });

  it("BYOK requests (client-supplied key) bypass the daily budget entirely, even fully exhausted", async () => {
    vi.stubEnv("JARGONSLAYER_API_KEY", "server-secret");
    for (let i = 0; i < 100; i++) allowDailyBudget("correct"); // exhaust it as if server-key traffic had spent it all

    const fixture = { corrections: [] };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(fixture) }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      makeRequest(
        { ...baseBody, segments: makeSegments(1, 5) },
        { "x-jargonslayer-key": "user-key" },
      ),
    );
    // Reaches the real (mocked) provider call and succeeds — proves the
    // budget check never ran for this request, not just that it didn't
    // happen to 429.
    expect(res.status).toBe(200);
  });
});
