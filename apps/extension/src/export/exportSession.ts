// Pure LiteSession export helpers (S7 blueprint §2 decision C) —
// Markdown + JSON serialization only. Mirrors apps/web's
// lib/history/export.ts house style (buildMarkdownReport /
// buildObsidianFrontmatter / buildSessionJson) as a sensible SUBSET:
// LiteSession carries no summary/speaker/translation/pauseIntervals
// (dictionary-only Lite capture produces none of those — see
// storage/history.ts's LiteSession doc), so those sections are simply
// absent rather than rendered empty. NO DOM code here — the actual
// Blob + <a download> click lives in the panel UI (Chunk 6); this
// module only builds strings and a filename.

import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import type { LiteSession } from "../storage/history";

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

/** mm:ss elapsed since session start — LiteSession has no pause
 *  bookkeeping (unlike MeetingSession's segmentElapsed.ts machinery),
 *  so this is a plain wall-clock difference. */
function formatElapsed(sessionStartedAt: number, segStartedAt: number): string {
  const totalSec = Math.max(0, Math.round((segStartedAt - sessionStartedAt) / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${pad2(min)}:${pad2(sec)}`;
}

function escapeMdTableCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function yamlListItem(s: string): string {
  return `  - "${s.replace(/"/g, '\\"')}"`;
}

function yamlString(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** YAML frontmatter — Lite subset of the web app's
 *  buildObsidianFrontmatter (title/date/duration/engine/expressions/
 *  terms/source/schemaVersion); same fields, no meeting-only extras. */
function buildFrontmatter(session: LiteSession): string {
  const durationMin = Math.max(0, Math.round((session.endedAt - session.startedAt) / 60000));
  const lines: string[] = ["---"];
  lines.push(`title: ${yamlString(session.title)}`);
  lines.push(`date: ${new Date(session.startedAt).toISOString()}`);
  lines.push(`duration_min: ${durationMin}`);
  lines.push(`engine: ${yamlString(session.engine)}`);
  if (session.cards.length === 0) {
    lines.push("expressions: []");
  } else {
    lines.push("expressions:");
    for (const c of session.cards) lines.push(yamlListItem(c.expression));
  }
  if (session.terms.length === 0) {
    lines.push("terms: []");
  } else {
    lines.push("terms:");
    for (const t of session.terms) lines.push(yamlListItem(t.term));
  }
  lines.push("source: jargonslayer");
  lines.push("schemaVersion: 1");
  lines.push("---");
  return lines.join("\n");
}

function buildBody(session: LiteSession): string {
  const lines: string[] = [];

  lines.push(`# ${session.title}`);
  lines.push(
    `日期：${formatDate(session.startedAt)}　时长：${formatDuration(
      session.startedAt,
      session.endedAt,
    )}　引擎：Web Speech（浏览器识别）`,
  );
  lines.push("");

  lines.push("## 转录");
  if (session.segments.length === 0) {
    lines.push("（无转录内容）");
  } else {
    for (const seg of session.segments) {
      lines.push(`**${formatElapsed(session.startedAt, seg.startedAt)}** ${seg.text}  `);
    }
  }
  lines.push("");

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

/** Markdown report for a LiteSession — sensible subset of the web
 *  app's buildMarkdownReport (no summary/speaker/translation sections:
 *  LiteSession has none of that data). `frontmatter` defaults to
 *  DEFAULT_SETTINGS.exportFrontmatter (true today) — the same knob the
 *  web app's Settings exposes. */
export function sessionToMarkdown(
  session: LiteSession,
  opts: { frontmatter?: boolean } = {},
): string {
  const frontmatter = opts.frontmatter ?? DEFAULT_SETTINGS.exportFrontmatter;
  const body = buildBody(session);
  return frontmatter ? `${buildFrontmatter(session)}\n\n${body}` : body;
}

/** Pretty-printed raw session JSON — round-trips via JSON.parse. */
export function sessionToJson(session: LiteSession): string {
  return JSON.stringify(session, null, 2);
}

/** `jargonslayer-YYYYMMDD-HHmm.{ext}`, stamped from the session's
 *  startedAt (local time, matching formatDate above). */
export function exportFilename(session: LiteSession, ext: "md" | "json"): string {
  const d = new Date(session.startedAt);
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(
    d.getHours(),
  )}${pad2(d.getMinutes())}`;
  return `jargonslayer-${stamp}.${ext}`;
}
