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
import { DAILY_IDIOM_EXPRESSIONS } from "../dictionary-data-idiom";
import { FINANCE_CONSUMER_EXPRESSIONS, FINANCE_CONSUMER_TERMS } from "../dictionary-data-finance";
import { MODERN_USAGE_EXPRESSIONS, MODERN_USAGE_TERMS } from "../dictionary-data-modern";
import { scanDictionary, setEnabledPacks, setSenseContext } from "../dictionary";
import { PACKS } from "../packs";

afterEach(() => {
  vi.clearAllMocks();
  setEnabledPacks(null);
  setSenseContext(null);
});

const VALID_CATEGORIES = new Set(["idiom", "slang", "phrase", "metaphor", "indirect", "other"]);
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

const MY_SURFACES = candidateSurfaces([], DAILY_IDIOM_EXPRESSIONS);

describe("DAILY_IDIOM_EXPRESSIONS — data integrity", () => {
  it("every entry has non-empty required fields, a valid ExpressionCategory, confidence 0.9, and pack 'daily-idiom'", () => {
    expect(DAILY_IDIOM_EXPRESSIONS.length).toBeGreaterThan(0);
    for (const entry of DAILY_IDIOM_EXPRESSIONS) {
      expect(entry.expression.trim().length).toBeGreaterThan(0);
      expect(entry.meaning.trim().length).toBeGreaterThan(0);
      expect(entry.chinese_explanation.trim().length).toBeGreaterThan(0);
      expect(entry.plain_english.trim().length).toBeGreaterThan(0);
      expect(entry.tone.trim().length).toBeGreaterThan(0);
      expect(VALID_CATEGORIES.has(entry.category)).toBe(true);
      expect(entry.confidence).toBe(0.9);
      expect(entry.pack).toBe("daily-idiom");
    }
  });

  it("every chinese_explanation is within the <=40 char quality bar", () => {
    for (const entry of DAILY_IDIOM_EXPRESSIONS) {
      expect(entry.chinese_explanation.length, `${entry.expression}: ${entry.chinese_explanation}`).toBeLessThanOrEqual(40);
    }
  });

  it("uses a real spread of categories, not just one bucket (idiom/slang/phrase/metaphor/indirect)", () => {
    const used = new Set(DAILY_IDIOM_EXPRESSIONS.map((e) => e.category));
    for (const cat of ["idiom", "slang", "phrase", "metaphor", "indirect"] as const) {
      expect(used.has(cat), `expected at least one '${cat}' entry`).toBe(true);
    }
  });
});

describe("entry count is roughly the ~150 the brief asked for", () => {
  it("lands in a sane range around 150", () => {
    expect(DAILY_IDIOM_EXPRESSIONS.length).toBeGreaterThanOrEqual(100);
    expect(DAILY_IDIOM_EXPRESSIONS.length).toBeLessThanOrEqual(200);
  });
});

describe("no duplicate surfaces", () => {
  it("no duplicate surface within DAILY_IDIOM_EXPRESSIONS itself", () => {
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

  it("no surface collides with the sibling v0.6 packs (modern-usage, finance-consumer)", () => {
    const siblingSurfaces = new Set(
      [
        ...candidateSurfaces(MODERN_USAGE_TERMS, MODERN_USAGE_EXPRESSIONS),
        ...candidateSurfaces(FINANCE_CONSUMER_TERMS, FINANCE_CONSUMER_EXPRESSIONS),
      ].map(norm),
    );
    for (const s of MY_SURFACES) {
      expect(siblingSurfaces.has(norm(s)), `"${s}" collides with modern-usage/finance-consumer`).toBe(false);
    }
  });

  it("no surface is matched by the LIVE built-in dictionary (base tables + extra + compiled, via scanDictionary)", () => {
    // The only way to check against dictionary.ts's own un-exported
    // BASE_EXPRESSIONS/BASE_TERM_DICTIONARY (e.g. "touch base", "ballpark",
    // "playing devil's advocate", "I hear you") without editing
    // dictionary.ts to export them — scanDictionary already merges
    // base+extra+compiled internally.
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

describe("tone is set honestly, not defaulted (hand-listed subset)", () => {
  it("casual/slangy entries are actually marked casual/informal in tone", () => {
    for (const expression of ["say less", "my bad", "yikes", "that's wild", "not gonna lie", "no way"]) {
      const entry = DAILY_IDIOM_EXPRESSIONS.find((e) => e.expression === expression);
      expect(entry, expression).toBeDefined();
      expect(entry!.tone.toLowerCase(), expression).toMatch(/casual|informal/);
    }
  });

  it("the one deliberately formal entry is marked formal, not casual", () => {
    const entry = DAILY_IDIOM_EXPRESSIONS.find((e) => e.expression === "at your earliest convenience");
    expect(entry).toBeDefined();
    expect(entry!.tone.toLowerCase()).toContain("formal");
  });
});
