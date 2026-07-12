// Real-time detection scheduler (#54 layered model): the built-in
// dictionary is the INSTANT FLOOR — every finalized segment is
// scanned synchronously at push time and hits surface immediately.
// When settings.aiDetect is on, the LLM additionally runs in parallel
// batches and its results upgrade dictionary cards in place (see
// dedupe.ts) — it never retracts a floor hit. LLM failures only lose
// the upgrade layer; the floor has already covered that text, so
// error paths must NOT re-scan it (double count).
// OWNER: worker B. Public signature is contract — do not change it.

import { detectApi, NoKeyError, RateLimitApiError } from "../llm/client";
import { resolveTaskCreds } from "../llm/taskConfig";
import { diagLog } from "../diag/log";
import type {
  DetectResponse,
  DetectionSource,
  Settings,
  TranscriptSegment,
} from "@jargonslayer/core/types";
import { scanDictionary } from "@jargonslayer/core/detect/dictionary";

export type DetectMode = "llm" | "dictionary" | "off";

export interface SchedulerOptions {
  getSettings: () => Settings;
  // Meeting-boundary guard: read at batch-dispatch time and again
  // when that batch's response lands. A response whose captured gen
  // no longer matches the store's current gen belongs to a PREVIOUS
  // meeting (that one stopped and a new one began while the request
  // was in flight) and is silently dropped — the ONLY discard
  // condition left in this scheduler (see attemptDetect below; the
  // old stale-batch/out-of-order drop was removed as a bug fix).
  getMeetingGen: () => number;
  // meta.batchWindowStart (llm responses only): when this batch began
  // accumulating — forwarded to mergeDetections as
  // llmCountSuppressSince so floor-counted occurrences aren't counted
  // twice (see dedupe.ts MergeOptions).
  onDetection: (
    res: DetectResponse,
    source: DetectionSource,
    meta?: { batchWindowStart?: number },
  ) => void;
  onBusyChange: (busy: boolean) => void;
  onModeChange: (mode: DetectMode) => void;
  onError: (msg: string) => void;
}

// ---------------------------------------------------------------
// Tunables (see design spec for rationale on each value).
// ---------------------------------------------------------------

const FLUSH_TIMER_MS = 3500;
const FLUSH_MIN_CHARS = 140;
const FLUSH_SENTENCE_END_CHARS = 60;
const FLUSH_HARD_CAP_CHARS = 1200;
const CONTEXT_TAIL_MAX_CHARS = 800;
const MAX_INFLIGHT = 2;
const MAX_CONSECUTIVE_FAILURES = 2;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_JITTER_MS = 300;
// #54 dictionary-floor observability: "at most one entry per 60s" cap
// on the detect-dict-floor diag entry (see pushSegment/recordDictDiagHit
// below) — evidence for whether the floor is actually finding hits,
// without spamming the diag ring buffer on every single segment.
const DICT_DIAG_THROTTLE_MS = 60_000;

// ---------------------------------------------------------------
// AI over-extraction guard (fix: "ai detection is catching whole
// sentences rather than phrases", soccer-stream field report) —
// defense in depth alongside the prompt-level constraint
// (packages/core/src/llm/prompts.ts's DETECT_SYSTEM_PROMPT rule 10).
// Applied ONLY to "llm"-sourced expressions, right where they're
// produced below (attemptDetect's success path) — dictionary hits
// (scanDictionary, in pushSegment) and custom-glossary hits (store.ts's
// addFinal) never pass through here, so neither can ever be silently
// dropped by it.
//
// CJK-aware: Chinese has no whitespace word boundaries, so an
// expression containing any CJK character is capped purely by
// character count; otherwise capped by whitespace-separated word count
// OR raw character count, whichever is stricter (catches a run-on
// phrase with few but very long "words" too).
// ---------------------------------------------------------------
const AI_EXPRESSION_MAX_WORDS = 8;
const AI_EXPRESSION_MAX_CHARS = 64;
const AI_EXPRESSION_MAX_CJK_CHARS = 20;
// CJK Unified Ideographs block, U+4E00-U+9FFF (covers the vast
// majority of everyday Chinese characters).
const CJK_RE = /[一-鿿]/;

/** True when `expression` is implausibly long for a term/phrase (a
 *  whole sentence, not what the detect contract asks for) — exported
 *  for direct unit testing of the boundary cases. */
export function isOversizedAiExpression(expression: string): boolean {
  const trimmed = expression.trim();
  if (CJK_RE.test(trimmed)) {
    return trimmed.length > AI_EXPRESSION_MAX_CJK_CHARS;
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length > AI_EXPRESSION_MAX_WORDS || trimmed.length > AI_EXPRESSION_MAX_CHARS;
}

/** Drops oversized expressions from an LLM detect response; `terms`
 *  passes through untouched (never oversized in the way this bug
 *  reports — a term is already, by rule 4's own definition, a short
 *  acronym/name/metric). Returns the SAME `res` reference when nothing
 *  was dropped (cheap no-op on the common case, and lets callers use
 *  `!==` as a "did anything change" check). `onDrop` receives only the
 *  COUNT of dropped items, never their text — see
 *  recordOversizedAiDiagHit's own privacy note below. */
export function filterOversizedAiExpressions(
  res: DetectResponse,
  onDrop?: (droppedCount: number) => void,
): DetectResponse {
  const kept = res.expressions.filter((e) => !isOversizedAiExpression(e.expression));
  const droppedCount = res.expressions.length - kept.length;
  if (droppedCount === 0) return res;
  onDrop?.(droppedCount);
  return { expressions: kept, terms: res.terms };
}

interface Batch {
  context: string;
  new_text: string;
  endOffset: number; // scheduling/telemetry only — never gates application
  gen: number; // meetingGen captured at dispatch time — see attemptDetect
  windowStart: number; // when this batch began accumulating (firstPendingAt)
  retried: boolean;
}

function sentenceEndsBatch(text: string): boolean {
  return /[.?!]\s*$/.test(text.trimEnd());
}

export class DetectionScheduler {
  private pendingPieces: string[] = [];
  private pendingChars = 0;
  private firstPendingAt: number | null = null;

  private contextTail = "";
  private offset = 0; // running transcript char offset

  private inflight = 0;
  private pendingForce = false;

  private stopped = false;
  private fellBack = false;
  private noKeyToastFired = false;
  private consecutiveFailures = 0;

  // Dictionary-floor observability (#54 field-evidence follow-up):
  // instance-scoped (one scheduler per meeting, see useMeeting.ts) so a
  // new meeting starts fresh — dictDiagFirstHitLogged makes sure a
  // short session still produces at least one detect-dict-floor diag
  // entry even if it never reaches the 60s throttle window.
  private dictDiagFirstHitLogged = false;
  private lastDictDiagAt: number | null = null;
  private dictDiagSegments = 0;
  private dictDiagExpressions = 0;
  private dictDiagTerms = 0;

  // Oversized-AI-expression observability (same "first hit immediate,
  // then at most one entry per 60s" posture as the dictionary-floor
  // counter above — see recordOversizedAiDiagHit below).
  private oversizedAiDiagFirstHitLogged = false;
  private lastOversizedAiDiagAt: number | null = null;
  private oversizedAiDiagDropped = 0;

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;

  constructor(private opts: SchedulerOptions) {
    if (typeof document !== "undefined") {
      this.visibilityHandler = () => this.flushNow();
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  /** Feed every finalized segment here, in order. */
  pushSegment(seg: TranscriptSegment): void {
    if (this.stopped) return;

    const settings = this.opts.getSettings();

    if (!settings.autoDetect) {
      this.opts.onModeChange("off");
      return;
    }

    // Instant floor (#54): dictionary scan runs synchronously on EVERY
    // segment, whether or not the LLM layer is on. This is the
    // perceived-latency fix — hits render now, not after a ~20s LLM
    // round trip.
    const res = scanDictionary(seg.text);
    if (res.expressions.length > 0 || res.terms.length > 0) {
      this.opts.onDetection(res, "dictionary");
      this.recordDictDiagHit(res);
    }

    if (!settings.aiDetect || this.fellBack) {
      this.opts.onModeChange("dictionary");
      return;
    }

    this.pendingPieces.push(seg.text);
    this.pendingChars += seg.text.length;
    this.offset += seg.text.length + 1; // +1 for the join space
    if (this.firstPendingAt === null) this.firstPendingAt = Date.now();
    this.armFlushTimer();

    const shouldFlush =
      this.pendingChars >= FLUSH_MIN_CHARS ||
      (sentenceEndsBatch(seg.text) && this.pendingChars >= FLUSH_SENTENCE_END_CHARS) ||
      this.pendingChars >= FLUSH_HARD_CAP_CHARS;

    if (shouldFlush) {
      this.tryFlush();
    }
  }

  /** Force-flush pending text (called on meeting stop). */
  flushNow(): void {
    this.tryFlush(true);
  }

  /** Cancel timers and in-flight requests. */
  stop(): void {
    this.stopped = true;
    this.clearFlushTimer();
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    // Late in-flight responses may still call onDetection after this
    // — that is fine/desired (results shouldn't be dropped just
    // because the meeting was stopped a moment earlier).
  }

  // ---------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------

  /** #54 field evidence: the owner reported seeing no dictionary cards
   *  while AI detect was on, with nothing in the diag ring buffer to
   *  confirm whether the floor was even running — this is observability
   *  only, never a behavior change (onDetection above already fired
   *  before this is called). Counts only, no text, per log.ts's PRIVACY
   *  RULE — segments/expressions/terms are accumulated across hits and
   *  written at most once per DICT_DIAG_THROTTLE_MS, except the very
   *  FIRST hit of this scheduler's lifetime, which writes immediately
   *  so a short session still produces evidence. */
  private recordDictDiagHit(res: DetectResponse): void {
    this.dictDiagSegments++;
    this.dictDiagExpressions += res.expressions.length;
    this.dictDiagTerms += res.terms.length;

    const now = Date.now();
    const isFirstHitEver = !this.dictDiagFirstHitLogged;
    const throttleElapsed =
      this.lastDictDiagAt === null || now - this.lastDictDiagAt >= DICT_DIAG_THROTTLE_MS;
    if (!isFirstHitEver && !throttleElapsed) return;

    this.dictDiagFirstHitLogged = true;
    this.lastDictDiagAt = now;
    diagLog(
      "info",
      "detect-dict-floor",
      "词典检测命中",
      `segments=${this.dictDiagSegments} expressions=${this.dictDiagExpressions} terms=${this.dictDiagTerms}`,
    );
    this.dictDiagSegments = 0;
    this.dictDiagExpressions = 0;
    this.dictDiagTerms = 0;
  }

  /** Fix: "ai detection is catching whole sentences rather than
   *  phrases" — observability for the post-filter above (see
   *  filterOversizedAiExpressions), same throttle posture as
   *  recordDictDiagHit: counts only, no expression text (log.ts's
   *  PRIVACY RULE), accumulated across hits and written at most once
   *  per DICT_DIAG_THROTTLE_MS except the very FIRST hit of this
   *  scheduler's lifetime, which writes immediately. */
  private recordOversizedAiDiagHit(droppedCount: number): void {
    this.oversizedAiDiagDropped += droppedCount;

    const now = Date.now();
    const isFirstHitEver = !this.oversizedAiDiagFirstHitLogged;
    const throttleElapsed =
      this.lastOversizedAiDiagAt === null ||
      now - this.lastOversizedAiDiagAt >= DICT_DIAG_THROTTLE_MS;
    if (!isFirstHitEver && !throttleElapsed) return;

    this.oversizedAiDiagFirstHitLogged = true;
    this.lastOversizedAiDiagAt = now;
    diagLog(
      "info",
      "detect-ai-oversize",
      "AI 表达超长已过滤",
      `dropped=${this.oversizedAiDiagDropped}`,
    );
    this.oversizedAiDiagDropped = 0;
  }

  private armFlushTimer(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.tryFlush();
    }, FLUSH_TIMER_MS);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private tryFlush(force = false): void {
    if (this.stopped) return;
    if (this.pendingPieces.length === 0) return;
    if (this.inflight >= MAX_INFLIGHT) {
      if (force) this.pendingForce = true;
      return;
    }

    const newText = this.pendingPieces.join(" ");
    const batch: Batch = {
      context: this.contextTail,
      new_text: newText,
      endOffset: this.offset,
      gen: this.opts.getMeetingGen(),
      windowStart: this.firstPendingAt ?? Date.now(),
      retried: false,
    };

    this.contextTail = `${this.contextTail} ${newText}`.slice(-CONTEXT_TAIL_MAX_CHARS);

    this.pendingPieces = [];
    this.pendingChars = 0;
    this.firstPendingAt = null;
    this.pendingForce = false;
    this.clearFlushTimer();

    this.runBatch(batch);
  }

  private runBatch(batch: Batch): void {
    this.inflight++;
    this.opts.onBusyChange(true);
    void this.attemptDetect(batch).finally(() => {
      this.inflight--;
      this.opts.onBusyChange(this.inflight > 0);
      if (this.pendingPieces.length > 0) {
        this.maybeFlushAfterCompletion();
      }
    });
  }

  private maybeFlushAfterCompletion(): void {
    const shouldFlush =
      this.pendingForce ||
      this.pendingChars >= FLUSH_MIN_CHARS ||
      this.pendingChars >= FLUSH_HARD_CAP_CHARS;
    if (shouldFlush) {
      this.tryFlush(this.pendingForce);
    }
  }

  private async attemptDetect(batch: Batch): Promise<void> {
    const settings = this.opts.getSettings();
    try {
      const res = await detectApi(
        { context: batch.context, new_text: batch.new_text, model: resolveTaskCreds(settings, "detect").model },
        settings,
      );

      // Note: no `this.stopped` short-circuit here on purpose — a
      // late in-flight response landing after stop() is still
      // applied (spec: "that's fine/desired"). Out-of-order batches
      // (e.g. batch 2 resolves before batch 1) are BOTH applied —
      // mergeDetections is idempotent by normKey and additive
      // (bumps counts), so applying an "older" batch after a newer
      // one is safe and must not be dropped. `batch.endOffset` is
      // kept only for scheduling/telemetry, never for gating.
      //
      // Two discard conditions at completion time (codex review round 1,
      // F1 HIGH added the second one below — this first one is
      // unchanged): this batch belongs to a PREVIOUS meeting (a new one
      // began — meetingGen bumped — while this request was in flight).
      // Applying it now would land detections (or an "llm mode active"
      // signal) on the wrong (current, unrelated) meeting — drop
      // silently, no side effects.
      if (batch.gen !== this.opts.getMeetingGen()) {
        return;
      }

      // aiDetect-off race (F1 HIGH): re-read settings HERE, at
      // completion time — NOT the `settings` captured at the top of
      // this method, before the network round trip. Header/StatusLine's
      // toggle sets aiDetect=false and synchronously echoes
      // detectMode="dictionary" the instant the user clicks — but this
      // in-flight batch was already on the wire. Applying its "llm"
      // result now would silently flip detectMode back to "llm" behind
      // the user's back: store ends up (aiDetect=false, detectMode=
      // "llm"), the label claims AI is on, and the NEXT toggle click
      // computes next=!aiDetect=true — the button reads as inverted.
      // The user explicitly turned AI off mid-round-trip; discard the
      // result and report the mode the user actually asked for.
      if (!this.opts.getSettings().aiDetect) {
        this.opts.onModeChange("dictionary");
        this.consecutiveFailures = 0;
        return;
      }

      // Post-filter (defense in depth, see filterOversizedAiExpressions'
      // own doc above): drops any expression the LLM returned anyway
      // despite the prompt-level constraint. Dictionary/custom cards
      // never reach this call — only this "llm" success path does.
      const filtered = filterOversizedAiExpressions(res, (droppedCount) =>
        this.recordOversizedAiDiagHit(droppedCount),
      );
      this.opts.onDetection(filtered, "llm", { batchWindowStart: batch.windowStart });

      this.opts.onModeChange("llm");
      this.consecutiveFailures = 0;
      return;
    } catch (err) {
      await this.handleDetectError(err, batch);
    }
  }

  private async handleDetectError(err: unknown, batch: Batch): Promise<void> {
    // Same meeting-boundary guard as the success path in attemptDetect
    // — an error for a batch dispatched by a PREVIOUS meeting must not
    // mutate the current (unrelated) meeting's dictionary-fallback
    // detections, mode, or error toast.
    if (batch.gen !== this.opts.getMeetingGen()) return;

    // F1 HIGH follow-up check: every onModeChange call below (both
    // terminal-failure branches) already reports "dictionary" — never
    // "llm" — unconditionally, with no aiDetect read at all. That is
    // correct regardless of the live aiDetect value at completion time:
    // a NoKeyError means there is no key to use either way, and
    // consecutiveFailures>=MAX permanently flips fellBack=true, so this
    // scheduler genuinely will only run dictionary-mode from here on.
    // Unlike the success path's "llm" report, there is no stale-mode
    // report to race here — nothing below needed the same fix.

    // NOTE (#54): no dictionary re-scan on any error path below — the
    // instant floor already scanned (and counted) this batch's text at
    // segment-push time; re-scanning here would double count. Failure
    // only loses the LLM upgrade layer.
    if (err instanceof NoKeyError) {
      this.fellBack = true;
      this.opts.onModeChange("dictionary");
      if (!this.noKeyToastFired) {
        this.noKeyToastFired = true;
        this.opts.onError(
          "未配置 API Key，AI 升级已停用；词典检测仍可用，可在设置中填入 Key 启用 AI",
        );
      }
      return;
    }

    if (err instanceof RateLimitApiError) {
      if (!batch.retried) {
        batch.retried = true;
        const delay = RETRY_BASE_DELAY_MS + Math.random() * RETRY_JITTER_MS;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (this.stopped) return;
        await this.attemptDetect(batch);
        return;
      }
      // Already retried once — fall through to the failure-counting
      // path below, same as any other persistent error.
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.fellBack = true;
      this.opts.onModeChange("dictionary");
      this.opts.onError("AI 检测暂时不可用，词典检测继续运行");
    } else {
      console.warn("[DetectionScheduler] batch dropped after error", err);
    }
  }
}
