import { describe, expect, it } from "vitest";
import { EXPRESSION_TTL_MS, mergeDetections, normalizeKey } from "../dedupe";
import type { DetectResponse, ExpressionCard, TermCard } from "../../types";

function makeDetectResponse(overrides: Partial<DetectResponse> = {}): DetectResponse {
  return {
    expressions: [],
    terms: [],
    ...overrides,
  };
}

function makeExpression(overrides: Partial<DetectResponse["expressions"][number]> = {}) {
  return {
    expression: "circle back",
    category: "phrase" as const,
    meaning: "revisit later",
    chinese_explanation: "回头再聊",
    plain_english: "discuss again later",
    tone: "neutral",
    confidence: 0.9,
    source_sentence: "Let's circle back on this.",
    ...overrides,
  };
}

function makeTerm(overrides: Partial<DetectResponse["terms"][number]> = {}) {
  return {
    term: "ARR",
    type: "metric" as const,
    gloss_en: "Annual Recurring Revenue",
    gloss_zh: "年度经常性收入",
    ...overrides,
  };
}

describe("normalizeKey", () => {
  it("lowercases, trims, collapses whitespace, strips edge punctuation", () => {
    expect(normalizeKey("  Circle   Back!  ")).toBe("circle back");
    expect(normalizeKey("...Hello, World...")).toBe("hello, world");
  });
});

describe("mergeDetections — new card creation", () => {
  it("creates a new ExpressionCard with all expected fields", () => {
    const now = 1_000_000;
    const res = makeDetectResponse({ expressions: [makeExpression()] });
    const { cards } = mergeDetections([], [], res, "llm", 0.5, now);

    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.expression).toBe("circle back");
    expect(card.category).toBe("phrase");
    expect(card.meaning).toBe("revisit later");
    expect(card.chinese_explanation).toBe("回头再聊");
    expect(card.plain_english).toBe("discuss again later");
    expect(card.tone).toBe("neutral");
    expect(card.confidence).toBe(0.9);
    expect(card.source_sentence).toBe("Let's circle back on this.");
    expect(card.normKey).toBe("circle back");
    expect(card.firstSeenAt).toBe(now);
    expect(card.lastSeenAt).toBe(now);
    expect(card.count).toBe(1);
    expect(card.source).toBe("llm");
    expect(typeof card.id).toBe("string");
    expect(card.id.length).toBeGreaterThan(0);
  });

  it("creates a new TermCard with all expected fields", () => {
    const now = 2_000_000;
    const res = makeDetectResponse({ terms: [makeTerm()] });
    const { terms } = mergeDetections([], [], res, "dictionary", 0.5, now);

    expect(terms).toHaveLength(1);
    const term = terms[0];
    expect(term.term).toBe("ARR");
    expect(term.type).toBe("metric");
    expect(term.gloss_en).toBe("Annual Recurring Revenue");
    expect(term.gloss_zh).toBe("年度经常性收入");
    expect(term.normKey).toBe("ARR");
    expect(term.firstSeenAt).toBe(now);
    expect(term.lastSeenAt).toBe(now);
    expect(term.count).toBe(1);
    expect(term.source).toBe("dictionary");
  });

  it("normKey for 'raised eyebrows' and 'raise eyebrow' forms — AS IMPLEMENTED they do NOT collide", () => {
    // Only the LAST word of a multi-word phrase gets its trailing
    // ing/ed/es/s/d suffix stripped (>4 chars, stripped len >=2).
    // "raised eyebrows" -> last word "eyebrows" (8 chars) strips
    // trailing "s" -> "eyebrow", giving normKey "raised eyebrow".
    // "raise eyebrow" -> last word "eyebrow" (7 chars) has no
    // ing/ed/es/s/d suffix to strip, so it is untouched -> normKey
    // "raise eyebrow". The FIRST word ("raised" vs "raise") is never
    // touched, so these two surface forms produce DIFFERENT keys and
    // create two separate cards, despite reading as the same idiom.
    const now = 1_000;
    const res = makeDetectResponse({
      expressions: [
        makeExpression({ expression: "raised eyebrows", source_sentence: "That raised eyebrows." }),
        makeExpression({ expression: "raise eyebrow", source_sentence: "It might raise eyebrow." }),
      ],
    });
    const { cards } = mergeDetections([], [], res, "llm", 0.5, now);
    expect(cards).toHaveLength(2);
    const keys = cards.map((c) => c.normKey).sort();
    expect(keys).toEqual(["raise eyebrow", "raised eyebrow"]);
  });

  it("normKey DOES collide for 'raise eyebrows' and 'raise eyebrow' (identical first word)", () => {
    const now = 1_000;
    const res = makeDetectResponse({
      expressions: [
        makeExpression({ expression: "raise eyebrows", source_sentence: "This will raise eyebrows." }),
        makeExpression({ expression: "raise eyebrow", source_sentence: "It might raise eyebrow." }),
      ],
    });
    const { cards } = mergeDetections([], [], res, "llm", 0.5, now);
    expect(cards).toHaveLength(1);
    expect(cards[0].normKey).toBe("raise eyebrow");
    expect(cards[0].count).toBe(2);
  });

  it("keeps 'circling back' and 'circle back' as distinct keys (last-word-only lemma, by design)", () => {
    const now = 1_000;
    const res = makeDetectResponse({
      expressions: [
        makeExpression({ expression: "circling back", source_sentence: "We are circling back." }),
        makeExpression({ expression: "circle back", source_sentence: "Let's circle back." }),
      ],
    });
    const { cards } = mergeDetections([], [], res, "llm", 0.5, now);
    expect(cards).toHaveLength(2);
    const keys = cards.map((c) => c.normKey).sort();
    expect(keys).toEqual(["circle back", "circling back"]);
  });
});

describe("mergeDetections — count bump within TTL / lastSeenAt update", () => {
  it("bumps count and updates lastSeenAt on the existing card for a repeat within TTL", () => {
    const firstSeen = 1_000_000;
    const existing: ExpressionCard[] = [
      {
        ...makeExpression(),
        id: "card-1",
        normKey: "circle back",
        firstSeenAt: firstSeen,
        lastSeenAt: firstSeen,
        count: 1,
        source: "llm",
      },
    ];
    const now = firstSeen + 60_000; // well within EXPRESSION_TTL_MS
    const res = makeDetectResponse({ expressions: [makeExpression()] });
    const { cards } = mergeDetections(existing, [], res, "llm", 0.5, now);

    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("card-1");
    expect(cards[0].count).toBe(2);
    expect(cards[0].firstSeenAt).toBe(firstSeen); // untouched
    expect(cards[0].lastSeenAt).toBe(now);
  });

  it("also just bumps (no new card) when the repeat is OLDER than TTL", () => {
    const firstSeen = 1_000_000;
    const existing: ExpressionCard[] = [
      {
        ...makeExpression(),
        id: "card-1",
        normKey: "circle back",
        firstSeenAt: firstSeen,
        lastSeenAt: firstSeen,
        count: 1,
        source: "llm",
      },
    ];
    const now = firstSeen + EXPRESSION_TTL_MS + 1; // past TTL
    const res = makeDetectResponse({ expressions: [makeExpression()] });
    const { cards } = mergeDetections(existing, [], res, "llm", 0.5, now);

    expect(cards).toHaveLength(1); // cards unique per session, never duplicated
    expect(cards[0].id).toBe("card-1");
    expect(cards[0].count).toBe(2);
    expect(cards[0].lastSeenAt).toBe(now);
  });

  it("bumps a TermCard's count and lastSeenAt on repeat", () => {
    const firstSeen = 5_000;
    const existingTerms: TermCard[] = [
      {
        ...makeTerm(),
        id: "term-1",
        normKey: "ARR",
        firstSeenAt: firstSeen,
        lastSeenAt: firstSeen,
        count: 1,
        source: "llm",
      },
    ];
    const now = firstSeen + 1_000;
    const res = makeDetectResponse({ terms: [makeTerm()] });
    const { terms } = mergeDetections([], existingTerms, res, "llm", 0.5, now);

    expect(terms).toHaveLength(1);
    expect(terms[0].id).toBe("term-1");
    expect(terms[0].count).toBe(2);
    expect(terms[0].lastSeenAt).toBe(now);
  });
});

describe("mergeDetections — minConfidence filtering", () => {
  it("drops expressions with confidence below minConfidence", () => {
    const res = makeDetectResponse({
      expressions: [
        makeExpression({ expression: "low conf", confidence: 0.3 }),
        makeExpression({ expression: "high conf", confidence: 0.8 }),
      ],
    });
    const { cards } = mergeDetections([], [], res, "llm", 0.5, 1000);
    expect(cards).toHaveLength(1);
    expect(cards[0].expression).toBe("high conf");
  });

  it("keeps an expression exactly AT minConfidence (strict < comparison)", () => {
    const res = makeDetectResponse({
      expressions: [makeExpression({ expression: "at threshold", confidence: 0.5 })],
    });
    const { cards } = mergeDetections([], [], res, "llm", 0.5, 1000);
    expect(cards).toHaveLength(1);
  });

  it("minConfidence filtering does not apply to terms (no confidence field on terms)", () => {
    const res = makeDetectResponse({ terms: [makeTerm()] });
    const { terms } = mergeDetections([], [], res, "llm", 0.99, 1000);
    expect(terms).toHaveLength(1);
  });
});

describe("mergeDetections — dictionary -> llm content upgrade", () => {
  it("upgrades an existing dictionary ExpressionCard's fields when an llm hit lands, preserving count/id/normKey/firstSeenAt", () => {
    const firstSeen = 10_000;
    const existing: ExpressionCard[] = [
      {
        expression: "circle back",
        category: "phrase",
        meaning: "old dictionary meaning",
        chinese_explanation: "旧的字典解释",
        plain_english: "old plain english",
        tone: "old tone",
        confidence: 0.7,
        source_sentence: "old sentence",
        id: "dict-card-1",
        normKey: "circle back",
        firstSeenAt: firstSeen,
        lastSeenAt: firstSeen,
        count: 3,
        source: "dictionary",
      },
    ];
    const now = firstSeen + 1000;
    const res = makeDetectResponse({
      expressions: [
        makeExpression({
          category: "idiom",
          meaning: "new llm meaning",
          chinese_explanation: "新的 llm 解释",
          plain_english: "new plain english",
          tone: "new tone",
          confidence: 0.95,
          source_sentence: "new live sentence",
        }),
      ],
    });
    const { cards } = mergeDetections(existing, [], res, "llm", 0.5, now);

    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.id).toBe("dict-card-1"); // same card, not replaced
    expect(card.normKey).toBe("circle back");
    expect(card.firstSeenAt).toBe(firstSeen); // preserved
    expect(card.count).toBe(4); // preserved + bumped (3 -> 4)
    expect(card.lastSeenAt).toBe(now);
    expect(card.source).toBe("llm"); // upgraded
    expect(card.category).toBe("idiom");
    expect(card.meaning).toBe("new llm meaning");
    expect(card.chinese_explanation).toBe("新的 llm 解释");
    expect(card.plain_english).toBe("new plain english");
    expect(card.tone).toBe("new tone");
    expect(card.confidence).toBe(0.95);
    expect(card.source_sentence).toBe("new live sentence");
  });

  it("upgrades an existing dictionary TermCard's fields when an llm hit lands, preserving count", () => {
    const firstSeen = 20_000;
    const existingTerms: TermCard[] = [
      {
        term: "ARR",
        type: "other",
        gloss_en: "old gloss",
        gloss_zh: "旧释义",
        id: "dict-term-1",
        normKey: "ARR",
        firstSeenAt: firstSeen,
        lastSeenAt: firstSeen,
        count: 2,
        source: "dictionary",
      },
    ];
    const now = firstSeen + 500;
    const res = makeDetectResponse({
      terms: [makeTerm({ type: "metric", gloss_en: "new gloss", gloss_zh: "新释义" })],
    });
    const { terms } = mergeDetections([], existingTerms, res, "llm", 0.5, now);

    expect(terms).toHaveLength(1);
    const term = terms[0];
    expect(term.id).toBe("dict-term-1");
    expect(term.count).toBe(3); // preserved + bumped
    expect(term.source).toBe("llm");
    expect(term.type).toBe("metric");
    expect(term.gloss_en).toBe("new gloss");
    expect(term.gloss_zh).toBe("新释义");
  });

  it("does NOT upgrade a dictionary card on a repeat dictionary hit (source stays dictionary)", () => {
    const existing: ExpressionCard[] = [
      {
        ...makeExpression(),
        id: "dict-card-1",
        normKey: "circle back",
        firstSeenAt: 1000,
        lastSeenAt: 1000,
        count: 1,
        source: "dictionary",
      },
    ];
    const res = makeDetectResponse({ expressions: [makeExpression({ meaning: "second dict meaning" })] });
    const { cards } = mergeDetections(existing, [], res, "dictionary", 0.5, 2000);
    expect(cards[0].source).toBe("dictionary");
    expect(cards[0].meaning).toBe("revisit later"); // original field, not overwritten
    expect(cards[0].count).toBe(2);
  });

  it("does NOT downgrade an llm card when a later dictionary hit lands on the same key", () => {
    const existing: ExpressionCard[] = [
      {
        ...makeExpression({ meaning: "llm meaning" }),
        id: "llm-card-1",
        normKey: "circle back",
        firstSeenAt: 1000,
        lastSeenAt: 1000,
        count: 1,
        source: "llm",
      },
    ];
    const res = makeDetectResponse({ expressions: [makeExpression({ meaning: "dict meaning" })] });
    const { cards } = mergeDetections(existing, [], res, "dictionary", 0.5, 2000);
    expect(cards[0].source).toBe("llm");
    expect(cards[0].meaning).toBe("llm meaning");
    expect(cards[0].count).toBe(2);
  });
});

describe("mergeDetections — custom-source protection", () => {
  it("a later llm hit on a custom expression normKey mutates NOTHING (zero mutation)", () => {
    const customCard: ExpressionCard = {
      ...makeExpression({ meaning: "my own curated meaning" }),
      id: "custom-card-1",
      normKey: "circle back",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      count: 5,
      source: "custom",
    };
    const existing: ExpressionCard[] = [customCard];
    const res = makeDetectResponse({ expressions: [makeExpression({ meaning: "llm would-be meaning" })] });
    const { cards } = mergeDetections(existing, [], res, "llm", 0.5, 2000);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual(customCard); // completely untouched, incl. count/lastSeenAt
  });

  it("a later dictionary hit on a custom expression normKey mutates NOTHING", () => {
    const customCard: ExpressionCard = {
      ...makeExpression(),
      id: "custom-card-1",
      normKey: "circle back",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      count: 5,
      source: "custom",
    };
    const existing: ExpressionCard[] = [customCard];
    const res = makeDetectResponse({ expressions: [makeExpression()] });
    const { cards } = mergeDetections(existing, [], res, "dictionary", 0.5, 2000);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual(customCard);
  });

  it("a later custom hit on a custom expression normKey IS allowed to bump (source === source)", () => {
    const customCard: ExpressionCard = {
      ...makeExpression(),
      id: "custom-card-1",
      normKey: "circle back",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      count: 5,
      source: "custom",
    };
    const existing: ExpressionCard[] = [customCard];
    const res = makeDetectResponse({ expressions: [makeExpression()] });
    const { cards } = mergeDetections(existing, [], res, "custom", 0.5, 2000);

    expect(cards[0].count).toBe(6);
    expect(cards[0].lastSeenAt).toBe(2000);
    expect(cards[0].source).toBe("custom");
  });

  it("custom-source protection applies identically to TermCards", () => {
    const customTerm: TermCard = {
      ...makeTerm(),
      id: "custom-term-1",
      normKey: "ARR",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      count: 2,
      source: "custom",
    };
    const existingTerms: TermCard[] = [customTerm];
    const res = makeDetectResponse({ terms: [makeTerm({ gloss_en: "llm gloss" })] });
    const { terms } = mergeDetections([], existingTerms, res, "llm", 0.5, 2000);

    expect(terms).toHaveLength(1);
    expect(terms[0]).toEqual(customTerm);
  });
});

describe("mergeDetections — term whole-session dedup + acronym uppercase keying", () => {
  it("always bumps a repeated term across the whole session, never duplicating", () => {
    const existingTerms: TermCard[] = [
      { ...makeTerm(), id: "t1", normKey: "ARR", firstSeenAt: 1000, lastSeenAt: 1000, count: 1, source: "llm" },
    ];
    const res = makeDetectResponse({ terms: [makeTerm(), makeTerm()] }); // two hits in one batch
    const { terms } = mergeDetections([], existingTerms, res, "llm", 0.5, 2000);
    expect(terms).toHaveLength(1);
    expect(terms[0].count).toBe(3); // 1 existing + 2 incoming, no duplicate row
  });

  it("short (<=6 char) all-letter terms are uppercased as an acronym key", () => {
    const res = makeDetectResponse({
      terms: [makeTerm({ term: "arr" }), makeTerm({ term: "Arr" }), makeTerm({ term: "ARR" })],
    });
    const { terms } = mergeDetections([], [], res, "llm", 0.5, 1000);
    expect(terms).toHaveLength(1);
    expect(terms[0].normKey).toBe("ARR");
    expect(terms[0].count).toBe(3);
  });

  it("terms longer than 6 chars are lowercased, not uppercased, even if all-letters", () => {
    // "Runways" is 7 letters (>6), so it falls into the lowercase
    // branch rather than the <=6-char acronym-uppercase branch.
    const res = makeDetectResponse({
      terms: [makeTerm({ term: "Runways" }), makeTerm({ term: "runways" })],
    });
    const { terms } = mergeDetections([], [], res, "llm", 0.5, 1000);
    expect(terms).toHaveLength(1);
    expect(terms[0].normKey).toBe("runways");
  });

  it("a 6-char all-letter term (boundary: <=6) is STILL treated as an acronym and uppercased", () => {
    const res = makeDetectResponse({
      terms: [makeTerm({ term: "Runway" }), makeTerm({ term: "runway" })],
    });
    const { terms } = mergeDetections([], [], res, "llm", 0.5, 1000);
    expect(terms).toHaveLength(1);
    expect(terms[0].normKey).toBe("RUNWAY");
  });

  it("terms with non-letter characters (e.g. 'P&L') are lowercased regardless of length", () => {
    const res = makeDetectResponse({
      terms: [makeTerm({ term: "P&L" }), makeTerm({ term: "p&l" })],
    });
    const { terms } = mergeDetections([], [], res, "llm", 0.5, 1000);
    expect(terms).toHaveLength(1);
    expect(terms[0].normKey).toBe("p&l");
  });

  it("term keys are trimmed but not whitespace-collapsed", () => {
    const res = makeDetectResponse({ terms: [makeTerm({ term: "  ARR  " })] });
    const { terms } = mergeDetections([], [], res, "llm", 0.5, 1000);
    expect(terms[0].normKey).toBe("ARR");
  });
});

describe("mergeDetections — immutability", () => {
  it("does not mutate the input existingCards/existingTerms arrays or their card objects", () => {
    const originalCard: ExpressionCard = {
      ...makeExpression(),
      id: "card-1",
      normKey: "circle back",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      count: 1,
      source: "llm",
    };
    const originalTerm: TermCard = {
      ...makeTerm(),
      id: "term-1",
      normKey: "ARR",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      count: 1,
      source: "llm",
    };
    const existingCards = [originalCard];
    const existingTerms = [originalTerm];
    const existingCardsSnapshot = JSON.parse(JSON.stringify(existingCards));
    const existingTermsSnapshot = JSON.parse(JSON.stringify(existingTerms));

    const res = makeDetectResponse({ expressions: [makeExpression()], terms: [makeTerm()] });
    mergeDetections(existingCards, existingTerms, res, "llm", 0.5, 5000);

    expect(existingCards).toEqual(existingCardsSnapshot);
    expect(existingTerms).toEqual(existingTermsSnapshot);
    // The original object identity itself must be untouched too.
    expect(originalCard.count).toBe(1);
    expect(originalCard.lastSeenAt).toBe(1000);
    expect(originalTerm.count).toBe(1);
    expect(originalTerm.lastSeenAt).toBe(1000);
  });

  it("returns NEW array instances, not the same references as the inputs", () => {
    const existingCards: ExpressionCard[] = [];
    const existingTerms: TermCard[] = [];
    const res = makeDetectResponse();
    const { cards, terms } = mergeDetections(existingCards, existingTerms, res, "llm", 0.5, 1000);

    expect(cards).not.toBe(existingCards);
    expect(terms).not.toBe(existingTerms);
  });

  it("returns a new array instance even when nothing changed content-wise", () => {
    const card: ExpressionCard = {
      ...makeExpression(),
      id: "card-1",
      normKey: "circle back",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      count: 1,
      source: "llm",
    };
    const existingCards = [card];
    const res = makeDetectResponse(); // no incoming detections at all
    const { cards } = mergeDetections(existingCards, [], res, "llm", 0.5, 1000);

    expect(cards).not.toBe(existingCards);
    expect(cards).toHaveLength(1);
    expect(cards[0]).not.toBe(card); // per-card shallow copy too
    expect(cards[0]).toEqual(card);
  });
});

describe("mergeDetections — #54 floor count dedup (llmCountSuppressSince)", () => {
  function dictCard(overrides: Partial<ExpressionCard> = {}): ExpressionCard {
    return {
      ...makeExpression({ meaning: "dict meaning" }),
      id: "card-dict",
      normKey: "circle back",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      count: 1,
      source: "dictionary",
      lastDictSeenAt: 1000,
      ...overrides,
    };
  }

  it("dictionary merges stamp lastDictSeenAt on create and on bump", () => {
    const res = makeDetectResponse({ expressions: [makeExpression()] });
    const { cards } = mergeDetections([], [], res, "dictionary", 0.5, 5000);
    expect(cards[0].lastDictSeenAt).toBe(5000);

    const { cards: cards2 } = mergeDetections(cards, [], res, "dictionary", 0.5, 9000);
    expect(cards2[0].lastDictSeenAt).toBe(9000);
    expect(cards2[0].count).toBe(2);
  });

  it("llm/custom-born cards have NO lastDictSeenAt", () => {
    const res = makeDetectResponse({ expressions: [makeExpression()] });
    const { cards } = mergeDetections([], [], res, "llm", 0.5, 5000);
    expect(cards[0].lastDictSeenAt).toBeUndefined();
  });

  it("suppresses the llm count bump when the floor already counted this occurrence (lastDictSeenAt >= suppressSince) — content upgrade still applies", () => {
    // Floor counted at t=2000; the llm batch began accumulating at t=1500.
    const existing = [dictCard({ lastDictSeenAt: 2000, lastSeenAt: 2000 })];
    const res = makeDetectResponse({
      expressions: [makeExpression({ meaning: "llm meaning" })],
    });
    const { cards } = mergeDetections(existing, [], res, "llm", 0.5, 25_000, {
      llmCountSuppressSince: 1500,
    });

    expect(cards[0].count).toBe(1); // NOT double counted
    expect(cards[0].lastSeenAt).toBe(25_000); // freshness still updated
    expect(cards[0].meaning).toBe("llm meaning"); // upgrade-in-place still happened
    expect(cards[0].source).toBe("llm");
  });

  it("does NOT suppress when the dictionary sighting predates the batch window (a genuinely new llm-only occurrence)", () => {
    const existing = [dictCard({ lastDictSeenAt: 1000 })];
    const res = makeDetectResponse({ expressions: [makeExpression()] });
    const { cards } = mergeDetections(existing, [], res, "llm", 0.5, 25_000, {
      llmCountSuppressSince: 20_000,
    });
    expect(cards[0].count).toBe(2);
  });

  it("never suppresses cards the dictionary has never seen (llm-only expressions keep counting per batch)", () => {
    const llmCard: ExpressionCard = {
      ...makeExpression({ expression: "boil the ocean" }),
      id: "card-llm",
      normKey: "boil the ocean",
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      count: 1,
      source: "llm",
    };
    const res = makeDetectResponse({
      expressions: [makeExpression({ expression: "boil the ocean" })],
    });
    const { cards } = mergeDetections([llmCard], [], res, "llm", 0.5, 25_000, {
      llmCountSuppressSince: 0,
    });
    expect(cards[0].count).toBe(2);
  });

  it("without opts (dictionary merges, popover lookups, imports) behavior is unchanged — always bumps", () => {
    const existing = [dictCard({ lastDictSeenAt: 2000 })];
    const res = makeDetectResponse({ expressions: [makeExpression()] });
    const { cards } = mergeDetections(existing, [], res, "llm", 0.5, 25_000);
    expect(cards[0].count).toBe(2);
  });

  it("suppression applies to terms symmetrically", () => {
    const dictTerm: TermCard = {
      ...makeTerm(),
      id: "term-dict",
      normKey: "ARR",
      firstSeenAt: 1000,
      lastSeenAt: 2000,
      count: 1,
      source: "dictionary",
      lastDictSeenAt: 2000,
    };
    const res = makeDetectResponse({ terms: [makeTerm({ gloss_en: "upgraded" })] });
    const { terms } = mergeDetections([], [dictTerm], res, "llm", 0.5, 25_000, {
      llmCountSuppressSince: 1500,
    });
    expect(terms[0].count).toBe(1);
    expect(terms[0].gloss_en).toBe("upgraded");
    expect(terms[0].source).toBe("llm");
  });
});
