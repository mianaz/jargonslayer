import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get as idbGet, set as idbSet } from "idb-keyval";
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

// ---------------------------------------------------------------
// Hydration atomicity (Codex/#48 s1 review item 2a): loadLearnset's
// disk read must not clobber a record already written into the
// module cache since this module was loaded — store.ts's hydrate()
// depends on this to keep its own action-wins merge meaningful (see
// store.test.ts's "hydrate — atomicity" describe block for the
// store-level half of this fix).
// ---------------------------------------------------------------

describe("loadLearnset — action-wins merge with the module cache (#48 s1 review item 2a)", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("a record already upserted into the cache before this load survives, even when the disk read races behind it", async () => {
    const learn = await import("../store");
    const newerFromAction = makeRecord({ familiarity: 0.9, updatedAt: 2000 });
    await learn.upsertLearnRecord(newerFromAction);

    // Force THIS ONE read to resolve with a stale snapshot for the
    // same key, regardless of what's actually in memStore right now —
    // simulates loadLearnset's get() having started before the action
    // above's own write landed on disk.
    const staleOnDisk = makeRecord({ familiarity: 0.1, updatedAt: 500 });
    vi.mocked(idbGet).mockResolvedValueOnce({ [staleOnDisk.learnKey]: staleOnDisk });

    const loaded = await learn.loadLearnset();

    expect(loaded[newerFromAction.learnKey]).toEqual(newerFromAction);
  });

  it("a disk record for a DIFFERENT key than anything in the cache is still picked up normally", async () => {
    const learn = await import("../store");
    const cachedOnly = makeRecord({ learnKey: "term:ARR", surface: "ARR", kind: "term" });
    await learn.upsertLearnRecord(cachedOnly);

    const onDiskOnly = makeRecord({
      learnKey: "expression:touch base",
      surface: "touch base",
    });
    vi.mocked(idbGet).mockResolvedValueOnce({ [onDiskOnly.learnKey]: onDiskOnly });

    const loaded = await learn.loadLearnset();

    expect(loaded).toEqual({
      [cachedOnly.learnKey]: cachedOnly,
      [onDiskOnly.learnKey]: onDiskOnly,
    });
  });
});

// ---------------------------------------------------------------
// Transient read-failure safety (Codex/#48 s1 review item 3): a
// failed get() must not enable the next mutation to blindly persist
// a partial map as the COMPLETE one.
// ---------------------------------------------------------------

describe("transient load failures never enable a destructive whole-map write (#48 s1 review item 3)", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("get-fails-once, then a mutation: previously-persisted records are NOT lost", async () => {
    const existing = makeRecord({ learnKey: "term:ARR", surface: "ARR", kind: "term" });
    memStore.set("jargonslayer:learnset", { [existing.learnKey]: existing });

    vi.mocked(idbGet).mockRejectedValueOnce(new Error("boom"));
    const learn = await import("../store");

    await expect(learn.loadLearnset()).resolves.toEqual({});
    expect(learn.getLearnsetLoadState()).toBe("failed");

    // The next mutation must re-attempt the load (this time the mock
    // no longer rejects) and merge before writing — NOT blindly
    // persist {newRecord} as the complete map.
    const newRecord = makeRecord({ familiarity: 0.5 });
    const map = await learn.upsertLearnRecord(newRecord);

    const expected = { [existing.learnKey]: existing, [newRecord.learnKey]: newRecord };
    expect(map).toEqual(expected);
    expect(memStore.get("jargonslayer:learnset")).toEqual(expected);
    expect(learn.getLearnsetLoadState()).toBe("loaded");
  });

  it("set-fails: the mutation rejects with a typed LearnsetPersistError instead of silently succeeding", async () => {
    const learn = await import("../store");
    vi.mocked(idbSet).mockRejectedValueOnce(new Error("disk full"));

    await expect(learn.upsertLearnRecord(makeRecord())).rejects.toBeInstanceOf(
      learn.LearnsetPersistError,
    );
  });

  it("after a write failure, a further write is refused outright if the reload attempt ALSO fails", async () => {
    const learn = await import("../store");
    vi.mocked(idbSet).mockRejectedValueOnce(new Error("disk full"));
    await expect(learn.upsertLearnRecord(makeRecord())).rejects.toBeInstanceOf(
      learn.LearnsetPersistError,
    );
    expect(learn.getLearnsetLoadState()).toBe("failed");

    vi.mocked(idbGet).mockRejectedValueOnce(new Error("still broken"));
    await expect(
      learn.upsertLearnRecord(makeRecord({ familiarity: 0.3 })),
    ).rejects.toBeInstanceOf(learn.LearnsetPersistError);
  });

  it("once the underlying read recovers, a subsequent write succeeds normally again", async () => {
    const learn = await import("../store");
    vi.mocked(idbSet).mockRejectedValueOnce(new Error("disk full"));
    await expect(learn.upsertLearnRecord(makeRecord())).rejects.toBeInstanceOf(
      learn.LearnsetPersistError,
    );

    // get() is not mocked to fail this time — the automatic reload
    // inside upsertLearnRecord succeeds, flips loadState back to
    // "loaded", and this write proceeds normally.
    const record = makeRecord({ familiarity: 0.7 });
    const map = await learn.upsertLearnRecord(record);
    expect(map[record.learnKey]).toEqual(record);
    expect(learn.getLearnsetLoadState()).toBe("loaded");
  });

  it("removeLearnRecord gets the same reload-before-write protection as upsertLearnRecord", async () => {
    const existing = makeRecord({ learnKey: "term:ARR", surface: "ARR", kind: "term" });
    const other = makeRecord({ familiarity: 0.2 });
    memStore.set("jargonslayer:learnset", {
      [existing.learnKey]: existing,
      [other.learnKey]: other,
    });

    vi.mocked(idbGet).mockRejectedValueOnce(new Error("boom"));
    const learn = await import("../store");
    await expect(learn.loadLearnset()).resolves.toEqual({});

    const map = await learn.removeLearnRecord(other.learnKey);

    expect(map).toEqual({ [existing.learnKey]: existing });
  });
});
