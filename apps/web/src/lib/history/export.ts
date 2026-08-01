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
} from "@jargonslayer/core/types";
import { getAllPacks } from "@jargonslayer/core/detect/packs";
import { formatElapsedClock, resolveSessionElapsedBasis, segmentElapsedMs } from "../segmentElapsed";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { IS_IOS } from "@/lib/platform/ios";

const ENGINE_LABELS: Record<STTEngineKind, string> = {
  demo: "演示模式",
  webspeech: "浏览器识别",
  whisper: "本地模型",
  tabaudio: "标签页音频",
  appaudio: "系统/App 音频",
  // S11 (v0.4.3): terse noun form for the export label, matching every
  // other entry here. Since the iOS field-fix round the picker label
  // (engineCapabilities.ts) dropped its "· 开箱即用" tagline too, so
  // the two are now byte-identical — kept as separate constants only
  // because this file stays engine-metadata-free by design.
  osspeech: "系统识别",
  soniox: "Soniox 云端识别",
  // v0.4.7 (docs/design-explorations/stt-provider-wiring-2026-07.md,
  // Lane D): second cloud engine, terse noun form matching soniox above.
  deepgram: "Deepgram 云端识别",
  // v0.6 round 2: third BYOK cloud engine, terse noun form matching
  // soniox/deepgram above.
  elevenlabs: "ElevenLabs 云端识别",
  // v0.5 Wave-1 Foundation (F4 tab-audio-cloud kind, not yet a
  // selectable engine — see STTEngineKind's own doc comment in
  // types.ts). Terse noun form matching every other entry here.
  "tabaudio-cloud": "标签页音频·云端",
  import: "导入",
  // v0.4.4 field ruling (round 2, item 1): the desktop app never frames
  // this path as "浏览器" — it's 内置 there (see ImportHub's own card);
  // the web PWA keeps the accurate browser wording.
  "browser-whisper": IS_DESKTOP ? "内置 Whisper" : "浏览器 Whisper",
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

function escapeMdTableCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function packName(packId: string | undefined): string {
  if (!packId) return "-";
  return getAllPacks().find((pack) => pack.id === packId)?.name ?? packId;
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
    // Live bilingual translation (session.translations, id-keyed —
    // MeetingSession.translations) wins over the summary's index-keyed
    // pair for the same segment: it's the map the transcript actually
    // rendered from live, so it reflects any per-segment retranslation/
    // correction the summary snapshot never saw. Falls back to the
    // summary pair when the live map has no entry for this segment id.
    const liveTranslations = session.translations ?? {};
    // Transcript-timestamp fix: exports now match the screen — elapsed
    // since meeting start (paused spans excluded), not a wall-clock
    // time. The session-level header above keeps the absolute date
    // (formatDate(session.startedAt)); only this per-segment line
    // switches.
    const { startedAt: elapsedZero, pauseIntervals } = resolveSessionElapsedBasis(session);
    for (const seg of session.segments) {
      const speaker = seg.speaker || "Speaker";
      const elapsed = formatElapsedClock(segmentElapsedMs(elapsedZero, seg.startedAt, pauseIntervals));
      lines.push(`**${speaker}** \`${elapsed}\`  `);
      lines.push(`${seg.text}  `);
      // F9 fix (v0.7.1 train-2 adversarial review): an empty/whitespace
      // live value (e.g. a gap-fill batch that gave up on this segment,
      // landing "" rather than nothing at all) must still fall back to
      // the summary pair — `??` alone treats "" as present and wins,
      // silently dropping a translation the summary stage actually has.
      const liveZh = liveTranslations[seg.id];
      const zh = liveZh && liveZh.trim().length > 0 ? liveZh : translationByIndex.get(seg.index);
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
    lines.push("| 术语 | 类型 | 英文释义 | 中文释义 | 词典包 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const t of session.terms) {
      lines.push(
        `| ${escapeMdTableCell(t.term)} | ${escapeMdTableCell(t.type)} | ${escapeMdTableCell(
          t.gloss_en,
        )} | ${escapeMdTableCell(t.gloss_zh)} | ${escapeMdTableCell(packName(t.pack))} |`,
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

/** Trigger a save of a pre-built `blob` as `filename` — the app's one
 *  save path; downloadFile below delegates here for the string+mime
 *  case. Every non-iOS build keeps the original throwaway-anchor
 *  download. On iOS, `<a download>.click()` is a silent no-op — the
 *  Tauri WKWebView shell has no download delegate to catch it — so
 *  this hands the file to the OS share sheet (navigator.share)
 *  instead, falling back to the anchor attempt only when share itself
 *  is unavailable. Always resolves: a dismissed share sheet is treated
 *  as a completed export (see AbortError below), and a rejected one
 *  surfaces its own retry toast rather than throwing. */
export async function downloadBlob(filename: string, blob: Blob): Promise<void> {
  if (IS_IOS && typeof navigator.share === "function") {
    const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
    const shareData: ShareData = { files: [file] };
    if (!navigator.canShare || navigator.canShare(shareData)) {
      try {
        await navigator.share(shareData);
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // The user dismissed the share sheet — a cancel, not a
          // failure, so this stays silent (no toast, no fallback).
          return;
        }
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          // Transient activation can expire before share() actually
          // runs (e.g. after an await'd docx build) — WKWebView then
          // refuses the sheet outright. The retry button's own click
          // is a fresh user gesture, so a retry from there can still
          // succeed. Dynamic import: store.ts's own static graph
          // already reaches this file (store -> autoExport -> export),
          // so a top-level `import { useApp } from "@/lib/store"` here
          // would close that cycle — see store.ts's
          // triggerSelectionLookup for the same dynamic-import idiom.
          const { useApp } = await import("@/lib/store");
          useApp.getState().showToast({
            message: "导出未完成，请重试",
            action: { label: "重试", run: () => void downloadBlob(filename, blob) },
          });
          return;
        }
        console.warn("[export] navigator.share failed, falling back to anchor download", err);
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Trigger a save of `content` as `filename` — builds a Blob and
 *  delegates to downloadBlob (see its own doc comment for the iOS
 *  share-sheet path). */
export async function downloadFile(filename: string, content: string, mime: string): Promise<void> {
  await downloadBlob(filename, new Blob([content], { type: mime }));
}

function yamlListItem(s: string): string {
  return `  - "${s.replace(/"/g, '\\"')}"`;
}

function yamlString(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** YAML frontmatter block for exported markdown — Obsidian-compatible
 *  (title/date/duration/engine/expressions/terms/source/schemaVersion).
 *  Shared by the manual export button and the auto-export folder. */
export function buildObsidianFrontmatter(session: MeetingSession): string {
  const durationMin = Math.max(
    0,
    Math.round((session.endedAt - session.startedAt) / 60000),
  );
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

/** Full Markdown payload used by note-taking connectors. Keeping the
 *  frontmatter composition here prevents Obsidian/manual-share callers
 *  from each inventing a subtly different report shape. */
export function buildMarkdownNote(session: MeetingSession): string {
  return `${buildObsidianFrontmatter(session)}\n\n${buildMarkdownReport(session)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A deliberately small Markdown renderer for clipboard interchange.
 *  It covers the report syntax JargonSlayer itself emits (headings,
 *  bullets, quotes, bold speaker labels, paragraphs). The plain-text
 *  Markdown flavour is written alongside it and remains the source of
 *  truth for apps that do not accept HTML. */
export function markdownToClipboardHtml(markdown: string): string {
  const rendered: string[] = [];
  let listOpen = false;

  const closeList = () => {
    if (!listOpen) return;
    rendered.push("</ul>");
    listOpen = false;
  };

  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      rendered.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = /^\s*-\s+(.+)$/.exec(line);
    if (bullet) {
      if (!listOpen) {
        rendered.push("<ul>");
        listOpen = true;
      }
      rendered.push(`<li>${escapeHtml(bullet[1])}</li>`);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      rendered.push(`<blockquote>${escapeHtml(quote[1])}</blockquote>`);
      continue;
    }

    closeList();
    const speaker = /^\*\*(.+?)\*\*\s+`(.+?)`/.exec(line);
    if (speaker) {
      rendered.push(`<p><strong>${escapeHtml(speaker[1])}</strong> <code>${escapeHtml(speaker[2])}</code></p>`);
      continue;
    }
    rendered.push(`<p>${escapeHtml(line.replace(/\s{2}$/, ""))}</p>`);
  }
  closeList();
  return `<article>${rendered.join("\n")}</article>`;
}

/** Copy text to the system clipboard. Resolves false on failure
 *  (unsupported browser, denied permission) instead of throwing. */
export async function copyToClipboard(text: string, html?: string): Promise<boolean> {
  try {
    if (
      html &&
      typeof ClipboardItem !== "undefined" &&
      typeof navigator.clipboard?.write === "function"
    ) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    // Some browsers expose ClipboardItem/write but reject rich writes.
    // Preserve the existing one-click plain-text path before reporting
    // a real failure.
    if (html) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fall through to the shared warning below.
      }
    }
    console.warn("[export] copyToClipboard failed", err);
    return false;
  }
}

/** Copy Markdown with both plain-text and rich HTML clipboard flavours. */
export function copyMarkdownToClipboard(markdown: string): Promise<boolean> {
  return copyToClipboard(markdown, markdownToClipboardHtml(markdown));
}

export type ShareMarkdownResult = "shared" | "downloaded" | "cancelled";

/** Prefer the platform share sheet (where Apple Notes appears), then
 *  fall back to a normal .md export on platforms without Web Share. */
export async function shareMarkdownFile(
  filename: string,
  markdown: string,
): Promise<ShareMarkdownResult> {
  const file = new File([markdown], filename, { type: "text/markdown" });
  const shareData: ShareData = { title: filename.replace(/\.md$/i, ""), files: [file] };
  if (
    typeof navigator.share === "function" &&
    (!navigator.canShare || navigator.canShare(shareData))
  ) {
    try {
      await navigator.share(shareData);
      return "shared";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
      console.warn("[export] shareMarkdownFile failed, falling back to download", err);
    }
  }
  await downloadFile(filename, markdown, "text/markdown");
  return "downloaded";
}

// Re-exported for consumers that want category labels consistent
// with the report (e.g. UI badges) without duplicating the map.
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

// Keep type imports referenced for callers that only need the types
// (avoids an unused-import lint footgun if this file is trimmed later).
export type { ExpressionCard, TermCard };
