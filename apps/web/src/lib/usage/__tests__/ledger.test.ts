import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import type { UsageRecord } from "../ledger";

// In-memory idb-keyval mock, shared by ledger.ts AND history/storage.ts
// (recordUsage's own Settings.usageTracking gate reads storage.ts's
// loadSettings(), which goes through the SAME "idb-keyval" module id —
// see ledger.ts's own header for why it reads storage.ts rather than
// the zustand store). Mirrors history/glossary.test.ts's mock shape.
const memStore = new Map<string, unknown>();

vi.mock("idb-keyval", () => ({
  get: vi.fn(async (key: string) => memStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    memStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    memStore.delete(key);
  }),
}));

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    day: "2026-07-24",
    provider: "soniox",
    kind: "stt",
    metric: "seconds",
    value: 10,
    ...overrides,
  };
}

describe("usage/ledger.ts", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  // ---------------------------------------------------------------
  // Pure functions — no IDB involved.
  // ---------------------------------------------------------------

  describe("aggregateUsage (pure)", () => {
    it("sums value into a matching (day,provider,kind,metric) row", async () => {
      const { aggregateUsage } = await import("../ledger");
      const base = [record({ value: 10 })];
      const next = aggregateUsage(base, record({ value: 5 }));
      expect(next).toEqual([record({ value: 15 })]);
      expect(next).not.toBe(base); // pure — new array, base untouched
      expect(base).toEqual([record({ value: 10 })]);
    });

    it("appends a new row when no (day,provider,kind,metric) match exists", async () => {
      const { aggregateUsage } = await import("../ledger");
      const base = [record({ provider: "soniox" })];
      const next = aggregateUsage(base, record({ provider: "deepgram" }));
      expect(next).toHaveLength(2);
    });

    it("keeps day/provider/kind/metric independent — different metric never merges", async () => {
      const { aggregateUsage } = await import("../ledger");
      const base = [record({ kind: "llm", metric: "calls", value: 1, provider: "anthropic" })];
      const next = aggregateUsage(
        base,
        record({ kind: "llm", metric: "inputTokens", value: 500, provider: "anthropic" }),
      );
      expect(next).toHaveLength(2);
    });

    it.each([0, -1, NaN, Infinity])("drops a non-finite/non-positive value (%s)", async (value) => {
      const { aggregateUsage } = await import("../ledger");
      expect(aggregateUsage([], record({ value }))).toEqual([]);
    });
  });

  describe("pruneOldUsage (pure)", () => {
    it("keeps today and the 89 days before it, drops anything older", async () => {
      const { pruneOldUsage } = await import("../ledger");
      const now = new Date(2026, 6, 22); // local July 22 2026
      const records = [
        record({ day: "2026-07-22" }), // today — kept
        record({ day: "2026-04-24" }), // exactly 89 days before — kept (retention boundary)
        record({ day: "2026-04-20" }), // >90 days before — dropped
      ];
      expect(pruneOldUsage(records, now).map((r) => r.day)).toEqual(["2026-07-22", "2026-04-24"]);
    });
  });

  describe("dateKeyDaysAgo (pure)", () => {
    it("computes the local day-key N days before a given date", async () => {
      const { dateKeyDaysAgo } = await import("../ledger");
      const now = new Date(2026, 6, 24);
      expect(dateKeyDaysAgo(0, now)).toBe("2026-07-24");
      expect(dateKeyDaysAgo(7, now)).toBe("2026-07-17");
    });
  });

  describe("summarizeUsage (pure)", () => {
    it("totals per provider and reports the covered date range", async () => {
      const { summarizeUsage } = await import("../ledger");
      const records: UsageRecord[] = [
        record({ day: "2026-07-01", provider: "soniox", kind: "stt", metric: "seconds", value: 60 }),
        record({ day: "2026-07-02", provider: "soniox", kind: "stt", metric: "seconds", value: 30 }),
        record({ day: "2026-07-01", provider: "anthropic", kind: "llm", metric: "calls", value: 3 }),
        record({
          day: "2026-07-01",
          provider: "anthropic",
          kind: "llm",
          metric: "inputTokens",
          value: 500,
        }),
        record({
          day: "2026-07-01",
          provider: "anthropic",
          kind: "llm",
          metric: "outputTokens",
          value: 80,
        }),
      ];
      const summary = summarizeUsage(records);
      expect(summary.earliestDay).toBe("2026-07-01");
      expect(summary.latestDay).toBe("2026-07-02");
      expect(summary.providers).toEqual([
        { provider: "anthropic", sttSeconds: 0, llmCalls: 3, llmInputTokens: 500, llmOutputTokens: 80 },
        { provider: "soniox", sttSeconds: 90, llmCalls: 0, llmInputTokens: 0, llmOutputTokens: 0 },
      ]);
    });

    it("honors `since`, excluding records before the cutoff", async () => {
      const { summarizeUsage } = await import("../ledger");
      const records: UsageRecord[] = [
        record({ day: "2026-06-01", value: 100 }),
        record({ day: "2026-07-10", value: 20 }),
      ];
      const summary = summarizeUsage(records, { since: "2026-07-01" });
      expect(summary.since).toBe("2026-07-01");
      expect(summary.providers).toEqual([
        { provider: "soniox", sttSeconds: 20, llmCalls: 0, llmInputTokens: 0, llmOutputTokens: 0 },
      ]);
    });

    it("returns an empty/null summary for no records", async () => {
      const { summarizeUsage } = await import("../ledger");
      expect(summarizeUsage([])).toEqual({
        since: null,
        providers: [],
        earliestDay: null,
        latestDay: null,
      });
    });
  });

  // ---------------------------------------------------------------
  // Impure shell — recordUsage/getUsage/clearUsage against the mocked
  // IDB.
  // ---------------------------------------------------------------

  describe("recordUsage / getUsage / clearUsage", () => {
    it("aggregates repeated calls into one persisted row", async () => {
      const ledger = await import("../ledger");
      await ledger.recordUsage({ provider: "soniox", kind: "stt", metric: "seconds", value: 10 });
      await ledger.recordUsage({ provider: "soniox", kind: "stt", metric: "seconds", value: 5 });

      const records = await ledger.getUsage();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ provider: "soniox", kind: "stt", metric: "seconds", value: 15 });
      // Actually durable, not just cached in memory.
      expect(memStore.get("jargonslayer:usage")).toEqual(records);
    });

    it("records once per completed call — two DIFFERENT providers stay two separate rows", async () => {
      const ledger = await import("../ledger");
      await ledger.recordUsage({ provider: "soniox", kind: "stt", metric: "seconds", value: 10 });
      await ledger.recordUsage({ provider: "deepgram", kind: "stt", metric: "seconds", value: 10 });
      expect(await ledger.getUsage()).toHaveLength(2);
    });

    it("aggregates correctly under CONCURRENT (non-sequential) calls — no lost update", async () => {
      // Fires both WITHOUT awaiting between them (unlike every other
      // test in this file), exercising the synchronous-cache-mutation
      // invariant recordUsage's own doc comment claims: the in-memory
      // cache is updated before either call's first `await`, so the
      // second call's merge always sees the first one's update rather
      // than racing off a stale read.
      const ledger = await import("../ledger");
      const p1 = ledger.recordUsage({ provider: "soniox", kind: "stt", metric: "seconds", value: 10 });
      const p2 = ledger.recordUsage({ provider: "soniox", kind: "stt", metric: "seconds", value: 20 });
      await Promise.all([p1, p2]);

      const records = await ledger.getUsage();
      expect(records).toHaveLength(1);
      expect(records[0].value).toBe(30);
      expect(memStore.get("jargonslayer:usage")).toEqual(records);
    });

    it("is a no-op when Settings.usageTracking is explicitly false", async () => {
      memStore.set("jargonslayer:settings", { ...DEFAULT_SETTINGS, usageTracking: false } satisfies Settings);
      const ledger = await import("../ledger");
      await ledger.recordUsage({ provider: "anthropic", kind: "llm", metric: "calls", value: 1 });
      expect(await ledger.getUsage()).toEqual([]);
    });

    it("records when no Settings blob exists yet (fresh install defaults to on)", async () => {
      // No "jargonslayer:settings" key seeded at all.
      const ledger = await import("../ledger");
      await ledger.recordUsage({ provider: "anthropic", kind: "llm", metric: "calls", value: 1 });
      expect(await ledger.getUsage()).toHaveLength(1);
    });

    it("never throws when the underlying IDB write rejects", async () => {
      const idb = await import("idb-keyval");
      vi.mocked(idb.set).mockRejectedValueOnce(new Error("boom"));
      const ledger = await import("../ledger");
      await expect(
        ledger.recordUsage({ provider: "soniox", kind: "stt", metric: "seconds", value: 1 }),
      ).resolves.toBeUndefined();
    });

    it("drops a non-finite/non-positive value without writing anything", async () => {
      const ledger = await import("../ledger");
      await ledger.recordUsage({ provider: "soniox", kind: "stt", metric: "seconds", value: 0 });
      expect(await ledger.getUsage()).toEqual([]);
    });

    it("clearUsage empties both the in-memory cache and IDB", async () => {
      const ledger = await import("../ledger");
      await ledger.recordUsage({ provider: "soniox", kind: "stt", metric: "seconds", value: 1 });
      await ledger.clearUsage();
      expect(await ledger.getUsage()).toEqual([]);
      expect(memStore.get("jargonslayer:usage")).toBeUndefined();
    });

    it("prunes records older than the 90-day retention window on load", async () => {
      memStore.set("jargonslayer:usage", [record({ day: "2020-01-01" })] satisfies UsageRecord[]);
      const ledger = await import("../ledger");
      expect(await ledger.getUsage()).toEqual([]);
      // The prune is also persisted back, not just filtered in memory.
      expect(memStore.get("jargonslayer:usage")).toEqual([]);
    });

    it("getUsage({since}) filters to the requested window", async () => {
      memStore.set("jargonslayer:usage", [
        record({ day: "2026-06-01" }),
        record({ day: "2026-07-20" }),
      ] satisfies UsageRecord[]);
      const ledger = await import("../ledger");
      const records = await ledger.getUsage({ since: "2026-07-01" });
      expect(records.map((r) => r.day)).toEqual(["2026-07-20"]);
    });
  });
});
