import { describe, expect, it, vi } from "vitest";

// Isolate scanDictionary from the personal glossary and the remote
// pack registry, same as dictionary.test.ts.
vi.mock("../../history/glossaryLookup", () => ({
  findEntryBySurface: vi.fn(() => null),
}));
vi.mock("../remotePacksRegistry", () => ({
  getLoadedRemotePacks: vi.fn(() => []),
  // M4 fix round: scanDictionary now also reads this for regex-cache
  // invalidation — see dictionary.test.ts's own mock for the full doc.
  getRemotePacksGeneration: vi.fn(() => 0),
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

describe("packCounts() — installed remote packs are counted too", () => {
  // Live-verification catch: a freshly imported pack rendered "0 条"
  // next to its toggle because packCounts only walked the compile-time
  // dictionary, so every install looked like it had silently failed.
  it("adds an installed pack's own expressions + terms under its id", async () => {
    const registry = await import("../remotePacksRegistry");
    const mocked = vi.mocked(registry.getLoadedRemotePacks);
    mocked.mockReturnValueOnce([
      {
        id: "installed-probe",
        name: "probe",
        version: "1.0.0",
        expressions: [{ expression: "probe phrase" }],
        terms: [{ term: "PROBEA" }, { term: "PROBEB" }],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    expect(packCounts()["installed-probe"]).toBe(3);
  });

  it("reports nothing for a pack id that is not installed", () => {
    expect(packCounts()["installed-probe"]).toBeUndefined();
  });
});

describe("packCounts() — compiled packs registered with real post-dedupe counts", () => {
  it("includes stats/ml-stats/bioinformatics-edam with the actual post-dedupe counts", () => {
    const counts = packCounts();
    // Source packs have 48/101/77 terms. v0.7.2 dictionary-audit Bug B
    // fix: "regression" (ml-stats) and "SAM" (bioinformatics-edam) used
    // to be silently dropped by the old dedupeByKey chain because
    // base/EXTRA already had a same-KEY-but-different-MEANING entry
    // ("regression" the tech-terms bug-report sense, "SAM" the
    // business-terms market-size acronym) — both compiled entries now
    // survive as their own pack-tagged sense (mergeTermTables in
    // dictionary.ts), so these two packs report their full source count.
    expect(counts["stats"]).toBe(48);
    expect(counts["ml-stats"]).toBe(101);
    expect(counts["bioinformatics-edam"]).toBe(77);
  });
});

// v0.7.2 fix (dictionary audit, Bug B): mergeTermTables (dictionary.ts)
// now keeps BOTH senses of a genuine cross-pack collision instead of
// silently dropping the one that lost dedupeByKey's normalized-key
// race, each still tagged with its own source pack and filtered by
// scanDictionary's own isPackEnabled check like any other entry.
describe("scanDictionary — Bug B fix: cross-pack collisions no longer delete an entry", () => {
  it("only bioinformatics-edam enabled -> 'SAM' resolves to the bioinformatics sense", () => {
    const res = scanDictionary("We stored the alignment in SAM format.", ["bioinformatics-edam"]);
    const hit = res.terms.find((t) => t.term === "SAM");
    expect(hit?.gloss_en).toMatch(/Sequence Alignment\/Map/);
  });

  it("only business-terms enabled -> 'SAM' resolves to the business sense", () => {
    const res = scanDictionary("Our SAM is much smaller than our TAM.", ["business-terms"]);
    const hit = res.terms.find((t) => t.term === "SAM");
    expect(hit?.gloss_en).toMatch(/Serviceable Addressable Market/);
  });

  it("both enabled -> exactly one 'SAM' card, deterministic (table-priority order)", () => {
    const res = scanDictionary("Our SAM is much smaller than our TAM.", [
      "business-terms",
      "bioinformatics-edam",
    ]);
    const hits = res.terms.filter((t) => t.term === "SAM");
    expect(hits).toHaveLength(1);
    expect(hits[0].gloss_en).toMatch(/Serviceable Addressable Market/);
  });

  it("only tech-terms enabled -> 'regression' resolves to the tech-terms sense", () => {
    const res = scanDictionary("We shipped a regression last week.", ["tech-terms"]);
    const hit = res.terms.find((t) => t.term === "regression");
    expect(hit?.gloss_en).toMatch(/previously-working feature/);
  });

  it("only ml-stats enabled -> 'regression' resolves to the ml-stats sense", () => {
    const res = scanDictionary("We ran a regression on the dataset.", ["ml-stats"]);
    const hit = res.terms.find((t) => t.term === "regression");
    expect(hit?.gloss_en).toMatch(/numerical prediction/);
  });

  it("both enabled -> exactly one 'regression' card, deterministic (table-priority order)", () => {
    const res = scanDictionary("We ran a regression on the dataset.", ["tech-terms", "ml-stats"]);
    const hits = res.terms.filter((t) => t.term === "regression");
    expect(hits).toHaveLength(1);
    expect(hits[0].gloss_en).toMatch(/previously-working feature/);
  });

  it("identical-gloss cross-pack duplicate still collapses to one card (OKR, core + business-terms both enabled)", () => {
    const res = scanDictionary("We reviewed our OKR this quarter.", ["core", "business-terms"]);
    const hits = res.terms.filter((t) => t.term === "OKR");
    expect(hits).toHaveLength(1);
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

  it("fires a common word once its domain is active", () => {
    // "mean" is checked in its own sentence on purpose: in "the sample
    // mean and variance", the longer entry "sample mean" subsumes it and
    // the shorter card is correctly dropped, which would mask what this
    // test is actually about (the commonWord opt-in gate).
    expect(
      scanDictionary("The mean was higher than we expected.", ["stats"], {
        activeDomains: new Set(["stats"]),
      }).terms.some((t) => t.term === "mean"),
    ).toBe(true);
    const res = scanDictionary("The sample mean and variance were computed.", ["stats"], {
      activeDomains: new Set(["stats"]),
    });
    expect(res.terms.some((t) => t.term === "variance")).toBe(true);
    expect(res.terms.some((t) => t.term === "sample mean")).toBe(true);
  });

  it("non-common compiled terms still fire under the default all-on state", () => {
    // regression guard: the opt-in gate must not touch ordinary terms.
    const res = scanDictionary("The p-value came from cross-validation.", null);
    expect(res.terms.some((t) => t.term === "p-value")).toBe(true);
  });
});
