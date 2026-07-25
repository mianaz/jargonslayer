// Local, private usage ledger (v0.6, BYOK spend-visibility ask) — lets a
// BYOK user see what their OWN keys are being spent on: STT seconds
// streamed and LLM calls/tokens, entirely on-device. NO TELEMETRY —
// nothing here ever leaves the browser/desktop app. This is a local
// aggregate for the settings UsagePanel, not analytics, and has no
// server component at all (unlike e.g. webhookUrl/autoExport, which
// deliberately DO send data out).
//
// Storage: idb-keyval key "jargonslayer:usage", same cache+write posture
// as history/glossary.ts (in-memory cache mutated SYNCHRONOUSLY before
// any awaited IDB write — see persist() below) — every export here is a
// thin impure shell around the pure functions (aggregateUsage/
// pruneOldUsage/summarizeUsage/dateKeyDaysAgo), which is what makes the
// aggregation/pruning/summary math directly unit-testable without IDB.
//
// Never per-event (T1): every record is aggregated to its (day,
// provider, kind, metric) bucket at write time — a year of heavy
// multi-provider use is still at most a few hundred rows, never an
// unbounded per-call event log.
//
// Retention: 90 days, pruned at LOAD time (ensureLoaded below), not on
// every write — a ledger nobody reopens for months must not grow
// forever, but re-checking the cutoff on every single recordUsage()
// call is unneeded churn for a value that only moves once a day per
// bucket.
//
// Gate: recordUsage reads Settings.usageTracking (default true) via
// history/storage.ts's loadSettings() — deliberately NOT via the
// zustand store (store.ts's useApp) — because this module is imported
// from llm/providerCore.ts, which MUST stay isomorphic (safe to import
// server-side from Next.js route handlers — see that file's own
// header). storage.ts has zero DOM/browser-only dependencies (plain
// idb-keyval + types), so importing it here keeps providerCore.ts's own
// import graph server-safe too; store.ts (theme engine, DOM writes, …)
// would not.
import { del, get, set } from "idb-keyval";
import * as storage from "../history/storage";

const USAGE_KEY = "jargonslayer:usage";
const RETENTION_DAYS = 90;

export type UsageKind = "stt" | "llm";
export type UsageMetric = "seconds" | "calls" | "inputTokens" | "outputTokens";

export interface UsageRecord {
  /** Local YYYY-MM-DD (see dateKey) — the user's own calendar day, not
   *  UTC's. */
  day: string;
  /** STT engine kind ("soniox"/"deepgram"/"elevenlabs") for kind:"stt",
   *  or "anthropic"/the openai-compat base URL's hostname for
   *  kind:"llm" — see llm/providerCore.ts's resolveLlmProviderId. */
  provider: string;
  kind: UsageKind;
  metric: UsageMetric;
  value: number;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local-date key ("YYYY-MM-DD") — the same idiom used across this
 *  codebase (history/export.ts, history/autoExport.ts, cornell.ts, …)
 *  rather than toISOString's UTC-based date, so "today" matches the
 *  user's own calendar day. */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The day-key `daysAgo` days before `now` — shared by the 90-day
 *  retention cutoff below (pruneOldUsage) and by UsagePanel's own 7-day/
 *  30-day summary windows (summarizeUsage's `since`). */
export function dateKeyDaysAgo(daysAgo: number, now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  return dateKey(d);
}

/** Pure — drops any record older than the 90-day retention window.
 *  `RETENTION_DAYS - 1` keeps exactly 90 distinct day-buckets inclusive
 *  of `now`'s own day (today + the 89 days before it). */
export function pruneOldUsage(records: UsageRecord[], now: Date = new Date()): UsageRecord[] {
  const cutoff = dateKeyDaysAgo(RETENTION_DAYS - 1, now);
  return records.filter((r) => r.day >= cutoff);
}

/** Pure — merges one new entry into an aggregated-records array:
 *  matches on (day, provider, kind, metric) and sums `value` into the
 *  existing row, or appends a new row when none matches. Never mutates
 *  `records`. Non-finite/non-positive values are dropped defensively —
 *  a caller computing elapsed-ms/1000 or reading a malformed usage
 *  block must never quietly corrupt the ledger with a zero/negative/NaN
 *  row. */
export function aggregateUsage(records: UsageRecord[], entry: UsageRecord): UsageRecord[] {
  if (!Number.isFinite(entry.value) || entry.value <= 0) return records;
  const idx = records.findIndex(
    (r) =>
      r.day === entry.day &&
      r.provider === entry.provider &&
      r.kind === entry.kind &&
      r.metric === entry.metric,
  );
  if (idx === -1) return [...records, entry];
  const next = [...records];
  next[idx] = { ...next[idx], value: next[idx].value + entry.value };
  return next;
}

function filterSince(records: UsageRecord[], since: string | undefined): UsageRecord[] {
  if (!since) return records;
  return records.filter((r) => r.day >= since);
}

export interface ProviderUsageSummary {
  provider: string;
  sttSeconds: number;
  llmCalls: number;
  llmInputTokens: number;
  llmOutputTokens: number;
}

export interface UsageSummary {
  /** The cutoff actually applied, or null when summarizing every record
   *  passed in (no `since`). */
  since: string | null;
  providers: ProviderUsageSummary[];
  /** Date range actually COVERED by the summarized records (not the
   *  requested window) — null/null when there is nothing to summarize
   *  (e.g. a brand-new install). */
  earliestDay: string | null;
  latestDay: string | null;
}

/** Pure — per-provider totals for the settings UsagePanel (T3). Takes
 *  whatever records the caller already has (typically one getUsage()
 *  fetch, reused for both a 7-day and a 30-day window via two
 *  summarizeUsage calls, rather than two separate IDB reads). */
export function summarizeUsage(
  records: UsageRecord[],
  opts: { since?: string } = {},
): UsageSummary {
  const filtered = filterSince(records, opts.since);
  const byProvider = new Map<string, ProviderUsageSummary>();
  for (const r of filtered) {
    let s = byProvider.get(r.provider);
    if (!s) {
      s = { provider: r.provider, sttSeconds: 0, llmCalls: 0, llmInputTokens: 0, llmOutputTokens: 0 };
      byProvider.set(r.provider, s);
    }
    if (r.kind === "stt" && r.metric === "seconds") s.sttSeconds += r.value;
    else if (r.kind === "llm" && r.metric === "calls") s.llmCalls += r.value;
    else if (r.kind === "llm" && r.metric === "inputTokens") s.llmInputTokens += r.value;
    else if (r.kind === "llm" && r.metric === "outputTokens") s.llmOutputTokens += r.value;
  }
  const days = filtered.map((r) => r.day).sort();
  return {
    since: opts.since ?? null,
    providers: [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    earliestDay: days[0] ?? null,
    latestDay: days[days.length - 1] ?? null,
  };
}

// ---------------------------------------------------------------
// Impure shell — cache + IDB, mirrors history/glossary.ts's own
// cache+persist pattern (see that file's header).
// ---------------------------------------------------------------

let cachedRecords: UsageRecord[] = [];
let loaded = false;
let loadPromise: Promise<void> | null = null;

async function persist(next: UsageRecord[]): Promise<void> {
  cachedRecords = next;
  if (!hasIndexedDb()) return;
  try {
    await set(USAGE_KEY, next);
  } catch (err) {
    console.warn("[usage] persist failed", err);
  }
}

/** Loads from IDB exactly once (a shared in-flight promise covers
 *  concurrent callers — mirrors history/storage.ts's own
 *  migrateLegacyOnce) and prunes anything past the 90-day retention
 *  window. Every exported function below awaits this first, so the
 *  cache is always populated before it's read OR read-modify-written —
 *  recordUsage in particular must never compute its merge off a still-
 *  empty, not-yet-loaded cache, or it would overwrite real IDB history
 *  with just the one new entry. */
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      let raw: UsageRecord[] = [];
      if (hasIndexedDb()) {
        try {
          raw = (await get<UsageRecord[]>(USAGE_KEY)) ?? [];
        } catch (err) {
          console.warn("[usage] load failed", err);
          raw = [];
        }
      }
      const pruned = pruneOldUsage(raw);
      if (pruned.length !== raw.length) {
        await persist(pruned);
      } else {
        cachedRecords = pruned;
      }
      loaded = true;
    })();
  }
  await loadPromise;
}

/** Record one usage delta, aggregated into today's (provider, kind,
 *  metric) bucket. Fire-and-forget from every call site (T2) — never
 *  throws, so a write failure (or a disabled Settings.usageTracking,
 *  default true) can never break a meeting or an LLM call.
 *
 *  Concurrent calls are safe without an explicit write queue: the
 *  in-memory cache is mutated SYNCHRONOUSLY (inside persist(), before
 *  its own first `await`) as part of each call's own synchronous run —
 *  so if two recordUsage() calls are in flight, the second one's merge
 *  always reads the first one's already-applied update before computing
 *  its own, the same invariant history/glossary.ts's persist() already
 *  relies on. */
export async function recordUsage(entry: Omit<UsageRecord, "day">): Promise<void> {
  try {
    const settings = await storage.loadSettings();
    if (settings?.usageTracking === false) return;
    await ensureLoaded();
    const next = aggregateUsage(cachedRecords, { ...entry, day: dateKey(new Date()) });
    await persist(next);
  } catch (err) {
    console.warn("[usage] recordUsage failed", err);
  }
}

/** All records within the 90-day retention window, optionally cut to
 *  `since` (a day-key, inclusive — see dateKeyDaysAgo). */
export async function getUsage(opts: { since?: string } = {}): Promise<UsageRecord[]> {
  await ensureLoaded();
  return filterSince(cachedRecords, opts.since);
}

/** Wipes the ledger (the settings UsagePanel's 清除使用记录 button,
 *  after its own confirm step) — does not touch Settings.usageTracking
 *  itself, only accumulated history. */
export async function clearUsage(): Promise<void> {
  cachedRecords = [];
  loaded = true;
  if (!hasIndexedDb()) return;
  try {
    await del(USAGE_KEY);
  } catch (err) {
    console.warn("[usage] clear failed", err);
  }
}
