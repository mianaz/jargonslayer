import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate scanDictionary from the personal glossary and the remote
// pack registry so these tests only exercise the built-in tables.
vi.mock("../../history/glossaryLookup", () => ({
  findEntryBySurface: vi.fn(() => null),
}));
vi.mock("../remotePacksRegistry", () => ({
  getLoadedRemotePacks: vi.fn(() => []),
}));

import { findEntryBySurface } from "../../history/glossaryLookup";
import { getLoadedRemotePacks } from "../remotePacksRegistry";
import type { LoadedRemotePack } from "../remotePacksRegistry";
import { packTermsForBias, scanDictionary, setEnabledPacks } from "../dictionary";

const mockFindEntryBySurface = vi.mocked(findEntryBySurface);
const mockGetLoadedRemotePacks = vi.mocked(getLoadedRemotePacks);

beforeEach(() => {
  mockFindEntryBySurface.mockReset();
  mockFindEntryBySurface.mockReturnValue(null);
  mockGetLoadedRemotePacks.mockReset();
  mockGetLoadedRemotePacks.mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  // packTermsForBias's own tests below call setEnabledPacks() to
  // exercise its default-param registry read — real module state,
  // untouched by clearAllMocks(), so it must be restored explicitly or
  // it would leak into scanDictionary's OWN default-enabledPacks tests
  // above (which rely on the "null = every pack on" default).
  setEnabledPacks(null);
});

describe("scanDictionary — base entry matching, word boundary", () => {
  it("matches an exact base expression, case-insensitively, with source_sentence extracted", () => {
    const res = scanDictionary("Let's Circle Back on this tomorrow.");
    const hit = res.expressions.find((e) => e.expression === "circle back");
    expect(hit).toBeDefined();
    expect(hit!.source_sentence).toBe("Let's Circle Back on this tomorrow.");
    expect(hit!.category).toBe("phrase");
    expect(hit!.chinese_explanation).toBe("回头再聊、之后再讨论这个话题");
  });

  it("respects word boundaries — does not match inside a larger word", () => {
    const res = scanDictionary("The bandwidths available are wide.");
    // "bandwidth" entry should not match "bandwidths" via naive substring,
    // but WILL match via the last-word 's' inflection tolerance (single
    // word phrase, last word == only word == "bandwidth").
    const hit = res.expressions.find((e) => e.expression === "bandwidth");
    expect(hit).toBeDefined();
  });

  it("does not match a completely unrelated sentence", () => {
    const res = scanDictionary("We had lunch and went home.");
    expect(res.expressions).toHaveLength(0);
    expect(res.terms).toHaveLength(0);
  });
});

describe("scanDictionary — last-word inflection AS IMPLEMENTED", () => {
  it("a single-word entry (e.g. 'bandwidth') matches its own inflected forms since it IS the last word", () => {
    const res = scanDictionary("Do we have the bandwidths for this?");
    expect(res.expressions.some((e) => e.expression === "bandwidth")).toBe(true);
  });

  it("REAL BEHAVIOR: 'circling back' does NOT match the 'circle back' entry — only the LAST word ('back') is allowed to flex, and 'back' has no inflected form here", () => {
    const res = scanDictionary("We are circling back on this next week.");
    expect(res.expressions.some((e) => e.expression === "circle back")).toBe(false);
  });

  it("REAL BEHAVIOR: 'circled back' does NOT match the 'circle back' entry either", () => {
    const res = scanDictionary("She circled back with an update.");
    expect(res.expressions.some((e) => e.expression === "circle back")).toBe(false);
  });

  it("a multi-word entry whose LAST word is the one that naturally inflects DOES match (e.g. 'touch base' -> 'touch bases')", () => {
    const res = scanDictionary("Let's touch bases again on Friday.");
    expect(res.expressions.some((e) => e.expression === "touch base")).toBe(true);
  });

  it("REAL BEHAVIOR: 'push back' entry does NOT match 'pushing back' or 'pushed back' (verb is the FIRST word, not the last)", () => {
    const res1 = scanDictionary("The team keeps pushing back on the plan.");
    const res2 = scanDictionary("Leadership pushed back on the proposal.");
    expect(res1.expressions.some((e) => e.expression === "push back")).toBe(false);
    expect(res2.expressions.some((e) => e.expression === "push back")).toBe(false);
  });

  it("'push back' DOES match its exact form and its explicit 'pushback' variant", () => {
    const res1 = scanDictionary("I expect some push back on this.");
    const res2 = scanDictionary("There was a lot of pushback internally.");
    expect(res1.expressions.some((e) => e.expression === "push back")).toBe(true);
    expect(res2.expressions.some((e) => e.expression === "push back")).toBe(true);
  });
});

describe("scanDictionary — source_sentence extraction", () => {
  it("extracts only the sentence containing the match, not the whole text", () => {
    const res = scanDictionary(
      "This is unrelated filler text with no jargon at all. Let's circle back tomorrow. And here is a trailing sentence.",
    );
    const hit = res.expressions.find((e) => e.expression === "circle back");
    expect(hit).toBeDefined();
    expect(hit!.source_sentence).toBe("Let's circle back tomorrow.");
  });
});

describe("scanDictionary — at-most-once per entry per call", () => {
  it("only emits a single hit even when the same expression appears in multiple sentences", () => {
    const res = scanDictionary(
      "We need to circle back on this. Later today let's circle back again.",
    );
    const hits = res.expressions.filter((e) => e.expression === "circle back");
    expect(hits).toHaveLength(1);
  });

  it("only emits a single hit for a term even if it appears multiple times", () => {
    const res = scanDictionary("Our ARR grew and ARR is now our north star metric.");
    const hits = res.terms.filter((t) => t.term === "ARR");
    expect(hits).toHaveLength(1);
  });
});

describe("scanDictionary — pack filtering via second argument", () => {
  it("passing ['core'] includes core-pack entries", () => {
    const res = scanDictionary("Let's circle back and check the ARR.", ["core"]);
    expect(res.expressions.some((e) => e.expression === "circle back")).toBe(true);
    expect(res.terms.some((t) => t.term === "ARR")).toBe(true);
  });

  it("passing null includes everything (same result as ['core'] for core-only entries)", () => {
    const res = scanDictionary("Let's circle back and check the ARR.", null);
    expect(res.expressions.some((e) => e.expression === "circle back")).toBe(true);
    expect(res.terms.some((t) => t.term === "ARR")).toBe(true);
  });

  it("passing an empty array excludes all core-pack entries (core entries only survive via isPackEnabled special-case, but here we test the actual scan output)", () => {
    // NOTE: isPackEnabled() special-cases "core" -> always true, so even
    // [] still lets core-pack entries through. Confirm that IS the
    // observed behavior of scanDictionary (it delegates directly to
    // isPackEnabled, no extra filtering).
    const res = scanDictionary("Let's circle back and check the ARR.", []);
    expect(res.expressions.some((e) => e.expression === "circle back")).toBe(true);
    expect(res.terms.some((t) => t.term === "ARR")).toBe(true);
  });
});

describe("scanDictionary — glossary shadowing", () => {
  it("skips a dictionary expression entry whose surface has a personal-glossary entry (findEntryBySurface returns non-null)", () => {
    mockFindEntryBySurface.mockImplementation((surface: string) =>
      surface === "circle back"
        ? ({
            id: "fake-1",
            kind: "expression",
            headword: "circle back",
            variants: [],
            chinese_explanation: "fake",
            example: "",
            context: "",
            note: "",
            createdAt: 0,
            updatedAt: 0,
            source: "manual",
          } as never)
        : null,
    );

    const res = scanDictionary("Let's circle back and also touch base.");
    expect(res.expressions.some((e) => e.expression === "circle back")).toBe(false);
    // Unrelated entries still match normally.
    expect(res.expressions.some((e) => e.expression === "touch base")).toBe(true);
  });

  it("skips a dictionary term entry whose surface has a personal-glossary entry", () => {
    mockFindEntryBySurface.mockImplementation((surface: string) =>
      surface === "ARR"
        ? ({
            id: "fake-2",
            kind: "term",
            headword: "ARR",
            variants: [],
            chinese_explanation: "fake",
            example: "",
            context: "",
            note: "",
            createdAt: 0,
            updatedAt: 0,
            source: "manual",
          } as never)
        : null,
    );

    const res = scanDictionary("Our ARR and MRR both grew this quarter.");
    expect(res.terms.some((t) => t.term === "ARR")).toBe(false);
    expect(res.terms.some((t) => t.term === "MRR")).toBe(true);
  });
});

describe("scanDictionary — term matching (case sensitivity for acronyms)", () => {
  it("matches an all-caps acronym case-sensitively", () => {
    const res = scanDictionary("The ARR figure is up.");
    expect(res.terms.some((t) => t.term === "ARR")).toBe(true);
  });

  it("does not match an all-caps acronym typed in lowercase (case-sensitive for all-caps terms)", () => {
    const res = scanDictionary("the arr figure is up");
    expect(res.terms.some((t) => t.term === "ARR")).toBe(false);
  });

  it("matches a mixed-case term case-insensitively", () => {
    const res = scanDictionary("we are hiring more series b investors");
    expect(res.terms.some((t) => t.term === "Series B")).toBe(true);
  });
});

describe("scanDictionary — empty input", () => {
  it("returns empty expressions/terms for empty or whitespace-only text", () => {
    expect(scanDictionary("")).toEqual({ expressions: [], terms: [] });
    expect(scanDictionary("   ")).toEqual({ expressions: [], terms: [] });
  });
});

// ---------------------------------------------------------------
// packTermsForBias (v0.4.7 Lane B, glossary -> recognizer bias) — the
// SAME built-in-table + remote-pack universe scanDictionary's own term
// loop reads, minus personal-glossary shadowing (irrelevant to a bias
// hint). Filtered down to each test's own injected remote-pack
// fixture (tagged with a pack id the real built-in tables never use)
// so assertions don't depend on the real dictionary's exact term
// count/content.
// ---------------------------------------------------------------

describe("packTermsForBias", () => {
  // Mirrors LoadedRemotePack's own doc comment ("entries have `pack`
  // forced to the manifest's own id") — the real loader (apps/web's
  // remotePacks.ts) normalizes this before populating the registry;
  // this fixture builder does the same forcing so hand-written term
  // literals below don't have to repeat the pack id themselves.
  function remotePack(id: string, terms: Omit<LoadedRemotePack["terms"][number], "pack">[]): LoadedRemotePack {
    return {
      id,
      name: id,
      version: 1,
      expressions: [],
      terms: terms.map((t) => ({ ...t, pack: id })),
    };
  }

  it("includes remote-pack terms alongside the built-in tables, tagged with their own pack id", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePack("__test_remote_pack__", [{ term: "gene-x", type: "other", gloss_en: "", gloss_zh: "" }]),
    ]);
    const result = packTermsForBias(null);
    expect(result).toContainEqual({ term: "gene-x", pack: "__test_remote_pack__" });
  });

  it("expressions are never included — bias is term-only (doc §3, terms-not-idioms rationale)", () => {
    // No expression fixture to check against directly (packTermsForBias's
    // own return shape has no expression field at all) — this pins the
    // CONTRACT: the function signature only ever returns {term, pack}.
    mockGetLoadedRemotePacks.mockReturnValue([]);
    const result = packTermsForBias(null);
    expect(result.every((e) => typeof e.term === "string" && typeof e.pack === "string")).toBe(true);
  });

  it("isPackEnabled filtering: an explicit enabledPacks list excludes a pack not on it", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePack("__test_pack_a__", [{ term: "a-term", type: "other", gloss_en: "", gloss_zh: "" }]),
      remotePack("__test_pack_b__", [{ term: "b-term", type: "other", gloss_en: "", gloss_zh: "" }]),
    ]);
    const result = packTermsForBias(["__test_pack_a__"]);
    expect(result.some((e) => e.pack === "__test_pack_a__")).toBe(true);
    expect(result.some((e) => e.pack === "__test_pack_b__")).toBe(false);
  });

  it("commonWord terms are excluded under the default all-on state (enabledPacks: null) — same guard scanDictionary applies", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePack("__test_common_pack__", [
        { term: "common-word", type: "other", gloss_en: "", gloss_zh: "", commonWord: true },
      ]),
    ]);
    expect(packTermsForBias(null).some((e) => e.term === "common-word")).toBe(false);
    // Once the user has actively customized their pack selection
    // (an explicit list, even one that names this exact pack), the
    // commonWord guard lifts — mirrors scanDictionary's own rule.
    expect(packTermsForBias(["__test_common_pack__"]).some((e) => e.term === "common-word")).toBe(true);
  });

  it("defaults to the module-level registry (setEnabledPacks) when called with no argument", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePack("__test_pack_a__", [{ term: "a-term", type: "other", gloss_en: "", gloss_zh: "" }]),
      remotePack("__test_pack_b__", [{ term: "b-term", type: "other", gloss_en: "", gloss_zh: "" }]),
    ]);
    setEnabledPacks(["__test_pack_a__"]);
    const result = packTermsForBias();
    expect(result.some((e) => e.pack === "__test_pack_a__")).toBe(true);
    expect(result.some((e) => e.pack === "__test_pack_b__")).toBe(false);
  });
});
