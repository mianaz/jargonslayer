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
} from "@jargonslayer/core/types";
import { detectApi, NoKeyError, RateLimitApiError, taskHeaders } from "../llm/client";
import { resolveTaskCreds } from "../llm/taskConfig";
import { scanDictionary } from "@jargonslayer/core/detect/dictionary";
import { scanCustomEntries } from "../history/glossary";
import { mergeDetections } from "@jargonslayer/core/detect/dedupe";
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
// R6 field fix (Sol F5/F6): reused verbatim from the existing run-level
// rate-limit warning's own phrasing (see importText.ts's
// onRateLimitFallback callback: "检测请求多次被限流，剩余内容已切换到词典
// 模式") so the per-batch degraded-by-rate-limit case below reads
// consistently with the run-level one, rather than inventing a second
// wording for the same underlying cause.
const RATE_LIMIT_DEGRADED_REASON = "检测请求多次被限流";

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
 * "can't reach sidecar" state without try/catch plumbing.
 *
 * `diarization_installed` (S5 chunk 1, decision C) is the new,
 * token-INDEPENDENT "is pyannote even importable" fact — optional
 * because a legacy/external sidecar predating S5 simply omits the key;
 * callers must render that `undefined` as 未知, never coerce it to
 * 未安装 (risk 5). `diarization_ready`/`diarization_error` keep their
 * pre-S5 meaning unchanged (token-gated actual readiness). */
export async function fetchSidecarHealth(
  settings: Settings,
): Promise<
  | {
      ok: boolean;
      diarization_installed?: boolean;
      diarization_ready: boolean;
      diarization_error: string | null;
    }
  | null
> {
  const base = httpBaseFromWs(settings.whisperUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as {
      ok: boolean;
      diarization_installed?: boolean;
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

/** R6/F6 wording fix: builds the exact zh completion-toast fragment for
 *  onLlmDetectFailure's `(message, partial)` signal — "AI 检测未生效"
 *  when NO batch succeeded via the LLM this run, "AI 检测未完全生效" when
 *  at least one did (see runDetectionPipeline's own doc comment for the
 *  `partial` contract). Exported so importText.ts's own onLlmDetectFailure
 *  wiring builds the IDENTICAL template rather than forking a second,
 *  driftable copy. */
export function formatLlmDetectFailureWarning(message: string, partial: boolean): string {
  return partial
    ? `AI 检测未完全生效：${message}，部分内容仅词典检测`
    : `AI 检测未生效：${message}，本次仅词典检测`;
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
 * sidecar-job/cloud call sites keep compiling unchanged.
 *
 * v0.4.4 field-fix (finding 3 — silent AI-detect failure): a
 * NoKeyError/persistent-upstream-error fallback used to fall back to
 * the dictionary for its batch with zero signal anywhere but diagLog —
 * a user whose API key went invalid mid-release got dictionary-only
 * results on EVERY chunk with a completion toast that looked
 * perfectly normal. `onLlmDetectFailure` (optional, trailing — same
 * additive shape as onRateLimitFallback) fires AT MOST ONCE per run,
 * only when a MAJORITY of batches (>= half, including "all") fell back
 * to the dictionary for a reason OTHER than rate-limiting while
 * settings.aiDetect was on — rate-limit exhaustion already has its own
 * dedicated onRateLimitFallback signal above (and is deliberately
 * excluded here so a persistently-rate-limited run doesn't ALSO fire
 * this generic one, doubling the warning). Passes the last such
 * error's own `.message` straight through — every thrower in
 * llm/client.ts (NoKeyError/RateLimitApiError/UpstreamError) already
 * carries an honest, ready-to-show zh message, so there's nothing to
 * translate or reword here. Second `partial` arg (R6/F6): true when at
 * least one OTHER batch in this same run succeeded via the LLM — the
 * caller picks between the "AI 检测未生效" (zero succeeded) and "AI 检测
 * 部分未生效" (some succeeded) templates accordingly.
 *
 * R6 field fix (Sol F5): a batch that exhausts only its OWN per-batch
 * rate-limit wait cap (MAX_WAITS_PER_BATCH) WITHOUT the run-level cap
 * also tripping was previously excluded from every tally — a short
 * (1-2 batch) import could exhaust its lone batch's own cap without
 * ever reaching the run-wide MAX_WAITS_PER_RUN threshold that fires
 * onRateLimitFallback, completing with a fully dictionary-only result
 * and ZERO warning anywhere. `rateLimitDegradedBatches` tracks exactly
 * that case (mirrors nonRateLimitFailures' own batch-level tally
 * mechanism) and, at completion, feeds the SAME onLlmDetectFailure
 * slot (reusing RATE_LIMIT_DEGRADED_REASON as the reason text) whenever
 * ITS OWN majority threshold is met — still mutually exclusive with
 * onRateLimitFallback (a batch that trips the RUN-level latch is
 * already covered by that signal, so it's excluded here exactly like
 * nonRateLimitFailures already excludes every RateLimitApiError). */
export async function runDetectionPipeline(
  segmentTexts: { text: string }[],
  finalSegments: TranscriptSegment[],
  settings: Settings,
  onProgress?: (done: number, total: number) => void,
  onRateLimitFallback?: () => void,
  onLlmDetectFailure?: (message: string, partial: boolean) => void,
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
  let llmSucceededBatches = 0;
  // Finding 3: count of batches that fell back to the dictionary for a
  // NON-rate-limit reason (NoKeyError, or a persistent transient error
  // past its one retry) while aiDetect was on — a lone batch's own
  // per-batch rate-limit exhaustion is a RateLimitApiError too, so
  // it's excluded here on purpose (see the `lastErr` check below).
  let nonRateLimitFailures = 0;
  let lastNonRateLimitFailureMessage: string | null = null;
  // R6/F5: see this function's own doc comment above.
  let rateLimitDegradedBatches = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const context = tail.slice(-CONTEXT_TAIL_CHARS);
    let batchWaits = 0;
    let transientRetried = false;
    let res: DetectResponse | null = null;
    let lastErr: unknown = null;

    // settings.aiDetect off (#54) = the user chose fully offline — the
    // import paths honor it the same way the live scheduler does:
    // dictionary only, zero API calls.
    if (settings.aiDetect && !rateLimitLatched) {
      for (;;) {
        try {
          res = await detectApi(
            { context, new_text: batch, model: resolveTaskCreds(settings, "detect").model },
            settings,
          );
          break;
        } catch (err) {
          lastErr = err;
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
      llmSucceededBatches++;
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

      // Finding 3: this batch's own genuine failure (NOT a
      // RateLimitApiError — that's the separate, already-signaled
      // fallback path above) counts toward the run's majority-failed
      // tally. A batch skipped entirely because an EARLIER batch
      // already latched the run's rate limit never sets `lastErr` at
      // all, so it's naturally excluded here too.
      if (lastErr && !(lastErr instanceof RateLimitApiError)) {
        nonRateLimitFailures++;
        lastNonRateLimitFailureMessage =
          lastErr instanceof Error ? lastErr.message : String(lastErr);
      } else if (lastErr instanceof RateLimitApiError && !rateLimitLatched) {
        // R6/F5: this batch's own per-batch cap (not the run-level
        // one — `rateLimitLatched` would be true if THIS batch's own
        // retries were what tripped it, and that case is already
        // covered by onRateLimitFallback above) exhausted with no
        // other tally ever catching it.
        rateLimitDegradedBatches++;
      }
    }

    tail = `${tail} ${batch}`.slice(-CONTEXT_TAIL_CHARS);
    onProgress?.(i + 1, batches.length);
  }

  // Finding 3 / R6: fire at most once per run, and only when the
  // run-level rate-limit path above hasn't ALREADY signaled a fallback
  // (never two detect warnings for one import) — "majority" is >= half
  // the batches, which also covers the all-chunks-failed case the field
  // report hit. Two independent majority checks feed the SAME single
  // slot: a non-rate-limit failure majority takes priority (matches
  // pre-R6 behavior byte-for-byte when no rate-limit degradation
  // occurred), falling through to the rate-limit-degraded majority
  // otherwise — the two tallies are effectively partitioned across
  // batches (a batch counts toward at most one), so both reaching
  // majority simultaneously is only possible on a small batch count,
  // and picking the non-rate-limit reason first is a reasonable
  // tie-break rather than a meaningful design choice either way.
  const anyLlmSucceeded = llmSucceededBatches > 0;
  if (!rateLimitFallbackFired) {
    if (nonRateLimitFailures > 0 && nonRateLimitFailures * 2 >= batches.length) {
      onLlmDetectFailure?.(lastNonRateLimitFailureMessage ?? "检测失败", anyLlmSucceeded);
    } else if (rateLimitDegradedBatches > 0 && rateLimitDegradedBatches * 2 >= batches.length) {
      onLlmDetectFailure?.(RATE_LIMIT_DEGRADED_REASON, anyLlmSucceeded);
    }
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
 * personal-glossary scan — mirroring the live meeting detection mix.
 *
 * v0.4.4 field-fix (finding 3) — DEFERRED for this path on purpose: a
 * detect-failure warning has nowhere to go from here. This function's
 * only callers (importAndTrack/importUrlAndTrack below) report success
 * via `ImportCallbacks.onDone(sessionId)` — a contract registry.ts's
 * own header comment documents as "kept completely unchanged" (design
 * decision 2) precisely so the sidecar-job path stays untouched by UI-
 * layer churn. Widening it to also carry warnings would ripple into
 * that file's TrackedCallbacks/runTracked (outside this hotfix's file
 * set) for a payoff this hotfix's scope doesn't require — the browser-
 * Whisper (buildSessionFromSegments) and text-import
 * (importTranscriptText) paths already had a `warnings[]` reaching
 * their completion toast and are the ones fixed here. */
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
 * downstream (timeline synthesis, runDetectionPipeline) is identical.
 *
 * v0.4.4 field-fix (finding 3): `warnings`, when passed, is mutated
 * in place exactly like runTranslation's own `warnings` parameter — a
 * detect-side failure (see runDetectionPipeline's onLlmDetectFailure
 * doc above) is pushed into the SAME array the caller later merges
 * translate warnings into (importAudio.ts), so both phases reach the
 * one completion toast the same way. Optional/trailing: the sidecar-
 * job path (buildSessionFromJob below) is unaffected and still
 * surfaces no detect warnings — deferred, see that function's own
 * callers (ImportCallbacks has no warnings channel to carry it out). */
export async function buildSessionFromSegments(
  segments: PlainTranscriptSegment[],
  settings: Settings,
  opts: { title: string; engine: STTEngineKind },
  warnings?: string[],
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

  const { cards, terms } = await runDetectionPipeline(
    segments,
    finalSegments,
    settings,
    undefined,
    undefined,
    (message, partial) => warnings?.push(formatLlmDetectFailureWarning(message, partial)),
  );

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

/** Appended by importAndTrack/importUrlAndTrack's own catch below when
 * the failure carries no message of its own (a non-Error throw); also
 * exported for ImportHub's task-tray error rows (#58 review fix 2) —
 * the pre-#58 HistoryDrawer unconditionally appended this to EVERY
 * failed sidecar-path row regardless of the underlying message, and
 * TaskTray's TaskKind ("import-audio"/"import-video"/"import-url")
 * can't tell a sidecar-path failure from a browser-path one to
 * reproduce that itself, so the two sidecar call sites in ImportHub
 * wrap their onError with withSidecarHint to restore it. */
export const SIDECAR_UNREACHABLE_HINT = "，确认本地 Whisper 服务已启动且 --http-port 开启";

/** R7 field fix (Sol F8, client half — WIRE CONTRACT with the sidecar):
 *  the sidecar surfaces a model-LOAD failure (as opposed to "can't
 *  reach the sidecar at all") as a job/ws error whose message STARTS
 *  WITH this literal prefix. The sidecar is reachable and answered —
 *  telling the user to "start the sidecar / --http-port" is actively
 *  wrong advice for this case, so withSidecarHint below detects it and
 *  swaps in the honest local-model-load framing instead. */
const MODEL_LOAD_FAILURE_PREFIX = "模型加载失败";

/** Appends SIDECAR_UNREACHABLE_HINT to a task-registry error message —
 * see the constant's own doc above for why this lives here rather than
 * being derived from TaskKind.
 *
 * R7 exception (Sol F8): a MODEL_LOAD_FAILURE_PREFIX-prefixed message
 * means the sidecar was reached and answered — it just couldn't load
 * the configured Whisper model — so the "start the sidecar" connection
 * advice is skipped in favor of an honest "本地 Whisper 模型加载失败：
 * <detail>" message. */
export function withSidecarHint(message: string): string {
  if (message.startsWith(MODEL_LOAD_FAILURE_PREFIX)) {
    return `本地 Whisper ${message}`;
  }
  return `${message}${SIDECAR_UNREACHABLE_HINT}`;
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
    const msg = err instanceof Error ? err.message : `导入失败${SIDECAR_UNREACHABLE_HINT}`;
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
    const msg = err instanceof Error ? err.message : `导入失败${SIDECAR_UNREACHABLE_HINT}`;
    onError(msg);
  }
}
