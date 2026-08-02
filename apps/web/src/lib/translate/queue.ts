// Live bilingual transcript (#42): batches FINALIZED transcript
// segments and drives an injected TranslationProvider (v0.5 Wave-1
// Feature 6, providers.ts — "llm" by default, wrapping the same
// /api/translate path as before; "system" = an on-device provider,
// e.g. Chrome's Translator API) so each segment gets a secondary
// translated line under the English text. Sibling to detect/
// scheduler.ts but simpler — no dictionary fallback, no mode-changing
// latch (a dropped batch here just means one segment stays
// English-only, not something the user needs to be told about beyond
// the one-time NoKey toast — see MAX_CONSECUTIVE_RATE_LIMITS for the
// one queue-management counter this DOES keep). Public signature is
// contract — do not change it.

import { NoKeyError, RateLimitApiError } from "../llm/client";
import { SystemTranslatorUnavailableError, type TranslationProvider } from "./providers";
import type { Settings, TranscriptSegment } from "@jargonslayer/core/types";
import { diagLog } from "../diag/log";

export interface TranslateQueueOptions {
  getSettings: () => Settings;
  // Meeting-boundary guard, same pattern as DetectionScheduler: gen is
  // captured at dispatch time and re-checked when the response lands.
  // A response whose captured gen no longer matches the store's
  // current gen belongs to a PREVIOUS meeting and is silently dropped.
  getMeetingGen: () => number;
  // v0.5 Wave-1 Feature 6: resolved once per meeting by useMeeting.ts's
  // start() (resolveTranslationProvider) and primed there via a
  // synchronous prepare() call — see providers.ts's own header comment
  // for the full A6 activation contract. The queue only ever calls
  // translate() on it; it never resolves/primes a provider itself.
  provider: TranslationProvider;
  onTranslations: (map: Record<string, string>, gen: number) => void;
  onError: (msg: string) => void;
  // v0.7 wave 2A — optional, additive: a caller-observable state stream,
  // separate from onError's one-shot-per-meeting toast. `pending` is
  // queued items PLUS whatever's currently dispatched/in-flight (Finding
  // 5 fix, adversarial review: a ≤batch-size backlog must not report 0
  // while a request is outbound — see emitState/runBatch below). "busy":
  // that count > 0. "stalled": paused (a NoKeyError/
  // SystemTranslatorUnavailableError/rate-limit/generic-error cooldown
  // — see pauseFor/handleError below), `reason` set to whatever zh
  // string already exists for that pause (undefined where none does,
  // e.g. a rate-limit or generic-error cooldown, which have no user-
  // facing copy today). "done": the queue has drained back to fully
  // idle (nothing pending, nothing in flight, not paused) AFTER at
  // least one translation has actually landed via onTranslations. "off"
  // (Finding 6 fix, adversarial review — supersedes the old "off is
  // NEVER emitted" note): the queue has drained back to fully idle but
  // has NEVER yet landed a translation this meeting — documented as
  // "idle, nothing shown" (the StatusLine chip renders enabled+off
  // neutrally). "dead" (FT-11 fix — a distinct terminal state from
  // "stalled": a merely-paused lane self-heals and eventually shows
  // "busy"/"done" again, but a lane that has failed EVERY batch this
  // meeting just oscillates stalled<->busy forever, which reads to a
  // user as "working, occasionally hiccuping" rather than the truth —
  // see MAX_CONSECUTIVE_FAILED_BATCHES_DEAD below): no translation has
  // ever landed AND consecutiveFailedBatches has reached that
  // threshold. Sticky by construction — emitState checks it BEFORE
  // stalled/busy/done below, so it keeps winning on every later retry
  // (never flips back to "busy") until a batch actually lands, which
  // resets the counter and leaves hasLandedTranslation permanently
  // true, so "dead" can never re-trigger for the rest of the meeting.
  // The caller still separately derives its OWN "off" from
  // Settings.bilingualTranscript being off (this queue keeps running
  // even while the toggle is off, just no-opping every enqueue — see
  // pushSegment/backfill/tryFlush's own toggle checks); this class just
  // no longer refuses to ever emit the same string itself. Consecutive
  // identical emissions (same state + pending + reason) are deduped —
  // pushing a 2nd/3rd segment while already "busy" doesn't re-fire the
  // same event.
  onState?: (s: {
    state: "off" | "busy" | "done" | "stalled" | "dead";
    pending: number;
    reason?: string;
  }) => void;
}

// ---------------------------------------------------------------
// Tunables — see IMPLEMENT step 5 in the feature spec for rationale.
// ---------------------------------------------------------------

// S14.1 field fix (item 8b, real owner report): "翻译 does not appear
// per-chunk/segment — it appears all in one go for all segments in a
// period of time." Root cause is two tunables compounding: DEBOUNCE_MS
// delays even the FIRST flush of a quiet period, and — the bigger
// contributor — tryFlush() only ever has ONE batch in flight
// (`inflight`, see below); every segment finalized while an LLM
// round-trip is pending (multiple seconds, routinely longer than the
// old debounce) just piles up in `pending` and ships as one big batch
// the moment the previous one clears, instead of trickling in. Not
// redesigning the single-inflight queue itself (a provider-injection
// refactor is coming in another lane) — just shrinking both knobs so
// each wave is smaller/sooner: DEBOUNCE_MS 1500->800 (less wait before
// the FIRST flush of any quiet period), BATCH_MAX 6->3 (a busy-talk
// backlog now ships in 2 waves of <=3 instead of 1 wave of <=6, so the
// first few translations land roughly one LLM round-trip sooner).
// Request count roughly doubles ONLY during a genuine sustained-talk
// backlog (bounded, not exploding — the common case, one segment
// arriving well after the previous batch cleared, is still exactly
// one request either way).
const DEBOUNCE_MS = 800;
const BATCH_MAX = 3;
const MAX_TEXT_CHARS = 1500;
const RATE_LIMIT_PAUSE_MS = 30_000;
const ERROR_COOLDOWN_MS = 5_000;
// NoKeyError is thrown locally by the client (no network request at
// all — see handleError below), so retrying every 60s costs nothing;
// this turns "no key configured" from a permanent-for-the-meeting
// latch into a self-healing pause that quietly recovers once the user
// fills in a key, without them having to restart the meeting.
const NO_KEY_PAUSE_MS = 60_000;
// v0.5 Wave-1 Feature 6 / A6: same self-healing shape as NO_KEY_PAUSE_MS
// (drop pending, pause, retry) but for a system-provider (e.g. Chrome
// Translator) that's unavailable or still mid-download — a distinct
// constant purely so the pause site reads clearly, not because the
// value needs to differ.
const SYSTEM_UNAVAILABLE_PAUSE_MS = 60_000;
// Persistent 429s would otherwise re-queue the SAME oldest batch
// forever, starving every newer segment behind it — 5 consecutive
// failures (~2.5min at the 30s pause above) gives up on that one
// batch (segments stay English-only) so the queue can move on.
const MAX_CONSECUTIVE_RATE_LIMITS = 5;
// FT-11 fix: a "dead" lane (see onState's own doc above) — 3 straight
// batch failures of ANY kind, with nothing yet landed this meeting.
// Deliberately independent of MAX_CONSECUTIVE_RATE_LIMITS/
// MAX_RETRIES_PER_SEGMENT (which govern what happens to the DATA — drop
// vs re-queue) — this one only ever governs what the status chip says.
// 3 lines up with the field report's own timeline: at SYSTEM_UNAVAILABLE_
// PAUSE_MS (60s), 3 failures is ~2min of silently-stuck translation
// before the user is told anything is wrong.
const MAX_CONSECUTIVE_FAILED_BATCHES_DEAD = 3;
// S14.1 field fix (item 8a, real owner report): "翻译 missing some
// middle parts if we pause-restart-pause." pushSegment/onFinal have no
// status gate and nothing resets `pending` on pause (verified by
// reading useMeeting.ts's pause()/resume() — a soft OR teardown pause
// either keeps this same queue instance alive untouched, or its
// engine.stop() flushes the in-flight tail through the SAME onFinal ->
// pushSegment path as any other final) — so a segment is never
// SKIPPED at enqueue time around a pause/resume boundary. The actual
// gap: this used to be a Set (each item got exactly ONE retry, ever,
// for the whole meeting — see the old failedOnce doc below, kept
// verbatim in git history) — a single transient failure (mobile
// Safari backgrounding a paused tab routinely stalls/aborts an
// in-flight fetch, which is disproportionately likely to be happening
// right around a pause) burned that one retry and left the segment
// silently, PERMANENTLY English-only for the rest of the meeting, with
// only a console.warn no phone field session could ever see. Retries
// are now counted per-segment (retryCount, below) up to this cap
// instead — a segment stays eligible across however many
// debounce/cooldown cycles it takes, which naturally spans a
// pause/resume with no separate "resume" hook needed.
const MAX_RETRIES_PER_SEGMENT = 3;

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
  // Finding 5 fix (adversarial review): count of items in the CURRENT
  // in-flight batch (0 while nothing is dispatched) — folded into
  // emitState's reported `pending` below so a ≤BATCH_MAX backlog that's
  // already been dispatched (removed from `pending` itself, awaiting a
  // response) still reports its true size instead of a misleading 0
  // that would let a caller's "translation done" gate (e.g. the End
  // flow) fire while a request is still outbound.
  private inflightCount = 0;
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
  // SystemTranslatorUnavailableError toast fires at most once per
  // meeting too — same one-shot rationale as noKeyToastShown.
  private systemUnavailableToastShown = false;
  private consecutiveRateLimits = 0; // reset on any successful batch
  // FT-11 fix: counts ANY handleError() call (every error type, not
  // just rate limits) since the last landed translation — feeds the
  // "dead" state (see onState's own doc + MAX_CONSECUTIVE_FAILED_
  // BATCHES_DEAD above). Reset to 0 the moment a batch actually lands
  // (attemptTranslate's own success branch), same as
  // consecutiveRateLimits above but never reset by a mere
  // retry-eligible failure.
  private consecutiveFailedBatches = 0;
  // Per-segment generic-error retry attempts so far (S14.1 field fix,
  // item 8a — see MAX_RETRIES_PER_SEGMENT's own doc above for why this
  // replaced a one-shot Set). Not cleared on success for an id that
  // never actually retried (the common case) — only ever read/written
  // for an id that has failed at least once, so this stays small.
  private retryCount = new Map<string, number>();
  // onState support (v0.7 wave 2A) — see TranslateQueueOptions.onState's
  // own doc comment for the full state-machine contract.
  private hasLandedTranslation = false; // flips true the first time onTranslations fires with >=1 entry
  private lastEmittedState: {
    state: "off" | "busy" | "done" | "stalled" | "dead";
    pending: number;
    reason?: string;
  } | null = null;
  // The zh reason string the MOST RECENT pauseFor() call was given (see
  // that method's own doc) — stored rather than threaded through every
  // emitState() call site so a seam that fires WHILE already paused
  // (e.g. runBatch's finally, right after handleError's own pauseFor
  // already emitted) reads back the SAME reason instead of clobbering
  // it with undefined.
  private currentPauseReason: string | undefined = undefined;

  constructor(private opts: TranslateQueueOptions) {}

  /** Feed one finalized segment. No-op (silent) when the toggle is
   *  off or the segment is too long to bother translating. */
  pushSegment(seg: TranscriptSegment): void {
    if (this.stopped) return;
    if (!this.opts.getSettings().bilingualTranscript) return;
    if (seg.text.length > MAX_TEXT_CHARS) return;

    this.pending.push({ id: seg.id, text: seg.text });
    this.armDebounce();
    this.emitState();
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
    this.emitState();
  }

  /** Cancel timers and drop pending work. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearDebounce();
    this.clearResumeTimer();
    this.pending = [];
    // Late in-flight responses may still call onTranslations after
    // this — fine/desired, same rationale as DetectionScheduler.stop().
    // Sol r2 MEDIUM: publish the terminal state, or a 直接结束/timed-out
    // drain leaves the StatusLine chip stuck on 翻译中/翻译暂停 forever.
    // Direct callback (not emitState) — internals like inflightCount may
    // still be nonzero for the abandoned batch, and dedupe must not eat
    // this terminal emission.
    this.opts.onState?.({ state: "off", pending: 0 });
  }

  /** Resolves true once the queue is genuinely idle (nothing pending, no
   *  batch in flight) within `timeoutMs`; false if that timeout elapses
   *  first. Resolves false IMMEDIATELY (no wait at all) when the queue
   *  is currently paused/stalled, or the moment it BECOMES paused while
   *  already waiting — a pause self-heals on its own resumeTimer, not
   *  because some caller happened to be draining it, so a caller must
   *  never block on a queue that cannot make progress on its own right
   *  now. Observation only — polls the same state emitState() already
   *  derives from; never touches pending/inflight/pausedUntil itself. */
  drain(timeoutMs: number): Promise<boolean> {
    if (this.isPaused()) return Promise.resolve(false);
    if (this.pending.length === 0 && !this.inflight) return Promise.resolve(true);

    const DRAIN_POLL_MS = 50;
    return new Promise((resolve) => {
      const start = Date.now();
      const id = setInterval(() => {
        if (this.isPaused()) {
          clearInterval(id);
          resolve(false);
          return;
        }
        if (this.pending.length === 0 && !this.inflight) {
          clearInterval(id);
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          clearInterval(id);
          resolve(false);
        }
      }, DRAIN_POLL_MS);
    });
  }

  // ---------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------

  private isPaused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  /** Derives the current state from live queue fields and emits through
   *  onState IFF it (state + pending count + reason) differs from the
   *  last emission — see TranslateQueueOptions.onState's own doc comment
   *  for the full contract. A no-op with no onState configured. */
  private emitState(): void {
    if (!this.opts.onState) return;
    // Sol r3 (reopen of the stop-emission fix): stop()'s direct off
    // emission is the TERMINAL state — an already in-flight batch's
    // .finally()/error path must not emit past it (End doesn't bump
    // meetingGen, so the useMeeting gen guard would accept it).
    if (this.stopped) return;
    // Finding 5 fix: queued + in-flight, so a dispatched-but-unresolved
    // batch still counts (see inflightCount's own doc above).
    const pending = this.pending.length + this.inflightCount;
    // FT-11 fix: "dead" is checked FIRST, ahead of stalled/busy/done —
    // this is what makes it sticky (onState's own doc): as long as
    // nothing has landed and the failure streak stays at/above the
    // threshold, a later retry's own busy/stalled emission is
    // pre-empted by this same branch instead of flipping back.
    let state: "off" | "busy" | "done" | "stalled" | "dead" =
      !this.hasLandedTranslation && this.consecutiveFailedBatches >= MAX_CONSECUTIVE_FAILED_BATCHES_DEAD
        ? "dead"
        : this.isPaused()
          ? "stalled"
          : this.inflight || pending > 0
            ? "busy"
            : "done";
    // Finding 6 fix: a "done"-shaped drain (fully idle, not paused) that
    // has never landed a single translation reports "off" instead of
    // going silent forever — see onState's own doc for the "idle,
    // nothing shown" contract this documents. `done` itself stays
    // gated on >=1 landed translation, unchanged.
    if (state === "done" && !this.hasLandedTranslation) state = "off";
    const next = {
      state,
      pending,
      reason: state === "stalled" || state === "dead" ? this.currentPauseReason : undefined,
    };
    const last = this.lastEmittedState;
    if (last && last.state === next.state && last.pending === next.pending && last.reason === next.reason) {
      return;
    }
    this.lastEmittedState = next;
    this.opts.onState(next);
  }

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
   *  meantime (see the pausedUntil field doc above). `reason` (v0.7
   *  wave 2A) is whatever zh string already exists for this pause at
   *  its call site (undefined where none does, e.g. a rate-limit or
   *  generic-error cooldown) — stashed for emitState()'s "stalled"
   *  reason field, independent of whether onError's own one-shot toast
   *  fires for this same pause. */
  private pauseFor(ms: number, reason?: string): void {
    // Sol r3: a late in-flight rejection landing after stop() must not
    // re-arm the resume timer on a dead queue.
    if (this.stopped) return;
    this.pausedUntil = Date.now() + ms;
    this.currentPauseReason = reason;
    this.clearResumeTimer();
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.tryFlush();
    }, ms);
    this.emitState();
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
      this.emitState();
      return;
    }

    const items = this.pending.slice(0, BATCH_MAX);
    this.pending = this.pending.slice(BATCH_MAX);

    const batch: Batch = { items, gen: this.opts.getMeetingGen() };
    this.runBatch(batch);
    this.emitState();
  }

  private runBatch(batch: Batch): void {
    this.inflight = true;
    this.inflightCount = batch.items.length;
    void this.attemptTranslate(batch).finally(() => {
      this.inflight = false;
      this.inflightCount = 0;
      if (this.pending.length > 0) {
        // Re-arm the ordinary debounce for the next batch. If this
        // batch just triggered a cooldown, handleError already armed
        // its own resumeTimer (pauseFor) — tryFlush's pausedUntil
        // check makes an early debounce tick here a harmless no-op.
        this.armDebounce();
      }
      this.emitState();
    });
  }

  private async attemptTranslate(batch: Batch): Promise<void> {
    const settings = this.opts.getSettings();
    try {
      const translations = await this.opts.provider.translate(batch.items, settings.explainLanguage);

      // Meeting-boundary guard — see TranslateQueueOptions.getMeetingGen.
      if (batch.gen !== this.opts.getMeetingGen()) return;

      // Any successful batch clears the consecutive-429 counter — only
      // an unbroken run of failures should ever trigger the drop-batch
      // escape hatch below.
      this.consecutiveRateLimits = 0;

      if (translations.length > 0) {
        const map: Record<string, string> = {};
        for (const t of translations) map[t.id] = t.text;
        // v0.7 wave 2A: at least one translation has now genuinely
        // landed — emitState()'s "done" case gates on this so a queue
        // that has never yet succeeded stays silent instead of firing a
        // premature "done".
        this.hasLandedTranslation = true;
        // FT-11 fix: a genuine landing clears the "dead" failure streak —
        // see MAX_CONSECUTIVE_FAILED_BATCHES_DEAD's own doc above.
        this.consecutiveFailedBatches = 0;
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
    // Sol r3: an in-flight rejection landing after stop() is abandoned
    // wholesale — no re-queue, no pause timer, no emission (stop()
    // already published the terminal off state).
    if (this.stopped) return;
    // Finding 5 fix follow-up: zero the in-flight bookkeeping for THIS
    // batch immediately, before any branch below runs — every branch
    // either drops these items outright or re-queues them into
    // `pending` itself, and several call pauseFor (which emits state
    // synchronously, right here, well before runBatch's own trailing
    // .finally() would otherwise clear inflightCount). Without this, a
    // re-queued/dropped item would be double-counted — once via
    // `pending`, once via a still-stale inflightCount — in whatever
    // emitState() a branch below triggers. That trailing .finally()
    // still unconditionally re-zeroes both afterward too — a no-op by
    // then, kept as the safety net for the stale-gen early return just
    // below (which never reaches any branch that would reset these).
    this.inflight = false;
    this.inflightCount = 0;
    // Same meeting-boundary guard as the success path — an error for a
    // batch dispatched by a PREVIOUS meeting must not latch/toast onto
    // the current (unrelated) meeting.
    if (batch.gen !== this.opts.getMeetingGen()) return;

    // FT-11 fix: counts toward the "dead" status chip (onState's own
    // doc) — every branch below either drops or re-queues this batch,
    // so reaching this point at all is, from the status chip's
    // perspective, a failure regardless of which specific error it was.
    this.consecutiveFailedBatches++;
    if (this.consecutiveFailedBatches === MAX_CONSECUTIVE_FAILED_BATCHES_DEAD && !this.hasLandedTranslation) {
      // S14.1-style visibility fix, same motivation as the rate-limit/
      // generic-error diagLogs below: a field session with no devtools
      // needs 复制诊断信息 to carry this out, not just a chip flip nobody
      // is there to screenshot in time.
      diagLog(
        "error",
        "translate-queue",
        "translate queue has failed every batch so far this meeting — reporting 'dead' to the status chip",
        `consecutiveFailedBatches=${this.consecutiveFailedBatches}`,
      );
    }

    // v0.5 Wave-1 Feature 6 / A6: a system-provider (e.g. Chrome
    // Translator) failure gets its OWN classification — it must never
    // fall into the LLM-specific NoKeyError/RateLimitApiError branches
    // below, and it never enters the generic-error one-retry path
    // either (retrying an unavailable/still-downloading model on the
    // SAME batch is pointless): drop this batch outright (segments
    // stay English-only, no retry) and pause+self-heal, same shape as
    // NoKeyError just below.
    if (err instanceof SystemTranslatorUnavailableError) {
      this.pending = [];
      // Computed unconditionally (not just inside the toast-once gate
      // below) — emitState()'s "stalled" reason (v0.7 wave 2A) should
      // reflect why the queue is paused on EVERY pause, independent of
      // whether the one-shot onError toast fires for this one.
      const msg =
        err.reason === "downloading"
          ? "系统翻译模型下载中，双语转录已暂停，下载完成后自动恢复"
          : "系统翻译不可用，双语转录已暂停。可在设置中切换回 AI 模型翻译";
      this.pauseFor(SYSTEM_UNAVAILABLE_PAUSE_MS, msg);
      if (!this.systemUnavailableToastShown) {
        this.systemUnavailableToastShown = true;
        this.opts.onError(msg);
      }
      return;
    }

    if (err instanceof NoKeyError) {
      // Self-healing pause, not a permanent latch: drop pending (a
      // long keyless meeting shouldn't grow the queue unbounded) and
      // pause 60s. NoKeyError is thrown locally with no network round
      // trip, so retrying on the next debounce tick after a key is
      // filled in is free — the queue recovers on its own, no restart
      // needed. The toast still only fires once per meeting so filling
      // in a key mid-meeting isn't followed by a flood of repeats.
      this.pending = [];
      const msg = "未配置 API Key，双语转录已暂停。前往设置填入 Key 即可自动恢复";
      this.pauseFor(NO_KEY_PAUSE_MS, msg);
      if (!this.noKeyToastShown) {
        this.noKeyToastShown = true;
        this.opts.onError(msg);
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
        // S14.1 field fix (item 8a): this drop used to be silent —
        // diagLog so a field run's timeline shows which/how many
        // segments this was (same "make a silent failure visible"
        // motivation as webSpeech.ts's own item 7a additions).
        diagLog(
          "warn",
          "translate-queue",
          "gave up on a batch after repeated rate-limit failures — staying English-only",
          `count=${batch.items.length} consecutiveRateLimits=${MAX_CONSECUTIVE_RATE_LIMITS}`,
        );
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

    // Accept (adversarial review, LOW, parked): a DeepL 5xx lands here
    // as a plain thrown Error (see providers.ts's DeepLTranslationProvider
    // — only 403/429/456 get their own classification above), so it
    // rides this SAME generic per-segment retry budget/cooldown as any
    // other transient failure rather than a dedicated exponential
    // backoff. Deliberately deferred, not fixed here.
    //
    // Any other error: re-queue each item up to MAX_RETRIES_PER_SEGMENT
    // times (see that constant's own doc — S14.1 item 8a) instead of
    // the old one-shot Set; an item that exhausts every attempt is
    // still dropped (unbounded retries would let one poisoned segment
    // loop forever) but now diagLog's the drop instead of only a
    // console.warn no mobile field session could ever see. The
    // cooldown still spaces the retry so a down endpoint isn't
    // hammered on every debounce tick.
    const retriable = batch.items.filter(
      (it) => (this.retryCount.get(it.id) ?? 0) < MAX_RETRIES_PER_SEGMENT,
    );
    const exhaustedCount = batch.items.length - retriable.length;
    for (const it of retriable) {
      this.retryCount.set(it.id, (this.retryCount.get(it.id) ?? 0) + 1);
    }
    if (retriable.length > 0) {
      this.pending = [...retriable, ...this.pending];
    }
    if (exhaustedCount > 0) {
      diagLog(
        "warn",
        "translate-queue",
        "segment(s) gave up on translation after repeated errors — staying English-only",
        `count=${exhaustedCount} maxRetries=${MAX_RETRIES_PER_SEGMENT}`,
      );
    }
    console.warn(
      `[TranslateQueue] batch error — retrying ${retriable.length}/${batch.items.length}`,
      err,
    );
    this.pauseFor(ERROR_COOLDOWN_MS);
  }
}
