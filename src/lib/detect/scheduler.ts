// Real-time detection scheduler: batches finalized transcript
// segments and drives /api/detect (LLM) with dictionary fallback.
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
  onDetection: (res: DetectResponse, source: DetectionSource) => void;
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
  endOffset: number;
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
  private lastAppliedEndOffset = 0;

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

    if (settings.dictionaryOnly || this.fellBack) {
      const res = scanDictionary(seg.text);
      if (res.expressions.length > 0 || res.terms.length > 0) {
        this.opts.onDetection(res, "dictionary");
      }
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
      // applied (spec: "that's fine/desired").
      if (batch.endOffset > this.lastAppliedEndOffset) {
        this.opts.onDetection(res, "llm");
        this.lastAppliedEndOffset = batch.endOffset;
      }
      // else: a fresher batch already landed — drop this stale one.

      this.opts.onModeChange("llm");
      this.consecutiveFailures = 0;
      return;
    } catch (err) {
      await this.handleDetectError(err, batch);
    }
  }

  private async handleDetectError(err: unknown, batch: Batch): Promise<void> {
    if (err instanceof NoKeyError) {
      this.fellBack = true;
      const dictRes = scanDictionary(batch.new_text);
      this.opts.onDetection(dictRes, "dictionary");
      this.opts.onModeChange("dictionary");
      if (!this.noKeyToastFired) {
        this.noKeyToastFired = true;
        this.opts.onError(
          "未配置 API Key — 已切换到内置词典模式，可在设置中填入 Key 启用 AI 检测",
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
      const dictRes = scanDictionary(batch.new_text);
      this.opts.onDetection(dictRes, "dictionary");
      this.opts.onModeChange("dictionary");
      this.opts.onError("AI 检测暂时不可用 — 已切换到词典模式");
    } else {
      console.warn("[DetectionScheduler] batch dropped after error", err);
    }
  }
}
