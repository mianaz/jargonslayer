import { describe, expect, it } from "vitest";
import { buildCornellModel, cornellToMarkdown, type CornellInput } from "../cornell";
import type { ExpressionCard, MeetingSummary, TermCard, TranscriptSegment } from "../types";

function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "seg1",
    index: 0,
    startedAt: 1000,
    endedAt: 1500,
    text: "Let's circle back on this later.",
    engine: "demo",
    ...overrides,
  };
}

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
    source_sentence: "Let's circle back on this later.",
    normKey: "circle back",
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    count: 1,
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

function makeSummary(overrides: Partial<MeetingSummary> = {}): MeetingSummary {
  return {
    topic: { en: "Weekly sync", zh: "周会" },
    key_points: [{ en: "Ship on Friday", zh: "周五上线" }],
    decisions: [],
    action_items: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<CornellInput> = {}): CornellInput {
  return {
    title: "会议 2026-01-15",
    date: new Date("2026-01-15T09:00:00Z").getTime(),
    segments: [makeSegment()],
    cards: [makeCard()],
    terms: [],
    ...overrides,
  };
}

describe("buildCornellModel — empty guard", () => {
  it("returns empty: true when there are no segments at all", () => {
    const model = buildCornellModel(makeInput({ segments: [], cards: [], terms: [] }));
    expect(model.empty).toBe(true);
    expect(model.segments).toHaveLength(0);
    expect(model.annotations).toHaveLength(0);
  });

  it("is not empty when segments exist even with zero cards/terms (plain runs only)", () => {
    const model = buildCornellModel(makeInput({ cards: [], terms: [] }));
    expect(model.empty).toBe(false);
    expect(model.segments).toHaveLength(1);
    expect(model.annotations).toHaveLength(0);
    // The whole segment text survives as a single plain run.
    expect(model.segments[0].runs).toEqual([{ text: "Let's circle back on this later." }]);
  });
});

describe("buildCornellModel — matching", () => {
  it("highlights a case-insensitive match of a card expression", () => {
    const model = buildCornellModel(
      makeInput({
        segments: [makeSegment({ text: "Let's CIRCLE BACK on this." })],
      }),
    );
    const highlighted = model.segments[0].runs.filter((r) => r.ref !== undefined);
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0].text).toBe("CIRCLE BACK");
  });

  it("highlights a term name alongside expressions", () => {
    const model = buildCornellModel(
      makeInput({
        segments: [makeSegment({ text: "Our ARR grew and we should circle back." })],
        terms: [makeTerm()],
      }),
    );
    const kinds = model.annotations.map((a) => a.kind).sort();
    expect(kinds).toEqual(["expression", "term"]);
  });

  it("matches an inflected form of the last word only (circle back -> circle backed)", () => {
    const model = buildCornellModel(
      makeInput({
        segments: [makeSegment({ text: "We circle backed on this yesterday." })],
      }),
    );
    const highlighted = model.segments[0].runs.filter((r) => r.ref !== undefined);
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0].text.toLowerCase()).toBe("circle backed");
  });

  it("prefers the longer multi-word phrase over a shorter substring match", () => {
    const model = buildCornellModel(
      makeInput({
        segments: [makeSegment({ text: "Let's touch base on the touch point." })],
        cards: [
          makeCard({ id: "c1", expression: "touch base" }),
          makeCard({ id: "c2", expression: "touch", normKey: "touch" }),
        ],
      }),
    );
    // "touch base" should be highlighted as one run, not split into
    // "touch" + " base".
    const highlighted = model.segments[0].runs.filter((r) => r.ref !== undefined);
    expect(highlighted.some((r) => r.text.toLowerCase() === "touch base")).toBe(true);
  });

  it("produces only plain runs for a segment with no matches, while other segments still match", () => {
    const model = buildCornellModel(
      makeInput({
        segments: [
          makeSegment({ id: "seg1", index: 0, text: "Nothing special here." }),
          makeSegment({ id: "seg2", index: 1, text: "Let's circle back later." }),
        ],
      }),
    );
    expect(model.segments[0].runs.every((r) => r.ref === undefined)).toBe(true);
    expect(model.segments[1].runs.some((r) => r.ref !== undefined)).toBe(true);
  });

  it("does not match a bare substring across word boundaries (e.g. 'ARR' inside 'ARRAY')", () => {
    const model = buildCornellModel(
      makeInput({
        segments: [makeSegment({ text: "The array is sorted." })],
        cards: [],
        terms: [makeTerm({ term: "ARR" })],
      }),
    );
    expect(model.annotations).toHaveLength(0);
  });
});

describe("buildCornellModel — numbering (first occurrence only)", () => {
  it("assigns annotation numbers in first-appearance order, starting at 1", () => {
    const model = buildCornellModel(
      makeInput({
        segments: [makeSegment({ text: "Our ARR grew, so let's circle back." })],
        cards: [makeCard()],
        terms: [makeTerm()],
      }),
    );
    expect(model.annotations.map((a) => a.n)).toEqual([1, 2]);
    // ARR appears before "circle back" in the text, so it gets n=1.
    expect(model.annotations[0].headword).toBe("ARR");
    expect(model.annotations[1].headword).toBe("circle back");
  });

  it("does not create a second annotation entry for a repeated occurrence", () => {
    const model = buildCornellModel(
      makeInput({
        segments: [
          makeSegment({ id: "seg1", index: 0, text: "Let's circle back tomorrow." }),
          makeSegment({ id: "seg2", index: 1, text: "Did we circle back yet?" }),
        ],
      }),
    );
    expect(model.annotations).toHaveLength(1);
    expect(model.annotations[0].n).toBe(1);
  });

  it("gives the repeated occurrence's highlighted run the same ref number as the first", () => {
    const model = buildCornellModel(
      makeInput({
        segments: [
          makeSegment({ id: "seg1", index: 0, text: "Let's circle back tomorrow." }),
          makeSegment({ id: "seg2", index: 1, text: "Did we circle back yet?" }),
        ],
      }),
    );
    const firstRef = model.segments[0].runs.find((r) => r.ref !== undefined)?.ref;
    const secondRef = model.segments[1].runs.find((r) => r.ref !== undefined)?.ref;
    expect(firstRef).toBe(1);
    expect(secondRef).toBe(1);
  });

  it("records the segmentIndex of the first appearance, not a later repeat", () => {
    const model = buildCornellModel(
      makeInput({
        segments: [
          makeSegment({ id: "seg1", index: 0, text: "Nothing here." }),
          makeSegment({ id: "seg2", index: 1, text: "Let's circle back." }),
          makeSegment({ id: "seg3", index: 2, text: "We circled back again." }),
        ],
      }),
    );
    expect(model.annotations).toHaveLength(1);
    expect(model.annotations[0].segmentIndex).toBe(1);
  });
});

describe("buildCornellModel — en/zh gloss selection", () => {
  it("defaults to the Chinese gloss when explainLanguage is omitted", () => {
    const model = buildCornellModel(makeInput());
    expect(model.annotations[0].gloss).toBe("回头再聊");
  });

  it("uses chinese_explanation for expressions when explainLanguage is 'zh'", () => {
    const model = buildCornellModel(makeInput({ explainLanguage: "zh" }));
    expect(model.annotations[0].gloss).toBe("回头再聊");
  });

  it("uses plain_english for expressions when explainLanguage is 'en'", () => {
    const model = buildCornellModel(makeInput({ explainLanguage: "en" }));
    expect(model.annotations[0].gloss).toBe("discuss again later");
  });

  it("uses gloss_zh for terms when explainLanguage is 'zh'", () => {
    const model = buildCornellModel(
      makeInput({
        segments: [makeSegment({ text: "Our ARR grew." })],
        cards: [],
        terms: [makeTerm()],
        explainLanguage: "zh",
      }),
    );
    expect(model.annotations[0].gloss).toBe("年度经常性收入");
  });

  it("uses gloss_en for terms when explainLanguage is 'en'", () => {
    const model = buildCornellModel(
      makeInput({
        segments: [makeSegment({ text: "Our ARR grew." })],
        cards: [],
        terms: [makeTerm()],
        explainLanguage: "en",
      }),
    );
    expect(model.annotations[0].gloss).toBe("Annual Recurring Revenue");
  });
});

describe("buildCornellModel — summary block", () => {
  it("marks hasSummary false and empty strings/arrays when no summary is provided", () => {
    const model = buildCornellModel(makeInput({ summary: undefined }));
    expect(model.summary.hasSummary).toBe(false);
    expect(model.summary.topicZh).toBe("");
    expect(model.summary.keyPointsZh).toEqual([]);
  });

  it("uses topic.zh and key_points[].zh when present", () => {
    const model = buildCornellModel(makeInput({ summary: makeSummary() }));
    expect(model.summary.hasSummary).toBe(true);
    expect(model.summary.topicZh).toBe("周会");
    expect(model.summary.keyPointsZh).toEqual(["周五上线"]);
  });

  it("falls back to topic.en when topic.zh is missing", () => {
    const model = buildCornellModel(
      makeInput({
        summary: makeSummary({ topic: { en: "Weekly sync", zh: "" } }),
      }),
    );
    expect(model.summary.topicZh).toBe("Weekly sync");
  });

  it("falls back to a key point's en when its zh is missing", () => {
    const model = buildCornellModel(
      makeInput({
        summary: makeSummary({
          key_points: [
            { en: "Ship on Friday", zh: "周五上线" },
            { en: "No zh here", zh: "" },
          ],
        }),
      }),
    );
    expect(model.summary.keyPointsZh).toEqual(["周五上线", "No zh here"]);
  });
});

describe("cornellToMarkdown — golden shape", () => {
  it("includes the title as an H1 with the 康奈尔笔记 suffix", () => {
    const model = buildCornellModel(makeInput({ title: "My Big Meeting" }));
    const md = cornellToMarkdown(model);
    expect(md).toContain("# My Big Meeting · 康奈尔笔记");
  });

  it("contains 转录正文, 批注, and 小结 section headings in order", () => {
    const model = buildCornellModel(makeInput());
    const md = cornellToMarkdown(model);
    const transcriptIdx = md.indexOf("## 转录正文");
    const annotationsIdx = md.indexOf("## 批注");
    const summaryIdx = md.indexOf("## 小结");
    expect(transcriptIdx).toBeGreaterThanOrEqual(0);
    expect(annotationsIdx).toBeGreaterThan(transcriptIdx);
    expect(summaryIdx).toBeGreaterThan(annotationsIdx);
  });

  it("bolds a highlighted run and follows it with a circled-digit ref marker", () => {
    const model = buildCornellModel(makeInput());
    const md = cornellToMarkdown(model);
    expect(md).toContain("**circle back**①");
  });

  it("lists each annotation with its circled marker, bolded headword, and gloss", () => {
    const model = buildCornellModel(makeInput());
    const md = cornellToMarkdown(model);
    expect(md).toContain("① **circle back** — 回头再聊");
  });

  it("shows a placeholder under 批注 when there are no annotations", () => {
    const model = buildCornellModel(makeInput({ cards: [], terms: [] }));
    const md = cornellToMarkdown(model);
    expect(md).toContain("（未检测到表达/术语）");
  });

  it("shows 尚未生成纪要 under 小结 when no summary exists", () => {
    const model = buildCornellModel(makeInput({ summary: undefined }));
    const md = cornellToMarkdown(model);
    expect(md).toContain("尚未生成纪要");
  });

  it("renders the topic and each key point as a bullet under 小结 when a summary exists", () => {
    const model = buildCornellModel(makeInput({ summary: makeSummary() }));
    const md = cornellToMarkdown(model);
    expect(md).toContain("**主题**：周会");
    expect(md).toContain("- 周五上线");
  });

  it("shows a placeholder under 转录正文 for the empty model", () => {
    const model = buildCornellModel(makeInput({ segments: [], cards: [], terms: [] }));
    const md = cornellToMarkdown(model);
    expect(md).toContain("（无转录内容）");
  });

  it("prefixes a segment's rendered line with the speaker in bold when present", () => {
    const model = buildCornellModel(
      makeInput({ segments: [makeSegment({ speaker: "Alice" })] }),
    );
    const md = cornellToMarkdown(model);
    expect(md).toContain("**Alice**");
  });
});
