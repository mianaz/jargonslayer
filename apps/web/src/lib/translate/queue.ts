// Live bilingual transcript (#42): batches FINALIZED transcript
// segments and drives /api/translate (LLM) so each segment gets a
// secondary translated line under the English text. Sibling to
// detect/scheduler.ts but simpler — no dictionary fallback, no
// mode-changing latch (a dropped batch here just means one segment
// stays English-only, not something the user needs to be told about
// beyond the one-time NoKey toast — see MAX_CONSECUTIVE_RATE_LIMITS
// for the one queue-management counter this DOES keep). Public
// signature is contract — do not change it.

import { translateApi, NoKeyError, RateLimitApiError } from "../llm/client";
import type { Settings, TranscriptSegment } from "@jargonslayer/core/types";

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
// NoKeyError is thrown locally by the client (no network request at
// all — see handleError below), so retrying every 60s costs nothing;
// this turns "no key configured" from a permanent-for-the-meeting
// latch into a self-healing pause that quietly recovers once the user
// fills in a key, without them having to restart the meeting.
const NO_KEY_PAUSE_MS = 60_000;
// Persistent 429s would otherwise re-queue the SAME oldest batch
// forever, starving every newer segment behind it — 5 consecutive
// failures (~2.5min at the 30s pause above) gives up on that one
// batch (segments stay English-only) so the queue can move on.
const MAX_CONSECUTIVE_RATE_LIMITS = 5;

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
  private noKeyToastShown = false; // NoKeyError toast fires at most once per meeting
  private consecutiveRateLimits = 0; // reset on any successful batch
  // Segment ids that already burned their one generic-error retry —
  // a transient 5xx (the flaky-endpoint case, e.g. upstream 502s)
  // used to drop a whole 6-segment batch permanently; now each item
  // gets exactly one second chance before staying English-only.
  private failedOnce = new Set<string>();

  constructor(private opts: TranslateQueueOptions) {}

  /** Feed one finalized segment. No-op (silent) when the toggle is
   *  off or the segment is too long to bother translating. */
  pushSegment(seg: TranscriptSegment): void {
    if (this.stopped) return;
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
    if (this.stopped) return;
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

      // Any successful batch clears the consecutive-429 counter — only
      // an unbroken run of failures should ever trigger the drop-batch
      // escape hatch below.
      this.consecutiveRateLimits = 0;

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
      // Self-healing pause, not a permanent latch: drop pending (a
      // long keyless meeting shouldn't grow the queue unbounded) and
      // pause 60s. NoKeyError is thrown locally with no network round
      // trip, so retrying on the next debounce tick after a key is
      // filled in is free — the queue recovers on its own, no restart
      // needed. The toast still only fires once per meeting so filling
      // in a key mid-meeting isn't followed by a flood of repeats.
      this.pending = [];
      this.pauseFor(NO_KEY_PAUSE_MS);
      if (!this.noKeyToastShown) {
        this.noKeyToastShown = true;
        this.opts.onError(
          "未配置 API Key，双语转录已暂停。前往设置填入 Key 即可自动恢复",
        );
      }
      return;
    }

    if (err instanceof RateLimitApiError) {
      this.consecutiveRateLimits++;
      if (this.consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
        // An unbroken run of 429s means re-queuing this same oldest
        // batch keeps starving every newer segment behind it forever —
        // give up on it (segments stay English-only, no retry) rather
        // than reorder-block indefinitely. Still pause 30s so whatever
        // batch runs next doesn't fire immediately into the same 429.
        this.consecutiveRateLimits = 0;
        this.pauseFor(RATE_LIMIT_PAUSE_MS);
        return;
      }
      // Below the threshold: rate-limit is not a per-batch failure to
      // give up on — re-queue this batch's items at the front so
      // "pause then resume" has something to resume.
      this.pending = [...batch.items, ...this.pending];
      this.pauseFor(RATE_LIMIT_PAUSE_MS);
      return;
    }

    // Any other error: re-queue each item ONCE (transient 5xx / flaky
    // endpoint should not silently strip translations from six
    // segments at a time); an item that fails its retry too is dropped
    // for good (stays English-only). The cooldown still spaces the
    // retry so a down endpoint isn't hammered on every debounce tick.
    const retriable = batch.items.filter((it) => !this.failedOnce.has(it.id));
    for (const it of retriable) this.failedOnce.add(it.id);
    if (retriable.length > 0) {
      this.pending = [...retriable, ...this.pending];
    }
    console.warn(
      `[TranslateQueue] batch error — retrying ${retriable.length}/${batch.items.length} once`,
      err,
    );
    this.pauseFor(ERROR_COOLDOWN_MS);
  }
}
