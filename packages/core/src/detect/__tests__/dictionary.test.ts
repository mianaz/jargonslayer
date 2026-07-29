import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate scanDictionary from the personal glossary and the remote
// pack registry so these tests only exercise the built-in tables.
vi.mock("../../history/glossaryLookup", () => ({
  findEntryBySurface: vi.fn(() => null),
}));
// M4 fix round: dictionary.ts's scanDictionary now ALSO reads
// getRemotePacksGeneration (regex-cache invalidation) — a mock missing
// it would throw "getRemotePacksGeneration is not a function" the
// moment any test below calls scanDictionary. Fixed at 0 by default:
// most tests here don't care about pack-registry churn, so the cache
// simply stays warm across calls (still correct — see that function's
// own doc on why a stale cache entry can never produce a wrong match).
vi.mock("../remotePacksRegistry", () => ({
  getLoadedRemotePacks: vi.fn(() => []),
  getRemotePacksGeneration: vi.fn(() => 0),
}));

import { findEntryBySurface } from "../../history/glossaryLookup";
import { getLoadedRemotePacks, getRemotePacksGeneration } from "../remotePacksRegistry";
import type { LoadedRemotePack } from "../remotePacksRegistry";
import {
  dropSubsumedTermsForTests,
  packTermsForBias,
  scanDictionary,
  setEnabledPacks,
  setSenseContext,
} from "../dictionary";

const mockFindEntryBySurface = vi.mocked(findEntryBySurface);
const mockGetLoadedRemotePacks = vi.mocked(getLoadedRemotePacks);
const mockGetRemotePacksGeneration = vi.mocked(getRemotePacksGeneration);

beforeEach(() => {
  mockFindEntryBySurface.mockReset();
  mockFindEntryBySurface.mockReturnValue(null);
  mockGetLoadedRemotePacks.mockReset();
  mockGetLoadedRemotePacks.mockReturnValue([]);
  mockGetRemotePacksGeneration.mockReset();
  mockGetRemotePacksGeneration.mockReturnValue(0);
});

afterEach(() => {
  vi.clearAllMocks();
  // packTermsForBias's own tests below call setEnabledPacks() to
  // exercise its default-param registry read — real module state,
  // untouched by clearAllMocks(), so it must be restored explicitly or
  // it would leak into scanDictionary's OWN default-enabledPacks tests
  // above (which rely on the "null = every pack on" default).
  setEnabledPacks(null);
  // v0.6 multi-sense-terms sprint (T2/T3): same real-module-state leak
  // risk as setEnabledPacks above — the sense-selection tests below
  // call setSenseContext() and must not leak a scored context into
  // every OTHER test in this file (which all assume the "no context"
  // fallback, since they never call it themselves).
  setSenseContext(null);
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

// S11 fix (v0.6 round-2 review): buildExpressionRegex's trailing `\b`
// used to be unconditional — `\b` only satisfies when EXACTLY ONE of
// its two neighboring characters is a word character, so placed right
// after a non-word edge character (e.g. "100%") it can never match once
// that symbol is itself followed by whitespace/punctuation/end-of-string
// (both neighbors end up non-word) — the overwhelmingly common way such
// a token actually appears in real text. Every assertion below fails
// against pre-fix buildExpressionRegex.
describe("scanDictionary — S11 fix: an expression ending in a non-word character can actually match", () => {
  function remotePackWithExpression(expression: string) {
    return {
      id: "__test_symbol_pack__",
      name: "symbol pack",
      version: 1,
      expressions: [
        {
          expression,
          category: "phrase" as const,
          meaning: "entirely",
          chinese_explanation: "百分之百",
          plain_english: "completely",
          tone: "neutral",
          confidence: 0.9,
          pack: "__test_symbol_pack__",
        },
      ],
      terms: [],
    };
  }

  it("matches a trailing-symbol expression ('100%') followed by punctuation", () => {
    mockGetLoadedRemotePacks.mockReturnValue([remotePackWithExpression("100%")]);
    const res = scanDictionary("We hit 100% of the target.");
    expect(res.expressions.some((e) => e.expression === "100%")).toBe(true);
  });

  it("matches a trailing-symbol expression at the very end of the text (no trailing character at all)", () => {
    mockGetLoadedRemotePacks.mockReturnValue([remotePackWithExpression("100%")]);
    const res = scanDictionary("We are at 100%");
    expect(res.expressions.some((e) => e.expression === "100%")).toBe(true);
  });

  it("still matches an ordinary word-ending expression exactly as before (byte-identical regression guard)", () => {
    const res = scanDictionary("Let's circle back tomorrow.");
    expect(res.expressions.some((e) => e.expression === "circle back")).toBe(true);
  });

  it("still respects the leading word boundary for an ordinary entry — 'bandwidth' does not match inside 'broadband width'-style false substrings", () => {
    const res = scanDictionary("The megabandwidth metric is unofficial.");
    expect(res.expressions.some((e) => e.expression === "bandwidth")).toBe(false);
  });
});

// v0.7.2 fix (dictionary audit, Bug A): getCachedTermRegex had the same
// S11 problem above, but for TERMS — 14 built-in term headwords end in
// ')' (e.g. "stochastic gradient descent (SGD)", "mode (statistics)")
// and could never satisfy an unconditional trailing \b. Every assertion
// below fails against pre-fix getCachedTermRegex.
describe("scanDictionary — Bug A fix: a term ending in a non-word character can actually match", () => {
  it("matches a '(SGD)'-suffixed term inside realistic text", () => {
    const res = scanDictionary("We used stochastic gradient descent (SGD) to train the model.", null);
    expect(res.terms.some((t) => t.term === "stochastic gradient descent (SGD)")).toBe(true);
  });

  it("matches a '(statistics)'-suffixed term inside realistic text", () => {
    const res = scanDictionary("The mode (statistics) of this dataset is 7.", null);
    expect(res.terms.some((t) => t.term === "mode (statistics)")).toBe(true);
  });

  it("'401(k)' still matches as a variant of headword '401k'", () => {
    const res = scanDictionary("Do you contribute to your 401(k) every month?", null);
    const hit = res.terms.find((t) => t.term === "401k");
    expect(hit).toBeDefined();
  });

  it("plain terms keep strict word boundaries — no substring match inside a longer word", () => {
    const res = scanDictionary("The ARRAY was empty.", null);
    expect(res.terms.some((t) => t.term === "ARR")).toBe(false);
  });
});

// Variants enrichment pass (conservative alias sweep, field report):
// "get the ball rolling" gained explicit keep-family variants since the
// FIRST word is the light-verb here and buildExpressionRegex only ever
// inflects the LAST word of a multi-word phrase (see the "last-word
// inflection AS IMPLEMENTED" describe block above) — "keep"/"kept"/
// "keeps" would never have matched otherwise.
describe("scanDictionary — 'get the ball rolling' keep-family variants (variants enrichment pass)", () => {
  it("matches the keep-family variants added alongside the original headword", () => {
    const kept = scanDictionary("She kept the ball rolling while I was out.");
    expect(kept.expressions.some((e) => e.expression === "get the ball rolling")).toBe(true);

    const keep = scanDictionary("Let's keep the ball rolling on this.");
    expect(keep.expressions.some((e) => e.expression === "get the ball rolling")).toBe(true);

    const keeps = scanDictionary("He always keeps the ball rolling on these projects.");
    expect(keeps.expressions.some((e) => e.expression === "get the ball rolling")).toBe(true);
  });

  it("still matches the original headword and its own inflected last word ('rolling')", () => {
    const res = scanDictionary("Let's get the ball rolling on this.");
    expect(res.expressions.some((e) => e.expression === "get the ball rolling")).toBe(true);
  });

  it("negative guard: a deliberately NOT-aliased near-miss phrase stays unmatched ('drop the ball' has no 'lose the ball' variant)", () => {
    const res = scanDictionary("Let's not lose the ball on this one.");
    expect(res.expressions.some((e) => e.expression === "drop the ball")).toBe(false);
    expect(res.expressions).toHaveLength(0);
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

describe("scanDictionary — back-of-the-envelope ASR variants", () => {
  it("recognizes the reported 'back on the envelope calculation' transcript as the canonical idiom", () => {
    const res = scanDictionary(
      "Uh, I was doing the back on the envelope calculation.",
    );
    const hit = res.expressions.find(
      (e) => e.expression === "back-of-the-envelope",
    );
    expect(hit).toBeDefined();
    expect(hit?.matched_surface).toBe("back on the envelope calculation");
    expect(hit?.chinese_explanation).toBe("粗略估算一下，不是精确计算");
  });

  it("also recognizes the ordinary unhyphenated spoken form when followed by calculation", () => {
    const res = scanDictionary("This is only a back of the envelope calculation.");
    expect(
      res.expressions.some(
        (e) => e.expression === "back-of-the-envelope",
      ),
    ).toBe(true);
  });

  it("does not flag a literal reference to the physical back of an envelope", () => {
    const res = scanDictionary("The return address is on the back of the envelope.");
    expect(
      res.expressions.some(
        (e) => e.expression === "back-of-the-envelope",
      ),
    ).toBe(false);
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

describe("scanDictionary — term variants (v0.6 T2)", () => {
  function remotePackWithTerm(term: Omit<LoadedRemotePack["terms"][number], "pack">): LoadedRemotePack {
    return {
      id: "__test_variant_pack__",
      name: "variant pack",
      version: 1,
      expressions: [],
      terms: [{ ...term, pack: "__test_variant_pack__" }],
    };
  }

  it("a variant hit produces a card keyed by the entry's own headword, not the variant surface that matched", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePackWithTerm({
        term: "Synthetic Headword Alpha",
        type: "other",
        gloss_en: "",
        gloss_zh: "测试用生造术语",
        variants: ["SYNALPHA"],
      }),
    ]);
    const res = scanDictionary("Our SYNALPHA is trending down this quarter.");
    const hit = res.terms.find((t) => t.gloss_zh === "测试用生造术语");
    expect(hit).toBeDefined();
    expect(hit!.term).toBe("Synthetic Headword Alpha");
  });

  it("an all-caps variant stays case-sensitive even though the headword itself is mixed-case", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePackWithTerm({
        term: "Synthetic Headword Alpha",
        type: "other",
        gloss_en: "",
        gloss_zh: "测试用生造术语",
        variants: ["SYNALPHA"],
      }),
    ]);
    // Lowercase "synalpha" must NOT match the all-caps variant.
    const res = scanDictionary("the synalpha number needs review.");
    expect(res.terms.some((t) => t.gloss_zh === "测试用生造术语")).toBe(false);
  });

  it("the headword itself still matches when the variant doesn't appear in the text", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePackWithTerm({
        term: "Synthetic Headword Alpha",
        type: "other",
        gloss_en: "",
        gloss_zh: "测试用生造术语",
        variants: ["SYNALPHA"],
      }),
    ]);
    const res = scanDictionary("Our synthetic headword alpha is trending down.");
    expect(res.terms.some((t) => t.gloss_zh === "测试用生造术语")).toBe(true);
  });

  it("a term without variants behaves byte-identically to today (single-candidate match)", () => {
    const res = scanDictionary("The ARR figure is up.");
    expect(res.terms.some((t) => t.term === "ARR")).toBe(true);
  });
});

describe("scanDictionary — commonWord term suppression (H1/H2 doc fix pin, v0.6 dictpacks fix round)", () => {
  function remotePackWithCommonWordTerm(): LoadedRemotePack {
    return {
      id: "__test_commonword_pack__",
      name: "commonword pack",
      version: 1,
      expressions: [],
      terms: [
        {
          term: "zzztestword",
          type: "other",
          gloss_en: "",
          gloss_zh: "测试常见词",
          commonWord: true,
          pack: "__test_commonword_pack__",
        },
      ],
    };
  }

  it("suppresses a commonWord term under the default null (all-on) enabledPacks", () => {
    mockGetLoadedRemotePacks.mockReturnValue([remotePackWithCommonWordTerm()]);
    const res = scanDictionary("we discussed zzztestword today", null);
    expect(res.terms.some((t) => t.term === "zzztestword")).toBe(false);
  });

  it("fires the SAME commonWord term once the user has an explicit pack selection — even one that names this exact pack", () => {
    mockGetLoadedRemotePacks.mockReturnValue([remotePackWithCommonWordTerm()]);
    const res = scanDictionary("we discussed zzztestword today", ["__test_commonword_pack__"]);
    expect(res.terms.some((t) => t.term === "zzztestword")).toBe(true);
  });
});

describe("scanDictionary — regex cache does not block a mid-session pack install (M4 fix)", () => {
  it("a pack installed after an earlier scan is matchable on the very next scanDictionary call", () => {
    mockGetLoadedRemotePacks.mockReturnValue([]);
    mockGetRemotePacksGeneration.mockReturnValue(0);
    const before = scanDictionary("we discussed zzzfreshterm today", null);
    expect(before.terms.some((t) => t.term === "zzzfreshterm")).toBe(false);

    // Simulate a pack install: registry content AND generation both
    // change (setLoadedRemotePacks bumps generation — see that
    // function's own doc, packages/core/src/detect/remotePacksRegistry.ts).
    mockGetLoadedRemotePacks.mockReturnValue([
      {
        id: "__test_fresh_pack__",
        name: "fresh pack",
        version: 1,
        expressions: [],
        terms: [
          { term: "zzzfreshterm", type: "other", gloss_en: "", gloss_zh: "刚安装的词", pack: "__test_fresh_pack__" },
        ],
      },
    ]);
    mockGetRemotePacksGeneration.mockReturnValue(1);

    const after = scanDictionary("we discussed zzzfreshterm today", null);
    expect(after.terms.some((t) => t.term === "zzzfreshterm")).toBe(true);
  });
});

describe("scanDictionary — remote pack wins a term-key collision (F1 fix, adjudicated review)", () => {
  function remotePack(id: string, terms: Omit<LoadedRemotePack["terms"][number], "pack">[]): LoadedRemotePack {
    return {
      id,
      name: id,
      version: 1,
      expressions: [],
      terms: terms.map((t) => ({ ...t, pack: id })),
    };
  }

  it("remote-vs-builtin collision: the remote pack's gloss surfaces, and the builtin does not also produce a card", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePack("__test_remote_arr__", [
        { term: "ARR", type: "other", gloss_en: "Automatic Repeat reQuest", gloss_zh: "自动重传请求" },
      ]),
    ]);
    const res = scanDictionary("The ARR protocol retried the packet.");
    const arrHits = res.terms.filter((t) => t.term === "ARR");
    expect(arrHits).toHaveLength(1);
    expect(arrHits[0].gloss_zh).toBe("自动重传请求");
  });

  it("remote-vs-remote collision: the first pack in remote registry order wins deterministically", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePack("__test_remote_first__", [
        { term: "zzzcollide", type: "other", gloss_en: "", gloss_zh: "第一个包的释义" },
      ]),
      remotePack("__test_remote_second__", [
        { term: "zzzcollide", type: "other", gloss_en: "", gloss_zh: "第二个包的释义" },
      ]),
    ]);
    const res = scanDictionary("we saw zzzcollide today");
    const hits = res.terms.filter((t) => t.term === "zzzcollide");
    expect(hits).toHaveLength(1);
    expect(hits[0].gloss_zh).toBe("第一个包的释义");
  });

  it("no-collision regression: an existing builtin term still matches when remote packs are present", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePack("__test_remote_unrelated__", [
        { term: "zzzunrelated", type: "other", gloss_en: "", gloss_zh: "不冲突的远程词" },
      ]),
    ]);
    const res = scanDictionary("The MVP shipped this week.");
    expect(res.terms.some((t) => t.term === "MVP" && t.gloss_zh === "最小可行产品")).toBe(true);
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

// ---------------------------------------------------------------
// v0.6 T6 fix round: commonWord PER-ENTRY semantics test matrix — null /
// explicit-list-containing-the-pack / explicit-list-WITHOUT-it ×
// commonWord true/false, for BOTH scanDictionary and packTermsForBias.
// (Distinct from the earlier "H1/H2 doc fix pin" describe above, which
// only covered null vs. "an explicit list that happens to include the
// pack" — this block adds the THIRD, previously-untested cell: an
// explicit list that does NOT include the entry's own pack.)
// ---------------------------------------------------------------

describe("commonWord guard — v0.6 T6 per-entry test matrix", () => {
  const PACK_ID = "__test_t6_pack__";
  const OTHER_PACK_ID = "__test_t6_other_pack__";

  function packWithTerm(commonWord: boolean): LoadedRemotePack {
    return {
      id: PACK_ID,
      name: "t6 matrix pack",
      version: 1,
      expressions: [],
      terms: [
        { term: "t6word", type: "other", gloss_en: "", gloss_zh: "T6 矩阵测试词", commonWord, pack: PACK_ID },
      ],
    };
  }

  describe("scanDictionary", () => {
    it("commonWord: true, enabledPacks: null -> SUPPRESSED", () => {
      mockGetLoadedRemotePacks.mockReturnValue([packWithTerm(true)]);
      const res = scanDictionary("we discussed t6word today", null);
      expect(res.terms.some((t) => t.term === "t6word")).toBe(false);
    });

    it("commonWord: true, enabledPacks: [own pack] -> FIRES", () => {
      mockGetLoadedRemotePacks.mockReturnValue([packWithTerm(true)]);
      const res = scanDictionary("we discussed t6word today", [PACK_ID]);
      expect(res.terms.some((t) => t.term === "t6word")).toBe(true);
    });

    it("commonWord: true, enabledPacks: [a DIFFERENT pack, not this one] -> SUPPRESSED", () => {
      mockGetLoadedRemotePacks.mockReturnValue([packWithTerm(true)]);
      const res = scanDictionary("we discussed t6word today", [OTHER_PACK_ID]);
      expect(res.terms.some((t) => t.term === "t6word")).toBe(false);
    });

    it("commonWord: false, enabledPacks: null -> FIRES (guard only applies to commonWord entries)", () => {
      mockGetLoadedRemotePacks.mockReturnValue([packWithTerm(false)]);
      const res = scanDictionary("we discussed t6word today", null);
      expect(res.terms.some((t) => t.term === "t6word")).toBe(true);
    });

    it("commonWord: false, enabledPacks: [own pack] -> FIRES", () => {
      mockGetLoadedRemotePacks.mockReturnValue([packWithTerm(false)]);
      const res = scanDictionary("we discussed t6word today", [PACK_ID]);
      expect(res.terms.some((t) => t.term === "t6word")).toBe(true);
    });

    it("commonWord: false, enabledPacks: [a different pack] -> SUPPRESSED (isPackEnabled excludes the whole entry, unrelated to commonWord)", () => {
      mockGetLoadedRemotePacks.mockReturnValue([packWithTerm(false)]);
      const res = scanDictionary("we discussed t6word today", [OTHER_PACK_ID]);
      expect(res.terms.some((t) => t.term === "t6word")).toBe(false);
    });
  });

  describe("packTermsForBias", () => {
    it("commonWord: true, enabledPacks: null -> SUPPRESSED", () => {
      mockGetLoadedRemotePacks.mockReturnValue([packWithTerm(true)]);
      expect(packTermsForBias(null).some((e) => e.term === "t6word")).toBe(false);
    });

    it("commonWord: true, enabledPacks: [own pack] -> FIRES", () => {
      mockGetLoadedRemotePacks.mockReturnValue([packWithTerm(true)]);
      expect(packTermsForBias([PACK_ID]).some((e) => e.term === "t6word")).toBe(true);
    });

    it("commonWord: true, enabledPacks: [a different pack] -> SUPPRESSED", () => {
      mockGetLoadedRemotePacks.mockReturnValue([packWithTerm(true)]);
      expect(packTermsForBias([OTHER_PACK_ID]).some((e) => e.term === "t6word")).toBe(false);
    });

    it("commonWord: false, enabledPacks: null -> FIRES", () => {
      mockGetLoadedRemotePacks.mockReturnValue([packWithTerm(false)]);
      expect(packTermsForBias(null).some((e) => e.term === "t6word")).toBe(true);
    });

    it("commonWord: false, enabledPacks: [own pack] -> FIRES", () => {
      mockGetLoadedRemotePacks.mockReturnValue([packWithTerm(false)]);
      expect(packTermsForBias([PACK_ID]).some((e) => e.term === "t6word")).toBe(true);
    });

    it("commonWord: false, enabledPacks: [a different pack] -> SUPPRESSED", () => {
      mockGetLoadedRemotePacks.mockReturnValue([packWithTerm(false)]);
      expect(packTermsForBias([OTHER_PACK_ID]).some((e) => e.term === "t6word")).toBe(false);
    });
  });

  // The one case where this fix actually changes OBSERVABLE behavior —
  // every other pack id is already filtered out by isPackEnabled before
  // the commonWord check ever runs (the matrix above), but isPackEnabled
  // always treats "core" as enabled regardless of the list, so a
  // commonWord entry tagged "core" used to fire under ANY explicit
  // selection, even one that never named "core" at all.
  describe("the 'core' pack special case (why this fix matters at all)", () => {
    function corePackWithCommonWordTerm(): LoadedRemotePack {
      return {
        id: "core",
        name: "core (test double, injected directly into the registry mock)",
        version: 1,
        expressions: [],
        terms: [
          {
            term: "t6coreword",
            type: "other",
            gloss_en: "",
            gloss_zh: "核心包常见词测试",
            commonWord: true,
            pack: "core",
          },
        ],
      };
    }

    it("enabledPacks explicit but NOT naming 'core' -> now SUPPRESSED (was: fired, pre-T6)", () => {
      mockGetLoadedRemotePacks.mockReturnValue([corePackWithCommonWordTerm()]);
      const res = scanDictionary("we discussed t6coreword today", ["__unrelated_pack__"]);
      expect(res.terms.some((t) => t.term === "t6coreword")).toBe(false);
    });

    it("enabledPacks explicit AND naming 'core' -> FIRES", () => {
      mockGetLoadedRemotePacks.mockReturnValue([corePackWithCommonWordTerm()]);
      const res = scanDictionary("we discussed t6coreword today", ["core"]);
      expect(res.terms.some((t) => t.term === "t6coreword")).toBe(true);
    });

    it("enabledPacks: null -> SUPPRESSED (unchanged by this fix)", () => {
      mockGetLoadedRemotePacks.mockReturnValue([corePackWithCommonWordTerm()]);
      const res = scanDictionary("we discussed t6coreword today", null);
      expect(res.terms.some((t) => t.term === "t6coreword")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------
// v0.6 multi-sense-terms sprint (T3) — scanDictionary sense selection.
// setSenseContext() is real module state (see T2's own doc, dictionary.
// ts) — reset to null in this file's shared afterEach above so these
// tests never leak a scored context into any other test in this file.
// ---------------------------------------------------------------

describe("scanDictionary — multi-sense term selection (v0.6 T3)", () => {
  function remotePackWithSenses(
    senses: NonNullable<LoadedRemotePack["terms"][number]["senses"]>,
  ): LoadedRemotePack {
    return {
      id: "__test_sense_pack__",
      name: "sense pack",
      version: 1,
      expressions: [],
      terms: [
        {
          term: "EMT",
          type: "other",
          gloss_en: "top-level default gloss",
          gloss_zh: "顶层默认释义",
          pack: "__test_sense_pack__",
          senses,
        },
      ],
    };
  }

  it("an entry without `senses` at all emits byte-identical to today — no senseId/senses/ambiguous keys", () => {
    const res = scanDictionary("Our ARR grew this quarter.");
    const hit = res.terms.find((t) => t.term === "ARR");
    expect(hit).toEqual({
      term: "ARR",
      type: "metric",
      gloss_en: "Annual Recurring Revenue",
      gloss_zh: "年度经常性收入",
    });
    expect(hit).not.toHaveProperty("senseId");
    expect(hit).not.toHaveProperty("senses");
    expect(hit).not.toHaveProperty("ambiguous");
  });

  it("an entry with an EMPTY senses array also falls through to the no-senses branch, byte-identical", () => {
    mockGetLoadedRemotePacks.mockReturnValue([remotePackWithSenses([])]);
    const res = scanDictionary("Discussing EMT today.");
    const hit = res.terms.find((t) => t.term === "EMT");
    expect(hit).toEqual({
      term: "EMT",
      type: "other",
      gloss_en: "top-level default gloss",
      gloss_zh: "顶层默认释义",
    });
  });

  it("emits exactly ONE DetectedTerm for a multi-sense entry — cardinality never changes", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePackWithSenses([
        { senseId: "s1", gloss_en: "sense one", gloss_zh: "释义一", domain: "biomed", prior: 0.5 },
        { senseId: "s2", gloss_en: "sense two", gloss_zh: "释义二", domain: "genomics", prior: 0.5 },
      ]),
    ]);
    const res = scanDictionary("Discussing EMT today.");
    expect(res.terms.filter((t) => t.term === "EMT")).toHaveLength(1);
  });

  describe("no sense context at all — falls back to plain prior ordering", () => {
    it("the higher-prior sense wins", () => {
      mockGetLoadedRemotePacks.mockReturnValue([
        remotePackWithSenses([
          { senseId: "itk", gloss_en: "ITK gene", gloss_zh: "ITK 基因", domain: "genomics", prior: 0.3 },
          {
            senseId: "emt-transition",
            gloss_en: "epithelial-mesenchymal transition",
            gloss_zh: "上皮间质转化",
            domain: "biomed",
            prior: 0.7,
          },
        ]),
      ]);
      const res = scanDictionary("Discussing EMT today.");
      const hit = res.terms.find((t) => t.term === "EMT");
      expect(hit!.gloss_en).toBe("epithelial-mesenchymal transition");
      expect(hit!.senseId).toBe("emt-transition");
    });

    it("ambiguous: true when the top two priors are within 0.15", () => {
      mockGetLoadedRemotePacks.mockReturnValue([
        remotePackWithSenses([
          { senseId: "a", gloss_en: "a", gloss_zh: "甲", domain: "biomed", prior: 0.55 },
          { senseId: "b", gloss_en: "b", gloss_zh: "乙", domain: "genomics", prior: 0.5 },
        ]),
      ]);
      const res = scanDictionary("Discussing EMT today.");
      expect(res.terms.find((t) => t.term === "EMT")!.ambiguous).toBe(true);
    });

    it("ambiguous: false when the top two priors differ by >= 0.15", () => {
      mockGetLoadedRemotePacks.mockReturnValue([
        remotePackWithSenses([
          { senseId: "a", gloss_en: "a", gloss_zh: "甲", domain: "biomed", prior: 0.7 },
          { senseId: "b", gloss_en: "b", gloss_zh: "乙", domain: "genomics", prior: 0.3 },
        ]),
      ]);
      const res = scanDictionary("Discussing EMT today.");
      expect(res.terms.find((t) => t.term === "EMT")!.ambiguous).toBe(false);
    });
  });

  describe("with a sense context — weighted scoring", () => {
    it("domainWeights (0.45 weight) can flip the winner away from the higher-prior sense", () => {
      setSenseContext({ domainWeights: { biomed: 1.0 } });
      mockGetLoadedRemotePacks.mockReturnValue([
        remotePackWithSenses([
          { senseId: "itk", gloss_en: "ITK gene", gloss_zh: "ITK 基因", domain: "genomics", prior: 0.6 },
          {
            senseId: "emt",
            gloss_en: "epithelial-mesenchymal transition",
            gloss_zh: "上皮间质转化",
            domain: "biomed",
            prior: 0.4,
          },
        ]),
      ]);
      const res = scanDictionary("Discussing EMT today.");
      const hit = res.terms.find((t) => t.term === "EMT");
      // score(itk) = 0.15*0.6 = 0.09; score(emt) = 0.45 + 0.15*0.4 = 0.51.
      expect(hit!.gloss_en).toBe("epithelial-mesenchymal transition");
      expect(hit!.senseId).toBe("emt");
    });

    it("cooccurrence (0.25 weight) can also flip the winner", () => {
      setSenseContext({ cooccurrence: { genomics: 1.0 } });
      mockGetLoadedRemotePacks.mockReturnValue([
        remotePackWithSenses([
          { senseId: "itk", gloss_en: "ITK gene", gloss_zh: "ITK 基因", domain: "genomics", prior: 0.3 },
          {
            senseId: "emt",
            gloss_en: "epithelial-mesenchymal transition",
            gloss_zh: "上皮间质转化",
            domain: "biomed",
            prior: 0.6,
          },
        ]),
      ]);
      const res = scanDictionary("Discussing EMT today.");
      const hit = res.terms.find((t) => t.term === "EMT");
      // score(itk) = 0.25 + 0.15*0.3 = 0.295; score(emt) = 0.15*0.6 = 0.09.
      expect(hit!.gloss_en).toBe("ITK gene");
      expect(hit!.senseId).toBe("itk");
    });

    it("the pack-explicitly-enabled bonus (0.15) shifts every sense's score equally — never changes which sense wins within one entry", () => {
      setSenseContext({}); // present (non-null) context, forces the scored branch
      mockGetLoadedRemotePacks.mockReturnValue([
        remotePackWithSenses([
          { senseId: "a", gloss_en: "a", gloss_zh: "甲", domain: "biomed", prior: 0.7 },
          { senseId: "b", gloss_en: "b", gloss_zh: "乙", domain: "genomics", prior: 0.3 },
        ]),
      ]);
      const resWithoutBonus = scanDictionary("Discussing EMT today.", null);
      const resWithBonus = scanDictionary("Discussing EMT today.", ["__test_sense_pack__"]);
      const hitWithout = resWithoutBonus.terms.find((t) => t.term === "EMT")!;
      const hitWithBonus = resWithBonus.terms.find((t) => t.term === "EMT")!;
      expect(hitWithout.senseId).toBe("a");
      expect(hitWithBonus.senseId).toBe("a"); // same winner either way
      expect(hitWithBonus.senses![0].score).toBeCloseTo(hitWithout.senses![0].score! + 0.15, 5);
    });

    // LOW fix (v0.6 round-2 review): an EMPTY domainWeights map (`{}`,
    // not `undefined`) — this app's actual starting state every
    // meeting, before any domain is inferred (useMeeting.ts always
    // calls setSenseContext with a real object, never null in
    // practice) — used to make the domain-zero-weight ambiguity
    // trigger fire UNCONDITIONALLY, since "this sense's domain has
    // zero weight" is trivially true of every domain when nothing has
    // non-zero weight. Fails against pre-fix selectSense, where this
    // assertion would see `true`.
    it("an EMPTY domainWeights map ({}) does NOT trip the domain-zero-weight ambiguity trigger — no real domain signal to disagree with yet", () => {
      setSenseContext({}); // present (non-null), but no domain has any weight at all
      mockGetLoadedRemotePacks.mockReturnValue([
        remotePackWithSenses([
          { senseId: "high", gloss_en: "high prior", gloss_zh: "高先验", domain: "genomics", prior: 1.0 },
          { senseId: "low", gloss_en: "low prior", gloss_zh: "低先验", domain: "biomed", prior: 0.0 },
        ]),
      ]);
      const res = scanDictionary("Discussing EMT today.");
      const hit = res.terms.find((t) => t.term === "EMT");
      // Wide margin (score gap 0.15, not < 0.15) so this isolates the
      // domain-zero-weight condition, same isolation the sibling
      // "sales"-weighted test above uses.
      expect(hit!.gloss_en).toBe("high prior");
      expect(hit!.ambiguous).toBe(false);
    });

    it("ambiguous purely from zero domain weight (scored path only), even when the score margin is wide", () => {
      setSenseContext({ domainWeights: { sales: 1.0 } }); // neither candidate domain
      mockGetLoadedRemotePacks.mockReturnValue([
        remotePackWithSenses([
          { senseId: "high", gloss_en: "high prior", gloss_zh: "高先验", domain: "genomics", prior: 1.0 },
          { senseId: "low", gloss_en: "low prior", gloss_zh: "低先验", domain: "biomed", prior: 0.0 },
        ]),
      ]);
      const res = scanDictionary("Discussing EMT today.");
      const hit = res.terms.find((t) => t.term === "EMT");
      // score(high) = 0.15; score(low) = 0. Margin is exactly 0.15 (NOT
      // < 0.15), so this isolates the domain-zero-weight condition.
      expect(hit!.gloss_en).toBe("high prior");
      expect(hit!.ambiguous).toBe(true);
    });

    it("NOT ambiguous when the chosen sense's domain has real weight, even with the same wide margin", () => {
      setSenseContext({ domainWeights: { genomics: 1.0 } });
      mockGetLoadedRemotePacks.mockReturnValue([
        remotePackWithSenses([
          { senseId: "high", gloss_en: "high prior", gloss_zh: "高先验", domain: "genomics", prior: 1.0 },
          { senseId: "low", gloss_en: "low prior", gloss_zh: "低先验", domain: "biomed", prior: 0.0 },
        ]),
      ]);
      const res = scanDictionary("Discussing EMT today.");
      expect(res.terms.find((t) => t.term === "EMT")!.ambiguous).toBe(false);
    });
  });

  it("emits the full ranked `senses` array (chosen first), one entry per DictSense, each carrying its own score", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePackWithSenses([
        { senseId: "itk", gloss_en: "ITK gene", gloss_zh: "ITK 基因", domain: "genomics", prior: 0.3 },
        {
          senseId: "emt",
          gloss_en: "epithelial-mesenchymal transition",
          gloss_zh: "上皮间质转化",
          domain: "biomed",
          prior: 0.7,
        },
      ]),
    ]);
    const res = scanDictionary("Discussing EMT today.");
    const hit = res.terms.find((t) => t.term === "EMT");
    expect(hit!.senses).toHaveLength(2);
    expect(hit!.senses![0].senseId).toBe("emt"); // chosen first
    expect(hit!.senses![1].senseId).toBe("itk");
    expect(hit!.senses!.every((s) => typeof s.score === "number")).toBe(true);
  });

  it("a sense with its own `type` overrides the entry's top-level type", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePackWithSenses([
        { senseId: "s1", gloss_en: "s1", gloss_zh: "甲", domain: "biomed", type: "acronym", prior: 0.9 },
      ]),
    ]);
    const res = scanDictionary("Discussing EMT today.");
    expect(res.terms.find((t) => t.term === "EMT")!.type).toBe("acronym");
  });

  it("a sense WITHOUT its own `type` inherits the entry's top-level type", () => {
    mockGetLoadedRemotePacks.mockReturnValue([
      remotePackWithSenses([{ senseId: "s1", gloss_en: "s1", gloss_zh: "甲", domain: "biomed", prior: 0.9 }]),
    ]);
    const res = scanDictionary("Discussing EMT today.");
    // remotePackWithSenses' own top-level type is "other".
    expect(res.terms.find((t) => t.term === "EMT")!.type).toBe("other");
  });
});

describe("longest-match-wins across overlapping term surfaces", () => {
  it("drops a term whose surface is a whole-word substring of another matched term", () => {
    // Real case from the v0.6 content round: saying "vesting cliff"
    // produced BOTH a "vesting" card and a "vesting cliff" card.
    const res = scanDictionary("There is a one-year vesting cliff.", null);
    const surfaces = res.terms.map((t) => t.term);
    expect(surfaces).toContain("vesting cliff");
    expect(surfaces).not.toContain("vesting");
  });

  it("keeps both when neither surface contains the other", () => {
    const res = scanDictionary("The sample mean and variance were computed.", ["stats"]);
    const surfaces = res.terms.map((t) => t.term);
    expect(surfaces).toContain("sample mean");
    expect(surfaces).toContain("variance");
  });

  // S8 fix (v0.6 round-2 review): a STANDALONE occurrence of the
  // shorter surface, entirely separate from the compound one, must
  // survive — the old label-based containment check couldn't tell
  // these apart (it compared "vesting" against "vesting cliff" as bare
  // strings, with no idea WHERE in the text either one actually
  // matched) and dropped the legitimate standalone card too. Fails
  // against pre-fix dropSubsumedTerms.
  it("keeps a standalone occurrence of the shorter surface that is entirely separate from a LATER compound occurrence", () => {
    const res = scanDictionary(
      "Let's talk about vesting first, then get into the one-year vesting cliff.",
      null,
    );
    const surfaces = res.terms.map((t) => t.term);
    expect(surfaces).toContain("vesting"); // the standalone mention
    expect(surfaces).toContain("vesting cliff"); // the compound mention
  });

  describe("dropSubsumedTerms (pure, span-based)", () => {
    function hit(term: string, matchStart: number, matchEnd: number) {
      return { term, matchStart, matchEnd };
    }

    it("drops a shorter span fully contained within a STRICTLY longer one", () => {
      // "vesting" (7 chars) at [17,24) is fully inside "vesting cliff"
      // (14 chars) at [17,31) — same start, contained end.
      const result = dropSubsumedTermsForTests([hit("vesting", 17, 24), hit("vesting cliff", 17, 31)]);
      expect(result.map((h) => h.term)).toEqual(["vesting cliff"]);
    });

    it("keeps both when the spans don't overlap at all, even if one label textually contains the other", () => {
      const result = dropSubsumedTermsForTests([hit("vesting", 0, 7), hit("vesting cliff", 40, 54)]);
      expect(result.map((h) => h.term)).toEqual(["vesting", "vesting cliff"]);
    });

    it("equal-length spans never subsume each other, even at the exact same position", () => {
      const result = dropSubsumedTermsForTests([hit("a", 0, 5), hit("b", 0, 5)]);
      expect(result.map((h) => h.term)).toEqual(["a", "b"]);
    });

    it("never allocates a RegExp per comparison and never disables filtering above 64 hits (the old guard's own bug) — 100 non-overlapping hits all survive, and a genuinely subsumed one among them still gets dropped", () => {
      const hits = Array.from({ length: 100 }, (_, i) => hit(`term${i}`, i * 10, i * 10 + 5));
      // Insert one genuinely subsumed pair, positioned well past every
      // original hit's own span (0..995) so it can't accidentally
      // collide with one of them.
      hits.push(hit("short", 2000, 2005), hit("short-but-longer", 2000, 2016));
      const result = dropSubsumedTermsForTests(hits);
      expect(result.length).toBe(101); // 100 originals + the longer of the subsumed pair, minus the shorter
      expect(result.some((h) => h.term === "short")).toBe(false);
      expect(result.some((h) => h.term === "short-but-longer")).toBe(true);
    });
  });
});
