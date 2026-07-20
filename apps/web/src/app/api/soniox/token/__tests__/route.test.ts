import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetRateLimiter } from "@/lib/llm/rateLimit";
import { POST } from "../route";

// Preview Soniox temp-key mint route — the single place the owner's
// server credential is exchanged for session-capped single-use keys.
// Mirrors openrouter/exchange/__tests__/route.test.ts's harness shape.

function makeRequest(ip = "9.9.9.9"): Request {
  return new Request("http://localhost/api/soniox/token", {
    method: "POST",
    headers: { "x-real-ip": ip },
  });
}

function mintedResponse() {
  return new Response(
    JSON.stringify({ api_key: "temp:ABC123", expires_at: "2026-07-20T00:02:00Z" }),
    { status: 201 },
  );
}

describe("POST /api/soniox/token", () => {
  let scratchDir: string;
  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "soniox-route-"));
    vi.stubEnv("JARGONSLAYER_SONIOX_LEDGER_PATH", join(scratchDir, "ledger.json"));
    vi.stubEnv("JARGONSLAYER_SONIOX_KEY", "sk-server-key");
    vi.stubEnv("JARGONSLAYER_SONIOX_PREVIEW", "1");
    resetRateLimiter();
  });
  afterEach(() => {
    resetRateLimiter();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("404s with no_key when the deploy has no server credential", async () => {
    vi.stubEnv("JARGONSLAYER_SONIOX_KEY", "");
    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("no_key");
  });

  it("404s (same body) when the key exists but the runtime lane flag is absent — credential alone must not arm the endpoint", async () => {
    vi.stubEnv("JARGONSLAYER_SONIOX_PREVIEW", "");
    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("no_key");
  });

  it("mints a session-capped single-use key and returns ONLY api_key/expires_at/session_seconds", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(mintedResponse()));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = await res.json();
    expect(json).toEqual({ api_key: "temp:ABC123", expires_at: "2026-07-20T00:02:00Z", session_seconds: 600 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.soniox.com/v1/auth/temporary-api-key");
    expect(init.headers.Authorization).toBe("Bearer sk-server-key");
    const body = JSON.parse(init.body);
    // The three scoping fields ARE the per-mint cost bound — losing any
    // one silently unbounds a grant, so pin all three.
    expect(body.usage_type).toBe("transcribe_websocket");
    expect(body.single_use).toBe(true);
    expect(body.max_session_duration_seconds).toBe(600);
    expect(body.expires_in_seconds).toBe(120);
  });

  it("429s preview_budget once the global daily mint cap (16) is spent across IPs", async () => {
    global.fetch = vi.fn().mockImplementation(() => Promise.resolve(mintedResponse()));
    // One mint per distinct IP stays inside each IP's own per-minute
    // burst and per-IP daily caps — only the global money cap can stop
    // the 17th.
    for (let i = 0; i < 16; i++) {
      const res = await POST(makeRequest(`10.1.0.${i}`));
      expect(res.status).toBe(200);
    }
    const res = await POST(makeRequest("10.1.0.99"));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("preview_budget");
  });

  it("refunds the budget slot when the upstream mint fails (outage ≠ spent budget)", async () => {
    // Upstream down: the same IP's mint fails, then succeeds after
    // recovery — WITHOUT the refund the failed attempts would count
    // against the daily caps. Distinct IPs keep the per-minute burst
    // limiter (2/min/IP) out of the picture; total attempts stay under
    // the global cap only because of the refunds.
    global.fetch = vi.fn().mockRejectedValue(new Error("down"));
    for (let i = 0; i < 16; i++) {
      const res = await POST(makeRequest(`10.2.0.${i}`));
      expect(res.status).toBe(502);
    }
    global.fetch = vi.fn().mockImplementation(() => Promise.resolve(mintedResponse()));
    const res = await POST(makeRequest("10.2.0.99"));
    expect(res.status).toBe(200);
  });

  it("502s upstream (refunded) when Soniox returns non-2xx, without forwarding its body", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ detail: "account xyz" }), { status: 401 }));
    const res = await POST(makeRequest());
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.code).toBe("upstream");
    expect(JSON.stringify(json)).not.toContain("account xyz");
  });

  it("502s upstream when Soniox returns a body without api_key", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ expires_at: "x" }), { status: 201 }));
    const res = await POST(makeRequest());
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("upstream");
  });

  it("a reservation that fails upstream AFTER UTC midnight refunds its OWN day, leaving the new day's budget whole (route threads mintedAt)", async () => {
    vi.useFakeTimers();
    try {
      const DAY_MS = 86_400_000;
      const nearMidnight = 30 * DAY_MS - 500; // 23:59:59.5 UTC of day 29
      vi.setSystemTime(nearMidnight);

      // Upstream hangs across midnight, then fails — the refund must
      // land on day 29's entry, not debit day 30's.
      global.fetch = vi.fn().mockImplementation(async () => {
        vi.setSystemTime(30 * DAY_MS + 500); // now day 30
        throw new Error("down");
      });
      expect((await POST(makeRequest("6.6.6.6"))).status).toBe(502);

      // THE discriminating assertion (Sol final-confirm): day 29's own
      // ledger entry must be back to 0 — a refund with a DEFAULTED
      // timestamp lands on day 30 (absent → no-op) and would leave day
      // 29's count stranded at 1, while every downstream day-30
      // assertion still passed. Reading the ledger file is the only
      // observation that separates the two implementations.
      const { readFileSync } = await import("node:fs");
      const ledger = JSON.parse(readFileSync(join(scratchDir, "ledger.json"), "utf8"));
      expect(ledger.days[String(29 * DAY_MS)]?.total ?? 0).toBe(0);

      // Day 30: this IP still has its FULL per-IP allowance of 3.
      global.fetch = vi.fn().mockImplementation(() => Promise.resolve(mintedResponse()));
      vi.setSystemTime(30 * DAY_MS + 61_000); // clear the burst window
      expect((await POST(makeRequest("6.6.6.6"))).status).toBe(200);
      vi.setSystemTime(30 * DAY_MS + 122_000);
      expect((await POST(makeRequest("6.6.6.6"))).status).toBe(200);
      vi.setSystemTime(30 * DAY_MS + 183_000);
      expect((await POST(makeRequest("6.6.6.6"))).status).toBe(200);
      vi.setSystemTime(30 * DAY_MS + 244_000);
      const fourth = await POST(makeRequest("6.6.6.6"));
      expect(fourth.status).toBe(429);
      expect((await fourth.json()).code).toBe("preview_budget");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails CLOSED (preview_budget) when the ledger file is corrupt rather than re-granting a fresh day", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(scratchDir, "ledger.json"), "{ torn wri");
    global.fetch = vi.fn().mockImplementation(() => Promise.resolve(mintedResponse()));
    const res = await POST(makeRequest("13.13.13.13"));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("preview_budget");
  });

  it("burst-limits the 3rd rapid call from one IP with rate_limit (not preview_budget)", async () => {
    global.fetch = vi.fn().mockImplementation(() => Promise.resolve(mintedResponse()));
    expect((await POST(makeRequest("7.7.7.7"))).status).toBe(200);
    expect((await POST(makeRequest("7.7.7.7"))).status).toBe(200);
    const res = await POST(makeRequest("7.7.7.7"));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("rate_limit");
  });
});
