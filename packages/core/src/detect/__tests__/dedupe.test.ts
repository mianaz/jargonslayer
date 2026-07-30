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

  it("preserves and refreshes the observed surface without changing the canonical expression key", () => {
    const first = makeDetectResponse({
      expressions: [
        makeExpression({
          expression: "back-of-the-envelope",
          matched_surface: "back on the envelope calculation",
        }),
      ],
    });
    const created = mergeDetections([], [], first, "dictionary", 0.5, 1000);
    expect(created.cards[0].expression).toBe("back-of-the-envelope");
    expect(created.cards[0].matched_surface).toBe(
      "back on the envelope calculation",
    );

    const second = makeDetectResponse({
      expressions: [
        makeExpression({
          expression: "back-of-the-envelope",
          matched_surface: "back of the envelope estimate",
        }),
      ],
    });
    const updated = mergeDetections(
      created.cards,
      [],
      second,
      "dictionary",
      0.5,
      2000,
    );
    expect(updated.cards).toHaveLength(1);
    expect(updated.cards[0].normKey).toBe("back-of-the-envelope");
    expect(updated.cards[0].matched_surface).toBe(
      "back of the envelope estimate",
    );
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
  it("does not let a long LLM source sentence overwrite a compact dictionary context", () => {
    const existing: ExpressionCard[] = [
      {
        ...makeExpression({ source_sentence: "Let's circle back tomorrow." }),
        id: "dict-card-context",
        normKey: "circle back",
        firstSeenAt: 100,
        lastSeenAt: 100,
        count: 1,
        source: "dictionary",
      },
    ];
    const longLlmContext = "We spent the first part of the meeting walking through the customer feedback in detail and listing every concern the support team had heard this week, we need to circle back on the revised release plan with design tomorrow, and after that we will send the final notes to the launch team with every owner and due date confirmed before the end of the day";
    const res = makeDetectResponse({
      expressions: [makeExpression({ source_sentence: longLlmContext })],
    });

    const { cards } = mergeDetections(existing, [], res, "llm", 0.5, 200);

    expect(cards[0].source_sentence).toBe(
      "we need to circle back on the revised release plan with design tomorrow,",
    );
    expect(cards[0].source_sentence).toContain("circle back");
    expect(cards[0].source_sentence.length).toBeLessThan(longLlmContext.length);
  });

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

describe("mergeDetections — multi-sense terms (v0.6 T4)", () => {
  function sense(senseId: string, domain = "biomed", score = 0.5) {
    return { senseId, gloss_en: `gloss for ${senseId}`, gloss_zh: `释义 ${senseId}`, domain, score };
  }

  it("a new dictionary-sourced card carries senseId/senses/ambiguous straight through", () => {
    const res = makeDetectResponse({
      terms: [makeTerm({ senseId: "s1", senses: [sense("s1"), sense("s2")], ambiguous: true })],
    });
    const { terms } = mergeDetections([], [], res, "dictionary", 0.5, 1000);
    expect(terms).toHaveLength(1);
    expect(terms[0].senseId).toBe("s1");
    expect(terms[0].senses).toEqual([sense("s1"), sense("s2")]);
    expect(terms[0].ambiguous).toBe(true);
  });

  it("dictionary -> dictionary re-hit with the SAME senseId leaves glosses untouched (falls through to the plain bump path)", () => {
    const existingTerms: TermCard[] = [
      {
        ...makeTerm({ gloss_en: "original gloss", senseId: "s1", senses: [sense("s1")], ambiguous: false }),
        id: "term-1",
        normKey: "ARR",
        firstSeenAt: 1000,
        lastSeenAt: 1000,
        count: 1,
        source: "dictionary",
      },
    ];
    const res = makeDetectResponse({
      terms: [makeTerm({ gloss_en: "would-be new gloss", senseId: "s1", senses: [sense("s1")] })],
    });
    const { terms } = mergeDetections([], existingTerms, res, "dictionary", 0.5, 2000);
    expect(terms[0].gloss_en).toBe("original gloss"); // untouched — same senseId, no re-score to apply
    expect(terms[0].count).toBe(2); // still bumps normally
  });

  it("dictionary -> dictionary re-hit with a DIFFERENT senseId that clears AMBIGUOUS_MARGIN replaces glosses IN PLACE — same card, not a second one", () => {
    const existingTerms: TermCard[] = [
      {
        ...makeTerm({
          term: "EMT",
          type: "other",
          gloss_en: "ITK gene",
          gloss_zh: "ITK 基因",
          senseId: "itk",
          senses: [sense("itk", "biomed", 0.3)],
          ambiguous: false,
        }),
        id: "term-1",
        normKey: "EMT",
        firstSeenAt: 1000,
        lastSeenAt: 1000,
        count: 3,
        source: "dictionary",
      },
    ];
    const res = makeDetectResponse({
      terms: [
        makeTerm({
          term: "EMT",
          type: "acronym",
          gloss_en: "epithelial-mesenchymal transition",
          gloss_zh: "上皮间质转化",
          senseId: "emt",
          // MEDIUM-4 fix (v0.6 round-2 review): the new top score (0.8)
          // beats the card's OLD "itk" score (0.3) by 0.5 — well past
          // AMBIGUOUS_MARGIN (0.15), so the swap goes through. See the
          // sibling "insufficient margin" test below for the blocked case.
          senses: [sense("emt", "biomed", 0.8), sense("itk", "biomed", 0.3)],
          ambiguous: true,
        }),
      ],
    });
    const { terms } = mergeDetections([], existingTerms, res, "dictionary", 0.5, 5000);

    expect(terms).toHaveLength(1); // same card, not a second one for the same surface
    const term = terms[0];
    expect(term.id).toBe("term-1");
    expect(term.firstSeenAt).toBe(1000); // preserved
    expect(term.count).toBe(4); // still bumped
    expect(term.source).toBe("dictionary"); // NOT upgraded to llm
    expect(term.type).toBe("acronym");
    expect(term.gloss_en).toBe("epithelial-mesenchymal transition");
    expect(term.gloss_zh).toBe("上皮间质转化");
    expect(term.senseId).toBe("emt");
    expect(term.senses).toEqual([sense("emt", "biomed", 0.8), sense("itk", "biomed", 0.3)]);
    expect(term.ambiguous).toBe(true);
  });

  // MEDIUM-4 fix (v0.6 round-2 review): a margin now gates the swap —
  // without one, senseContext.ts's growing cooccurrence denominator lets
  // a card's meaning flip A->B->A as unrelated terms accumulate, which is
  // worse than staying wrong once. Fails against pre-fix dedupe.ts, which
  // swapped unconditionally on any senseId change.
  it("dictionary -> dictionary re-hit with a DIFFERENT senseId but an INSUFFICIENT score gap does NOT swap the winner", () => {
    const existingTerms: TermCard[] = [
      {
        ...makeTerm({
          gloss_en: "ITK gene",
          senseId: "itk",
          senses: [sense("itk", "biomed", 0.5)],
          ambiguous: false,
        }),
        id: "term-1",
        normKey: "ARR",
        firstSeenAt: 1000,
        lastSeenAt: 1000,
        count: 3,
        source: "dictionary",
      },
    ];
    const res = makeDetectResponse({
      terms: [
        makeTerm({
          gloss_en: "epithelial-mesenchymal transition",
          senseId: "emt",
          // Gap is exactly 0.10 — under AMBIGUOUS_MARGIN (0.15).
          senses: [sense("emt", "biomed", 0.6), sense("itk", "biomed", 0.5)],
          ambiguous: true,
        }),
      ],
    });
    const { terms } = mergeDetections([], existingTerms, res, "dictionary", 0.5, 5000);

    const term = terms[0];
    expect(term.count).toBe(4); // still bumps normally
    expect(term.senseId).toBe("itk"); // winner untouched
    expect(term.gloss_en).toBe("ITK gene"); // glosses untouched
    // S12 fix: the ranked snapshot/ambiguous flag itself DOES still
    // refresh even though the winner didn't move — see the dedicated
    // S12 test below for why that's a separate, always-on refresh.
    expect(term.senses).toEqual([sense("emt", "biomed", 0.6), sense("itk", "biomed", 0.5)]);
    expect(term.ambiguous).toBe(true);
  });

  // MEDIUM-4 fix — explicit oscillation scenario: the SAME two senses
  // trade the lead by a margin too thin to ever clear AMBIGUOUS_MARGIN,
  // across three consecutive re-hits (A, then B, then A again). The
  // card's WINNER must never move at all across this sequence — not
  // "ends up back on A after visibly flipping", genuinely never flips.
  it("A->B->A oscillation with a thin margin never actually swaps the winner across the whole sequence", () => {
    const existingTerms: TermCard[] = [
      {
        ...makeTerm({ gloss_en: "gloss A", senseId: "a", senses: [sense("a", "biomed", 0.52)], ambiguous: false }),
        id: "term-1",
        normKey: "ARR",
        firstSeenAt: 1000,
        lastSeenAt: 1000,
        count: 1,
        source: "dictionary",
      },
    ];

    const hitFor = (winner: "a" | "b") =>
      makeDetectResponse({
        terms: [
          makeTerm({
            gloss_en: `gloss ${winner.toUpperCase()}`,
            senseId: winner,
            // "b" edges out "a" by 0.05 (or vice versa) — always under
            // AMBIGUOUS_MARGIN (0.15), same shape a growing cooccurrence
            // denominator's own small nudges would actually produce.
            senses:
              winner === "b"
                ? [sense("b", "biomed", 0.57), sense("a", "biomed", 0.52)]
                : [sense("a", "biomed", 0.52), sense("b", "biomed", 0.47)],
            ambiguous: true,
          }),
        ],
      });

    let terms = existingTerms;
    ({ terms } = mergeDetections([], terms, hitFor("b"), "dictionary", 0.5, 2000));
    expect(terms[0].senseId).toBe("a"); // still A — "b"'s 0.05 edge never clears the margin
    ({ terms } = mergeDetections([], terms, hitFor("a"), "dictionary", 0.5, 3000));
    expect(terms[0].senseId).toBe("a");
    ({ terms } = mergeDetections([], terms, hitFor("b"), "dictionary", 0.5, 4000));
    expect(terms[0].senseId).toBe("a");

    expect(terms[0].gloss_en).toBe("gloss A"); // never touched across the whole sequence
    expect(terms[0].count).toBe(4);
  });

  // S12 fix (v0.6 round-2 review): dedupe.ts used to only refresh
  // senses/ambiguous when senseId ALSO changed — a context change that
  // shifts scores (or flips ambiguous) while the winner stays the same
  // left the OLD ranked snapshot on the card forever. Fails against
  // pre-fix dedupe.ts, where this assertion would still see the
  // original (stale) senses/ambiguous.
  it("same-winner re-hit still refreshes the ranked senses snapshot and ambiguous flag (S12 fix)", () => {
    const existingTerms: TermCard[] = [
      {
        ...makeTerm({
          gloss_en: "original gloss",
          senseId: "s1",
          senses: [sense("s1", "biomed", 0.5), sense("s2", "biomed", 0.2)],
          ambiguous: false,
        }),
        id: "term-1",
        normKey: "ARR",
        firstSeenAt: 1000,
        lastSeenAt: 1000,
        count: 1,
        source: "dictionary",
      },
    ];
    const res = makeDetectResponse({
      terms: [
        makeTerm({
          gloss_en: "would-be new gloss",
          senseId: "s1",
          // Same winner (s1), but the score gap has narrowed enough to
          // flip `ambiguous` true — a real context shift (e.g. a newly
          // inferred domain nudging s2 up) that must still show up.
          senses: [sense("s1", "biomed", 0.5), sense("s2", "biomed", 0.42)],
          ambiguous: true,
        }),
      ],
    });
    const { terms } = mergeDetections([], existingTerms, res, "dictionary", 0.5, 2000);

    expect(terms[0].senseId).toBe("s1");
    expect(terms[0].gloss_en).toBe("original gloss"); // identity fields untouched — winner never changed
    expect(terms[0].senses).toEqual([sense("s1", "biomed", 0.5), sense("s2", "biomed", 0.42)]); // refreshed
    expect(terms[0].ambiguous).toBe(true); // refreshed
  });

  it("dictionary -> llm upgrade CLEARS senses/ambiguous (the LLM's live judgement supersedes the heuristic)", () => {
    const existingTerms: TermCard[] = [
      {
        ...makeTerm({
          gloss_en: "old dict gloss",
          senseId: "s1",
          senses: [sense("s1"), sense("s2")],
          ambiguous: true,
        }),
        id: "term-1",
        normKey: "ARR",
        firstSeenAt: 1000,
        lastSeenAt: 1000,
        count: 1,
        source: "dictionary",
      },
    ];
    // An llm hit never carries senseId/senses/ambiguous at all.
    const res = makeDetectResponse({ terms: [makeTerm({ gloss_en: "llm gloss" })] });
    const { terms } = mergeDetections([], existingTerms, res, "llm", 0.5, 5000);

    expect(terms[0].source).toBe("llm");
    expect(terms[0].gloss_en).toBe("llm gloss");
    expect(terms[0].senses).toBeUndefined();
    expect(terms[0].ambiguous).toBeUndefined();
  });

  it("dictionary -> llm upgrade does NOT clear senseId (only senses/ambiguous, per spec) — inert once source has flipped to llm", () => {
    const existingTerms: TermCard[] = [
      {
        ...makeTerm({ senseId: "s1", senses: [sense("s1")], ambiguous: false }),
        id: "term-1",
        normKey: "ARR",
        firstSeenAt: 1000,
        lastSeenAt: 1000,
        count: 1,
        source: "dictionary",
      },
    ];
    const res = makeDetectResponse({ terms: [makeTerm({ gloss_en: "llm gloss" })] });
    const { terms } = mergeDetections([], existingTerms, res, "llm", 0.5, 5000);
    expect(terms[0].senseId).toBe("s1"); // left as-is — the dictionary->dictionary
    // branch above requires existing.source === "dictionary", which can
    // never be true again for this card once source has flipped to llm.
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
