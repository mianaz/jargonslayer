// Export helpers: Markdown bilingual report, Anki TSV, raw session
// JSON, and a generic browser download trigger.
// OWNER: worker B.

import type {
  ExpressionCard,
  Flashcard,
  MeetingSession,
  STTEngineKind,
  TermCard,
  TranslationPair,
} from "../types";

const ENGINE_LABELS: Record<STTEngineKind, string> = {
  demo: "演示模式",
  webspeech: "浏览器识别",
  whisper: "本地 Whisper",
  tabaudio: "标签页音频",
};

const CATEGORY_LABELS: Record<string, string> = {
  idiom: "习语",
  slang: "俚语",
  phrase: "短语",
  metaphor: "隐喻",
  indirect: "委婉",
  other: "其他",
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

function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function escapeMdTableCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Build a full bilingual Markdown report for a completed session. */
export function buildMarkdownReport(session: MeetingSession): string {
  const lines: string[] = [];
  const { summary } = session;

  lines.push(`# ${session.title}`);
  lines.push(
    `日期：${formatDate(session.startedAt)}　时长：${formatDuration(
      session.startedAt,
      session.endedAt,
    )}　引擎：${ENGINE_LABELS[session.engine] ?? session.engine}`,
  );
  lines.push("");

  if (summary) {
    lines.push("## 会议主题");
    lines.push(`${summary.summary.topic.en}`);
    lines.push(`${summary.summary.topic.zh}`);
    lines.push("");

    lines.push("## 要点");
    if (summary.summary.key_points.length === 0) {
      lines.push("（无）");
    } else {
      for (const p of summary.summary.key_points) {
        lines.push(`- ${p.en}`);
        lines.push(`  ${p.zh}`);
      }
    }
    lines.push("");

    lines.push("## 决定");
    if (summary.summary.decisions.length === 0) {
      lines.push("（无）");
    } else {
      for (const d of summary.summary.decisions) {
        lines.push(`- ${d.en}`);
        lines.push(`  ${d.zh}`);
      }
    }
    lines.push("");

    lines.push("## 行动项");
    if (summary.summary.action_items.length === 0) {
      lines.push("（无）");
    } else {
      lines.push("| 负责人 | 事项 | 期限 |");
      lines.push("| --- | --- | --- |");
      for (const item of summary.summary.action_items) {
        const task = `${escapeMdTableCell(item.zh)}<br>${escapeMdTableCell(item.en)}`;
        lines.push(
          `| ${escapeMdTableCell(item.owner || "unassigned")} | ${task} | ${
            escapeMdTableCell(item.due) || "-"
          } |`,
        );
      }
    }
    lines.push("");
  }

  lines.push("## 双语转录");
  if (session.segments.length === 0) {
    lines.push("（无转录内容）");
  } else {
    const translationByIndex = new Map<number, string>(
      (summary?.translations ?? []).map((t: TranslationPair) => [t.index, t.zh]),
    );
    for (const seg of session.segments) {
      const speaker = seg.speaker || "Speaker";
      lines.push(`**${speaker}** \`${formatClock(seg.startedAt)}\`  `);
      lines.push(`${seg.text}  `);
      const zh = translationByIndex.get(seg.index);
      if (zh) {
        lines.push(`> ${zh}`);
      }
      lines.push("");
    }
  }

  lines.push("## 表达学习卡片");
  if (session.cards.length === 0) {
    lines.push("（无）");
  } else {
    for (const card of session.cards) {
      lines.push(`### ${card.expression}`);
      lines.push(`含义：${card.meaning}`);
      lines.push(`中文：${card.chinese_explanation}`);
      lines.push(`直白说法：${card.plain_english}`);
      lines.push(`语气：${card.tone}`);
      lines.push(`例句：${card.source_sentence}`);
      lines.push(`出现 ${card.count} 次`);
      lines.push("");
    }
  }

  lines.push("## 术语表");
  if (session.terms.length === 0) {
    lines.push("（无）");
  } else {
    lines.push("| 术语 | 类型 | 英文释义 | 中文释义 |");
    lines.push("| --- | --- | --- | --- |");
    for (const t of session.terms) {
      lines.push(
        `| ${escapeMdTableCell(t.term)} | ${escapeMdTableCell(t.type)} | ${escapeMdTableCell(
          t.gloss_en,
        )} | ${escapeMdTableCell(t.gloss_zh)} |`,
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

function escapeAnkiField(s: string): string {
  return s.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
}

/** Build a two-column (front\tback) TSV importable into Anki. */
export function buildAnkiTSV(flashcards: Flashcard[]): string {
  const rows = flashcards.map((c) => {
    const front = escapeAnkiField(c.front);
    const back = escapeAnkiField(
      `${c.back_zh}<br>${c.back_en}<br><i>${c.example}</i>`,
    );
    return `${front}\t${back}`;
  });
  return rows.join("\n");
}

/** Pretty-printed raw session JSON, for archival/debugging. */
export function buildSessionJson(session: MeetingSession): string {
  return JSON.stringify(session, null, 2);
}

/** Trigger a browser download of `content` as `filename`. */
export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Re-exported for consumers that want category labels consistent
// with the report (e.g. UI badges) without duplicating the map.
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

// Keep type imports referenced for callers that only need the types
// (avoids an unused-import lint footgun if this file is trimmed later).
export type { ExpressionCard, TermCard };
