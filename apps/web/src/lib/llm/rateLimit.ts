// Fixed-window per-IP rate limiter for requests served by the shared
// server credential (the hosted demo's env key). In-memory by design:
// the demo runs as a single Node process, and BYOK requests never hit
// this path, so self-hosted multi-instance setups are unaffected.
//
// Also holds a per-UTC-day GLOBAL spend budget (allowDailyBudget,
// below) for that same shared credential: the per-IP window above
// bounds one caller's burst rate, but says nothing about total spend
// across many distributed IPs over a day — the slow-burn abuse
// pattern a per-IP limiter alone can't see. Same in-memory,
// single-process posture as above: a restart resets the day's count.
// That matches this file's existing documented posture, and the worst
// case is a handful of extra requests around a deploy, not an
// unbounded blow-out.

const WINDOW_MS = 60_000;
// Stale-bucket sweep threshold — prevents unbounded growth under a
// wide-IP scan without paying a sweep on every call.
const SWEEP_THRESHOLD = 5_000;

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

/** Best-effort client IP behind the nginx/Cloudflare chain: nginx sets
 *  X-Real-IP from the restored CF-Connecting-IP; X-Forwarded-For's
 *  first hop is the fallback for other reverse-proxy setups. */
export function clientIp(req: Request): string {
  return (
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/** True when `key` still fits in its per-minute budget (and counts the
 *  request); false when the caller should 429. */
export function allowRequest(
  key: string,
  limit: number,
  now: number = Date.now(),
): boolean {
  if (buckets.size > SWEEP_THRESHOLD) {
    for (const [k, b] of buckets) {
      if (now - b.windowStart >= WINDOW_MS) buckets.delete(k);
    }
  }

  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}

// ---------------------------------------------------------------
// Global daily budget — see header comment above.
// ---------------------------------------------------------------

const DAY_MS = 86_400_000;

// Per-task caps for the shared credential's daily spend, plus one
// combined cap across every task — a request must fit BOTH to pass
// (see allowDailyBudget). Hardcoded: unlike the total cap below,
// these aren't worth a per-deployment env knob each.
const DAILY_TASK_CAPS: Record<string, number> = {
  detect: 1500,
  define: 400,
  translate: 1500,
  summarize: 100,
  // v0.5 Wave-1 Feature 2 (AI transcript correction, §5 A5): batch,
  // one-shot per meeting like summarize — same cap.
  correct: 100,
};

const DAILY_BUDGET_TOTAL_DEFAULT = 3000;
// Parsed once at module load. Absent, empty, non-numeric, or <= 0 all
// fall back to the default rather than silently capping the shared
// key at 0 from e.g. an unset-but-present env var.
const DAILY_BUDGET_TOTAL = (() => {
  const raw = Number(process.env.JARGONSLAYER_DAILY_BUDGET_TOTAL);
  return Number.isFinite(raw) && raw > 0 ? raw : DAILY_BUDGET_TOTAL_DEFAULT;
})();

const DAILY_TOTAL_KEY = "__total__";
const dailyBuckets = new Map<string, Bucket>();

function utcDayStart(now: number): number {
  return now - (now % DAY_MS);
}

function dailyBucket(key: string, dayStart: number): Bucket {
  const existing = dailyBuckets.get(key);
  if (existing && existing.windowStart === dayStart) return existing;
  const fresh: Bucket = { windowStart: dayStart, count: 0 };
  dailyBuckets.set(key, fresh);
  return fresh;
}

/** True when `task` still fits both its own daily cap and the shared
 *  DAILY_BUDGET_TOTAL cap (and counts the request against both);
 *  false when the caller should 429. Fixed UTC-day window (resets at
 *  UTC midnight), unlike `allowRequest`'s sliding-by-first-hit minute
 *  window above. */
export function allowDailyBudget(task: string, now: number = Date.now()): boolean {
  const dayStart = utcDayStart(now);
  const taskCap = DAILY_TASK_CAPS[task] ?? Infinity;
  const taskBucket = dailyBucket(task, dayStart);
  const totalBucket = dailyBucket(DAILY_TOTAL_KEY, dayStart);

  if (taskBucket.count >= taskCap || totalBucket.count >= DAILY_BUDGET_TOTAL) {
    return false;
  }
  taskBucket.count++;
  totalBucket.count++;
  return true;
}

// ---------------------------------------------------------------
// Soniox preview-lane mint budget — the money cap behind
// /api/soniox/token. The preview build offers the hosted Soniox STT
// trial on the OWNER's Soniox credential (not BYOK); every minted
// temporary key is one ≤N-minute server-capped session, so worst-case
// spend = (mints/day) × (session minutes / 60) × Soniox's $0.12/hr
// streaming rate. The daily total below is sized so daily×31 stays
// under the owner's monthly ceiling ($10/mo → ≤$9.92 at the defaults:
// 16 mints/day × 10-min sessions × $0.12/hr).
//
// Same in-memory, single-process, restart-resets posture as the LLM
// budget above (documented there): a restart re-grants the day's
// count. For a low-traffic niche preview that only redeploys a few
// times a week, the worst case is a few extra cents around a deploy,
// not a blow-out — and the per-session server cap (max_session_
// duration_seconds on the minted key) bounds each grant regardless.
// A persistent monthly counter is the upgrade if traffic ever makes
// the reset window matter (noted in the route).

const SONIOX_MINT_DAILY_TOTAL = (() => {
  const raw = Number(process.env.JARGONSLAYER_SONIOX_MINT_DAILY);
  return Number.isFinite(raw) && raw > 0 ? raw : 16;
})();

const SONIOX_MINT_DAILY_PER_IP = (() => {
  const raw = Number(process.env.JARGONSLAYER_SONIOX_MINT_DAILY_PER_IP);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();

const SONIOX_MINT_TOTAL_KEY = "soniox-mint-total";

/** True when one more preview Soniox key may be minted for `ip` today
 *  — must fit BOTH the per-IP daily cap (fairness/anti-abuse) and the
 *  global daily cap (the money ceiling). Counts against both only when
 *  both pass, so a caller blocked by the global cap doesn't burn its
 *  own per-IP allowance. Fixed UTC-day window like allowDailyBudget. */
export function allowSonioxMint(ip: string, now: number = Date.now()): boolean {
  const dayStart = utcDayStart(now);
  const ipBucket = dailyBucket(`soniox-mint-ip:${ip}`, dayStart);
  const totalBucket = dailyBucket(SONIOX_MINT_TOTAL_KEY, dayStart);

  if (ipBucket.count >= SONIOX_MINT_DAILY_PER_IP || totalBucket.count >= SONIOX_MINT_DAILY_TOTAL) {
    return false;
  }
  ipBucket.count++;
  totalBucket.count++;
  return true;
}

/** Refund one previously-granted mint for `ip` (same UTC day only).
 *  Called by the token route when the UPSTREAM mint fails after
 *  allowSonioxMint already reserved the slot: reserving BEFORE the
 *  async upstream call keeps concurrent requests from over-minting
 *  past the cap (no check-then-act window), and refunding on upstream
 *  failure keeps a Soniox outage + user retries from draining the
 *  day's budget without a single key issued. Floor at 0 guards a
 *  refund landing after the UTC-day bucket rolled over. */
export function refundSonioxMint(ip: string, now: number = Date.now()): void {
  const dayStart = utcDayStart(now);
  const ipBucket = dailyBucket(`soniox-mint-ip:${ip}`, dayStart);
  const totalBucket = dailyBucket(SONIOX_MINT_TOTAL_KEY, dayStart);
  ipBucket.count = Math.max(0, ipBucket.count - 1);
  totalBucket.count = Math.max(0, totalBucket.count - 1);
}

/** Test helper — clears all window state. */
export function resetRateLimiter(): void {
  buckets.clear();
  dailyBuckets.clear();
}
