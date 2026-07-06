// Live bilingual transcript (#42): batches FINALIZED transcript
// segments and drives /api/translate (LLM) so each segment gets a
// secondary translated line under the English text. Sibling to
// detect/scheduler.ts but simpler — no dictionary fallback, no
// consecutive-failure latch (a dropped batch here just means one
// segment stays English-only, not a mode change the user needs to
// know about). Public signature is contract — do not change it.

import { translateApi, NoKeyError, RateLimitApiError } from "../llm/client";
import type { Settings, TranscriptSegment } from "../types";

export interface TranslateQueueOptions {
  getSettings: () => Settings;
  // Meeting-boundary guard, same pattern as DetectionScheduler: gen is
  // captured at dispatch time and re-checked when the response lands.
  // A response whose captured gen no longer matches the store's
  // current gen belongs to a PREVIOUS meeting and is silently dropped.
  getMeetingGen: () => number;
  onTranslations: (map: Record<string, string>, gen: number) => void;
  onError: (msg: string) => void;
}

// ---------------------------------------------------------------
// Tunables — see IMPLEMENT step 5 in the feature spec for rationale.
// ---------------------------------------------------------------

const DEBOUNCE_MS = 1500;
const BATCH_MAX = 6;
const MAX_TEXT_CHARS = 1500;
const RATE_LIMIT_PAUSE_MS = 30_000;
const ERROR_COOLDOWN_MS = 5_000;

interface PendingItem {
  id: string;
  text: string;
}

interface Batch {
  items: PendingItem[];
  gen: number; // meetingGen captured at dispatch time
}

export class TranslateQueue {
  private pending: PendingItem[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  private inflight = false;
  // rate-limit/error cooldown gate: while now < pausedUntil, tryFlush
  // no-ops (checked defensively below), but the ACTUAL resume is
  // driven by resumeTimer firing exactly at the pause boundary —
  // relying on the next pushSegment/backfill call to re-arm the debounce
  // timer would strand any already-pending items with no timer running
  // if no new segment arrives while paused.
  private pausedUntil = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  private stopped = false;
  private noKeyLatched = false; // permanent for this meeting once seen

  constructor(private opts: TranslateQueueOptions) {}

  /** Feed one finalized segment. No-op (silent) when the toggle is
   *  off or the segment is too long to bother translating. */
  pushSegment(seg: TranscriptSegment): void {
    if (this.stopped || this.noKeyLatched) return;
    if (!this.opts.getSettings().bilingualTranscript) return;
    if (seg.text.length > MAX_TEXT_CHARS) return;

    this.pending.push({ id: seg.id, text: seg.text });
    this.armDebounce();
  }

  /** Enqueue segments at the FRONT of the pending queue (used when
   *  the toggle flips on mid-meeting and recent segments need
   *  catch-up translation) — same filters as pushSegment, applied
   *  per-segment so a mixed batch doesn't lose the valid ones. */
  backfill(segs: TranscriptSegment[]): void {
    if (this.stopped || this.noKeyLatched) return;
    if (!this.opts.getSettings().bilingualTranscript) return;

    const items = segs
      .filter((s) => s.text.length <= MAX_TEXT_CHARS)
      .map((s) => ({ id: s.id, text: s.text }));
    if (items.length === 0) return;

    this.pending = [...items, ...this.pending];
    this.armDebounce();
  }

  /** Cancel timers and drop pending work. */
  stop(): void {
    this.stopped = true;
    this.clearDebounce();
    this.clearResumeTimer();
    this.pending = [];
    // Late in-flight responses may still call onTranslations after
    // this — fine/desired, same rationale as DetectionScheduler.stop().
  }

  // ---------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------

  private armDebounce(): void {
    if (this.debounceTimer !== null) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.tryFlush();
    }, DEBOUNCE_MS);
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer !== null) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  /** Set the cooldown gate and arm a timer to retry exactly when it
   *  lifts — the pending queue may otherwise sit un-drained forever if
   *  no new segment arrives to re-trigger armDebounce() in the
   *  meantime (see the pausedUntil field doc above). */
  private pauseFor(ms: number): void {
    this.pausedUntil = Date.now() + ms;
    this.clearResumeTimer();
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.tryFlush();
    }, ms);
  }

  private tryFlush(): void {
    if (this.stopped) return;
    if (this.pending.length === 0) return;
    if (this.inflight) return;
    if (this.noKeyLatched) return;
    if (Date.now() < this.pausedUntil) return;
    // The toggle is checked at enqueue time too, but re-check here so
    // flipping it OFF during the debounce window doesn't fire one last
    // request the user just opted out of.
    if (!this.opts.getSettings().bilingualTranscript) {
      this.pending = [];
      return;
    }

    const items = this.pending.slice(0, BATCH_MAX);
    this.pending = this.pending.slice(BATCH_MAX);

    const batch: Batch = { items, gen: this.opts.getMeetingGen() };
    this.runBatch(batch);
  }

  private runBatch(batch: Batch): void {
    this.inflight = true;
    void this.attemptTranslate(batch).finally(() => {
      this.inflight = false;
      if (this.pending.length > 0) {
        // Re-arm the ordinary debounce for the next batch. If this
        // batch just triggered a cooldown, handleError already armed
        // its own resumeTimer (pauseFor) — tryFlush's pausedUntil
        // check makes an early debounce tick here a harmless no-op.
        this.armDebounce();
      }
    });
  }

  private async attemptTranslate(batch: Batch): Promise<void> {
    const settings = this.opts.getSettings();
    try {
      const res = await translateApi(
        { segments: batch.items, lang: settings.explainLanguage },
        settings,
      );

      // Meeting-boundary guard — see TranslateQueueOptions.getMeetingGen.
      if (batch.gen !== this.opts.getMeetingGen()) return;

      if (res.translations.length > 0) {
        const map: Record<string, string> = {};
        for (const t of res.translations) map[t.id] = t.text;
        this.opts.onTranslations(map, batch.gen);
      }
      // A partial/empty response is failed-soft by design (see route
      // doc comment) — the missing segments simply stay English-only,
      // no retry, no error surfaced.
    } catch (err) {
      this.handleError(err, batch);
    }
  }

  private handleError(err: unknown, batch: Batch): void {
    // Same meeting-boundary guard as the success path — an error for a
    // batch dispatched by a PREVIOUS meeting must not latch/toast onto
    // the current (unrelated) meeting.
    if (batch.gen !== this.opts.getMeetingGen()) return;

    if (err instanceof NoKeyError) {
      this.noKeyLatched = true;
      // Drop pending and stop accepting new items (see pushSegment) —
      // without a key nothing will ever drain the queue, and a long
      // keyless meeting would otherwise grow it unbounded.
      this.pending = [];
      this.opts.onError("未配置 API Key，双语转录已暂停。前往设置填入 Key 即可恢复");
      return;
    }

    if (err instanceof RateLimitApiError) {
      // Unlike the generic-error branch below, rate-limit is not a
      // per-batch failure to give up on — re-queue this batch's items
      // at the front so "pause then resume" has something to resume.
      this.pending = [...batch.items, ...this.pending];
      this.pauseFor(RATE_LIMIT_PAUSE_MS);
      return;
    }

    // Any other error: the batch is NOT retried (its segments stay
    // English-only), but a short cooldown avoids hammering a flaky
    // endpoint on every subsequent debounce tick.
    console.warn("[TranslateQueue] batch dropped after error", err);
    this.pauseFor(ERROR_COOLDOWN_MS);
  }
}
