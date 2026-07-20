// v0.4.7 Lane B — glossary -> recognizer bias (docs/design-explorations/
// stt-provider-wiring-2026-07.md §3, D1/D3/D8). Isolates buildMeetingLexicon
// from the (large, real) built-in dictionary tables by mocking
// packTermsForBias — same "test only what THIS module owns" discipline
// dictionary.test.ts already uses for glossaryLookup/remotePacksRegistry.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomEntry } from "@jargonslayer/core/types";
import type { LearnRecord } from "@jargonslayer/core/learn/types";

vi.mock("@jargonslayer/core/detect/dictionary", () => ({
  packTermsForBias: vi.fn(() => []),
  // Pre-merge review Finding 2 fix: history/glossary.ts (imported below)
  // registers a shadow lookup into this module at load time — a no-op
  // stub keeps that call from throwing under this partial mock.
  setGlossaryShadowLookup: vi.fn(),
}));

import { packTermsForBias } from "@jargonslayer/core/detect/dictionary";
import {
  buildMeetingLexicon,
  projectForInitialPrompt,
  projectForOsSpeechContextualJson,
  projectForSonioxContext,
} from "../lexicon";
import * as glossary from "../../history/glossary";

const mockPackTermsForBias = vi.mocked(packTermsForBias);

function glossaryEntry(headword: string, variants: string[] = []): CustomEntry {
  const now = Date.now();
  return {
    id: headword,
    kind: "term",
    packId: "personal",
    headword,
    variants,
    chinese_explanation: "",
    example: "",
    context: "",
    note: "",
    createdAt: now,
    updatedAt: now,
    source: "manual",
  };
}

function learnRecord(surface: string, suppressed: boolean): LearnRecord {
  const now = Date.now();
  return {
    learnKey: `term:${surface.toLowerCase()}`,
    kind: "term",
    surface,
    familiarity: suppressed ? 1 : 0,
    suppressed,
    reps: 0,
    intervalDays: 0,
    ease: 2.5,
    dueAt: now,
    lapses: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe("buildMeetingLexicon", () => {
  beforeEach(() => {
    mockPackTermsForBias.mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty term list when every input is empty", () => {
    expect(buildMeetingLexicon({ customEntries: [], enabledPacks: null, learnset: {} })).toEqual({
      terms: [],
    });
  });

  it("D3 tier order: glossary headwords, THEN pack terms, THEN suppressed learn-set terms ranked last", () => {
    mockPackTermsForBias.mockReturnValue([{ term: "pack-term", pack: "core" }]);
    const lexicon = buildMeetingLexicon({
      customEntries: [glossaryEntry("headword-a")],
      enabledPacks: null,
      learnset: { "term:suppressed-x": learnRecord("suppressed-x", true) },
    });
    expect(lexicon.terms).toEqual(["headword-a", "pack-term", "suppressed-x"]);
  });

  it("every entry's headword comes before ANY entry's variants (headwords-first across the WHOLE glossary tier)", () => {
    const lexicon = buildMeetingLexicon({
      customEntries: [glossaryEntry("h1", ["v1"]), glossaryEntry("h2", ["v2"])],
      enabledPacks: null,
      learnset: {},
    });
    expect(lexicon.terms).toEqual(["h1", "h2", "v1", "v2"]);
  });

  it("caps variants at a per-entry ceiling (3) once headwords are exhausted, dropping the rest", () => {
    const lexicon = buildMeetingLexicon({
      customEntries: [glossaryEntry("h1", ["v1", "v2", "v3", "v4", "v5"])],
      enabledPacks: null,
      learnset: {},
    });
    expect(lexicon.terms).toEqual(["h1", "v1", "v2", "v3"]);
  });

  it("suppressed learn-set terms stay ELIGIBLE (Opus over Sol's filter-out) — not dropped, just ranked last", () => {
    const lexicon = buildMeetingLexicon({
      customEntries: [],
      enabledPacks: null,
      learnset: { "term:x": learnRecord("x", true) },
    });
    expect(lexicon.terms).toEqual(["x"]);
  });

  it("non-suppressed learn-set records never contribute a term (only suppressed ones do)", () => {
    const lexicon = buildMeetingLexicon({
      customEntries: [],
      enabledPacks: null,
      learnset: { "term:x": learnRecord("x", false) },
    });
    expect(lexicon.terms).toEqual([]);
  });

  it("dedupes across tiers by normalized key — the higher-priority tier's own surface wins the slot", () => {
    mockPackTermsForBias.mockReturnValue([{ term: "arr", pack: "core" }]);
    const lexicon = buildMeetingLexicon({
      customEntries: [glossaryEntry("ARR")],
      enabledPacks: null,
      learnset: { "term:arr": learnRecord("ARR", true) },
    });
    // Same normalized key (termNormKey uppercases short all-letter
    // tokens) — only the glossary's own "ARR" survives; the pack's
    // "arr" and the suppressed-learnset "ARR" both collapse into it.
    expect(lexicon.terms).toEqual(["ARR"]);
  });

  it("Sol F3: round-robins pack candidates ACROSS packs so one large pack can't crowd out a smaller one", () => {
    mockPackTermsForBias.mockReturnValue([
      { term: "biz1", pack: "business-terms" },
      { term: "biz2", pack: "business-terms" },
      { term: "biz3", pack: "business-terms" },
      { term: "tech1", pack: "tech-terms" },
    ]);
    const lexicon = buildMeetingLexicon({ customEntries: [], enabledPacks: null, learnset: {} });
    // Round 0: biz1, tech1. Round 1: biz2 (tech-terms exhausted). Round 2: biz3.
    expect(lexicon.terms).toEqual(["biz1", "tech1", "biz2", "biz3"]);
  });

  it("passes enabledPacks straight through to packTermsForBias", () => {
    buildMeetingLexicon({ customEntries: [], enabledPacks: ["tech-terms"], learnset: {} });
    expect(mockPackTermsForBias).toHaveBeenCalledWith(["tech-terms"]);
  });

  it("caps the overall list at the LEXICON_MAX_TERMS belt (500), preserving priority order", () => {
    const entries = Array.from({ length: 600 }, (_, i) => glossaryEntry(`term-${i}`));
    const lexicon = buildMeetingLexicon({ customEntries: entries, enabledPacks: null, learnset: {} });
    expect(lexicon.terms).toHaveLength(500);
    expect(lexicon.terms[0]).toBe("term-0");
    expect(lexicon.terms[499]).toBe("term-499");
  });

  it("blank/whitespace-only surfaces are skipped rather than emitted", () => {
    const lexicon = buildMeetingLexicon({
      customEntries: [glossaryEntry("  ", ["real-term", "   "])],
      enabledPacks: null,
      learnset: {},
    });
    expect(lexicon.terms).toEqual(["real-term"]);
  });
});

// v0.5 Wave-1 Feature 8 (named custom dictionary packs, blueprint §1
// F8 + §5 A7) — the Wave-0 seam: buildMeetingLexicon's glossary tier
// consults glossary.ts's own pack registry directly (see lexicon.ts's
// header comment), since useMeeting.ts's live-session snapshot still
// passes the FULL customEntries list. Unique pack names per test —
// this file's module state (glossary.ts's pack registry) is NOT
// reset between tests (no vi.resetModules() here, unlike glossary.
// test.ts), so a name collision would spuriously throw.
describe("buildMeetingLexicon — pack-aware filtering (the Wave-0 seam, A7)", () => {
  it("excludes a disabled custom pack's entries from the glossary tier", async () => {
    const packs = await glossary.createCustomPack("Lexicon Pack A");
    const pack = packs.find((p) => p.name === "Lexicon Pack A")!;
    await glossary.setCustomPackEnabled(pack.id, false);

    const lexicon = buildMeetingLexicon({
      customEntries: [
        glossaryEntry("personal-term"),
        { ...glossaryEntry("disabled-term"), packId: pack.id },
      ],
      enabledPacks: null,
      learnset: {},
    });
    expect(lexicon.terms).toEqual(["personal-term"]);
  });

  it("includes an enabled non-personal custom pack's entries", async () => {
    const packs = await glossary.createCustomPack("Lexicon Pack B");
    const pack = packs.find((p) => p.name === "Lexicon Pack B")!;

    const lexicon = buildMeetingLexicon({
      customEntries: [{ ...glossaryEntry("enabled-term"), packId: pack.id }],
      enabledPacks: null,
      learnset: {},
    });
    expect(lexicon.terms).toEqual(["enabled-term"]);
  });
});

// ---------------------------------------------------------------
// Per-adapter projection
// ---------------------------------------------------------------

describe("projectForOsSpeechContextualJson (S11/Q11 discipline, generalized)", () => {
  it("returns null for an empty lexicon", () => {
    expect(projectForOsSpeechContextualJson({ terms: [] })).toBeNull();
  });

  it("emits a JSON-stringified array, priority order preserved (a prefix, never reordered)", () => {
    const result = projectForOsSpeechContextualJson({ terms: ["a", "b", "c"] });
    expect(JSON.parse(result!)).toEqual(["a", "b", "c"]);
  });

  it("caps at 100 terms, keeping the FIRST (highest-priority) 100 in order", () => {
    const terms = Array.from({ length: 150 }, (_, i) => `term-${i}`);
    const result = JSON.parse(projectForOsSpeechContextualJson({ terms })!);
    expect(result).toHaveLength(100);
    expect(result[0]).toBe("term-0");
    expect(result[99]).toBe("term-99");
  });

  it("caps at ~8KB of UTF-8-encoded JSON even under the 100-term cap (CJK-heavy list)", () => {
    const longWord = "测".repeat(170); // ~510 UTF-8 bytes/term — well under 100 terms hits 8KB first
    const terms = Array.from({ length: 50 }, (_, i) => `${longWord}${i}`);
    const result = projectForOsSpeechContextualJson({ terms })!;
    const parsed = JSON.parse(result);

    expect(parsed.length).toBeLessThan(50);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(8 * 1024);
  });
});

describe("projectForSonioxContext", () => {
  it("returns an empty array for an empty lexicon", () => {
    expect(projectForSonioxContext({ terms: [] })).toEqual([]);
  });

  it("returns a plain term array, priority order preserved (a prefix, never reordered)", () => {
    expect(projectForSonioxContext({ terms: ["a", "b", "c"] })).toEqual(["a", "b", "c"]);
  });

  it("caps at 100 terms, keeping the FIRST (highest-priority) 100 in order", () => {
    const terms = Array.from({ length: 150 }, (_, i) => `term-${i}`);
    const result = projectForSonioxContext({ terms });
    expect(result).toHaveLength(100);
    expect(result[0]).toBe("term-0");
    expect(result[99]).toBe("term-99");
  });

  it("caps well under Soniox's own verified ~10,000-char/~8,000-token context limit (conservative, Sol F10)", () => {
    const longWord = "测".repeat(170);
    const terms = Array.from({ length: 50 }, (_, i) => `${longWord}${i}`);
    const result = projectForSonioxContext({ terms });
    const encoded = new TextEncoder().encode(JSON.stringify(result));
    expect(encoded.length).toBeLessThanOrEqual(4 * 1024);
  });
});

describe("projectForInitialPrompt — D3 END-priority projection (Sol F14)", () => {
  it("returns undefined for an empty lexicon (the wire's own 'omit the field' value)", () => {
    expect(projectForInitialPrompt({ terms: [] })).toBeUndefined();
  });

  it("reverses priority order — the HIGHEST-priority term lands at the END of the emitted string", () => {
    // lexicon.terms is highest-priority-FIRST; faster-whisper's own
    // get_prompt() keeps the prompt's LAST 223 tokens, so the emitted
    // string must be highest-priority-LAST to survive that truncation.
    const prompt = projectForInitialPrompt({ terms: ["high", "mid", "low"] });
    expect(prompt).toBe("low, mid, high");
  });

  it("caps by count BEFORE reversing — a term cut by the cap never appears anywhere in the string", () => {
    const terms = Array.from({ length: 250 }, (_, i) => `t${i}`); // t0 = highest priority
    const prompt = projectForInitialPrompt({ terms })!;
    const emitted = prompt.split(", ");

    expect(emitted).toHaveLength(200); // WHISPER_PROMPT_MAX_TERMS
    // t0 (highest priority overall) survives the cap AND lands last —
    // the position that survives faster-whisper's own truncation.
    expect(emitted[emitted.length - 1]).toBe("t0");
    // t200..t249 never made it into the candidate prefix at all.
    expect(prompt).not.toContain("t249");
    expect(prompt).not.toContain("t200");
  });
});
