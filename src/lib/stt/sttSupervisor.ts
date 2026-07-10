// Pure decision core for the Web Speech capture supervisor
// (webSpeech.ts is the thin, timer-driven shell around this — same
// pure-core/thin-shell split as webSpeechSession.ts and vadCore.ts).
//
// Everything the old shell used to decide inline — WHEN to rotate a
// session, WHEN a stalled session needs a stop()-recovery, and WHEN
// that recovery has failed enough times to steer the user toward a
// different engine — lives here as one pure function so it is fully
// table-testable without a fake DOM/timer harness. webSpeech.ts polls
// this on its watchdog tick (every WATCHDOG_TICK_MS, see webSpeech.ts)
// with a fresh snapshot of its own state + the VAD's state, and simply
// executes whatever action comes back.
//
// Design: docs/design-explorations/stt-vad-supervisor.md (accepted
// 2026-07-09). The policy below is transcribed from that doc's pseudo-
// code verbatim — do not "simplify" the branch order, the ordering
// encodes real priority (e.g. the hard rotation ceiling always wins,
// even mid-stall-backoff).

// ---- rotation: proactively end a session well under Chrome's
// observed continuous-speech stall, preferring a natural acoustic
// pause over a forced mid-utterance cut. ----
export const SESSION_ROTATE_SOFT_MS = 35_000;
export const SESSION_ROTATE_HARD_MS = 55_000;
// How long a VAD-observed silence gap must hold before a SOFT-age
// rotation is allowed to take it — long enough that it's a genuine
// pause, not just the micro-gap between two words.
export const ROTATE_PAUSE_MS = 700;

// ---- stall recovery: the recognizer went quiet even though VAD says
// someone is still talking (the untranscribable-language case that
// used to cost a routine abort() + full data loss every ~12s). ----
export const STALL_SPEECH_MS = 7_000;
// VAD-unavailable fallback only (see decideAction's `else` branch):
// today's old STALL_SILENCE_MS, hardened by stop()-first recovery
// even though we have no VAD signal to gate on.
export const STALL_SILENCE_MS_LEGACY = 30_000;
// Ultimate failsafe: fires even during VAD-confirmed silence, where
// the policy otherwise deliberately never recovers (rotation is
// supposed to have already ended a silently-dead session well before
// this — this only catches a session so zombied even rotation's
// stop() produced nothing).
export const STALL_ABSOLUTE_MS = 75_000;
// After this many consecutive speech-stall recoveries without an
// intervening real final (i.e. recovery isn't helping), stop blindly
// retrying every ~STALL_SPEECH_MS and steer the user toward a
// different engine instead — still backed by the same stop()-recovery,
// just throttled.
export const STALL_STEER_AFTER = 2;
export const STALL_BACKOFF_MS = 30_000;

export type SupervisorAction =
  | { type: "none" }
  | { type: "rotate" }
  | { type: "recover" }
  | { type: "steer" };

export interface SupervisorInput {
  /** Current wall-clock time (Date.now()). */
  now: number;
  /** When the CURRENT recognition session was launched. */
  sessionStartedAt: number;
  /** Last time any recognizer event (result/error) was observed. */
  lastEventAt: number;
  /** Whether the VAD shell came up successfully this meeting. */
  vadAvailable: boolean;
  /** VAD's debounced speaking flag (meaningless if !vadAvailable). */
  vadSpeaking: boolean;
  /** VAD's last-observed-loud-audio timestamp (see vadCore.ts). */
  lastSpeechAt: number;
  /** Assembler has unflushed interim text right now. */
  hasPendingInterim: boolean;
  /** A real (recognizer-issued) final has landed since this session's
   *  age crossed SESSION_ROTATE_SOFT_MS — the cheapest, least lossy
   *  moment to rotate. Shell-tracked, reset per session. */
  realFinalSinceSoft: boolean;
  /** Consecutive speech-stall recoveries without an intervening real
   *  final. Shell-tracked; reset whenever a real final lands. */
  consecutiveSpeechStalls: number;
  /** Wall-clock time of the last recover/steer action's stop() call
   *  (-Infinity if none yet this meeting). */
  lastRecoverAt: number;
}

/** Pure policy: given one snapshot of supervisor state, what should
 *  the shell do right now? Exact transcription of the accepted
 *  design's pseudocode — see the module doc comment above. */
export function decideAction(input: SupervisorInput): SupervisorAction {
  const {
    now,
    sessionStartedAt,
    lastEventAt,
    vadAvailable,
    vadSpeaking,
    lastSpeechAt,
    hasPendingInterim,
    realFinalSinceSoft,
    consecutiveSpeechStalls,
    lastRecoverAt,
  } = input;

  const age = now - sessionStartedAt;
  const idle = now - lastEventAt;
  const gap = vadAvailable ? now - lastSpeechAt : Infinity;

  // Hard ceiling always wins — never let a session run past this
  // regardless of what else is going on.
  if (age >= SESSION_ROTATE_HARD_MS) return { type: "rotate" };

  // Soft ceiling reached: take the cheapest rotation opportunity —
  // either a natural pause boundary (a real final) we've already seen
  // since crossing SOFT, or (VAD-equipped only) an acoustic gap long
  // enough to be a genuine pause rather than a mid-word micro-gap.
  if (age >= SESSION_ROTATE_SOFT_MS && realFinalSinceSoft) {
    return { type: "rotate" };
  }
  if (
    age >= SESSION_ROTATE_SOFT_MS &&
    vadAvailable &&
    !hasPendingInterim &&
    gap >= ROTATE_PAUSE_MS
  ) {
    return { type: "rotate" };
  }

  if (vadAvailable) {
    if (vadSpeaking && idle >= STALL_SPEECH_MS) {
      if (consecutiveSpeechStalls >= STALL_STEER_AFTER) {
        return now - lastRecoverAt >= STALL_BACKOFF_MS
          ? { type: "steer" }
          : { type: "none" };
      }
      return { type: "recover" };
    }
    // VAD says silence: never recover on stall grounds — rotation
    // (above) is what ends a session that dies during genuine
    // silence, so we don't cold-restart a perfectly idle-but-alive
    // recognizer just because nothing has been said in a while.
  } else {
    // No VAD signal this meeting (unsupported browser / permission
    // denial / capture failure) — fall back to a hardened version of
    // the pre-VAD watchdog: still stop()-first, just without the
    // speech/silence distinction VAD would otherwise give us.
    const limit = hasPendingInterim ? STALL_SPEECH_MS : STALL_SILENCE_MS_LEGACY;
    if (idle >= limit) return { type: "recover" };
  }

  // Absolute failsafe: catches a session so zombied that neither the
  // rotation ceiling nor the branches above ever managed to end it.
  if (idle >= STALL_ABSOLUTE_MS) return { type: "recover" };

  return { type: "none" };
}
