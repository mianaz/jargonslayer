import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LearnRecord } from "../types";

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

function makeRecord(overrides: Partial<LearnRecord> = {}): LearnRecord {
  const now = 1000;
  return {
    learnKey: "expression:circle back",
    kind: "expression",
    surface: "circle back",
    familiarity: 0,
    suppressed: false,
    reps: 0,
    intervalDays: 0,
    ease: 2.5,
    dueAt: now,
    lapses: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("learn/store.ts", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("learnKey uses the same normalizers as detection dedupe", async () => {
    const learn = await import("../store");
    expect(learn.learnKey("expression", "Circling Back!")).toBe("expression:circling back");
    expect(learn.learnKey("term", "arr")).toBe("term:ARR");
  });

  it("upsertLearnRecord writes by learnKey and keeps the sync cache current", async () => {
    const learn = await import("../store");
    const record = makeRecord();
    const map = await learn.upsertLearnRecord(record);

    expect(map).toEqual({ [record.learnKey]: record });
    expect(learn.getCachedLearnset()).toEqual({ [record.learnKey]: record });
    expect(memStore.get("jargonslayer:learnset")).toEqual({ [record.learnKey]: record });
  });

  it("upsertLearnRecord updates an existing key without disturbing other records", async () => {
    const learn = await import("../store");
    const first = makeRecord();
    const second = makeRecord({
      learnKey: "term:ARR",
      kind: "term",
      surface: "ARR",
    });
    await learn.upsertLearnRecord(first);
    await learn.upsertLearnRecord(second);
    const updated = makeRecord({ familiarity: 0.5, updatedAt: 2000 });
    const map = await learn.upsertLearnRecord(updated);

    expect(Object.keys(map).sort()).toEqual(["expression:circle back", "term:ARR"]);
    expect(map[updated.learnKey]).toEqual(updated);
    expect(map[second.learnKey]).toEqual(second);
  });

  it("removeLearnRecord removes one key and preserves the rest", async () => {
    const learn = await import("../store");
    const first = makeRecord();
    const second = makeRecord({
      learnKey: "term:ARR",
      kind: "term",
      surface: "ARR",
    });
    await learn.upsertLearnRecord(first);
    await learn.upsertLearnRecord(second);

    const map = await learn.removeLearnRecord(first.learnKey);
    expect(map).toEqual({ [second.learnKey]: second });
  });

  it("clearLearnset empties the cache and deletes the persisted key", async () => {
    const learn = await import("../store");
    await learn.upsertLearnRecord(makeRecord());
    await learn.clearLearnset();

    expect(learn.getCachedLearnset()).toEqual({});
    expect(memStore.has("jargonslayer:learnset")).toBe(false);
  });

  it("loadLearnset hydrates the persisted map", async () => {
    const record = makeRecord();
    memStore.set("jargonslayer:learnset", { [record.learnKey]: record });

    const learn = await import("../store");
    const loaded = await learn.loadLearnset();

    expect(loaded).toEqual({ [record.learnKey]: record });
    expect(learn.getCachedLearnset()).toEqual({ [record.learnKey]: record });
  });

  it("loadLearnset returns {} without touching storage when IndexedDB is unavailable", async () => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    const learn = await import("../store");

    await expect(learn.loadLearnset()).resolves.toEqual({});
  });
});
