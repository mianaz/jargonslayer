// Cornell-note layout model: transcript with jargon highlighted inline,
// numbered right-margin annotations, and a summary block. Pure data —
// no React — so it is fully unit-testable; CornellNote.tsx renders it,
// cornellToMarkdown() serializes it for the agent-native export story.
//
// Matching for the live transcript now lives in src/lib/highlight.ts
// (buildHighlightMatcher, covers both expressions and terms). cornell
// keeps its own variant deliberately: a different sort key (word count
// then length, vs. plain length), first-registration-wins instead of
// last-one-wins, a lang-dependent gloss payload (zh/en), and a frozen
// post-meeting artifact contract — not a candidate for sharing code
// with the live-transcript matcher.

import type {
  ExplainLanguage,
  ExpressionCard,
  MeetingSummary,
  TermCard,
  TranscriptSegment,
} from "@jargonslayer/core/types";

// ---------- input ----------

export interface CornellInput {
  title: string;
  date: number; // epoch ms, used for the sheet header + export filenames
  segments: TranscriptSegment[];
  cards: ExpressionCard[];
  terms: TermCard[];
  summary?: MeetingSummary | null;
  explainLanguage?: ExplainLanguage; // default "zh"
}

// ---------- model ----------

export type AnnotationKind = "expression" | "term";

/** A run of segment text: either plain, or a highlighted span carrying
 *  the annotation number it refers to (first occurrence AND every
 *  repeat of the same headword point at the same `ref`). */
export interface TextRun {
  text: string;
  ref?: number;
}

export interface CornellSegment {
  index: number;
  speaker?: string;
  runs: TextRun[];
}

export interface Annotation {
  n: number; // 1-based, in first-appearance order
  kind: AnnotationKind;
  headword: string;
  gloss: string;
  segmentIndex: number; // segment where this headword first appeared
}

export interface CornellSummaryBlock {
  hasSummary: boolean;
  topicZh: string;
  keyPointsZh: string[];
}

export interface CornellModel {
  empty: boolean; // true when there is nothing to show at all
  title: string;
  date: number;
  segments: CornellSegment[];
  annotations: Annotation[];
  summary: CornellSummaryBlock;
}

// ---------- matcher (session-wide, numbers first occurrence only) ----------

interface MatchEntry {
  kind: AnnotationKind;
  headword: string;
  gloss: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build one combined regex from cards+terms, longest expression first
 *  (by word count, then char length) so multi-word phrases win over
 *  their substrings. The last word of each entry may carry an optional
 *  trailing inflection (s|ed|ing|d), same as TranscriptPanel. */
function buildEntryMatcher(
  cards: ExpressionCard[],
  terms: TermCard[],
  lang: ExplainLanguage,
): { regex: RegExp | null; byLower: Map<string, MatchEntry> } {
  const byLower = new Map<string, MatchEntry>();
  const parts: { pattern: string; wordCount: number; length: number }[] = [];

  const addEntry = (surface: string, entry: MatchEntry) => {
    const trimmed = surface.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    // First registration wins (cards processed before terms below) —
    // acceptable, purely cosmetic tie-break, mirrors TranscriptPanel's
    // "last one wins" comment in spirit (a stable, documented choice).
    if (!byLower.has(lower)) byLower.set(lower, entry);

    const words = trimmed.split(/\s+/);
    const escapedWords = words.map((w, i) => {
      const escaped = escapeRegExp(w);
      const isLast = i === words.length - 1;
      return isLast ? `${escaped}(?:s|ed|ing|d)?` : escaped;
    });
    parts.push({
      pattern: escapedWords.join("\\s+"),
      wordCount: words.length,
      length: trimmed.length,
    });
  };

  for (const card of cards) {
    addEntry(card.expression, {
      kind: "expression",
      headword: card.expression,
      gloss: lang === "en" ? card.plain_english : card.chinese_explanation,
    });
  }
  for (const term of terms) {
    addEntry(term.term, {
      kind: "term",
      headword: term.term,
      gloss: lang === "en" ? term.gloss_en : term.gloss_zh,
    });
  }

  if (parts.length === 0) return { regex: null, byLower };

  const sorted = [...parts].sort(
    (a, b) => b.wordCount - a.wordCount || b.length - a.length,
  );
  const regex = new RegExp(`\\b(${sorted.map((p) => p.pattern).join("|")})\\b`, "giu");
  return { regex, byLower };
}

/** Look up a matched literal's entry, trying the exact match then
 *  stripping a trailing inflection off the last word — same fallback
 *  chain as TranscriptPanel.resolveCardId. */
function resolveEntry(
  byLower: Map<string, MatchEntry>,
  matched: string,
): MatchEntry | undefined {
  const lower = matched.toLowerCase();
  const direct = byLower.get(lower);
  if (direct) return direct;

  const stripped = lower.replace(/(?:ing|ed|s|d)$/u, "");
  for (const [key, entry] of byLower) {
    if (key === stripped || key.replace(/(?:ing|ed|s|d)$/u, "") === stripped) {
      return entry;
    }
    if (lower.startsWith(key)) return entry;
  }
  return undefined;
}

/** Split one segment's text into plain/highlight runs, assigning `ref`
 *  numbers from the shared `registry` (session-wide: first occurrence
 *  of a headword allocates the next number and pushes an Annotation;
 *  later occurrences reuse it without adding a new entry). */
function splitSegmentRuns(
  text: string,
  matcher: { regex: RegExp | null; byLower: Map<string, MatchEntry> },
  registry: Map<string, number>,
  annotations: Annotation[],
  segmentIndex: number,
): TextRun[] {
  if (!matcher.regex) return text ? [{ text }] : [];

  const regex = matcher.regex;
  regex.lastIndex = 0;
  const runs: TextRun[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const matched = match[0];
    if (matched.length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    if (match.index > lastIndex) {
      runs.push({ text: text.slice(lastIndex, match.index) });
    }

    const entry = resolveEntry(matcher.byLower, matched);
    if (entry) {
      const regKey = entry.headword.toLowerCase();
      let n = registry.get(regKey);
      if (n === undefined) {
        n = registry.size + 1;
        registry.set(regKey, n);
        annotations.push({
          n,
          kind: entry.kind,
          headword: entry.headword,
          gloss: entry.gloss,
          segmentIndex,
        });
      }
      runs.push({ text: matched, ref: n });
    } else {
      runs.push({ text: matched });
    }
    lastIndex = match.index + matched.length;
  }

  if (lastIndex < text.length) {
    runs.push({ text: text.slice(lastIndex) });
  }

  return runs;
}

// ---------- public builder ----------

export function buildCornellModel(input: CornellInput): CornellModel {
  const lang: ExplainLanguage = input.explainLanguage ?? "zh";
  const summaryBlock: CornellSummaryBlock = input.summary
    ? {
        hasSummary: true,
        topicZh: input.summary.topic.zh || input.summary.topic.en,
        keyPointsZh: input.summary.key_points.map((p) => p.zh || p.en),
      }
    : { hasSummary: false, topicZh: "", keyPointsZh: [] };

  if (input.segments.length === 0) {
    return {
      empty: true,
      title: input.title,
      date: input.date,
      segments: [],
      annotations: [],
      summary: summaryBlock,
    };
  }

  const matcher = buildEntryMatcher(input.cards, input.terms, lang);
  const registry = new Map<string, number>();
  const annotations: Annotation[] = [];

  const segments: CornellSegment[] = input.segments.map((seg) => ({
    index: seg.index,
    speaker: seg.speaker,
    runs: splitSegmentRuns(seg.text, matcher, registry, annotations, seg.index),
  }));

  return {
    empty: false,
    title: input.title,
    date: input.date,
    segments,
    annotations,
    summary: summaryBlock,
  };
}

// ---------- markdown export ----------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const CIRCLED_DIGITS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

/** Circled-digit ref marker for n<=20 (①-⑳), falls back to "(n)" beyond
 *  that range rather than silently truncating a real meeting's cards. */
function refMarker(n: number): string {
  if (n >= 1 && n <= CIRCLED_DIGITS.length) return CIRCLED_DIGITS[n - 1];
  return `(${n})`;
}

/** Render one segment's runs as Markdown: highlighted spans become
 *  **bold** text followed by their ①-style ref marker. */
function renderSegmentMarkdown(seg: CornellSegment): string {
  return seg.runs
    .map((run) => (run.ref ? `**${run.text}**${refMarker(run.ref)}` : run.text))
    .join("");
}

/** Cornell-structured Markdown: title, 转录正文 (bold highlights + circled
 *  refs), 批注 (ordered annotation list), 小结 (topic + key points). */
export function cornellToMarkdown(model: CornellModel): string {
  const lines: string[] = [];
  lines.push(`# ${model.title} · 康奈尔笔记`);
  lines.push(`${formatDate(model.date)}`);
  lines.push("");

  lines.push("## 转录正文");
  if (model.empty) {
    lines.push("（无转录内容）");
  } else {
    for (const seg of model.segments) {
      const speaker = seg.speaker ? `**${seg.speaker}**　` : "";
      lines.push(`${speaker}${renderSegmentMarkdown(seg)}`);
      lines.push("");
    }
  }

  lines.push("## 批注");
  if (model.annotations.length === 0) {
    lines.push("（未检测到表达/术语）");
  } else {
    for (const a of model.annotations) {
      lines.push(`${refMarker(a.n)} **${a.headword}** — ${a.gloss}`);
    }
  }
  lines.push("");

  lines.push("## 小结");
  if (!model.summary.hasSummary) {
    lines.push("尚未生成纪要");
  } else {
    lines.push(`**主题**：${model.summary.topicZh}`);
    if (model.summary.keyPointsZh.length > 0) {
      lines.push("");
      for (const p of model.summary.keyPointsZh) {
        lines.push(`- ${p}`);
      }
    }
  }
  lines.push("");

  return lines.join("\n");
}
