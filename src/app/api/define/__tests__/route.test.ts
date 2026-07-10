import { describe, expect, it } from "vitest";
import { POST } from "../route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/define", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// #48 step 3 — same passthrough contract as detect/__tests__/route.test.ts.
describe("POST /api/define — profile field passthrough (#48 step 3)", () => {
  it("accepts a request with a profile hint string (fails later for lack of a key, not schema validation)", async () => {
    const res = await POST(
      makeRequest({ phrase: "circle back", context: "", profile: "角色：工程师" }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("no_key");
  });

  it("accepts a request with no profile field at all", async () => {
    const res = await POST(makeRequest({ phrase: "circle back", context: "" }));
    expect(res.status).toBe(401);
  });

  it("rejects a profile string over 500 chars with 400 bad_request", async () => {
    const res = await POST(
      makeRequest({ phrase: "circle back", context: "", profile: "x".repeat(501) }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });
});
