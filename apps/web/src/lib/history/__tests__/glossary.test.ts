import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomEntry } from "@jargonslayer/core/types";

// In-memory idb-keyval mock. glossary.ts guards every call behind
// `typeof indexedDB !== "undefined"`, so we also stub a minimal global
// indexedDB below (its shape is never inspected by glossary.ts — only
// its presence is checked via `typeof`).
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

function makeEntry(overrides: Partial<CustomEntry> = {}): CustomEntry {
  return {
    id: "e1",
    kind: "expression",
    headword: "circle back",
    variants: ["circling back"],
    chinese_explanation: "回头再聊",
    example: "Let's circle back later.",
    context: "",
    note: "",
    createdAt: 1000,
    updatedAt: 1000,
    source: "manual",
    ...overrides,
  };
}

describe("glossary.ts", () => {
  beforeEach(() => {
    memStore.clear();
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  describe("scanCustomEntries matching", () => {
    it("matches a cached entry's headword/variant against free text and returns it as an expression", async () => {
      const glossary = await import("../glossary");
      await glossary.upsertCustomEntry(makeEntry());

      const res = glossary.scanCustomEntries("We need to circle back on pricing tomorrow.");
      expect(res.expressions).toHaveLength(1);
      expect(res.expressions[0].expression).toBe("circle back");
      expect(res.expressions[0].source_sentence).toBe(
        "We need to circle back on pricing tomorrow.",
      );
      expect(res.terms).toHaveLength(0);
    });

    it("matches via a variant surface form, not just the headword", async () => {
      const glossary = await import("../glossary");
      await glossary.upsertCustomEntry(makeEntry());

      const res = glossary.scanCustomEntries("I was circling back on this issue.");
      expect(res.expressions).toHaveLength(1);
      expect(res.expressions[0].expression).toBe("circle back"); // still the headword
    });

    it("routes kind:'term' entries into res.terms instead of res.expressions", async () => {
      const glossary = await import("../glossary");
      await glossary.upsertCustomEntry(
        makeEntry({
          id: "e2",
          kind: "term",
          headword: "ARR",
          variants: [],
          termType: "metric",
          gloss_en: "Annual Recurring Revenue",
        }),
      );

      const res = glossary.scanCustomEntries("Our ARR grew nicely this quarter.");
      expect(res.terms).toHaveLength(1);
      expect(res.terms[0].term).toBe("ARR");
      expect(res.expressions).toHaveLength(0);
    });

    it("returns empty result for empty text or an empty cache", async () => {
      const glossary = await import("../glossary");
      expect(glossary.scanCustomEntries("")).toEqual({ expressions: [], terms: [] });
      expect(glossary.scanCustomEntries("some text with no entries loaded")).toEqual({
        expressions: [],
        terms: [],
      });
    });

    it("does not match text that contains no configured entry", async () => {
      const glossary = await import("../glossary");
      await glossary.upsertCustomEntry(makeEntry());
      const res = glossary.scanCustomEntries("Nothing relevant is mentioned here at all.");
      expect(res.expressions).toHaveLength(0);
    });
  });

  describe("customEntrySurfaces dedup (via findEntryBySurface)", () => {
    it("finds an entry by its headword, case-insensitively", async () => {
      const glossary = await import("../glossary");
      await glossary.upsertCustomEntry(makeEntry());
      expect(glossary.findEntryBySurface("Circle Back")?.id).toBe("e1");
    });

    it("finds an entry by one of its variants", async () => {
      const glossary = await import("../glossary");
      await glossary.upsertCustomEntry(makeEntry());
      expect(glossary.findEntryBySurface("CIRCLING BACK")?.id).toBe("e1");
    });

    it("returns null for a surface not present in any entry", async () => {
      const glossary = await import("../glossary");
      await glossary.upsertCustomEntry(makeEntry());
      expect(glossary.findEntryBySurface("unrelated phrase")).toBeNull();
    });

    it("returns null for an empty/whitespace needle without throwing", async () => {
      const glossary = await import("../glossary");
      expect(glossary.findEntryBySurface("")).toBeNull();
      expect(glossary.findEntryBySurface("   ")).toBeNull();
    });
  });

  describe("upsert/delete ordering (newest first)", () => {
    it("upsertCustomEntry inserts a new entry at the front of the cache", async () => {
      const glossary = await import("../glossary");
      await glossary.upsertCustomEntry(makeEntry({ id: "a" }));
      const list = await glossary.upsertCustomEntry(makeEntry({ id: "b", headword: "touch base" }));
      expect(list.map((e) => e.id)).toEqual(["b", "a"]);
    });

    it("upsertCustomEntry updates an existing entry in-place at the front (moves to front, not duplicated)", async () => {
      const glossary = await import("../glossary");
      await glossary.upsertCustomEntry(makeEntry({ id: "a" }));
      await glossary.upsertCustomEntry(makeEntry({ id: "b", headword: "touch base" }));
      const list = await glossary.upsertCustomEntry(
        makeEntry({ id: "a", chinese_explanation: "updated explanation" }),
      );
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe("a");
      expect(list[0].chinese_explanation).toBe("updated explanation");
      expect(list[1].id).toBe("b");
    });

    it("deleteCustomEntry removes the entry and preserves remaining order", async () => {
      const glossary = await import("../glossary");
      await glossary.upsertCustomEntry(makeEntry({ id: "a" }));
      await glossary.upsertCustomEntry(makeEntry({ id: "b", headword: "touch base" }));
      const list = await glossary.deleteCustomEntry("b");
      expect(list.map((e) => e.id)).toEqual(["a"]);
    });

    it("getCachedEntries reflects the same in-memory state synchronously", async () => {
      const glossary = await import("../glossary");
      await glossary.upsertCustomEntry(makeEntry({ id: "a" }));
      expect(glossary.getCachedEntries().map((e) => e.id)).toEqual(["a"]);
    });

    it("clearGlossary empties the cache and deletes the persisted key", async () => {
      const glossary = await import("../glossary");
      await glossary.upsertCustomEntry(makeEntry({ id: "a" }));
      await glossary.clearGlossary();
      expect(glossary.getCachedEntries()).toEqual([]);
      expect(memStore.has("jargonslayer:glossary")).toBe(false);
    });
  });

  describe("legacy 'meetlingo:glossary' migration copy path", () => {
    it("loadCustomEntries copies legacy data into the new key when the new key is empty", async () => {
      const legacyEntries = [makeEntry({ id: "legacy-1", headword: "legacy phrase" })];
      memStore.set("meetlingo:glossary", legacyEntries);

      const glossary = await import("../glossary");
      const loaded = await glossary.loadCustomEntries();

      expect(loaded).toEqual(legacyEntries);
      expect(memStore.get("jargonslayer:glossary")).toEqual(legacyEntries);
      // Legacy key is COPIED, not deleted (per the "copy, don't delete" comment).
      expect(memStore.get("meetlingo:glossary")).toEqual(legacyEntries);
    });

    it("does NOT migrate when the legacy key is empty/absent", async () => {
      const glossary = await import("../glossary");
      const loaded = await glossary.loadCustomEntries();
      expect(loaded).toEqual([]);
      expect(memStore.has("jargonslayer:glossary")).toBe(false);
    });

    it("does NOT migrate over existing new-key data (new key already populated wins)", async () => {
      const newEntries = [makeEntry({ id: "new-1" })];
      const legacyEntries = [makeEntry({ id: "legacy-1" })];
      memStore.set("jargonslayer:glossary", newEntries);
      memStore.set("meetlingo:glossary", legacyEntries);

      const glossary = await import("../glossary");
      const loaded = await glossary.loadCustomEntries();

      expect(loaded).toEqual(newEntries);
    });

    it("loadCustomEntries returns [] without touching storage when indexedDB is unavailable", async () => {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
      const glossary = await import("../glossary");
      const loaded = await glossary.loadCustomEntries();
      expect(loaded).toEqual([]);
    });
  });
});
