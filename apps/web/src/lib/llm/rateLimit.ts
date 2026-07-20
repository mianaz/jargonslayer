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
//
// (The Soniox mint budget at the bottom is the one DELIBERATE
// exception to the in-memory posture — see its own header for why a
// dollar-denominated cap can't accept restart amnesia. Server-only
// module: the node:fs imports below are safe because every importer
// is an API route — verified 2026-07-20, and a client-bundle import
// would fail the build loudly rather than silently.)

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
 *  first hop is the fallback for other reverse-proxy setups.
 *
 *  TRUST BOUNDARY (Sol review 2026-07-20, accept-documented): these
 *  headers are only as honest as the proxy in front — an origin
 *  reachable DIRECTLY lets a caller rotate X-Real-IP and sidestep
 *  every per-IP window in this file (all routes share this seam; it
 *  predates the Soniox lane). The blast radius is bounded by the
 *  GLOBAL caps (daily LLM budget / Soniox mint ledger), i.e. trial
 *  exhaustion for the day, never unbounded spend. Closing it for real
 *  is an ops task — firewall the origin to the proxy and strip
 *  inbound forwarding headers at nginx — not an app-code change. */
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
// temporary key is one ≤SONIOX_SESSION_SECONDS server-capped session.
//
// Unlike the LLM daily budget above, this one is DURABLE (a small
// JSON ledger on disk, sync read-modify-write per mint) and the daily
// cap is DERIVED from the owner's monthly dollar ceiling rather than
// hand-sized: dailyMints = floor(monthlyUsd / 31 / perSessionUsd).
// Both choices close the 2026-07-20 Sol review's H finding — an
// in-memory count resets on every restart, quietly multiplying the
// advertised "$10/month" by (1 + restarts/day), and a hand-sized
// count silently diverges from the dollar target whenever the session
// length knob moves. Deriving from the money knob makes the ceiling
// hold by construction; persisting makes it hold across deploys.
// Sync fs (not async) is deliberate: it makes reserve() atomic w.r.t.
// the single-threaded event loop, and the write volume is ≤ a few
// dozen tiny writes per UTC day.

// Soniox real-time streaming list price. Not an env knob: a price
// change should be a reviewed edit here (it re-derives the daily cap),
// not a silent per-deployment override.
const SONIOX_RT_USD_PER_HOUR = 0.12;

/** One minted session's server-enforced maximum length — exported for
 *  /api/soniox/token, which passes it as max_session_duration_seconds
 *  (live-verified 2026-07-20: Soniox itself drops the ws at the cap).
 *  Clamped to [60, 900]: below 60s the transport's 403-collision age
 *  heuristic (SESSION_CAP_MIN_AGE_MS) could mislabel a real cap as an
 *  auth failure; above 900s a single grant exceeds the per-session
 *  cost the trial copy promises (Sol review M finding — the knobs
 *  must not be able to wander off the budget math unbounded). */
export const SONIOX_SESSION_SECONDS = (() => {
  const raw = Number(process.env.JARGONSLAYER_SONIOX_SESSION_SECONDS);
  const val = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 600;
  return Math.min(900, Math.max(60, val));
})();

// The money knob. Everything else derives from it.
const SONIOX_MONTHLY_USD = (() => {
  const raw = Number(process.env.JARGONSLAYER_SONIOX_MONTHLY_USD);
  const val = Number.isFinite(raw) && raw > 0 ? raw : 10;
  return Math.min(200, val);
})();

// floor(10 / 31 / (600/3600 × 0.12)) = 16 mints/day at the defaults —
// ≈$9.92/mo worst case. NO floor-of-1 (Sol re-verify, L finding): a
// monthly budget too small to fund even one session per day derives to
// 0 and the lane simply refuses every mint — honest, unlike rounding
// the owner's ceiling UP past what they configured.
const SONIOX_MINT_DAILY_TOTAL = Math.floor(
  SONIOX_MONTHLY_USD / 31 / ((SONIOX_SESSION_SECONDS / 3600) * SONIOX_RT_USD_PER_HOUR),
);

const SONIOX_MINT_DAILY_PER_IP = (() => {
  const raw = Number(process.env.JARGONSLAYER_SONIOX_MINT_DAILY_PER_IP);
  const val = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
  return Math.min(8, Math.max(1, val));
})();

// Ledger shape: { days: { "<utcDayStartMs>": { total, perIp: {ip: n} } } }.
// Day keys let a refund target the exact day its reservation was
// charged to (Sol review L finding: a refund crossing UTC midnight
// must not erase a NEW day's count). Pruned to the last 2 days on
// every write, so the file never grows past a few hundred bytes.
interface SonioxLedgerDay {
  total: number;
  perIp: Record<string, number>;
}
interface SonioxLedger {
  days: Record<string, SonioxLedgerDay>;
}

// Per-call (not module-load) so tests can point each case at a scratch
// file; production resolves once to the same path every call.
function sonioxLedgerPath(): string {
  return (
    process.env.JARGONSLAYER_SONIOX_LEDGER_PATH ||
    join(homedir(), ".jargonslayer", "soniox-mint-ledger.json")
  );
}

/** null = the ledger EXISTS but can't be trusted (unreadable or
 *  corrupt) — callers must fail the mint closed rather than re-grant
 *  a full day off a wiped count (Sol re-verify 2026-07-20, M finding:
 *  fresh-on-corrupt turned any partial write into restart amnesia).
 *  Only ENOENT (genuinely no file yet — first mint ever, or a test's
 *  scratch path) starts a fresh empty ledger. */
function loadSonioxLedger(): SonioxLedger | null {
  let raw: string;
  try {
    raw = readFileSync(sonioxLedgerPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { days: {} };
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as SonioxLedger;
    if (sonioxLedgerShapeValid(parsed)) return parsed;
  } catch {
    // fall through — corrupt
  }
  return null;
}

/** Full shape walk, not a typeof spot-check (Sol final-confirm,
 *  2026-07-20): `{"days":[]}` passes `typeof === "object"`, and a
 *  non-finite counter (e.g. a string total) makes every `>=` cap
 *  comparison false — i.e. valid-but-corrupt JSON silently fails
 *  OPEN. Anything structurally off → the whole file is untrusted. */
function sonioxLedgerShapeValid(parsed: unknown): parsed is SonioxLedger {
  if (!parsed || typeof parsed !== "object") return false;
  const days = (parsed as SonioxLedger).days;
  if (!days || typeof days !== "object" || Array.isArray(days)) return false;
  for (const day of Object.values(days)) {
    if (!day || typeof day !== "object" || Array.isArray(day)) return false;
    if (!Number.isFinite(day.total) || day.total < 0) return false;
    if (!day.perIp || typeof day.perIp !== "object" || Array.isArray(day.perIp)) return false;
    for (const n of Object.values(day.perIp)) {
      if (!Number.isFinite(n) || n < 0) return false;
    }
  }
  return true;
}

/** True when the ledger write landed. A ledger that cannot be
 *  PERSISTED fails the mint closed (money safety over availability):
 *  granting on an unwritable ledger would silently revert to exactly
 *  the restart-amnesia this ledger exists to prevent. */
function saveSonioxLedger(ledger: SonioxLedger, dayStart: number): boolean {
  // Prune: keep today and yesterday (the only day a refund can still
  // legitimately target after a midnight-straddling request).
  for (const key of Object.keys(ledger.days)) {
    if (Number(key) < dayStart - DAY_MS) delete ledger.days[key];
  }
  try {
    const path = sonioxLedgerPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Atomic replace (write-temp + rename) so a crash mid-write leaves
    // the PREVIOUS ledger intact instead of a truncated file — paired
    // with loadSonioxLedger's fail-closed-on-corrupt, a torn write can
    // now only ever cost availability, never budget.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger));
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** True when one more preview Soniox key may be minted for `ip` today
 *  — must fit BOTH the per-IP daily cap (fairness/anti-abuse) and the
 *  derived global daily cap (the money ceiling), and the reservation
 *  must PERSIST (see saveSonioxLedger). Counts against both only when
 *  granted. Fixed UTC-day window; the route must pass the SAME `now`
 *  to a later refundSonioxMint so the refund lands on this
 *  reservation's day. */
export function allowSonioxMint(ip: string, now: number = Date.now()): boolean {
  const dayStart = utcDayStart(now);
  const ledger = loadSonioxLedger();
  if (ledger === null) return false; // corrupt/unreadable — fail closed
  const day = (ledger.days[String(dayStart)] ??= { total: 0, perIp: {} });
  const ipCount = day.perIp[ip] ?? 0;

  if (ipCount >= SONIOX_MINT_DAILY_PER_IP || day.total >= SONIOX_MINT_DAILY_TOTAL) {
    return false;
  }
  day.perIp[ip] = ipCount + 1;
  day.total += 1;
  return saveSonioxLedger(ledger, dayStart);
}

/** Refund one previously-granted mint. Called by the token route when
 *  the UPSTREAM mint fails after allowSonioxMint already reserved the
 *  slot: reserving BEFORE the async upstream call keeps concurrent
 *  requests from over-minting past the cap (no check-then-act window),
 *  and refunding on upstream failure keeps a Soniox outage + user
 *  retries from draining the day's budget without a single key issued.
 *  `now` MUST be the same instant the route passed to allowSonioxMint:
 *  the refund decrements that reservation's own day entry — if it was
 *  already pruned (a >1-day-hung request), the refund is a no-op
 *  rather than a debit against a newer day. */
export function refundSonioxMint(ip: string, now: number = Date.now()): void {
  const dayStart = utcDayStart(now);
  const ledger = loadSonioxLedger();
  if (ledger === null) return; // corrupt — nothing trustworthy to refund into
  const day = ledger.days[String(dayStart)];
  if (!day) return;
  day.total = Math.max(0, day.total - 1);
  day.perIp[ip] = Math.max(0, (day.perIp[ip] ?? 0) - 1);
  saveSonioxLedger(ledger, dayStart);
}

/** Test helper — clears all window state, including the on-disk
 *  Soniox mint ledger (tests point JARGONSLAYER_SONIOX_LEDGER_PATH at
 *  a scratch file). */
export function resetRateLimiter(): void {
  buckets.clear();
  dailyBuckets.clear();
  try {
    rmSync(sonioxLedgerPath(), { force: true });
  } catch {
    // Best-effort: a missing/undeletable scratch ledger only matters
    // inside tests, which stub the path per-case anyway.
  }
}
