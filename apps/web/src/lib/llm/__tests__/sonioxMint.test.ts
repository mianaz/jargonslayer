import { afterEach, describe, expect, it } from "vitest";
import { allowSonioxMint, resetRateLimiter } from "../rateLimit";

// Money-path guard for the preview Soniox mint budget (the $10/mo
// ceiling behind /api/soniox/token). Defaults: 3 mints/IP/day, 16
// mints/day global. Fixed UTC-day window keyed off `now`.

const DAY_MS = 86_400_000;

afterEach(() => resetRateLimiter());

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

  it("enforces the global daily cap of 16 across many IPs", () => {
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
});
