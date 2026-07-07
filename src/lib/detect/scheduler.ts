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
import type {
  DetectResponse,
  DetectionSource,
  Settings,
  TranscriptSegment,
} from "../types";
import { scanDictionary } from "./dictionary";

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
        { context: batch.context, new_text: batch.new_text, model: settings.detectModel },
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
      // The ONE discard condition left: this batch belongs to a
      // PREVIOUS meeting (a new one began — meetingGen bumped — while
      // this request was in flight). Applying it now would land
      // detections (or an "llm mode active" signal) on the wrong
      // (current, unrelated) meeting — drop silently, no side effects.
      if (batch.gen !== this.opts.getMeetingGen()) {
        return;
      }

      this.opts.onDetection(res, "llm", { batchWindowStart: batch.windowStart });

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
          "未配置 API Key，AI 升级已停用；词典检测持续可用，可在设置中填入 Key 启用 AI",
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
