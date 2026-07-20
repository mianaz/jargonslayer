import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowSonioxMint, refundSonioxMint, resetRateLimiter } from "../rateLimit";

// Money-path guard for the preview Soniox mint budget (the $10/mo
// ceiling behind /api/soniox/token). Defaults derive to 16 mints/day
// global (floor($10 / 31 days / (10min × $0.12/hr))) + 3/IP/day. The
// counts live in an on-disk ledger (Sol review 2026-07-20 H finding:
// an in-memory count resets on restart, quietly multiplying the
// advertised monthly ceiling) — each test points the ledger at its own
// scratch file via JARGONSLAYER_SONIOX_LEDGER_PATH.

const DAY_MS = 86_400_000;

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "soniox-ledger-"));
  vi.stubEnv("JARGONSLAYER_SONIOX_LEDGER_PATH", join(scratchDir, "ledger.json"));
  resetRateLimiter();
});
afterEach(() => {
  resetRateLimiter();
  vi.unstubAllEnvs();
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("allowSonioxMint", () => {
  it("caps a single IP at 3 mints per day, then resets the next day", () => {
    const t = 1_000; // any instant within UTC day 0
    expect(allowSonioxMint("1.1.1.1", t)).toBe(true);
    expect(allowSonioxMint("1.1.1.1", t)).toBe(true);
    expect(allowSonioxMint("1.1.1.1", t)).toBe(true);
    expect(allowSonioxMint("1.1.1.1", t)).toBe(false); // 4th blocked

    // Next UTC day → fresh allowance.
    expect(allowSonioxMint("1.1.1.1", t + DAY_MS)).toBe(true);
  });

  it("enforces the derived global daily cap of 16 across many IPs", () => {
    const t = 5_000;
    let granted = 0;
    // 10 distinct IPs × up to 3 each = 30 attempts; the global cap of
    // 16 must stop it at exactly 16 regardless of per-IP headroom.
    for (let ip = 0; ip < 10; ip++) {
      for (let n = 0; n < 3; n++) {
        if (allowSonioxMint(`10.0.0.${ip}`, t)) granted++;
      }
    }
    expect(granted).toBe(16);

    // A brand-new IP still under its own per-IP cap is refused once the
    // global budget is spent — the ceiling is global, not per-IP.
    expect(allowSonioxMint("172.16.0.1", t)).toBe(false);
  });

  it("SURVIVES a process restart: a re-imported module sees the same day's spent budget", async () => {
    const t = 9_000;
    for (let ip = 0; ip < 6; ip++) {
      for (let n = 0; n < 3; n++) allowSonioxMint(`10.9.0.${ip}`, t); // 16 granted, cap hit
    }
    expect(allowSonioxMint("10.9.9.9", t)).toBe(false);

    // Simulate the restart the Sol review's H finding is about: fresh
    // module state, same ledger file. WITHOUT the on-disk ledger this
    // re-import would happily grant 16 more.
    vi.resetModules();
    const fresh = await import("../rateLimit");
    expect(fresh.allowSonioxMint("10.9.9.9", t)).toBe(false);
  });

  it("fails CLOSED on valid-but-corrupt ledger JSON (array days, non-finite counters) — never re-grants off an untrusted file", () => {
    const path = join(scratchDir, "ledger.json");
    writeFileSync(path, JSON.stringify({ days: [] })); // array passes typeof "object"
    expect(allowSonioxMint("2.2.2.2", 1_000)).toBe(false);
    writeFileSync(path, JSON.stringify({ days: { "0": { total: "abc", perIp: {} } } }));
    expect(allowSonioxMint("2.2.2.2", 1_000)).toBe(false);
  });

  it("refund lands on the RESERVATION's day, not the refund-time day", () => {
    const lateNight = DAY_MS - 1_000; // 23:59:59 UTC of day 0
    const nextDay = DAY_MS + 1_000; // 00:00:01 UTC of day 1

    expect(allowSonioxMint("8.8.8.8", lateNight)).toBe(true);
    // Day 1 spends one slot of its own before the refund arrives.
    expect(allowSonioxMint("8.8.8.8", nextDay)).toBe(true);

    // The upstream failure for the day-0 reservation resolves after
    // midnight; the route passes the ORIGINAL `now` — day 1's count
    // must be untouched (still 1 of 3 for this IP → two more grants,
    // not three).
    refundSonioxMint("8.8.8.8", lateNight);
    expect(allowSonioxMint("8.8.8.8", nextDay)).toBe(true);
    expect(allowSonioxMint("8.8.8.8", nextDay)).toBe(true);
    expect(allowSonioxMint("8.8.8.8", nextDay)).toBe(false); // 4th of day 1 blocked
  });
});
