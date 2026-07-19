import { describe, expect, it, vi } from "vitest";

// Isolate scanDictionary from the personal glossary and the remote
// pack registry, same as dictionary.test.ts.
vi.mock("../../history/glossaryLookup", () => ({
  findEntryBySurface: vi.fn(() => null),
}));
vi.mock("../remotePacksRegistry", () => ({
  getLoadedRemotePacks: vi.fn(() => []),
}));

import { COMPILED_PACK_TERMS } from "../dictionary-packs-compiled";
import { packCounts, scanDictionary } from "../dictionary";

const VALID_TYPES = new Set(["acronym", "company", "product", "tech", "metric", "person", "other"]);

describe("COMPILED_PACK_TERMS — data integrity", () => {
  it("every entry has a valid TermType and non-empty gloss_en + gloss_zh", () => {
    expect(COMPILED_PACK_TERMS.length).toBeGreaterThan(0);
    for (const entry of COMPILED_PACK_TERMS) {
      expect(VALID_TYPES.has(entry.type)).toBe(true);
      expect(entry.gloss_en.trim().length).toBeGreaterThan(0);
      expect(entry.gloss_zh.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("packCounts() — compiled packs registered with real post-dedupe counts", () => {
  it("includes stats/ml-stats/bioinformatics-edam with the actual post-dedupe counts", () => {
    const counts = packCounts();
    // Source packs have 48/101/77 terms. Two compiled terms are dropped
    // by dedupeByKey because base/EXTRA already has a same-key entry:
    // "regression" (ml-stats, collides with EXTRA_TERMS' "regression")
    // and "SAM" (bioinformatics-edam, collides with EXTRA_TERMS' "SAM").
    expect(counts["stats"]).toBe(48);
    expect(counts["ml-stats"]).toBe(100);
    expect(counts["bioinformatics-edam"]).toBe(76);
  });
});

describe("scanDictionary — compiled pack terms are matched when enabled", () => {
  it("finds 'p-value', a stats term not present in base/EXTRA", () => {
    const res = scanDictionary("The p-value was below 0.05.", null);
    expect(res.terms.some((t) => t.term === "p-value")).toBe(true);
  });

  it("finds 'supervised learning', an ml-stats term not present in base/EXTRA", () => {
    const res = scanDictionary("We used supervised learning for this task.", null);
    expect(res.terms.some((t) => t.term === "supervised learning")).toBe(true);
  });

  it("finds 'FASTQ', a bioinformatics-edam term not present in base/EXTRA", () => {
    const res = scanDictionary("We aligned the FASTQ reads to the reference.", null);
    expect(res.terms.some((t) => t.term === "FASTQ")).toBe(true);
  });
});

describe("scanDictionary — pack gating excludes disabled compiled packs", () => {
  it("does not return a stats term when 'stats' is not in the enabled list", () => {
    const res = scanDictionary("The p-value was below 0.05.", ["core"]);
    expect(res.terms.some((t) => t.term === "p-value")).toBe(false);
  });
});

describe("commonWord terms stay opt-in under the default all-on state", () => {
  const COMMON = ["mean", "prior", "attention", "precision", "recall", "accuracy", "token", "variance", "epoch", "embedding"];

  it("flags exactly the expected everyday-English headwords", () => {
    const flagged = COMPILED_PACK_TERMS.filter((t) => t.commonWord).map((t) => t.term).sort();
    expect(flagged).toEqual([...COMMON].sort());
  });

  it("does NOT fire a common word on casual speech under enabledPacks === null", () => {
    // "mean" (stats) and "attention" (ml-stats) are commonWord; under the
    // default (null) they must not match "I mean..." / "pay attention".
    const res = scanDictionary("I mean, we should pay attention to the details.", null);
    expect(res.terms.some((t) => t.term === "mean")).toBe(false);
    expect(res.terms.some((t) => t.term === "attention")).toBe(false);
  });

  it("DOES fire a common word once the user has customized packs (explicit enabled list)", () => {
    const res = scanDictionary("The sample mean and variance were computed.", ["stats"]);
    expect(res.terms.some((t) => t.term === "mean")).toBe(true);
    expect(res.terms.some((t) => t.term === "variance")).toBe(true);
  });

  it("non-common compiled terms still fire under the default all-on state", () => {
    // regression guard: the opt-in gate must not touch ordinary terms.
    const res = scanDictionary("The p-value came from cross-validation.", null);
    expect(res.terms.some((t) => t.term === "p-value")).toBe(true);
  });
});
