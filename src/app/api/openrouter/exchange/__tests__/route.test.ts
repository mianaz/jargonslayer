import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimiter } from "@/lib/llm/rateLimit";
import { POST } from "../route";

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/openrouter/exchange", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const validBody = {
  code: "auth-code-123",
  code_verifier: "a-valid-verifier-value",
  code_challenge_method: "S256" as const,
};

describe("POST /api/openrouter/exchange — request validation", () => {
  beforeEach(() => resetRateLimiter());
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a missing code with 400 bad_request", async () => {
    const res = await POST(makeRequest({ ...validBody, code: undefined }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("rejects a missing code_verifier with 400 bad_request", async () => {
    const res = await POST(makeRequest({ ...validBody, code_verifier: undefined }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("rejects a code_challenge_method other than S256 with 400 bad_request", async () => {
    const res = await POST(makeRequest({ ...validBody, code_challenge_method: "plain" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("rejects a non-JSON body with 400 bad_request", async () => {
    const req = new Request("http://localhost/api/openrouter/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("bad_request");
  });

  it("forwards a well-formed body to OpenRouter and passes through the key on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ key: "sk-or-v1-xyz" }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ key: "sk-or-v1-xyz" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(validBody);
  });

  it("propagates the upstream error message and status on a non-2xx OpenRouter response", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "invalid code" }), { status: 400 }));

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid code");
    expect(json.code).toBe("upstream");
  });

  it("returns 502 upstream when the fetch to OpenRouter itself throws", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.code).toBe("upstream");
  });

  it("rate-limits after 10 requests/min from the same IP", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ key: "sk-or-v1-xyz" }), { status: 200 }));

    const headers = { "x-real-ip": "5.5.5.5" };
    for (let i = 0; i < 10; i++) {
      const res = await POST(makeRequest(validBody, headers));
      expect(res.status).not.toBe(429);
    }
    const res = await POST(makeRequest(validBody, headers));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.code).toBe("rate_limit");
  });
});
