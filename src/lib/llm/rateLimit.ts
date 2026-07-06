// Fixed-window per-IP rate limiter for requests served by the shared
// server credential (the hosted demo's env key). In-memory by design:
// the demo runs as a single Node process, and BYOK requests never hit
// this path, so self-hosted multi-instance setups are unaffected.

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

/** Test helper — clears all window state. */
export function resetRateLimiter(): void {
  buckets.clear();
}
