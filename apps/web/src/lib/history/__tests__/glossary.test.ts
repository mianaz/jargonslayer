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
    packId: "personal",
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

  // v0.5 Wave-1 Feature 8 (named custom dictionary packs, blueprint
  // §1 F8 + §5 A7 "path-complete registry").
  describe("pack-aware filtering — getCachedEntries/scanCustomEntries (A7)", () => {
    it("excludes a disabled custom pack's entries from scanCustomEntries", async () => {
      const glossary = await import("../glossary");
      const packs = await glossary.createCustomPack("Tech Terms");
      const pack = packs.find((p) => p.name === "Tech Terms")!;
      await glossary.setCustomPackEnabled(pack.id, false);
      await glossary.upsertCustomEntry(makeEntry({ id: "a", packId: pack.id }));

      const res = glossary.scanCustomEntries("We need to circle back on pricing tomorrow.");
      expect(res.expressions).toHaveLength(0);
    });

    it("excludes a disabled custom pack's entries from getCachedEntries — the SAME accessor upload.ts's currentUploadLexicon imports, so its filtering comes for free", async () => {
      const glossary = await import("../glossary");
      const packs = await glossary.createCustomPack("Tech Terms");
      const pack = packs.find((p) => p.name === "Tech Terms")!;
      await glossary.setCustomPackEnabled(pack.id, false);
      await glossary.upsertCustomEntry(makeEntry({ id: "a", packId: pack.id }));
      await glossary.upsertCustomEntry(makeEntry({ id: "b", packId: "personal" }));

      expect(glossary.getCachedEntries().map((e) => e.id)).toEqual(["b"]);
    });

    it("re-enabling a pack makes its entries match/appear again", async () => {
      const glossary = await import("../glossary");
      const packs = await glossary.createCustomPack("Tech Terms");
      const pack = packs.find((p) => p.name === "Tech Terms")!;
      await glossary.setCustomPackEnabled(pack.id, false);
      await glossary.upsertCustomEntry(makeEntry({ id: "a", packId: pack.id }));
      expect(glossary.getCachedEntries()).toHaveLength(0);

      await glossary.setCustomPackEnabled(pack.id, true);
      expect(glossary.getCachedEntries().map((e) => e.id)).toEqual(["a"]);
    });

    it("a disabled pack's entries are still returned by loadCustomEntries (full/unfiltered — the management-UI list must never silently lose them)", async () => {
      const glossary = await import("../glossary");
      const packs = await glossary.createCustomPack("Tech Terms");
      const pack = packs.find((p) => p.name === "Tech Terms")!;
      await glossary.setCustomPackEnabled(pack.id, false);
      await glossary.upsertCustomEntry(makeEntry({ id: "a", packId: pack.id }));

      const loaded = await glossary.loadCustomEntries();
      expect(loaded.map((e) => e.id)).toContain("a");
    });
  });

  // Pre-merge review Finding 2 — integrated regression test: exercises
  // the REAL registration wiring between this file's
  // setGlossaryShadowLookup(findEnabledEntryBySurface) call (module
  // load side effect, see the source's own comment) and core's
  // scanDictionary, unlike detect/__tests__/dictionary.test.ts's own
  // shadowing suite (which deliberately MOCKS ../../history/
  // glossaryLookup to isolate scanDictionary from the real glossary).
  describe("scanDictionary shadow lookup — enabled-pack-aware (Finding 2)", () => {
    it("a custom entry in a DISABLED pack does NOT suppress the built-in dictionary's own version of that surface", async () => {
      const glossary = await import("../glossary");
      const { scanDictionary, setEnabledPacks } = await import("@jargonslayer/core/detect/dictionary");
      setEnabledPacks(null);

      const packs = await glossary.createCustomPack("Tech Terms");
      const pack = packs.find((p) => p.name === "Tech Terms")!;
      await glossary.setCustomPackEnabled(pack.id, false);
      await glossary.upsertCustomEntry(
        makeEntry({ id: "a", packId: pack.id, headword: "circle back" }),
      );

      // Sanity check: the disabled entry itself never fires (existing
      // A7 behavior, unaffected by this fix).
      expect(glossary.scanCustomEntries("Let's circle back on this.").expressions).toHaveLength(0);

      // The regression: the built-in "circle back" entry must still be
      // detected — before this fix it silently vanished (shadowed by
      // the disabled custom entry's RAW, pack-unaware lookup).
      const res = scanDictionary("Let's circle back on this tomorrow.");
      expect(res.expressions.some((e) => e.expression === "circle back")).toBe(true);
    });

    it("a custom entry in an ENABLED pack still shadows the built-in dictionary's version, exactly as before this fix", async () => {
      const glossary = await import("../glossary");
      const { scanDictionary, setEnabledPacks } = await import("@jargonslayer/core/detect/dictionary");
      setEnabledPacks(null);

      await glossary.upsertCustomEntry(
        makeEntry({ id: "a", packId: "personal", headword: "circle back" }),
      );

      const res = scanDictionary("Let's circle back on this tomorrow.");
      expect(res.expressions.some((e) => e.expression === "circle back")).toBe(false);
      // The custom scan is the one that owns it instead.
      expect(
        glossary.scanCustomEntries("Let's circle back on this tomorrow.").expressions[0]?.expression,
      ).toBe("circle back");
    });
  });

  describe("loadCustomPacks — personal auto-create + packId normalization (A7)", () => {
    it("auto-creates the 'personal' pack when none is persisted yet", async () => {
      const glossary = await import("../glossary");
      const packs = await glossary.loadCustomPacks();
      expect(packs.map((p) => p.id)).toEqual(["personal"]);
      expect(packs[0].name).toBe("个人词库");
      expect(packs[0].enabled).toBe(true);
      expect(memStore.has("jargonslayer:custom-packs")).toBe(true);
    });

    it("does not duplicate 'personal' when it's already persisted", async () => {
      const glossary = await import("../glossary");
      await glossary.loadCustomPacks();
      const again = await glossary.loadCustomPacks();
      expect(again.filter((p) => p.id === "personal")).toHaveLength(1);
    });

    it("normalizes an entry with a missing/unknown packId to 'personal' and persists the fix", async () => {
      const glossary = await import("../glossary");
      await glossary.upsertCustomEntry(makeEntry({ id: "a", packId: "ghost-pack" }));

      const loaded = await glossary.loadCustomEntries();
      expect(loaded.find((e) => e.id === "a")?.packId).toBe("personal");
      // Persisted, not just in-memory — a fresh load reflects the fix.
      expect(
        (memStore.get("jargonslayer:glossary") as { id: string; packId: string }[]).find(
          (e) => e.id === "a",
        )?.packId,
      ).toBe("personal");
    });

    it("leaves an entry with a valid non-personal packId untouched", async () => {
      const glossary = await import("../glossary");
      const packs = await glossary.createCustomPack("Tech Terms");
      const pack = packs.find((p) => p.name === "Tech Terms")!;
      await glossary.upsertCustomEntry(makeEntry({ id: "a", packId: pack.id }));

      const loaded = await glossary.loadCustomEntries();
      expect(loaded.find((e) => e.id === "a")?.packId).toBe(pack.id);
    });
  });

  describe("pack CRUD (A7)", () => {
    it("createCustomPack rejects a blank/whitespace-only name", async () => {
      const glossary = await import("../glossary");
      await expect(glossary.createCustomPack("   ")).rejects.toThrow("词包名称不能为空");
    });

    it("createCustomPack rejects a duplicate name, case-insensitive and trimmed", async () => {
      const glossary = await import("../glossary");
      await glossary.createCustomPack("Tech Terms");
      await expect(glossary.createCustomPack("  tech terms  ")).rejects.toThrow("词包名称已存在");
    });

    it("renameCustomPack allows keeping its own name (uniqueness check excludes itself)", async () => {
      const glossary = await import("../glossary");
      const packs = await glossary.createCustomPack("Tech Terms");
      const pack = packs.find((p) => p.name === "Tech Terms")!;
      await expect(glossary.renameCustomPack(pack.id, "Tech Terms")).resolves.not.toThrow();
    });

    it("renameCustomPack rejects renaming to another pack's existing name", async () => {
      const glossary = await import("../glossary");
      await glossary.createCustomPack("Tech Terms");
      const packs = await glossary.createCustomPack("Biz Terms");
      const bizPack = packs.find((p) => p.name === "Biz Terms")!;
      await expect(glossary.renameCustomPack(bizPack.id, "Tech Terms")).rejects.toThrow(
        "词包名称已存在",
      );
    });

    it("renameCustomPack rejects an unknown pack id", async () => {
      const glossary = await import("../glossary");
      await expect(glossary.renameCustomPack("does-not-exist", "New Name")).rejects.toThrow(
        "词包不存在",
      );
    });

    it("setCustomPackEnabled rejects an unknown pack id", async () => {
      const glossary = await import("../glossary");
      await expect(glossary.setCustomPackEnabled("does-not-exist", false)).rejects.toThrow(
        "词包不存在",
      );
    });

    it("deleteCustomPack refuses to delete 'personal' even with confirmCascade:true", async () => {
      const glossary = await import("../glossary");
      await glossary.loadCustomPacks();
      await expect(glossary.deleteCustomPack("personal", true)).rejects.toThrow(
        "个人词库不能删除",
      );
    });

    it("deleteCustomPack refuses without confirmCascade:true", async () => {
      const glossary = await import("../glossary");
      const packs = await glossary.createCustomPack("Tech Terms");
      const pack = packs.find((p) => p.name === "Tech Terms")!;
      await expect(glossary.deleteCustomPack(pack.id, false)).rejects.toThrow(
        "删除词包需要先确认词条会移动到个人词库",
      );
      // Refused — the pack must still exist.
      expect(glossary.getCustomPacks().some((p) => p.id === pack.id)).toBe(true);
    });

    it("deleteCustomPack removes a confirmed non-personal pack", async () => {
      const glossary = await import("../glossary");
      const packs = await glossary.createCustomPack("Tech Terms");
      const pack = packs.find((p) => p.name === "Tech Terms")!;
      const next = await glossary.deleteCustomPack(pack.id, true);
      expect(next.some((p) => p.id === pack.id)).toBe(false);
    });

    it("upsertCustomPack inserts a new pack or overwrites an existing one by id", async () => {
      const glossary = await import("../glossary");
      const inserted = await glossary.upsertCustomPack({
        id: "restored-1",
        name: "Restored Pack",
        enabled: false,
        createdAt: 1000,
      });
      expect(inserted.find((p) => p.id === "restored-1")).toMatchObject({
        name: "Restored Pack",
        enabled: false,
      });

      const overwritten = await glossary.upsertCustomPack({
        id: "restored-1",
        name: "Renamed",
        enabled: true,
        createdAt: 1000,
      });
      expect(overwritten.filter((p) => p.id === "restored-1")).toHaveLength(1);
      expect(overwritten.find((p) => p.id === "restored-1")?.name).toBe("Renamed");
    });
  });
});
