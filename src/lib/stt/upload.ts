// Upload-a-recording transcription: PUT a recording file to the local
// Whisper sidecar's HTTP job API and poll progress, then converge on
// the shared detection/merge stage (runDetectionPipeline below) to
// build a full MeetingSession — LLM with dictionary fallback, plus the
// personal glossary, mirroring live meeting detection. (#66 removed
// the second acquisition path that lived here — POST to the #22 cloud
// transcription route — per the "BYOK is LLM-only" decision; keyless
// batch transcription is importAudio.ts's in-browser Whisper.)

import {
  newId,
  type DetectResponse,
  type ExpressionCard,
  type MeetingSession,
  type Settings,
  type STTEngineKind,
  type TermCard,
  type TranscriptSegment,
} from "../types";
import { detectApi, NoKeyError, RateLimitApiError, taskHeaders } from "../llm/client";
import { scanDictionary } from "../detect/dictionary";
import { scanCustomEntries } from "../history/glossary";
import { mergeDetections } from "../detect/dedupe";
import * as storage from "../history/storage";
import { useApp } from "../store";
import { withBase } from "../basePath";

const BATCH_CHARS = 1200;
const CONTEXT_TAIL_CHARS = 800;
const POLL_INTERVAL_MS = 1500;
// Rate-limit pacing (#43): the server enforces a fixed 60s window, so
// a 429 mid-import is worth waiting out rather than immediately
// falling back to the offline dictionary for the rest of a long
// transcript. Caps keep a persistently-limited run from hanging
// forever — beyond either, remaining batches go straight to the
// dictionary (today's existing no-key/failure behavior), and the
// caller learns about it via the optional onProgress-sibling callback
// (see runDetectionPipeline below).
const RATE_LIMIT_WAIT_MS = 65_000;
const MAX_WAITS_PER_BATCH = 2;
const MAX_WAITS_PER_RUN = 5;
const TRANSIENT_RETRY_DELAY_MS = 4_000;

export interface JobSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface JobStatus {
  id: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  status_detail: string | null;
  segments: JobSegment[];
  error: string | null;
  diarized: boolean;
  warning: string | null;
  /** URL-import (#43 phase 2c) jobs only: the captured video title,
   *  else the URL's last path segment — resolved server-side since the
   *  client only has the URL upfront. undefined/null for upload-path
   *  jobs (the client already knows file.name before the job starts,
   *  so it never needs this echoed back). */
  display_name?: string | null;
}

/** ws://host:port -> http://host:8766 — the sidecar's job API always
 * runs on port 8766 regardless of the configured ws port; we simply
 * swap the protocol and force that port rather than trying to derive
 * it, since the two servers are started together by the same process
 * with independent (but conventionally-paired) --port/--http-port. */
export function httpBaseFromWs(whisperUrl: string): string {
  try {
    const u = new URL(whisperUrl);
    u.protocol = "http:";
    u.port = "8766";
    return u.origin;
  } catch {
    return "http://localhost:8766";
  }
}

export async function uploadRecording(
  file: File,
  settings: Settings,
  diarize: boolean = true,
): Promise<{ jobId: string }> {
  const base = httpBaseFromWs(settings.whisperUrl);
  let url = `${base}/transcribe?filename=${encodeURIComponent(file.name)}&language=${encodeURIComponent(
    settings.language.split("-")[0],
  )}`;
  if (settings.hfToken) {
    url += `&diarize=${diarize ? "1" : "0"}&hf_token=${encodeURIComponent(settings.hfToken)}`;
  }

  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });

  if (!res.ok) {
    throw new Error(`上传失败（${res.status}）`);
  }

  const body = (await res.json()) as { job_id: string };
  return { jobId: body.job_id };
}

/** GET /health on the sidecar's job API: reports whether speaker
 * diarization is ready to run (pyannote importable + a token
 * available). 3s timeout; returns null on any failure (sidecar
 * unreachable, timeout, bad response) so callers can render a single
 * "can't reach sidecar" state without try/catch plumbing. */
export async function fetchSidecarHealth(
  settings: Settings,
): Promise<{ ok: boolean; diarization_ready: boolean; diarization_error: string | null } | null> {
  const base = httpBaseFromWs(settings.whisperUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as {
      ok: boolean;
      diarization_ready: boolean;
      diarization_error: string | null;
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function pollJob(
  jobId: string,
  settings: Settings,
): Promise<JobStatus> {
  const base = httpBaseFromWs(settings.whisperUrl);
  const res = await fetch(`${base}/jobs/${jobId}`);
  if (!res.ok) {
    throw new Error(`查询任务状态失败（${res.status}）`);
  }
  return (await res.json()) as JobStatus;
}

/** Split segment texts into ~BATCH_CHARS-sized batches for detection,
 * keeping each batch's segments together for later reference. Typed on
 * the minimal `{text}` shape (rather than JobSegment) so both the
 * sidecar-job path and the cloud path — which carries no
 * start/end/speaker beyond what TranscriptSegment already has — can
 * feed it identically via runDetectionPipeline. */
function chunkSegmentTexts(segments: { text: string }[]): string[] {
  const batches: string[] = [];
  let current = "";
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    if (current && current.length + 1 + text.length > BATCH_CHARS) {
      batches.push(current);
      current = text;
    } else {
      current = current ? `${current} ${text}` : text;
    }
  }
  if (current) batches.push(current);
  return batches;
}

export interface DetectionPipelineResult {
  cards: ExpressionCard[];
  terms: TermCard[];
}

/** Shared detection/merge stage for every import path (sidecar job,
 * browser-Whisper import, text import #43): runs LLM detection per
 * ~1200-char batch (falling back to the offline dictionary on
 * no-key/failure), plus a per-segment personal-glossary scan —
 * mirroring the live meeting detection mix. Takes plain `{text}`
 * items rather than JobSegment so plain segments (which carry no
 * `speaker`) can feed it identically.
 *
 * Rate-limit pacing (#43): a 429 is retried in place after a 65s wait
 * (the server's fixed window) rather than immediately giving up on
 * that batch, up to MAX_WAITS_PER_BATCH per batch. A separate,
 * run-wide MAX_WAITS_PER_RUN budget also caps total waits across every
 * batch — a lone batch merely exhausting its OWN per-batch cap falls
 * back to the dictionary for that batch alone (the next batch still
 * gets a fresh attempt), but once the RUN-level budget itself is
 * spent, the endpoint has proven persistently rate-limited and every
 * remaining batch (including the one that tripped it) falls back to
 * the dictionary directly with no further detectApi attempts;
 * `onRateLimitFallback` fires once at that point so the caller can
 * surface a warning. `onProgress` is called after each batch completes
 * (success, dictionary fallback, or rate-limit fallback all count as
 * "done"). Both new params are optional and trailing so the existing
 * sidecar-job/cloud call sites keep compiling unchanged. */
export async function runDetectionPipeline(
  segmentTexts: { text: string }[],
  finalSegments: TranscriptSegment[],
  settings: Settings,
  onProgress?: (done: number, total: number) => void,
  onRateLimitFallback?: () => void,
): Promise<DetectionPipelineResult> {
  let cards: ExpressionCard[] = [];
  let terms: TermCard[] = [];
  const now = Date.now();

  // ---- batched LLM/dictionary detection over the joined text ----
  const batches = chunkSegmentTexts(segmentTexts);
  let tail = "";
  let runWaits = 0;
  let rateLimitLatched = false;
  let rateLimitFallbackFired = false;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const context = tail.slice(-CONTEXT_TAIL_CHARS);
    let batchWaits = 0;
    let transientRetried = false;
    let res: DetectResponse | null = null;

    // settings.aiDetect off (#54) = the user chose fully offline — the
    // import paths honor it the same way the live scheduler does:
    // dictionary only, zero API calls.
    if (settings.aiDetect && !rateLimitLatched) {
      for (;;) {
        try {
          res = await detectApi({ context, new_text: batch }, settings);
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
            // The RUN-level cap (not just this batch's own cap) is
            // what stopped the retry — the endpoint has now proven
            // persistently rate-limited across multiple batches, so
            // stop attempting the LLM for every remaining batch too
            // (a lone batch exhausting only its own per-batch cap does
            // NOT latch — the next batch still gets a fresh attempt).
            rateLimitLatched = true;
            if (!rateLimitFallbackFired) {
              rateLimitFallbackFired = true;
              onRateLimitFallback?.();
            }
          }
          // Transient upstream failures (5xx blips at the model
          // gateway, brief network errors) get ONE short-delay retry:
          // an import is a single pass, so a 5-second bad window would
          // otherwise permanently degrade this batch to the dictionary
          // — observed live 2026-07-06 (two OpenRouter 502 windows
          // within ~40min). Rate-limit has its own pacing above;
          // NoKeyError can't succeed on retry.
          if (
            !(err instanceof RateLimitApiError) &&
            !(err instanceof NoKeyError) &&
            !transientRetried
          ) {
            transientRetried = true;
            await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
            continue;
          }
          // NoKeyError, a lone batch's own per-batch cap exhausted, or
          // a repeated failure — fall back to the offline dictionary
          // for this batch only, exactly like today.
          break;
        }
      }
    }

    if (res) {
      const merged = mergeDetections(cards, terms, res, "llm", settings.minConfidence, now);
      cards = merged.cards;
      terms = merged.terms;
    } else {
      const fallback = scanDictionary(batch);
      const merged = mergeDetections(
        cards,
        terms,
        fallback,
        "dictionary",
        settings.minConfidence,
        now,
      );
      cards = merged.cards;
      terms = merged.terms;
    }

    tail = `${tail} ${batch}`.slice(-CONTEXT_TAIL_CHARS);
    onProgress?.(i + 1, batches.length);
  }

  // ---- per-segment personal glossary scan ----
  for (const seg of finalSegments) {
    const hits = scanCustomEntries(seg.text);
    if (hits.expressions.length > 0 || hits.terms.length > 0) {
      const merged = mergeDetections(cards, terms, hits, "custom", settings.minConfidence, now);
      cards = merged.cards;
      terms = merged.terms;
    }
  }

  return { cards, terms };
}

/** Build a full session (transcript + detected cards/terms) from a
 * finished job. Runs LLM detection per ~1200-char batch (falling back
 * to the offline dictionary on no-key/failure), plus a per-segment
 * personal-glossary scan — mirroring the live meeting detection mix. */
export async function buildSessionFromJob(
  job: JobStatus,
  settings: Settings,
  filename: string,
): Promise<MeetingSession> {
  // Synthetic timeline: segment offsets (seconds, from the job) laid
  // out relative to a single "import happened now" base timestamp so
  // ordering/durations stay faithful without claiming a false
  // real-world start time.
  const base = Date.now();
  const segments: TranscriptSegment[] = job.segments.map((s, i) => ({
    id: newId(),
    index: i,
    startedAt: base + Math.round(s.start * 1000),
    endedAt: base + Math.round(s.end * 1000),
    speaker: s.speaker,
    text: s.text.trim(),
    engine: "whisper",
  }));

  const { cards, terms } = await runDetectionPipeline(job.segments, segments, settings);

  const startedAt = segments.length > 0 ? segments[0].startedAt : base;
  const endedAt = segments.length > 0 ? segments[segments.length - 1].endedAt : base;

  return {
    id: newId(),
    title: `导入 ${filename}`,
    startedAt,
    endedAt,
    engine: "whisper",
    segments,
    cards,
    terms,
  };
}

// ---------------------------------------------------------------
// Plain already-transcribed segments (#66: the cloud transcription
// path that used to live here — POST /api/transcribe-cloud — was
// sunset with the "BYOK is LLM-only" decision; the in-browser Whisper
// import (importAudio.ts) is the keyless batch-transcription story
// now. This shape is what every acquisition method converges on.)
// ---------------------------------------------------------------

export interface PlainTranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** Build a full session (transcript + detected cards/terms) from
 * already-transcribed {start,end,text} segments, parameterized on
 * `engine`/`title` so both the cloud path (#22) and the in-browser
 * Whisper path (#43 phase 2a, importAudio.ts) share one
 * implementation — only the acquisition method differs, everything
 * downstream (timeline synthesis, runDetectionPipeline) is identical. */
export async function buildSessionFromSegments(
  segments: PlainTranscriptSegment[],
  settings: Settings,
  opts: { title: string; engine: STTEngineKind },
): Promise<MeetingSession> {
  const base = Date.now();
  const finalSegments: TranscriptSegment[] = segments.map((s, i) => ({
    id: newId(),
    index: i,
    startedAt: base + Math.round(s.start * 1000),
    endedAt: base + Math.round(s.end * 1000),
    text: s.text.trim(),
    engine: opts.engine,
  }));

  const { cards, terms } = await runDetectionPipeline(segments, finalSegments, settings);

  const startedAt = finalSegments.length > 0 ? finalSegments[0].startedAt : base;
  const endedAt =
    finalSegments.length > 0 ? finalSegments[finalSegments.length - 1].endedAt : base;

  return {
    id: newId(),
    title: opts.title,
    startedAt,
    endedAt,
    engine: opts.engine,
    segments: finalSegments,
    cards,
    terms,
  };
}

export interface ImportCallbacks {
  onProgress: (progress: number, phase: string) => void;
  onDone: (sessionId: string) => void;
  onError: (msg: string) => void;
}

export interface ImportOptions {
  // #66: the "cloud" mode variant (POST /api/transcribe-cloud, #22)
  // was sunset — BYOK is LLM-only by product decision; the sidecar is
  // the only recorded-audio path here (browser-Whisper imports live in
  // importAudio.ts and never used this options shape).
  /** Request speaker diarization for this upload (still requires
   *  settings.hfToken to actually run). Default true. */
  diarize?: boolean;
}

/** status_detail -> Chinese phase label for a sidecar job's polled
 * status. The upload path's own detail values (`"diarizing"`,
 * `null`); `importUrlAndTrack` passes a wider mapper that also covers
 * URL-import's own `"下载中"` value (see JobStatus.status_detail /
 * whisper_server.py's new_job doc). Kept as a plain function (not a
 * lookup table) so the default case stays exactly today's `? :`
 * one-liner for the existing upload call sites. */
function phaseForStatusDetail(statusDetail: string | null): string {
  if (statusDetail === "diarizing") return "说话人分离中";
  if (statusDetail === "下载中") return "下载中";
  return "转录中";
}

/** Poll a sidecar job to completion (status "done"), calling
 * `onProgress` on every poll and reporting the phase label via
 * `phaseForStatusDetail`. Throws the job's own error message on
 * status "error" (caller's try/catch turns that into onError,
 * mirroring importAndTrack's pre-extraction try/catch exactly) —
 * shared by both importAndTrack (uploaded file) and importUrlAndTrack
 * (#43 phase 2c, URL import), which otherwise differ only in how the
 * job was started (uploadRecording vs ingestUrl) and what they pass to
 * buildSessionFromJob as the display filename. */
async function pollJobUntilDone(
  jobId: string,
  settings: Settings,
  onProgress: (progress: number, phase: string) => void,
): Promise<JobStatus> {
  let job: JobStatus;
  for (;;) {
    job = await pollJob(jobId, settings);

    if (job.status === "error") {
      throw new Error(job.error ?? "转录失败");
    }

    onProgress(job.progress, phaseForStatusDetail(job.status_detail));

    if (job.status === "done") break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return job;
}

/** Orchestrates the full upload -> poll -> detect -> save -> load
 * flow for one recording via the local sidecar's job API. Never
 * throws — reports outcomes via the provided callbacks so a caller
 * (e.g. HistoryDrawer) can track many concurrent imports without
 * try/catch plumbing per call site. */
export async function importAndTrack(
  file: File,
  settings: Settings,
  callbacks: ImportCallbacks,
  opts: ImportOptions = {},
): Promise<void> {
  const { onProgress, onDone, onError } = callbacks;

  try {
    onProgress(0, "转录中");
    const { jobId } = await uploadRecording(file, settings, opts.diarize ?? true);

    const job = await pollJobUntilDone(jobId, settings, onProgress);

    onProgress(job.progress, "构建会话");
    const session = await buildSessionFromJob(job, settings, file.name);

    await storage.saveSession(session);
    await useApp.getState().loadSession(session.id);

    onDone(session.id);
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : "导入失败，请确认 sidecar 已启动且 --http-port 开启";
    onError(msg);
  }
}

// ---------------------------------------------------------------
// URL import (#43 phase 2c, LOCAL TIER ONLY) — the sidecar's own
// yt-dlp download runs on the USER's machine/IP, so this path only
// ever targets the local Whisper sidecar's job API (no "cloud" mode
// counterpart, unlike importAndTrack above): the hosted demo can't
// legally/technically run it (datacenter-side YouTube ripping is a
// DMCA §1201 liability, and YouTube blocks datacenter IPs anyway).
// ---------------------------------------------------------------

/** POST {httpBase}/ingest-url — same language/diarize/hf_token
 * semantics as uploadRecording (settings.language's primary subtag,
 * diarize gated on settings.hfToken being present), but as a JSON
 * body (matching the sidecar's POST /ingest-url contract) instead of
 * uploadRecording's query-string + raw-body PUT. */
export async function ingestUrl(
  url: string,
  settings: Settings,
  diarize: boolean = true,
): Promise<{ jobId: string }> {
  const base = httpBaseFromWs(settings.whisperUrl);
  const body: Record<string, unknown> = {
    url,
    language: settings.language.split("-")[0],
  };
  if (settings.hfToken) {
    body.diarize = diarize;
    body.hf_token = settings.hfToken;
  }

  const res = await fetch(`${base}/ingest-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let message = `导入失败（${res.status}）`;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody?.error) message = errBody.error;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }

  const resBody = (await res.json()) as { job_id: string };
  return { jobId: resBody.job_id };
}

/** Orchestrates the full ingest -> poll -> detect -> save -> load flow
 * for one video/audio URL, reusing pollJobUntilDone/buildSessionFromJob
 * exactly like importAndTrack's sidecar-mode branch — only the job's
 * acquisition method (ingestUrl vs uploadRecording) and the display
 * filename (the job's own display_name, resolved server-side from the
 * video title/URL — the client never has a local filename to offer
 * upfront) differ. Never throws — same callback-reporting contract as
 * importAndTrack. */
export async function importUrlAndTrack(
  url: string,
  settings: Settings,
  callbacks: ImportCallbacks,
  opts: { diarize?: boolean } = {},
): Promise<void> {
  const { onProgress, onDone, onError } = callbacks;

  try {
    onProgress(0, "下载中");
    const { jobId } = await ingestUrl(url, settings, opts.diarize ?? true);

    const job = await pollJobUntilDone(jobId, settings, onProgress);

    onProgress(job.progress, "构建会话");
    const filename = job.display_name ?? url;
    const session = await buildSessionFromJob(job, settings, filename);

    await storage.saveSession(session);
    await useApp.getState().loadSession(session.id);

    onDone(session.id);
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : "导入失败，请确认 sidecar 已启动且 --http-port 开启";
    onError(msg);
  }
}
