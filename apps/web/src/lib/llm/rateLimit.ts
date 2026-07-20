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

/** Test helper — clears all window state. */
export function resetRateLimiter(): void {
  buckets.clear();
  dailyBuckets.clear();
}
