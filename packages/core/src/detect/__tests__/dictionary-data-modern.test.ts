import { afterEach, describe, expect, it, vi } from "vitest";

// Isolate scanDictionary from the personal glossary and the remote pack
// registry, same mocking as dictionary.test.ts / compiledPacks.test.ts —
// the cross-collision checks below run scanDictionary directly.
vi.mock("../../history/glossaryLookup", () => ({
  findEntryBySurface: vi.fn(() => null),
}));
vi.mock("../remotePacksRegistry", () => ({
  getLoadedRemotePacks: vi.fn(() => []),
  getRemotePacksGeneration: vi.fn(() => 0),
}));

import { EXTRA_EXPRESSIONS, EXTRA_TERMS } from "../dictionary-data";
import { COMPILED_PACK_TERMS } from "../dictionary-packs-compiled";
import { FINANCE_CONSUMER_EXPRESSIONS, FINANCE_CONSUMER_TERMS } from "../dictionary-data-finance";
import { DAILY_IDIOM_EXPRESSIONS } from "../dictionary-data-idiom";
import { MODERN_USAGE_EXPRESSIONS, MODERN_USAGE_TERMS } from "../dictionary-data-modern";
import { scanDictionary, setEnabledPacks, setSenseContext } from "../dictionary";
import { PACKS } from "../packs";

afterEach(() => {
  vi.clearAllMocks();
  setEnabledPacks(null);
  setSenseContext(null);
});

const VALID_CATEGORIES = new Set(["idiom", "slang", "phrase", "metaphor", "indirect", "other"]);
const VALID_TYPES = new Set(["acronym", "company", "product", "tech", "metric", "person", "other"]);
// Every built-in pack id, named explicitly — passing this (rather than
// null) to scanDictionary both (a) surfaces commonWord-flagged existing
// entries, which enabledPacks: null would otherwise suppress, and (b)
// matches the v0.6 T6 isPackExplicitlyEnabled fix: a commonWord entry
// only un-suppresses once its OWN pack is named, so every pack must be
// listed for this to behave as "everything visible".
const ALL_PACK_IDS = PACKS.map((p) => p.id);

const norm = (s: string) => s.trim().toLowerCase();

function candidateSurfaces(
  terms: { term: string; variants?: string[] }[],
  expressions: { expression: string; variants?: string[] }[],
): string[] {
  const out: string[] = [];
  for (const t of terms) out.push(t.term, ...(t.variants ?? []));
  for (const e of expressions) out.push(e.expression, ...(e.variants ?? []));
  return out;
}

const MY_SURFACES = candidateSurfaces(MODERN_USAGE_TERMS, MODERN_USAGE_EXPRESSIONS);

describe("MODERN_USAGE_TERMS — data integrity", () => {
  it("every entry has non-empty required fields, a valid TermType, and pack 'modern-usage'", () => {
    expect(MODERN_USAGE_TERMS.length).toBeGreaterThan(0);
    for (const entry of MODERN_USAGE_TERMS) {
      expect(entry.term.trim().length).toBeGreaterThan(0);
      expect(entry.gloss_en.trim().length).toBeGreaterThan(0);
      expect(entry.gloss_zh.trim().length).toBeGreaterThan(0);
      expect(VALID_TYPES.has(entry.type)).toBe(true);
      expect(entry.pack).toBe("modern-usage");
    }
  });

  it("every gloss_zh is within the <=40 char quality bar", () => {
    for (const entry of MODERN_USAGE_TERMS) {
      expect(entry.gloss_zh.length, `${entry.term}: ${entry.gloss_zh}`).toBeLessThanOrEqual(40);
    }
  });
});

describe("MODERN_USAGE_EXPRESSIONS — data integrity", () => {
  it("every entry has non-empty required fields, a valid ExpressionCategory, confidence 0.9, and pack 'modern-usage'", () => {
    expect(MODERN_USAGE_EXPRESSIONS.length).toBeGreaterThan(0);
    for (const entry of MODERN_USAGE_EXPRESSIONS) {
      expect(entry.expression.trim().length).toBeGreaterThan(0);
      expect(entry.meaning.trim().length).toBeGreaterThan(0);
      expect(entry.chinese_explanation.trim().length).toBeGreaterThan(0);
      expect(entry.plain_english.trim().length).toBeGreaterThan(0);
      expect(entry.tone.trim().length).toBeGreaterThan(0);
      expect(VALID_CATEGORIES.has(entry.category)).toBe(true);
      expect(entry.confidence).toBe(0.9);
      expect(entry.pack).toBe("modern-usage");
    }
  });

  it("every chinese_explanation is within the <=40 char quality bar", () => {
    for (const entry of MODERN_USAGE_EXPRESSIONS) {
      expect(entry.chinese_explanation.length, `${entry.expression}: ${entry.chinese_explanation}`).toBeLessThanOrEqual(40);
    }
  });
});

describe("entry count is roughly the ~60 the brief asked for", () => {
  it("terms + expressions together land in a sane range around 60", () => {
    const total = MODERN_USAGE_TERMS.length + MODERN_USAGE_EXPRESSIONS.length;
    expect(total).toBeGreaterThanOrEqual(45);
    expect(total).toBeLessThanOrEqual(80);
  });
});

describe("no duplicate surfaces", () => {
  it("no duplicate surface within MODERN_USAGE_TERMS + MODERN_USAGE_EXPRESSIONS themselves", () => {
    const normalized = MY_SURFACES.map(norm);
    expect(new Set(normalized).size).toBe(normalized.length);
  });

  it("no surface collides with EXTRA_EXPRESSIONS/EXTRA_TERMS (dictionary-data.ts)", () => {
    const existing = new Set(candidateSurfaces(EXTRA_TERMS, EXTRA_EXPRESSIONS).map(norm));
    for (const s of MY_SURFACES) {
      expect(existing.has(norm(s)), `"${s}" collides with dictionary-data.ts`).toBe(false);
    }
  });

  it("no surface collides with COMPILED_PACK_TERMS (dictionary-packs-compiled.ts)", () => {
    const existing = new Set(COMPILED_PACK_TERMS.flatMap((t) => [t.term, ...(t.variants ?? [])]).map(norm));
    for (const s of MY_SURFACES) {
      expect(existing.has(norm(s)), `"${s}" collides with a compiled-pack term`).toBe(false);
    }
  });

  it("no surface collides with the sibling v0.6 packs (finance-consumer, daily-idiom)", () => {
    const siblingSurfaces = new Set(
      [
        ...candidateSurfaces(FINANCE_CONSUMER_TERMS, FINANCE_CONSUMER_EXPRESSIONS),
        ...candidateSurfaces([], DAILY_IDIOM_EXPRESSIONS),
      ].map(norm),
    );
    for (const s of MY_SURFACES) {
      expect(siblingSurfaces.has(norm(s)), `"${s}" collides with finance-consumer/daily-idiom`).toBe(false);
    }
  });

  it("no surface is matched by the LIVE built-in dictionary (base tables + extra + compiled, via scanDictionary)", () => {
    // The only way to check against dictionary.ts's own un-exported
    // BASE_EXPRESSIONS/BASE_TERM_DICTIONARY (e.g. "circle back", "take
    // this offline") without editing dictionary.ts to export them —
    // scanDictionary already merges base+extra+compiled internally.
    // These modules are now MERGED into dictionary.ts, so each surface
    // legitimately matches its OWN entry. The invariant that matters is
    // unchanged: exactly one entry may claim a surface — a second one
    // would be a competing card for the same string.
    for (const s of MY_SURFACES) {
      const res = scanDictionary(s, ALL_PACK_IDS);
      const hits = [...res.expressions, ...res.terms];
      expect(hits.length, `"${s}" produced ${hits.length} entries: ${JSON.stringify(hits)}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("commonWord — hand-listed subset (pins intent, not just current data)", () => {
  const EXPECTED_COMMON = [
    "agent",
    "checkpoint",
    "compute",
    "harness",
    "leverage",
    "primitives",
    "surface area",
    "unicorn",
    "unlock",
    "wrapper",
  ];

  it("flags exactly the expected everyday-English headwords", () => {
    const flagged = MODERN_USAGE_TERMS.filter((t) => t.commonWord).map((t) => t.term).sort();
    expect(flagged).toEqual([...EXPECTED_COMMON].sort());
  });

  it("does NOT flag AI-only vocabulary that has no everyday meaning", () => {
    for (const term of ["RAG", "hallucinate", "MCP", "guardrails", "distillation", "jailbreak"]) {
      const entry = MODERN_USAGE_TERMS.find((t) => t.term === term);
      expect(entry, term).toBeDefined();
      expect(entry!.commonWord, term).not.toBe(true);
    }
  });

  // NOTE: this pack isn't wired into dictionary.ts's TERM_DICTIONARY yet
  // (the lead wires MODERN_USAGE_TERMS/EXPRESSIONS in separately — see
  // this module's own header), so scanDictionary can't be exercised
  // end-to-end against these entries here; the runtime suppress/fire
  // behavior itself is already covered generically by
  // compiledPacks.test.ts against real wired-in commonWord entries. The
  // static commonWord flag values are pinned above.
});
