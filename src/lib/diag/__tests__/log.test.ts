import { beforeEach, describe, expect, it } from "vitest";
import { clearDiag, DIAG_MAX_ENTRIES, diagLog, getDiagEntries, newErrorRef } from "../log";

describe("diag/log.ts — ring buffer", () => {
  beforeEach(() => {
    clearDiag();
  });

  it("starts empty", () => {
    expect(getDiagEntries()).toEqual([]);
  });

  it("appends an entry with the given level/tag/message/detail and a timestamp", () => {
    const before = Date.now();
    diagLog("info", "test-tag", "hello", "some detail");
    const entries = getDiagEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: "info", tag: "test-tag", message: "hello", detail: "some detail" });
    expect(entries[0].ts).toBeGreaterThanOrEqual(before);
  });

  it("detail is omitted (undefined) when not passed", () => {
    diagLog("warn", "test-tag", "no detail here");
    expect(getDiagEntries()[0].detail).toBeUndefined();
  });

  it("preserves insertion order, oldest first", () => {
    diagLog("info", "a", "first");
    diagLog("info", "b", "second");
    diagLog("info", "c", "third");
    const messages = getDiagEntries().map((e) => e.message);
    expect(messages).toEqual(["first", "second", "third"]);
  });

  it("caps at DIAG_MAX_ENTRIES, dropping the OLDEST entries first", () => {
    for (let i = 0; i < DIAG_MAX_ENTRIES + 10; i++) {
      diagLog("info", "cap-test", `entry-${i}`);
    }
    const entries = getDiagEntries();
    expect(entries).toHaveLength(DIAG_MAX_ENTRIES);
    // The first 10 (oldest) were dropped — entry-10 is now the oldest survivor.
    expect(entries[0].message).toBe("entry-10");
    expect(entries[entries.length - 1].message).toBe(`entry-${DIAG_MAX_ENTRIES + 9}`);
  });

  it("clearDiag empties the buffer", () => {
    diagLog("info", "a", "one");
    diagLog("error", "b", "two");
    expect(getDiagEntries()).not.toHaveLength(0);
    clearDiag();
    expect(getDiagEntries()).toEqual([]);
  });

  it("getDiagEntries returns a fresh array each call — callers can't mutate internal state", () => {
    diagLog("info", "a", "one");
    const snap1 = getDiagEntries();
    snap1.push({ ts: 0, level: "error", tag: "injected", message: "should not persist" });
    const snap2 = getDiagEntries();
    expect(snap2).toHaveLength(1);
    expect(snap2.some((e) => e.tag === "injected")).toBe(false);
  });

  describe("error refs", () => {
    it("level:'error' entries get a ref automatically", () => {
      const entry = diagLog("error", "test-tag", "boom");
      expect(entry.ref).toMatch(/^JS-[0-9A-Z]{4}$/);
      expect(getDiagEntries()[0].ref).toBe(entry.ref);
    });

    it("level:'warn'/'info' entries carry no ref", () => {
      expect(diagLog("warn", "test-tag", "meh").ref).toBeUndefined();
      expect(diagLog("info", "test-tag", "fyi").ref).toBeUndefined();
    });

    it("diagLog returns the created entry", () => {
      const entry = diagLog("error", "test-tag", "boom", "detail");
      expect(entry).toMatchObject({ level: "error", tag: "test-tag", message: "boom", detail: "detail" });
    });
  });

  describe("newErrorRef — format + statistical uniqueness", () => {
    it("matches the documented JS-XXXX format (4 uppercase base36 chars)", () => {
      for (let i = 0; i < 50; i++) {
        expect(newErrorRef()).toMatch(/^JS-[0-9A-Z]{4}$/);
      }
    });

    it("produces a highly diverse set across many calls (statistical, not exhaustive)", () => {
      const refs = new Set(Array.from({ length: 500 }, () => newErrorRef()));
      // 4 base36 chars ~ 1.68M combinations — 500 draws should collide
      // only rarely; assert we see substantially more unique values
      // than a broken (e.g. constant or near-constant) generator would.
      expect(refs.size).toBeGreaterThan(450);
    });
  });
});
