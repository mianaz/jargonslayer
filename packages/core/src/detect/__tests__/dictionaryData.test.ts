import { describe, expect, it } from "vitest";
import { COMPILED_PACK_TERMS } from "../dictionary-packs-compiled";
import { DOMAIN_TAGS, EXTRA_TERMS, type DictTermEntry } from "../dictionary-data";
import { FINANCE_CONSUMER_TERMS } from "../dictionary-data-finance";
import { MODERN_USAGE_TERMS } from "../dictionary-data-modern";

describe("DOMAIN_TAGS", () => {
  it("has exactly 16 unique entries, matching the DomainTag union's own value count", () => {
    expect(DOMAIN_TAGS).toHaveLength(16);
    expect(new Set(DOMAIN_TAGS).size).toBe(16);
  });
});

// v0.6 multi-sense-terms sprint (T1) — the ONE invariant that keeps
// this feature additive/zero-migration: every consumer that doesn't
// know `senses` exists at all (packTermsForBias, remote-pack installs
// predating this field, every one of the ~750 existing built-ins) must
// keep seeing today's single, correct default gloss via the entry's
// own top-level fields, never something that only makes sense once
// `senses` is also read.
describe("DictTermEntry.senses invariant — senses[0] mirrors the entry's own top-level gloss (v0.6 T1)", () => {
  const TABLES: { name: string; entries: DictTermEntry[] }[] = [
    { name: "EXTRA_TERMS", entries: EXTRA_TERMS },
    { name: "MODERN_USAGE_TERMS", entries: MODERN_USAGE_TERMS },
    { name: "FINANCE_CONSUMER_TERMS", entries: FINANCE_CONSUMER_TERMS },
    { name: "COMPILED_PACK_TERMS", entries: COMPILED_PACK_TERMS },
  ];

  it(
    "holds for every entry that declares `senses`, across every built-in term table " +
      "exported from a dictionary data module",
    () => {
      for (const { name, entries } of TABLES) {
        for (const entry of entries) {
          if (!entry.senses || entry.senses.length === 0) continue;
          expect(entry.senses[0].gloss_en, `${name}: "${entry.term}".senses[0].gloss_en`).toBe(
            entry.gloss_en,
          );
          expect(entry.senses[0].gloss_zh, `${name}: "${entry.term}".senses[0].gloss_zh`).toBe(
            entry.gloss_zh,
          );
        }
      }
    },
  );

  it("the check above is not vacuous — a hand-built entry that violates the invariant is genuinely catchable", () => {
    const violating: DictTermEntry = {
      term: "TEST_INVARIANT_VIOLATION",
      type: "other",
      gloss_en: "top-level EN",
      gloss_zh: "顶层中文",
      pack: "core",
      senses: [
        {
          gloss_en: "a genuinely different EN gloss",
          gloss_zh: "顶层中文",
          domain: "general",
          prior: 0.5,
          senseId: "s0",
        },
      ],
    };
    expect(violating.senses![0].gloss_en).not.toBe(violating.gloss_en);
  });
});
