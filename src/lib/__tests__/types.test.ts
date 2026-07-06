import { describe, expect, it } from "vitest";
import {
  cardToCustomEntry,
  customEntrySurfaces,
  customEntryToExpression,
  sessionToMeta,
  termToCustomEntry,
  type CustomEntry,
  type ExpressionCard,
  type MeetingSession,
  type TermCard,
} from "../types";

function makeCustomEntry(overrides: Partial<CustomEntry> = {}): CustomEntry {
  return {
    id: "e1",
    kind: "expression",
    headword: "circle back",
    variants: ["circling back", "circle back"], // deliberate duplicate + trim-worthy input below
    chinese_explanation: "回头再聊",
    example: "Let's circle back later.",
    context: "",
    note: "",
    createdAt: 1000,
    updatedAt: 1000,
    source: "manual",
    ...overrides,
  };
}

describe("customEntrySurfaces — dedup/trim", () => {
  it("dedupes the headword against a variant that repeats it verbatim", () => {
    const surfaces = customEntrySurfaces(makeCustomEntry());
    // headword "circle back" appears once even though variants also list it.
    expect(surfaces.filter((s) => s === "circle back")).toHaveLength(1);
  });

  it("trims whitespace from headword and variants before dedup", () => {
    const entry = makeCustomEntry({ headword: "  circle back  ", variants: ["circle back", "  "] });
    const surfaces = customEntrySurfaces(entry);
    expect(surfaces).toContain("circle back");
    expect(surfaces).not.toContain("  circle back  ");
  });

  it("filters out empty-string variants entirely", () => {
    const entry = makeCustomEntry({ variants: ["", "   ", "touch base"] });
    const surfaces = customEntrySurfaces(entry);
    expect(surfaces).not.toContain("");
    expect(surfaces).toContain("touch base");
  });

  it("preserves distinct surfaces without collapsing case (dedup is exact-string, not case-insensitive)", () => {
    const entry = makeCustomEntry({ headword: "ARR", variants: ["arr"] });
    const surfaces = customEntrySurfaces(entry);
    expect(surfaces).toContain("ARR");
    expect(surfaces).toContain("arr");
    expect(surfaces).toHaveLength(2);
  });
});

describe("customEntryToExpression — sentence fallback chain (sentence -> context -> example)", () => {
  it("uses the provided sentence when non-empty", () => {
    const entry = makeCustomEntry({ context: "stored context", example: "stored example" });
    const result = customEntryToExpression(entry, "matched live sentence");
    expect(result.source_sentence).toBe("matched live sentence");
  });

  it("falls back to context when sentence is an empty string", () => {
    const entry = makeCustomEntry({ context: "stored context", example: "stored example" });
    const result = customEntryToExpression(entry, "");
    expect(result.source_sentence).toBe("stored context");
  });

  it("falls back to example when both sentence and context are empty", () => {
    const entry = makeCustomEntry({ context: "", example: "stored example" });
    const result = customEntryToExpression(entry, "");
    expect(result.source_sentence).toBe("stored example");
  });

  it("falls back category/meaning/plain_english/tone to sensible defaults when unset", () => {
    const entry = makeCustomEntry({
      category: undefined,
      meaning: undefined,
      plain_english: undefined,
      tone: undefined,
    });
    const result = customEntryToExpression(entry, "a sentence");
    expect(result.category).toBe("phrase");
    expect(result.meaning).toBe(entry.chinese_explanation); // meaning ?? chinese_explanation
    expect(result.plain_english).toBe(entry.headword); // plain_english ?? headword
    expect(result.tone).toBe("自定义词条");
    expect(result.confidence).toBe(1);
  });
});

describe("cardToCustomEntry — field mapping", () => {
  it("maps an ExpressionCard onto a CustomEntry with source 'session' and expression fields carried over", () => {
    const card: ExpressionCard = {
      id: "c1",
      expression: "circle back",
      category: "phrase",
      meaning: "revisit later",
      chinese_explanation: "回头再聊",
      plain_english: "discuss again later",
      tone: "neutral",
      confidence: 0.9,
      source_sentence: "Let's circle back on this.",
      normKey: "circle back",
      firstSeenAt: 1000,
      lastSeenAt: 2000,
      count: 3,
      source: "llm",
    };
    const entry = cardToCustomEntry(card);

    expect(entry.kind).toBe("expression");
    expect(entry.headword).toBe("circle back");
    expect(entry.variants).toEqual([]);
    expect(entry.chinese_explanation).toBe("回头再聊");
    expect(entry.example).toBe("");
    expect(entry.context).toBe("Let's circle back on this."); // context <- source_sentence
    expect(entry.note).toBe("");
    expect(entry.source).toBe("session");
    expect(entry.category).toBe("phrase");
    expect(entry.meaning).toBe("revisit later");
    expect(entry.plain_english).toBe("discuss again later");
    expect(entry.tone).toBe("neutral");
    expect(entry.mastered).toBe(false);
    expect(entry.reviewCount).toBe(0);
    expect(typeof entry.id).toBe("string");
    expect(entry.id).not.toBe(card.id); // gets a fresh id, not the card's id
    expect(entry.createdAt).toBe(entry.updatedAt); // stamped together at creation
  });
});

describe("termToCustomEntry — field mapping", () => {
  it("maps a TermCard onto a CustomEntry with source 'session' and term fields carried over", () => {
    const term: TermCard = {
      id: "t1",
      term: "ARR",
      type: "metric",
      gloss_en: "Annual Recurring Revenue",
      gloss_zh: "年度经常性收入",
      normKey: "ARR",
      firstSeenAt: 1000,
      lastSeenAt: 2000,
      count: 1,
      source: "llm",
    };
    const entry = termToCustomEntry(term);

    expect(entry.kind).toBe("term");
    expect(entry.headword).toBe("ARR");
    expect(entry.variants).toEqual([]);
    expect(entry.chinese_explanation).toBe("年度经常性收入"); // <- gloss_zh
    expect(entry.context).toBe("");
    expect(entry.source).toBe("session");
    expect(entry.termType).toBe("metric");
    expect(entry.gloss_en).toBe("Annual Recurring Revenue");
    expect(entry.mastered).toBe(false);
    expect(entry.reviewCount).toBe(0);
    expect(entry.id).not.toBe(term.id);
  });
});

describe("sessionToMeta — counts", () => {
  it("counts segments/cards/terms and reflects hasSummary correctly", () => {
    const session: MeetingSession = {
      id: "s1",
      title: "Weekly sync",
      startedAt: 1000,
      endedAt: 2000,
      engine: "demo",
      segments: [
        { id: "seg1", index: 0, startedAt: 1000, endedAt: 1100, text: "hi", engine: "demo" },
        { id: "seg2", index: 1, startedAt: 1100, endedAt: 1200, text: "bye", engine: "demo" },
      ],
      cards: [
        {
          id: "c1",
          expression: "circle back",
          category: "phrase",
          meaning: "m",
          chinese_explanation: "z",
          plain_english: "p",
          tone: "t",
          confidence: 0.9,
          source_sentence: "s",
          normKey: "circle back",
          firstSeenAt: 1000,
          lastSeenAt: 1000,
          count: 1,
          source: "llm",
        },
      ],
      terms: [],
    };

    const meta = sessionToMeta(session);
    expect(meta.segmentCount).toBe(2);
    expect(meta.cardCount).toBe(1);
    expect(meta.termCount).toBe(0);
    expect(meta.hasSummary).toBe(false);
    expect(meta.id).toBe("s1");
    expect(meta.title).toBe("Weekly sync");
    expect(meta.startedAt).toBe(1000);
    expect(meta.endedAt).toBe(2000);
  });

  it("hasSummary is true when session.summary is present", () => {
    const session: MeetingSession = {
      id: "s1",
      title: "t",
      startedAt: 0,
      endedAt: 0,
      engine: "demo",
      segments: [],
      cards: [],
      terms: [],
      summary: {
        summary: { topic: { en: "", zh: "" }, key_points: [], decisions: [], action_items: [] },
        translations: [],
        flashcards: [],
        generatedAt: 0,
        model: "m",
      },
    };
    expect(sessionToMeta(session).hasSummary).toBe(true);
  });
});
