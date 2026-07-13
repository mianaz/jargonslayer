import { describe, expect, it } from "vitest";

import { exportFilename, sessionToJson, sessionToMarkdown } from "../exportSession";
import type { LiteSession } from "../../storage/history";

function makeSession(overrides: Partial<LiteSession> = {}): LiteSession {
  return {
    id: "s1",
    title: "英文晨会",
    startedAt: Date.UTC(2026, 6, 12, 6, 30, 0),
    endedAt: Date.UTC(2026, 6, 12, 6, 35, 0),
    engine: "webspeech",
    segments: [
      {
        text: "Let's circle back on this next week.",
        startedAt: Date.UTC(2026, 6, 12, 6, 30, 5),
      },
    ],
    cards: [
      {
        id: "c1",
        normKey: "circle back",
        expression: "circle back",
        category: "phrase",
        meaning: "revisit later",
        chinese_explanation: "回头再聊",
        plain_english: "discuss again later",
        tone: "neutral",
        confidence: 0.9,
        source_sentence: "Let's circle back on this next week.",
        firstSeenAt: 1,
        lastSeenAt: 1,
        count: 1,
        source: "dictionary",
      },
    ],
    terms: [
      {
        id: "t1",
        normKey: "ARR",
        term: "ARR",
        type: "metric",
        gloss_en: "Annual Recurring Revenue",
        gloss_zh: "年度经常性收入",
        firstSeenAt: 1,
        lastSeenAt: 1,
        count: 1,
        source: "dictionary",
      },
    ],
    ...overrides,
  };
}

describe("sessionToMarkdown", () => {
  it("includes title, transcript, cards, and terms sections", () => {
    const md = sessionToMarkdown(makeSession());

    expect(md).toContain("# 英文晨会");
    expect(md).toContain("## 转录");
    expect(md).toContain("Let's circle back on this next week.");
    expect(md).toContain("## 表达学习卡片");
    expect(md).toContain("### circle back");
    expect(md).toContain("回头再聊");
    expect(md).toContain("## 术语表");
    expect(md).toContain("| ARR |");
    expect(md).toContain("年度经常性收入");
  });

  it("includes YAML frontmatter by default (mirrors DEFAULT_SETTINGS.exportFrontmatter=true)", () => {
    const md = sessionToMarkdown(makeSession());

    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain('title: "英文晨会"');
    expect(md).toContain("expressions:");
    expect(md).toContain('  - "circle back"');
    expect(md).toContain("terms:");
    expect(md).toContain('  - "ARR"');
    expect(md).toContain("schemaVersion: 1");
  });

  it("omits frontmatter when frontmatter: false", () => {
    const md = sessionToMarkdown(makeSession(), { frontmatter: false });

    expect(md.startsWith("---")).toBe(false);
    expect(md.startsWith("# 英文晨会")).toBe(true);
  });

  it("renders empty-state copy for a session with no transcript/cards/terms", () => {
    const md = sessionToMarkdown(makeSession({ segments: [], cards: [], terms: [] }), {
      frontmatter: false,
    });

    expect(md).toContain("（无转录内容）");
    // Two bare "（无）" occurrences: the empty cards section + the
    // empty terms section ("（无转录内容）" doesn't match this literal
    // substring, so this count isolates just those two).
    expect(md.match(/（无）/g)?.length).toBe(2);
  });
});

describe("sessionToJson", () => {
  it("round-trips a LiteSession exactly", () => {
    const session = makeSession();
    const json = sessionToJson(session);

    expect(JSON.parse(json)).toEqual(session);
  });
});

describe("exportFilename", () => {
  it("stamps jargonslayer-YYYYMMDD-HHmm from startedAt (local time)", () => {
    const session = makeSession({ startedAt: new Date(2026, 6, 12, 14, 30, 0).getTime() });

    expect(exportFilename(session, "md")).toBe("jargonslayer-20260712-1430.md");
    expect(exportFilename(session, "json")).toBe("jargonslayer-20260712-1430.json");
  });

  it("zero-pads single-digit month/day/hour/minute", () => {
    const session = makeSession({ startedAt: new Date(2026, 0, 5, 9, 5, 0).getTime() });

    expect(exportFilename(session, "md")).toBe("jargonslayer-20260105-0905.md");
  });
});
