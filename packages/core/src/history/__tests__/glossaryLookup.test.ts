// Real behavior coverage for history/glossaryLookup.ts. Every other
// suite that touches this module vi.mock()s it away (detect/dictionary
// tests stub findEntryBySurface), and domFreeness only proves it loads —
// so until now the logic that lets a personal-glossary entry SHADOW the
// built-in dictionary (dictionary.ts's scanDictionary calls
// findEntryBySurface synchronously per scan) had no test asserting what
// it actually matches.
import { beforeEach, describe, expect, it } from "vitest";
import type { CustomEntry } from "../../types";
import {
  findEntryBySurface,
  getCachedEntries,
  setCachedEntries,
} from "../glossaryLookup";

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

beforeEach(() => {
  setCachedEntries([]);
});

describe("setCachedEntries / getCachedEntries", () => {
  it("replaces the cache wholesale and returns the same array", () => {
    const next = [makeEntry()];
    setCachedEntries(next);
    expect(getCachedEntries()).toBe(next);
  });

  it("an empty replacement clears previous matches", () => {
    setCachedEntries([makeEntry()]);
    expect(findEntryBySurface("circle back")).not.toBeNull();
    setCachedEntries([]);
    expect(findEntryBySurface("circle back")).toBeNull();
  });
});

describe("findEntryBySurface", () => {
  it("returns null for empty and whitespace-only queries", () => {
    setCachedEntries([makeEntry()]);
    expect(findEntryBySurface("")).toBeNull();
    expect(findEntryBySurface("   ")).toBeNull();
  });

  it("returns null when nothing in the cache matches", () => {
    setCachedEntries([makeEntry()]);
    expect(findEntryBySurface("runway")).toBeNull();
  });

  it("matches the headword case-insensitively with surrounding whitespace ignored", () => {
    const entry = makeEntry({ headword: "Sync Up" });
    setCachedEntries([entry]);
    expect(findEntryBySurface("  sync up  ")).toBe(entry);
    expect(findEntryBySurface("SYNC UP")).toBe(entry);
  });

  it("matches a variant surface, not just the headword", () => {
    const entry = makeEntry({ headword: "circle back", variants: ["circling back"] });
    setCachedEntries([entry]);
    expect(findEntryBySurface("Circling Back")).toBe(entry);
  });

  it("matches a variant that was stored with stray whitespace (surfaces are trimmed)", () => {
    const entry = makeEntry({ variants: ["  touch base  "] });
    setCachedEntries([entry]);
    expect(findEntryBySurface("touch base")).toBe(entry);
  });

  it("returns the FIRST cache entry when two share a surface — insertion order is the shadowing tiebreak", () => {
    const first = makeEntry({ id: "e1", headword: "runway" });
    const second = makeEntry({ id: "e2", headword: "Runway" });
    setCachedEntries([first, second]);
    expect(findEntryBySurface("runway")).toBe(first);
  });
});
