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
});
