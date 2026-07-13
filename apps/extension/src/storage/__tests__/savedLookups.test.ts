import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSavedLookups,
  isAlreadySaved,
  removeSavedLookup,
  saveLookup,
} from "../savedLookups";

// Mocks chrome.storage.local with a real backing object (not just
// vi.fn() stubs returning canned values) so a fresh get() genuinely
// reflects whatever the last set() wrote — the same round-trip a real
// panel close/reopen exercises against the real chrome.storage.local.
function mockChromeStorageLocal(): void {
  let store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          store = { ...store, ...items };
        }),
      },
    },
  });
}

describe("savedLookups storage", () => {
  beforeEach(() => {
    mockChromeStorageLocal();
  });

  it("returns an empty array when nothing has been saved", async () => {
    expect(await getSavedLookups()).toEqual([]);
  });

  it("persists a saved lookup and survives a fresh read (panel close/reopen)", async () => {
    const saved = await saveLookup({
      kind: "expression",
      headword: "circle back",
      chinese_explanation: "回头再聊、之后再讨论这个话题",
      source_sentence: "Let's circle back on this next week.",
    });
    expect(saved.id).toBeTruthy();
    expect(saved.savedAt).toBeGreaterThan(0);

    // A fresh call — no shared in-memory state with saveLookup() above
    // beyond the mocked chrome.storage.local itself.
    const all = await getSavedLookups();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(saved);
  });

  it("appends rather than overwrites on a second save", async () => {
    await saveLookup({ kind: "term", headword: "ARR", chinese_explanation: "年度经常性收入" });
    await saveLookup({ kind: "term", headword: "MRR", chinese_explanation: "月度经常性收入" });
    const all = await getSavedLookups();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.headword)).toEqual(["ARR", "MRR"]);
  });

  // F6a (S7 review) — a duplicate 收藏 click for the SAME kind+headword
  // (re-scanning the same paste, or the same word surfacing on both
  // the paste area and a live-capture card) must not grow the list.
  it("F6a: saveLookup returns the existing record unchanged for a same kind+headword duplicate, case/whitespace-insensitively", async () => {
    const first = await saveLookup({
      kind: "term",
      headword: "ARR",
      chinese_explanation: "年度经常性收入",
    });

    const second = await saveLookup({
      kind: "term",
      headword: "  arr ",
      chinese_explanation: "a different gloss that must NOT overwrite the original",
    });

    expect(second).toEqual(first);
    const all = await getSavedLookups();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(first);
  });

  it("F6a: a different kind with the SAME headword text is not treated as a duplicate", async () => {
    const term = await saveLookup({ kind: "term", headword: "ARR", chinese_explanation: "年度经常性收入" });
    const expression = await saveLookup({
      kind: "expression",
      headword: "ARR",
      chinese_explanation: "some expression sense of ARR",
    });

    expect(expression.id).not.toBe(term.id);
    const all = await getSavedLookups();
    expect(all).toHaveLength(2);
  });

  it("removes a saved lookup by id, leaving the rest intact", async () => {
    const first = await saveLookup({ kind: "term", headword: "KPI", chinese_explanation: "关键绩效指标" });
    const second = await saveLookup({ kind: "term", headword: "ROI", chinese_explanation: "投资回报率" });

    await removeSavedLookup(first.id);

    const all = await getSavedLookups();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(second.id);
  });

  it("detects an already-saved headword case/whitespace-insensitively", () => {
    const list = [
      { id: "1", kind: "term" as const, headword: "  ARR ", chinese_explanation: "x", savedAt: 1 },
    ];
    expect(isAlreadySaved(list, "arr")).toBe(true);
    expect(isAlreadySaved(list, "ARR")).toBe(true);
    expect(isAlreadySaved(list, "MRR")).toBe(false);
  });

  // ---------------------------------------------------------------
  // F5 (codex v04-integration review) — saveLookup/removeSavedLookup
  // used to do an unlocked read-modify-write against the SAME storage
  // key; two rapid 收藏 clicks (or any two concurrent calls) could both
  // read the pre-write list and the second set() to land would
  // silently drop the first call's record. These exercise real
  // concurrency (Promise.all — both calls in flight at once, not
  // sequentially awaited) against the SAME mocked-but-real-backing-
  // object chrome.storage.local from the top of this file.
  // ---------------------------------------------------------------

  describe("write serialization (F5) — concurrent calls never drop a record", () => {
    it("two concurrent saveLookup calls both persist", async () => {
      const [a, b] = await Promise.all([
        saveLookup({ kind: "term", headword: "ARR", chinese_explanation: "年度经常性收入" }),
        saveLookup({ kind: "term", headword: "MRR", chinese_explanation: "月度经常性收入" }),
      ]);

      const all = await getSavedLookups();
      expect(all).toHaveLength(2);
      expect(all.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
      expect(all.map((e) => e.headword).sort()).toEqual(["ARR", "MRR"]);
    });

    it("five concurrent saveLookup calls all persist (stress the queue beyond a single pair)", async () => {
      const headwords = ["ARR", "MRR", "KPI", "ROI", "SLA"];
      const saved = await Promise.all(
        headwords.map((headword) =>
          saveLookup({ kind: "term", headword, chinese_explanation: "x" }),
        ),
      );

      const all = await getSavedLookups();
      expect(all).toHaveLength(5);
      expect(all.map((e) => e.id).sort()).toEqual(saved.map((e) => e.id).sort());
      expect(all.map((e) => e.headword).sort()).toEqual([...headwords].sort());
    });

    it("a save racing a remove of a DIFFERENT pre-existing entry: both the new save and the removal survive", async () => {
      const existing = await saveLookup({ kind: "term", headword: "KPI", chinese_explanation: "关键绩效指标" });

      const [saved] = await Promise.all([
        saveLookup({ kind: "term", headword: "ARR", chinese_explanation: "年度经常性收入" }),
        removeSavedLookup(existing.id),
      ]);

      const all = await getSavedLookups();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(saved.id);
      expect(all[0].headword).toBe("ARR");
    });

    it("a failed write (chrome.storage.local.set rejects) does not permanently wedge the queue for later writes", async () => {
      const chromeStub = (globalThis as { chrome: typeof chrome }).chrome;
      // mockImplementationOnce: rejects exactly the NEXT call, then
      // falls back to the mock's default (real-backing-object)
      // implementation from mockChromeStorageLocal() above — avoids
      // hand-rolling a "call through to the original" wrapper, which
      // (when the target is already a vi.fn(), as here) would just
      // recurse into itself instead of the pre-spy implementation.
      vi.mocked(chromeStub.storage.local.set).mockImplementationOnce(async () => {
        throw new Error("simulated storage failure");
      });

      await expect(
        saveLookup({ kind: "term", headword: "ARR", chinese_explanation: "年度经常性收入" }),
      ).rejects.toThrow("simulated storage failure");

      // The queue must not be wedged — a later call still completes.
      const saved = await saveLookup({ kind: "term", headword: "MRR", chinese_explanation: "月度经常性收入" });
      expect(saved.headword).toBe("MRR");

      const all = await getSavedLookups();
      expect(all.map((e) => e.headword)).toEqual(["MRR"]);
    });
  });
});
