// Docx export: mirrors buildMarkdownReport's structure (export.ts:67)
// section-for-section, as an OOXML Word document instead of Markdown.
// v05-wave1-blueprint.md §1 Feature 3.
//
// The "docx" package is DYNAMICALLY imported inside buildDocxReport —
// this file must have NO top-level `import ... from "docx"` (pinned
// by docx.test.ts's static-source assertion) so the package stays
// out of the initial bundle and only loads when the export button is
// clicked.
//
// A few small formatters (pad2/formatDate/formatDuration/
// ENGINE_LABELS) are duplicated from export.ts rather than imported —
// this lane's edit surface on export.ts is scoped to adding
// `downloadBlob` only (v05-wave1-blueprint.md §2 lane table), so this
// file stays self-contained instead of exporting export.ts's private
// helpers.

import type { MeetingSession, STTEngineKind, TranslationPair } from "@jargonslayer/core/types";
import { formatElapsedClock, resolveSessionElapsedBasis, segmentElapsedMs } from "../segmentElapsed";
import { IS_DESKTOP } from "@/lib/platform/desktop";

const ENGINE_LABELS: Record<STTEngineKind, string> = {
  demo: "演示模式",
  webspeech: "浏览器识别",
  whisper: "本地 Whisper",
  tabaudio: "标签页音频",
  appaudio: "系统/App 音频",
  osspeech: "系统识别",
  soniox: "Soniox 云端识别",
  // v0.5 Wave-0 (F4 tab-audio-cloud, landing concurrently with this
  // lane): STTEngineKind gained "deepgram" while this file was being
  // written. Label follows the exact naming convention of the
  // "soniox" entry above (same BYOK-cloud-engine shape) — a
  // placeholder pending export.ts's own ENGINE_LABELS getting the
  // same key from whichever lane owns that copy; sync if the actual
  // copy differs.
  deepgram: "Deepgram 云端识别",
  // v0.5 Wave-1 Foundation (F4 tab-audio-cloud kind, not yet a
  // selectable engine — see STTEngineKind's own doc comment): same
  // placeholder-pending-sync posture as "deepgram" immediately above.
  "tabaudio-cloud": "标签页音频·云端",
  import: "导入",
  "browser-whisper": IS_DESKTOP ? "内置 Whisper" : "浏览器 Whisper",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

function formatDuration(startMs: number, endMs: number): string {
  const totalSec = Math.max(0, Math.round((endMs - startMs) / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min} 分 ${sec} 秒`;
}

// CJK-safe default: a plain string `font` sets rFonts ascii/eastAsia/
// hAnsi/cs all to this one name (see docx's createRunFonts), and it's
// applied once via styles.default.document.run below — docDefaults is
// the base of the whole style cascade, so it reaches headings/tables/
// body text alike (none of docx's built-in Heading/Title styles set
// their own rFonts). No font embedding, just naming one Word/Pages
// can resolve for Chinese without falling back to tofu.
const CJK_FONT = "Microsoft YaHei";

/** Build a full bilingual .docx report for a completed session — same
 *  sections as buildMarkdownReport (export.ts), rendered as OOXML via
 *  Packer.toBlob(). Dynamically imports "docx" so the package stays
 *  out of the initial bundle. */
export async function buildDocxReport(session: MeetingSession): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } =
    await import("docx");
  type Block = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;

  const heading = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]) =>
    new Paragraph({ heading: level, children: [new TextRun(text)] });

  const plain = (text: string, opts: { bold?: boolean; italics?: boolean } = {}) =>
    new Paragraph({ children: [new TextRun({ text, ...opts })] });

  // One bullet item spanning two lines (en, then zh) — mirrors MD's
  // "- en\n  zh" (one list item, soft-wrapped second line via a
  // manual <w:br/> rather than two separate list items).
  const bulletPair = (en: string, zh: string) =>
    new Paragraph({
      bullet: { level: 0 },
      children: [new TextRun(en), new TextRun({ text: zh, break: 1 })],
    });

  // Translation line under a transcript segment — mirrors MD's "> zh"
  // blockquote with a light indent + italics instead of a MD quote
  // marker.
  const quote = (text: string) =>
    new Paragraph({ indent: { left: 400 }, children: [new TextRun({ text, italics: true })] });

  const headerRow = (cells: string[], widths: number[]) =>
    new TableRow({
      children: cells.map(
        (text, i) =>
          new TableCell({
            width: { size: widths[i], type: WidthType.PERCENTAGE },
            shading: { fill: "F2F2F2" },
            children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })],
          }),
      ),
    });

  const textRow = (cells: string[], widths: number[]) =>
    new TableRow({
      children: cells.map(
        (text, i) =>
          new TableCell({
            width: { size: widths[i], type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun(text)] })],
          }),
      ),
    });

  const children: Block[] = [];
  const { summary } = session;

  children.push(heading(session.title, HeadingLevel.HEADING_1));
  children.push(
    plain(
      `日期：${formatDate(session.startedAt)}　时长：${formatDuration(
        session.startedAt,
        session.endedAt,
      )}　引擎：${ENGINE_LABELS[session.engine] ?? session.engine}`,
    ),
  );

  if (summary) {
    children.push(heading("会议主题", HeadingLevel.HEADING_2));
    children.push(plain(summary.summary.topic.en));
    children.push(plain(summary.summary.topic.zh));

    children.push(heading("要点", HeadingLevel.HEADING_2));
    if (summary.summary.key_points.length === 0) {
      children.push(plain("（无）"));
    } else {
      for (const p of summary.summary.key_points) children.push(bulletPair(p.en, p.zh));
    }

    children.push(heading("决定", HeadingLevel.HEADING_2));
    if (summary.summary.decisions.length === 0) {
      children.push(plain("（无）"));
    } else {
      for (const d of summary.summary.decisions) children.push(bulletPair(d.en, d.zh));
    }

    children.push(heading("行动项", HeadingLevel.HEADING_2));
    if (summary.summary.action_items.length === 0) {
      children.push(plain("（无）"));
    } else {
      const rows = [headerRow(["负责人", "事项", "期限"], [20, 60, 20])];
      for (const item of summary.summary.action_items) {
        rows.push(
          new TableRow({
            children: [
              new TableCell({
                width: { size: 20, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun(item.owner || "unassigned")] })],
              }),
              new TableCell({
                width: { size: 60, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun(item.zh)] }), new Paragraph({ children: [new TextRun(item.en)] })],
              }),
              new TableCell({
                width: { size: 20, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun(item.due || "-")] })],
              }),
            ],
          }),
        );
      }
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: {}, rows }));
    }
  }

  children.push(heading("双语转录", HeadingLevel.HEADING_2));
  if (session.segments.length === 0) {
    children.push(plain("（无转录内容）"));
  } else {
    const translationByIndex = new Map<number, string>(
      (summary?.translations ?? []).map((t: TranslationPair) => [t.index, t.zh]),
    );
    const { startedAt: elapsedZero, pauseIntervals } = resolveSessionElapsedBasis(session);
    for (const seg of session.segments) {
      const speaker = seg.speaker || "Speaker";
      const elapsed = formatElapsedClock(segmentElapsedMs(elapsedZero, seg.startedAt, pauseIntervals));
      children.push(
        new Paragraph({
          children: [new TextRun({ text: speaker, bold: true }), new TextRun(` ${elapsed}`)],
        }),
      );
      children.push(plain(seg.text));
      const zh = translationByIndex.get(seg.index);
      if (zh) children.push(quote(zh));
    }
  }

  children.push(heading("表达学习卡片", HeadingLevel.HEADING_2));
  if (session.cards.length === 0) {
    children.push(plain("（无）"));
  } else {
    for (const card of session.cards) {
      children.push(heading(card.expression, HeadingLevel.HEADING_3));
      children.push(plain(`含义：${card.meaning}`));
      children.push(plain(`中文：${card.chinese_explanation}`));
      children.push(plain(`直白说法：${card.plain_english}`));
      children.push(plain(`语气：${card.tone}`));
      children.push(plain(`例句：${card.source_sentence}`));
      children.push(plain(`出现 ${card.count} 次`));
    }
  }

  children.push(heading("术语表", HeadingLevel.HEADING_2));
  if (session.terms.length === 0) {
    children.push(plain("（无）"));
  } else {
    const rows = [headerRow(["术语", "类型", "英文释义", "中文释义"], [15, 15, 35, 35])];
    for (const t of session.terms) {
      rows.push(textRow([t.term, t.type, t.gloss_en, t.gloss_zh], [15, 15, 35, 35]));
    }
    children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: {}, rows }));
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: CJK_FONT } } } },
    sections: [{ children }],
  });

  return Packer.toBlob(doc);
}
