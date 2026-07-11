import { describe, expect, it } from "vitest";
import {
  buildAnkiTSV,
  buildMarkdownReport,
  buildObsidianFrontmatter,
} from "../export";
import type { ExpressionCard, Flashcard, MeetingSession, TermCard } from "@jargonslayer/core/types";

function makeCard(overrides: Partial<ExpressionCard> = {}): ExpressionCard {
  return {
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
    lastSeenAt: 1000,
    count: 2,
    source: "llm",
    ...overrides,
  };
}

function makeTerm(overrides: Partial<TermCard> = {}): TermCard {
  return {
    id: "t1",
    term: "ARR",
    type: "metric",
    gloss_en: "Annual Recurring Revenue",
    gloss_zh: "年度经常性收入",
    normKey: "ARR",
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    count: 1,
    source: "llm",
    ...overrides,
  };
}

function makeSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
  return {
    id: "s1",
    title: "Weekly sync",
    startedAt: new Date("2026-01-15T09:00:00Z").getTime(),
    endedAt: new Date("2026-01-15T09:30:00Z").getTime(),
    engine: "demo",
    segments: [],
    cards: [],
    terms: [],
    ...overrides,
  };
}

describe("buildAnkiTSV — escaping", () => {
  it("replaces tab characters with a space in both front and back fields", () => {
    const cards: Flashcard[] = [
      {
        front: "circle\tback",
        back_zh: "回头\t再聊",
        back_en: "discuss\tagain",
        example: "an\texample",
        tags: [],
      },
    ];
    const tsv = buildAnkiTSV(cards);
    expect(tsv).not.toContain("\t\t"); // no literal tabs survive inside a field
    expect(tsv.split("\t")).toHaveLength(2); // exactly one column-separator tab
    expect(tsv).toBe("circle back\t回头 再聊<br>discuss again<br><i>an example</i>");
  });

  it("replaces newlines (both \\n and \\r\\n) with <br>", () => {
    const cards: Flashcard[] = [
      {
        front: "circle back",
        back_zh: "回头再聊\n第二行",
        back_en: "line one\r\nline two",
        example: "example",
        tags: [],
      },
    ];
    const tsv = buildAnkiTSV(cards);
    expect(tsv).toContain("回头再聊<br>第二行");
    expect(tsv).toContain("line one<br>line two");
    expect(tsv).not.toMatch(/\r|\n/);
  });

  it("joins back_zh/back_en/example with <br> separators and wraps example in <i>", () => {
    const cards: Flashcard[] = [
      { front: "ARR", back_zh: "年度经常性收入", back_en: "Annual Recurring Revenue", example: "Our ARR grew.", tags: [] },
    ];
    const tsv = buildAnkiTSV(cards);
    expect(tsv).toBe("ARR\t年度经常性收入<br>Annual Recurring Revenue<br><i>Our ARR grew.</i>");
  });

  it("joins multiple flashcards with newline-separated rows", () => {
    const cards: Flashcard[] = [
      { front: "a", back_zh: "1", back_en: "one", example: "ex1", tags: [] },
      { front: "b", back_zh: "2", back_en: "two", example: "ex2", tags: [] },
    ];
    const tsv = buildAnkiTSV(cards);
    expect(tsv.split("\n")).toHaveLength(2);
  });

  it("returns an empty string for zero flashcards", () => {
    expect(buildAnkiTSV([])).toBe("");
  });
});

describe("buildMarkdownReport — sections", () => {
  it("contains the session title as an H1", () => {
    const report = buildMarkdownReport(makeSession({ title: "My Big Meeting" }));
    expect(report).toContain("# My Big Meeting");
  });

  it("contains a 双语转录 (bilingual transcript) section", () => {
    const report = buildMarkdownReport(makeSession());
    expect(report).toContain("## 双语转录");
  });

  it("contains a 术语表 (glossary/terms table) section", () => {
    const report = buildMarkdownReport(makeSession({ terms: [makeTerm()] }));
    expect(report).toContain("## 术语表");
    expect(report).toContain("ARR");
  });

  it("contains a 表达学习卡片 (expression flashcards) section listing card fields", () => {
    const report = buildMarkdownReport(makeSession({ cards: [makeCard()] }));
    expect(report).toContain("## 表达学习卡片");
    expect(report).toContain("### circle back");
    expect(report).toContain("含义：revisit later");
    expect(report).toContain("出现 2 次");
  });

  it("includes translation quote lines aligned by segment index", () => {
    const session = makeSession({
      segments: [
        { id: "seg1", index: 0, startedAt: 1000, endedAt: 1500, text: "Hello everyone.", engine: "demo" },
        { id: "seg2", index: 1, startedAt: 1600, endedAt: 2000, text: "Let's start.", engine: "demo" },
      ],
      summary: {
        summary: { topic: { en: "", zh: "" }, key_points: [], decisions: [], action_items: [] },
        translations: [
          { index: 0, zh: "大家好。" },
          { index: 1, zh: "我们开始吧。" },
        ],
        flashcards: [],
        generatedAt: 1000,
        model: "test-model",
      },
    });
    const report = buildMarkdownReport(session);
    const lines = report.split("\n");

    const seg1TextIdx = lines.indexOf("Hello everyone.  ");
    expect(seg1TextIdx).toBeGreaterThanOrEqual(0);
    expect(lines[seg1TextIdx + 1]).toBe("> 大家好。");

    const seg2TextIdx = lines.indexOf("Let's start.  ");
    expect(seg2TextIdx).toBeGreaterThanOrEqual(0);
    expect(lines[seg2TextIdx + 1]).toBe("> 我们开始吧。");
  });

  it("omits a translation quote line when no translation exists for that segment index", () => {
    const session = makeSession({
      segments: [
        { id: "seg1", index: 0, startedAt: 1000, endedAt: 1500, text: "No translation for me.", engine: "demo" },
      ],
    });
    const report = buildMarkdownReport(session);
    expect(report).not.toContain("> ");
  });

  it("shows placeholder text for empty sections", () => {
    const report = buildMarkdownReport(makeSession());
    expect(report).toContain("（无转录内容）");
    expect(report).toContain("（无）"); // cards/terms placeholder(s)
  });
});

describe("buildObsidianFrontmatter — YAML", () => {
  it("escapes double quotes inside the title", () => {
    const fm = buildObsidianFrontmatter(makeSession({ title: 'The "Big" Meeting' }));
    expect(fm).toContain('title: "The \\"Big\\" Meeting"');
  });

  it("lists expressions from session.cards, one per YAML list item", () => {
    const fm = buildObsidianFrontmatter(
      makeSession({ cards: [makeCard({ expression: "circle back" }), makeCard({ id: "c2", expression: "touch base" })] }),
    );
    expect(fm).toContain("expressions:");
    expect(fm).toContain('  - "circle back"');
    expect(fm).toContain('  - "touch base"');
  });

  it("emits 'expressions: []' when there are no cards", () => {
    const fm = buildObsidianFrontmatter(makeSession());
    expect(fm).toContain("expressions: []");
  });

  it("emits 'terms: []' when there are no terms", () => {
    const fm = buildObsidianFrontmatter(makeSession());
    expect(fm).toContain("terms: []");
  });

  it("lists terms from session.terms", () => {
    const fm = buildObsidianFrontmatter(makeSession({ terms: [makeTerm({ term: "MRR" })] }));
    expect(fm).toContain("terms:");
    expect(fm).toContain('  - "MRR"');
  });

  it("includes source: jargonslayer", () => {
    const fm = buildObsidianFrontmatter(makeSession());
    expect(fm).toContain("source: jargonslayer");
  });

  it("includes schemaVersion: 1", () => {
    const fm = buildObsidianFrontmatter(makeSession());
    expect(fm).toContain("schemaVersion: 1");
  });

  it("wraps the whole block in --- delimiters", () => {
    const fm = buildObsidianFrontmatter(makeSession());
    const lines = fm.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[lines.length - 1]).toBe("---");
  });
});
