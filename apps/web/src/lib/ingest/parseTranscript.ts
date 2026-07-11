// Transcript-text ingestion (#43 phase 1) — parses a pasted or
// uploaded meeting transcript (Zoom/Otter-style .srt/.vtt exports, or
// plain text) into speaker/timestamp-aware segments, fully offline
// and synchronous. Pure — no network, no storage, no store access;
// importText.ts consumes this to build a MeetingSession.

export type TranscriptFormat = "srt" | "vtt" | "plain";

export interface ParsedSegment {
  speaker?: string;
  text: string;
  startMs?: number;
  endMs?: number;
}

export interface ParsedTranscript {
  segments: ParsedSegment[];
  format: TranscriptFormat;
  warnings: string[];
}

/** Thrown for the two hard caps (raw input too large, too many
 *  segments after merge) — message is already zh and UI-ready. */
export class ParseTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseTranscriptError";
  }
}

const RAW_CHAR_CAP = 200_000;
const MAX_SEGMENTS = 2000;
const MERGE_MAX_CHARS = 400;

// ---------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------

const SRT_CUE_TIME_RE =
  /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/;

function detectFormat(raw: string, filename?: string): TranscriptFormat {
  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "srt") return "srt";
  if (ext === "vtt") return "vtt";

  const trimmed = raw.trimStart();
  if (/^WEBVTT/.test(trimmed)) return "vtt";
  if (SRT_CUE_TIME_RE.test(raw)) return "srt";
  return "plain";
}

// ---------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------

/** Strip HTML-ish cue tags (<i>, <b>, <font color="...">, </font>, …)
 *  used by both SRT and VTT cue text. */
function stripTags(text: string): string {
  return text.replace(/<\/?[a-zA-Z][^>]*>/g, "").trim();
}

// Speaker prefix: 1-24 chars of letters/digits/space/._- (no colon —
// guaranteed by the character class), followed by ":" (half- or
// full-width — hand-typed Chinese notes routinely use "张三：") and
// non-empty remaining text. Matches both "Alice: hi" and "Alice:hi".
// Applied only to single-line (newline-free) cue/line text, so `.`
// needing to match "any character" (dotAll) never comes up — the `s`
// flag would require an ES2018+ target, which this repo doesn't set.
const SPEAKER_PREFIX_RE = /^([\p{L}\p{N} ._-]{1,24})[:：]\s*(\S.*)$/u;

/** Extract a leading "NAME:" speaker prefix from one line/cue's text,
 *  trimming it off. Returns the original text untouched when no
 *  speaker prefix is present. */
function extractSpeakerPrefix(text: string): { speaker?: string; text: string } {
  const m = SPEAKER_PREFIX_RE.exec(text);
  if (!m) return { text };
  return { speaker: m[1].trim(), text: m[2].trim() };
}

/** Strip a single leading "- " dialogue dash (SRT convention for
 *  multi-speaker cues), then the NAME: prefix fallback. */
function normalizeCueLine(line: string): string {
  return line.replace(/^-\s+/, "");
}

function msFromClock(h: string, m: string, s: string, frac: string): number {
  // frac may be 1-3 digits (".5", ".50", ".500") — normalize to ms.
  const ms = Number(frac.padEnd(3, "0").slice(0, 3));
  return (
    Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1_000 + ms
  );
}

// ---------------------------------------------------------------
// SRT
// ---------------------------------------------------------------

const SRT_TIME_LINE_RE =
  /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function parseSrt(raw: string, warnings: string[]): ParsedSegment[] {
  const blocks = raw.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const segments: ParsedSegment[] = [];
  let skipped = 0;

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;

    const lines = block.split("\n");
    let i = 0;
    // Optional bare-integer index line.
    if (/^\d+$/.test(lines[i]?.trim() ?? "")) i++;

    const timeMatch = SRT_TIME_LINE_RE.exec(lines[i]?.trim() ?? "");
    if (!timeMatch) {
      skipped++;
      continue;
    }
    i++;

    const startMs = msFromClock(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
    const endMs = msFromClock(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);

    const textLines = lines
      .slice(i)
      .map((l) => stripTags(normalizeCueLine(l.trim())))
      .filter(Boolean);
    if (textLines.length === 0) {
      skipped++;
      continue;
    }

    const joined = textLines.join(" ");
    const { speaker, text } = extractSpeakerPrefix(joined);
    if (!text) {
      skipped++;
      continue;
    }

    segments.push({ speaker, text, startMs, endMs });
  }

  if (skipped > 0) {
    warnings.push(`跳过 ${skipped} 个无法解析的字幕块`);
  }

  return segments;
}

// ---------------------------------------------------------------
// VTT
// ---------------------------------------------------------------

const VTT_TIME_LINE_RE =
  /^(?:(\d{1,2}):)?(\d{2}):(\d{2})[.](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.](\d{1,3})/;

const VTT_VOICE_TAG_RE = /<v(?:\.[^\s>]+)?\s+([^>]+)>/;

function parseVttTimestamp(h: string | undefined, m: string, s: string, frac: string): number {
  return msFromClock(h ?? "0", m, s, frac);
}

function parseVtt(raw: string, warnings: string[]): ParsedSegment[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const segments: ParsedSegment[] = [];
  let skipped = 0;
  let i = 0;

  // Skip the WEBVTT header line (and anything else before the first
  // blank line / first cue) — metadata headers may follow on the same
  // "block" as WEBVTT per spec, but in practice exports keep it to one
  // line; either way we just need to not misread it as a cue.
  if (/^WEBVTT/.test(lines[i]?.trim() ?? "")) i++;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (!line) {
      i++;
      continue;
    }

    // NOTE / STYLE / REGION blocks: skip through the next blank line.
    if (/^(NOTE|STYLE|REGION)\b/.test(line)) {
      i++;
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }

    // Optional cue-identifier line before the timestamp line.
    let timeLineIdx = i;
    if (!VTT_TIME_LINE_RE.test(line)) {
      timeLineIdx = i + 1;
    }

    const timeLine = lines[timeLineIdx]?.trim() ?? "";
    const timeMatch = VTT_TIME_LINE_RE.exec(timeLine);
    if (!timeMatch) {
      // Not a cue we can parse — advance past this block through the
      // next blank line and count it as skipped (unless it was just a
      // stray blank/identifier-only line, already handled above).
      skipped++;
      i = timeLineIdx + 1;
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }

    const startMs = parseVttTimestamp(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
    const endMs = parseVttTimestamp(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);
    // Cue settings (align/position/size/…) after the second timestamp
    // are already excluded since the regex is unanchored at the end —
    // nothing further to strip.

    i = timeLineIdx + 1;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }

    if (textLines.length === 0) {
      skipped++;
      continue;
    }

    const joined = textLines.map((l) => normalizeCueLine(l.trim())).join(" ");
    const voiceMatch = VTT_VOICE_TAG_RE.exec(joined);
    let speaker: string | undefined;
    let text: string;
    if (voiceMatch) {
      speaker = voiceMatch[1].trim();
      text = stripTags(joined.replace(VTT_VOICE_TAG_RE, "").replace(/<\/v>/g, ""));
    } else {
      const stripped = stripTags(joined);
      const extracted = extractSpeakerPrefix(stripped);
      speaker = extracted.speaker;
      text = extracted.text;
    }

    if (!text) {
      skipped++;
      continue;
    }

    segments.push({ speaker, text, startMs, endMs });
  }

  if (skipped > 0) {
    warnings.push(`跳过 ${skipped} 个无法解析的字幕块`);
  }

  return segments;
}

// ---------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------

function parsePlain(raw: string): ParsedSegment[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const segments: ParsedSegment[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const { speaker, text } = extractSpeakerPrefix(trimmed);
    if (!text) continue;
    segments.push({ speaker, text });
  }
  return segments;
}

// ---------------------------------------------------------------
// Merge pass — subtitle exports routinely split one sentence across
// several cues; coalesce consecutive same-speaker cues that don't yet
// end a sentence, up to a length cap. Deterministic single pass.
// ---------------------------------------------------------------

function endsSentence(text: string): boolean {
  return /[.?!]\s*$/.test(text.trimEnd());
}

function mergeSegments(segments: ParsedSegment[]): ParsedSegment[] {
  const merged: ParsedSegment[] = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    const sameSpeaker = prev !== undefined && prev.speaker === seg.speaker;
    const combinedLength = prev ? prev.text.length + 1 + seg.text.length : 0;
    if (
      prev &&
      sameSpeaker &&
      !endsSentence(prev.text) &&
      combinedLength < MERGE_MAX_CHARS
    ) {
      prev.text = `${prev.text} ${seg.text}`;
      if (seg.endMs !== undefined) prev.endMs = seg.endMs;
      continue;
    }
    merged.push({ ...seg });
  }
  return merged;
}

// ---------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------

export function parseTranscript(raw: string, filename?: string): ParsedTranscript {
  if (raw.length > RAW_CHAR_CAP) {
    throw new ParseTranscriptError(
      `文本过长（超过 ${RAW_CHAR_CAP.toLocaleString()} 字符），请拆分后再导入`,
    );
  }

  const format = detectFormat(raw, filename);
  const warnings: string[] = [];

  let rawSegments: ParsedSegment[];
  if (format === "srt") {
    rawSegments = parseSrt(raw, warnings);
  } else if (format === "vtt") {
    rawSegments = parseVtt(raw, warnings);
  } else {
    rawSegments = parsePlain(raw);
  }

  const segments = mergeSegments(rawSegments);

  if (segments.length > MAX_SEGMENTS) {
    throw new ParseTranscriptError(
      `解析后段落过多（${segments.length} 段，上限 ${MAX_SEGMENTS} 段），请拆分后再导入`,
    );
  }

  return { segments, format, warnings };
}
