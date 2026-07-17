// Text-transcript import orchestration (#43 phase 1): the paste/
// upload counterpart to stt/upload.ts's recording import — builds a
// full MeetingSession from raw transcript text (paste, or a .txt/
// .srt/.vtt export) fully offline (parse + detect + translate all
// resolved before save), then a single storage.saveSession. No store
// interplay during processing and no gen guards, mirroring upload.ts's
// buildSessionFromJob/buildSessionFromCloudSegments — the caller (UI)
// does loadSession + toast afterward, same division of labor as
// importAndTrack.

import {
  newId,
  type MeetingSession,
  type Settings,
  type TranscriptSegment,
} from "@jargonslayer/core/types";
import { NoKeyError, RateLimitApiError, translateApi } from "../llm/client";
import { formatLlmDetectFailureWarning, runDetectionPipeline } from "../stt/upload";
import * as storage from "../history/storage";
import { parseTranscript, ParseTranscriptError } from "./parseTranscript";

export { ParseTranscriptError };

const PLAIN_TEXT_SPACING_MS = 4_000;
const TRANSLATE_BATCH_SIZE = 6;
const RATE_LIMIT_WAIT_MS = 65_000;
const MAX_WAITS_PER_BATCH = 2;
const MAX_WAITS_PER_RUN = 5;
// One short-delay retry for transient upstream failures — an import
// is a single pass, so a brief 5xx window (observed twice on the
// hosted gateway, 2026-07-06) would otherwise permanently strand a
// batch untranslated. Matches runDetectionPipeline's constant.
const TRANSIENT_RETRY_DELAY_MS = 4_000;

export interface ImportTextOptions {
  raw: string;
  filename?: string;
  title?: string;
  translate: boolean;
  settings: Settings;
  onProgress: (phase: "parse" | "detect" | "translate", done: number, total: number) => void;
}

export interface ImportTextResult {
  sessionId: string;
  warnings: string[];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Same auto-title convention as store.ts's saveCurrentSession
 *  ("会议 YYYY-MM-DD HH:MM") — this is the "导入的文稿" sibling for
 *  when neither an explicit title nor a filename is available. */
function defaultDateTitle(atMs: number): string {
  const d = new Date(atMs);
  return `导入的文稿 ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

/** Strip a recognized transcript extension to get the filename stem
 *  ("meeting.srt" -> "meeting"); any other/no extension is returned
 *  as-is. */
function filenameStem(filename: string): string {
  return filename.replace(/\.(txt|srt|vtt)$/i, "");
}

function resolveTitle(opts: Pick<ImportTextOptions, "title" | "filename">, now: number): string {
  if (opts.title?.trim()) return opts.title.trim();
  if (opts.filename?.trim()) return `导入 ${filenameStem(opts.filename.trim())}`;
  return defaultDateTitle(now);
}

/** Build the synthetic segment timeline: cue timestamps when the
 *  parse provided them (mirrors upload.ts's "import happened now" base
 *  + offset comment), otherwise PLAIN_TEXT_SPACING_MS per segment for
 *  timestamp-less plain text. */
function buildSegments(
  parsed: ReturnType<typeof parseTranscript>,
  base: number,
): TranscriptSegment[] {
  const hasTimestamps = parsed.segments.some((s) => s.startMs !== undefined);
  // Normalize cue times so the FIRST cue lands at `base` — a trimmed
  // export whose first cue starts at e.g. 00:10:00 must not produce a
  // session stamped ten minutes in the future (breaks history sort and
  // duration display). Recordings never hit this (jobs start ~0s).
  const originMs = hasTimestamps
    ? Math.min(...parsed.segments.map((s) => s.startMs ?? Infinity))
    : 0;

  return parsed.segments.map((s, i) => {
    const startedAt = hasTimestamps
      ? base + ((s.startMs ?? originMs) - originMs)
      : base + i * PLAIN_TEXT_SPACING_MS;
    const endedAt = hasTimestamps
      ? base + ((s.endMs ?? s.startMs ?? originMs) - originMs)
      : base + (i + 1) * PLAIN_TEXT_SPACING_MS;

    return {
      id: newId(),
      index: i,
      startedAt,
      endedAt,
      speaker: s.speaker,
      text: s.text,
      engine: "import",
    };
  });
}

/** Sequential batches of TRANSLATE_BATCH_SIZE through /api/translate,
 *  same rate-limit pacing shape as runDetectionPipeline: a 429 waits
 *  65s and retries the same batch, up to MAX_WAITS_PER_BATCH per batch
 *  and MAX_WAITS_PER_RUN for the whole call — beyond the run-level cap
 *  specifically, translation stops for every remaining batch (keeping
 *  whatever already translated) with one zh warning. NoKeyError stops
 *  translating silently (its own warning, no retry). Any other error
 *  skips just that batch and continues. Exported so importAudio.ts
 *  (#43 phase 2a) reuses the identical translate pacing rather than
 *  duplicating it. */
export async function runTranslation(
  segments: TranscriptSegment[],
  settings: Settings,
  warnings: string[],
  onProgress: ImportTextOptions["onProgress"],
): Promise<Record<string, string>> {
  const translations: Record<string, string> = {};
  const batches: TranscriptSegment[][] = [];
  for (let i = 0; i < segments.length; i += TRANSLATE_BATCH_SIZE) {
    batches.push(segments.slice(i, i + TRANSLATE_BATCH_SIZE));
  }

  let runWaits = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    let batchWaits = 0;
    let transientRetried = false;

    for (;;) {
      try {
        const res = await translateApi(
          {
            segments: batch.map((s) => ({ id: s.id, text: s.text })),
            lang: settings.explainLanguage,
          },
          settings,
        );
        for (const t of res.translations) translations[t.id] = t.text;
        break;
      } catch (err) {
        if (
          err instanceof RateLimitApiError &&
          batchWaits < MAX_WAITS_PER_BATCH &&
          runWaits < MAX_WAITS_PER_RUN
        ) {
          batchWaits++;
          runWaits++;
          await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
          continue;
        }
        if (err instanceof RateLimitApiError && runWaits >= MAX_WAITS_PER_RUN) {
          warnings.push("翻译请求多次被限流，已停止翻译剩余内容");
          onProgress("translate", batches.length, batches.length);
          return translations;
        }
        if (err instanceof RateLimitApiError) {
          // This batch's own per-batch cap exhausted (run budget not
          // yet spent) — skip just this batch, same as "any other
          // error" below, and move on to the next one.
          break;
        }
        if (err instanceof NoKeyError) {
          warnings.push("未配置 API Key，已跳过中文对照");
          onProgress("translate", batches.length, batches.length);
          return translations;
        }
        // Transient upstream failure: one short-delay retry (see
        // TRANSIENT_RETRY_DELAY_MS above), then skip this batch and
        // keep going.
        if (!transientRetried) {
          transientRetried = true;
          await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
          continue;
        }
        break;
      }
    }

    onProgress("translate", i + 1, batches.length);
  }

  return translations;
}

/** Parse -> detect -> (optional) translate -> save, fully offline
 *  except for the shared detect/translate API calls. Never touches
 *  the store — the caller does loadSession(sessionId) + toast, same
 *  division of labor as importAndTrack in stt/upload.ts. */
export async function importTranscriptText(
  opts: ImportTextOptions,
): Promise<ImportTextResult> {
  const { raw, filename, translate, settings, onProgress } = opts;

  onProgress("parse", 0, 1);
  const parsed = parseTranscript(raw, filename);
  onProgress("parse", 1, 1);

  const base = Date.now();
  const segments = buildSegments(parsed, base);
  const warnings = [...parsed.warnings];

  const segmentTexts = segments.map((s) => ({ text: s.text }));
  const { cards, terms } = await runDetectionPipeline(
    segmentTexts,
    segments,
    settings,
    (done, total) => onProgress("detect", done, total),
    () => warnings.push("检测请求多次被限流，剩余内容已切换到词典模式"),
    // v0.4.4 field-fix (finding 3) / R6 (Sol F5/F6): the NoKeyError/
    // persistent-failure/per-batch-rate-limit-degraded sibling of the
    // run-level rate-limit warning above — see runDetectionPipeline's
    // own onLlmDetectFailure doc comment for the majority-failed
    // trigger, and formatLlmDetectFailureWarning's own doc for the
    // zero-vs-some-succeeded template split (shared with upload.ts's
    // buildSessionFromSegments so both never drift apart).
    (message, partial) => warnings.push(formatLlmDetectFailureWarning(message, partial)),
  );

  let translations: Record<string, string> | undefined;
  if (translate && segments.length > 0) {
    translations = await runTranslation(segments, settings, warnings, onProgress);
  }

  const startedAt = segments.length > 0 ? segments[0].startedAt : base;
  const endedAt = segments.length > 0 ? segments[segments.length - 1].endedAt : base;

  const session: MeetingSession = {
    id: newId(),
    title: resolveTitle({ title: opts.title, filename }, base),
    startedAt,
    endedAt,
    engine: "import",
    segments,
    cards,
    terms,
    translations,
  };

  await storage.saveSession(session);

  return { sessionId: session.id, warnings };
}
