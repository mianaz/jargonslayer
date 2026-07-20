import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildDocxReport } from "../docx";
import type { ExpressionCard, MeetingSession, TermCard } from "@jargonslayer/core/types";

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
    title: "Weekly sync 会议纪要",
    startedAt: new Date("2026-01-15T09:00:00Z").getTime(),
    endedAt: new Date("2026-01-15T09:30:00Z").getTime(),
    engine: "demo",
    segments: [],
    cards: [],
    terms: [],
    ...overrides,
  };
}

// Unzips the Blob's bytes the same way Word/Pages would, using jszip
// (already an installed transitive dependency of docx — no new dep
// added just for this test) so assertions read real OOXML content
// rather than raw compressed bytes.
async function unzip(blob: Blob) {
  const buf = Buffer.from(await blob.arrayBuffer());
  return JSZip.loadAsync(buf);
}

describe("buildDocxReport — valid OOXML zip", () => {
  it("resolves a Blob whose bytes start with the PK\\x03\\x04 zip signature", async () => {
    const blob = await buildDocxReport(makeSession());
    expect(blob).toBeInstanceOf(Blob);
    const buf = Buffer.from(await blob.arrayBuffer());
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
  });

  it("produces a non-trivial file (well above a placeholder-sized floor)", async () => {
    const blob = await buildDocxReport(makeSession());
    expect(blob.size).toBeGreaterThan(1000);
  });

  it("contains a [Content_Types].xml declaring the wordprocessingml content type", async () => {
    const blob = await buildDocxReport(makeSession());
    const zip = await unzip(blob);
    const contentTypes = await zip.file("[Content_Types].xml")?.async("string");
    expect(contentTypes).toBeDefined();
    expect(contentTypes).toContain("wordprocessingml");
  });

  it("contains word/document.xml", async () => {
    const blob = await buildDocxReport(makeSession());
    const zip = await unzip(blob);
    expect(zip.file("word/document.xml")).not.toBeNull();
  });
});

describe("buildDocxReport — sections mirror buildMarkdownReport", () => {
  it("renders the session title", async () => {
    const blob = await buildDocxReport(makeSession({ title: "My Big Meeting 大会议" }));
    const zip = await unzip(blob);
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("My Big Meeting 大会议");
  });

  it("always renders 双语转录 / 表达学习卡片 / 术语表 headings, even with no data", async () => {
    const blob = await buildDocxReport(makeSession());
    const zip = await unzip(blob);
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("双语转录");
    expect(docXml).toContain("表达学习卡片");
    expect(docXml).toContain("术语表");
    expect(docXml).toContain("（无转录内容）");
  });

  it("omits 会议主题/要点/决定/行动项 entirely when the session has no summary (mirrors buildMarkdownReport's `if (summary)` gate)", async () => {
    const blob = await buildDocxReport(makeSession());
    const zip = await unzip(blob);
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).not.toContain("会议主题");
    expect(docXml).not.toContain("行动项");
  });

  it("renders 术语表 with term fields when terms are present", async () => {
    const blob = await buildDocxReport(makeSession({ terms: [makeTerm()] }));
    const zip = await unzip(blob);
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("ARR");
    expect(docXml).toContain("Annual Recurring Revenue");
    expect(docXml).toContain("年度经常性收入");
  });

  it("renders 表达学习卡片 with card fields when cards are present", async () => {
    const blob = await buildDocxReport(makeSession({ cards: [makeCard()] }));
    const zip = await unzip(blob);
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("circle back");
    expect(docXml).toContain("revisit later");
    expect(docXml).toContain("回头再聊");
    expect(docXml).toContain("出现 2 次");
  });

  it("renders bilingual speaker-labeled transcript segments with aligned translations", async () => {
    const session = makeSession({
      segments: [
        { id: "seg1", index: 0, startedAt: 1000, endedAt: 1500, text: "Hello everyone.", engine: "demo", speaker: "Alice" },
      ],
      summary: {
        summary: { topic: { en: "Kickoff", zh: "启动会" }, key_points: [], decisions: [], action_items: [] },
        translations: [{ index: 0, zh: "大家好。" }],
        flashcards: [],
        generatedAt: 1000,
        model: "test-model",
      },
    });
    const blob = await buildDocxReport(session);
    const zip = await unzip(blob);
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("Alice");
    expect(docXml).toContain("Hello everyone.");
    expect(docXml).toContain("大家好。");
    expect(docXml).toContain("Kickoff");
    expect(docXml).toContain("启动会");
  });

  it("renders the 行动项 table with owner/task/due when action items are present", async () => {
    const session = makeSession({
      summary: {
        summary: {
          topic: { en: "", zh: "" },
          key_points: [],
          decisions: [],
          action_items: [{ owner: "Bob", en: "Ship the report", zh: "上线报告", due: "Friday" }],
        },
        translations: [],
        flashcards: [],
        generatedAt: 1000,
        model: "test-model",
      },
    });
    const blob = await buildDocxReport(session);
    const zip = await unzip(blob);
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("Bob");
    expect(docXml).toContain("上线报告");
    expect(docXml).toContain("Ship the report");
    expect(docXml).toContain("Friday");
  });
});

describe("buildDocxReport — CJK-safe default font", () => {
  it("sets a document-default rFonts (ascii/eastAsia/hAnsi/cs) instead of embedding a font", async () => {
    const blob = await buildDocxReport(makeSession());
    const zip = await unzip(blob);
    const stylesXml = await zip.file("word/styles.xml")?.async("string");
    expect(stylesXml).toBeDefined();
    expect(stylesXml).toContain("w:eastAsia");
    // No font embedding: fontTable/embedded font parts stay absent.
    expect(zip.file(/word\/fonts\//).length).toBe(0);
  });
});

describe("docx.ts — lazy-import gate (static source assertion)", () => {
  it("has no top-level `import ... from \"docx\"` — only a dynamic import() inside the function", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../docx.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s.*from\s+["']docx["']/m);
    expect(source).toContain('await import("docx")');
  });
});
