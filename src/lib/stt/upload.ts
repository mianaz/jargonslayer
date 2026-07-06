// Upload-a-recording transcription: two acquisition paths — (1) PUT a
// recording file to the local Whisper sidecar's HTTP job API and poll
// progress, or (2) POST it straight to the cloud transcription API
// route (#22, requires an openai-compat provider). Both paths converge
// on the same detection/merge stage (runDetectionPipeline below) to
// build a full MeetingSession — LLM with dictionary fallback, plus the
// personal glossary, mirroring live meeting detection.

import {
  newId,
  type DetectResponse,
  type ExpressionCard,
  type MeetingSession,
  type Settings,
  type TermCard,
  type TranscriptSegment,
} from "../types";
import { PROVIDER_HEADERS } from "../types";
import { detectApi, NoKeyError, RateLimitApiError } from "../llm/client";
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
 * cloud transcription, text import #43): runs LLM detection per
 * ~1200-char batch (falling back to the offline dictionary on
 * no-key/failure), plus a per-segment personal-glossary scan —
 * mirroring the live meeting detection mix. Takes plain `{text}`
 * items rather than JobSegment so cloud segments (which carry no
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

    if (!rateLimitLatched) {
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
// Cloud transcription path (#22) — POST straight to /api/transcribe-
// cloud (requires an openai-compat provider; the route 400s otherwise)
// instead of the local sidecar's job API, then converges on the same
// runDetectionPipeline stage above.
// ---------------------------------------------------------------

export interface CloudTranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export async function transcribeViaCloud(
  file: File,
  settings: Settings,
): Promise<CloudTranscriptSegment[]> {
  const form = new FormData();
  form.set("file", file, file.name);
  form.set("language", settings.language.split("-")[0]);

  const headers: Record<string, string> = {
    [PROVIDER_HEADERS.provider]: settings.provider,
  };
  if (settings.apiKey) headers[PROVIDER_HEADERS.key] = settings.apiKey;
  if (settings.provider === "openai-compat" && settings.baseUrl) {
    headers[PROVIDER_HEADERS.baseUrl] = settings.baseUrl;
  }

  const res = await fetch(withBase("/api/transcribe-cloud"), {
    method: "POST",
    headers,
    body: form,
  });

  if (!res.ok) {
    let message = `云端转录失败（${res.status}）`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }

  const body = (await res.json()) as { segments: CloudTranscriptSegment[] };
  return body.segments;
}

/** Build a full session (transcript + detected cards/terms) from cloud-
 * transcribed segments. Shares runDetectionPipeline with
 * buildSessionFromJob so both import paths get identical LLM/dictionary
 * fallback + personal-glossary behavior. */
export async function buildSessionFromCloudSegments(
  segments: CloudTranscriptSegment[],
  settings: Settings,
  filename: string,
): Promise<MeetingSession> {
  const base = Date.now();
  const finalSegments: TranscriptSegment[] = segments.map((s, i) => ({
    id: newId(),
    index: i,
    startedAt: base + Math.round(s.start * 1000),
    endedAt: base + Math.round(s.end * 1000),
    text: s.text.trim(),
    engine: "whisper",
  }));

  const { cards, terms } = await runDetectionPipeline(segments, finalSegments, settings);

  const startedAt = finalSegments.length > 0 ? finalSegments[0].startedAt : base;
  const endedAt =
    finalSegments.length > 0 ? finalSegments[finalSegments.length - 1].endedAt : base;

  return {
    id: newId(),
    title: `导入 ${filename}`,
    startedAt,
    endedAt,
    engine: "whisper",
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
  /** "sidecar" (default): PUT to the local Whisper sidecar's job API
   *  and poll progress. "cloud" (#22): single POST to
   *  /api/transcribe-cloud, no polling — the route itself blocks
   *  until the upstream transcription completes. */
  mode?: "sidecar" | "cloud";
  /** Sidecar mode only: request speaker diarization for this upload
   *  (still requires settings.hfToken to actually run). Default true. */
  diarize?: boolean;
}

/** Orchestrates the full upload -> poll -> detect -> save -> load
 * flow for one recording (sidecar mode), or upload -> detect -> save
 * -> load (cloud mode, no polling stage). Never throws — reports
 * outcomes via the provided callbacks so a caller (e.g. HistoryDrawer)
 * can track many concurrent imports without try/catch plumbing per
 * call site. */
export async function importAndTrack(
  file: File,
  settings: Settings,
  callbacks: ImportCallbacks,
  opts: ImportOptions = {},
): Promise<void> {
  const { onProgress, onDone, onError } = callbacks;
  const mode = opts.mode ?? "sidecar";

  try {
    if (mode === "cloud") {
      onProgress(0.5, "云端转录中");
      const segments = await transcribeViaCloud(file, settings);

      onProgress(0.9, "构建会话");
      const session = await buildSessionFromCloudSegments(segments, settings, file.name);

      await storage.saveSession(session);
      await useApp.getState().loadSession(session.id);

      onDone(session.id);
      return;
    }

    onProgress(0, "转录中");
    const { jobId } = await uploadRecording(file, settings, opts.diarize ?? true);

    let job: JobStatus;
    for (;;) {
      job = await pollJob(jobId, settings);

      if (job.status === "error") {
        onError(job.error ?? "转录失败");
        return;
      }

      const phase =
        job.status_detail === "diarizing" ? "说话人分离中" : "转录中";
      onProgress(job.progress, phase);

      if (job.status === "done") break;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

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
