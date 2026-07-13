// Pure, DOM-free segmentation + dedup bookkeeping for the Web Speech
// engine (webSpeech.ts is the thin browser shell around this).
//
// Why this exists: Chrome's recognizer only marks a result `isFinal`
// on a pause. Under CONTINUOUS speech (a lecture, a monologue) one
// non-final result grows unboundedly — no segment ever finalizes (so
// nothing reaches detection/translation), and after roughly 1–2
// minutes the recognition service silently stalls without firing
// `onend`, killing transcription for the rest of the meeting. The
// local sidecar solved the same problem server-side with
// MAX_SEGMENT_MS = 25s force-finalization (whisper_server.py); this
// module gives the browser engine the same semantics:
//
//  - self-flush: once the unflushed interim text is long/old enough,
//    emit its stable prefix as a synthetic final segment;
//  - dedup: remember how much of each result index was already
//    flushed, so Chrome's eventual REAL final (whose transcript
//    contains everything, including what we flushed) emits only the
//    unseen suffix;
//  - holdback: never flush the revision-prone tail — Chrome rewrites
//    the last few words of an interim hypothesis as context arrives.
//
// Two flush-everything methods, both used when a recognition session
// is about to end, but for different reasons (see flushAll/flushStable
// below): flushAll grabs the holdback tail too because nothing further
// will ever be processed once the caller tears down (engine.stop());
// flushStable respects the SAME holdback boundary as self-flush
// because the caller (rotation/recovery) IS still watching — the
// dying session's own stop()-triggered real final is expected to
// complete whatever gets held back (MDN: stop() "must attempt to
// return a recognition result based on audio already collected").
// Using flushAll for rotation used to commit an in-flight revision
// (Chrome rewriting the last word, e.g. "w3" -> "w3x") as permanent,
// wrong text AND desync the dedup offset past the real final's actual
// (shorter, plain) length — the real final's slice(offset) then
// underflowed to "", silently dropping the correct word while the
// corrupted guess survived in the transcript. That was the source of
// the 66-dup regression webSpeechLoss.test.ts's natural-pauses
// scenario measured (2026-07).
//
// Rotation/stall-watchdog timing now lives in sttSupervisor.ts (the
// pure decision core the shell polls) — this module stays scoped to
// segmentation/dedup bookkeeping only.

import { diagLog } from "../lib/diag";

export const FLUSH_MAX_CHARS = 200; // self-flush when unflushed grows past this
export const FLUSH_AFTER_MS = 15_000; // …or the utterance is older than this
export const FLUSH_MIN_CHARS = 80; // time trigger needs at least this much text
export const FLUSH_HOLDBACK_CHARS = 48; // revision-prone tail, never flushed
export const FLUSH_MIN_EMIT_CHARS = 24; // don't emit crumbs

// stt-interim-shrink diag entries (append-only contract, round 3):
// module-level (not per-assembler) throttle so a single Chrome session
// that keeps revising a hypothesis down can never dominate the
// DIAG_MAX_ENTRIES ring buffer — a hard cap on ring-buffer PRESSURE
// from this one tag, independent of how many UtteranceAssembler
// instances exist over the engine's lifetime (a new one is constructed
// per WebSpeechEngine, not per session — see webSpeech.ts).
const INTERIM_SHRINK_LOG_THROTTLE_MS = 5_000;
let lastInterimShrinkLogAt = -Infinity;

function maybeLogInterimShrink(byChars: number, now: number): void {
  if (now - lastInterimShrinkLogAt < INTERIM_SHRINK_LOG_THROTTLE_MS) return;
  lastInterimShrinkLogAt = now;
  diagLog(
    "warn",
    "stt-interim-shrink",
    "non-final transcript shrank past the revision holdback",
    `byChars=${byChars}`,
  );
}

export interface EmittedFinal {
  text: string;
  startedAt: number;
}

export interface AssembleInput {
  /** Absolute result index within the recognition session. */
  index: number;
  /** Full cumulative transcript for that result (Web Speech shape). */
  transcript: string;
  isFinal: boolean;
}

export interface AssembleOutput {
  finals: EmittedFinal[];
  /** Unflushed interim remainder to display. `null` = no change since
   *  the last push()/peekInterim() call (honest interim contract,
   *  round 3 fix #A4) — the caller should skip re-emitting onInterim
   *  entirely. A non-null string (including `""`) means the remainder
   *  actually changed, `""` itself signaling a retraction (whatever
   *  was showing got fully flushed/cleared) rather than "unchanged". */
  interim: string | null;
  /** True when a REAL (recognizer-issued) final was in this event —
   *  a natural pause boundary, the cheapest moment to rotate. */
  sawRealFinal: boolean;
}

const SENTENCE_ENDERS = new Set([".", "?", "!", "。", "？", "！"]);

/** Pick how many chars of `unflushed` to emit as a synthetic final.
 *  Returns 0 for "don't flush". Prefers the last sentence-ending
 *  punctuation outside the holdback tail, then the last word gap,
 *  then (pathological no-space text) a hard cut at the limit. */
export function findFlushCut(unflushed: string): number {
  const limit = unflushed.length - FLUSH_HOLDBACK_CHARS;
  if (limit < FLUSH_MIN_EMIT_CHARS) return 0;

  for (let i = limit - 1; i >= FLUSH_MIN_EMIT_CHARS; i--) {
    if (SENTENCE_ENDERS.has(unflushed[i])) return i + 1;
  }
  const space = unflushed.lastIndexOf(" ", limit - 1);
  if (space >= FLUSH_MIN_EMIT_CHARS) return space;
  return limit;
}

export class UtteranceAssembler {
  /** result index -> chars of its transcript already emitted. */
  private flushedChars = new Map<number, number>();
  /** result index -> last-seen full transcript (non-final only). */
  private pendingSnapshots = new Map<number, string>();
  /** First-seen wall-clock of the current unflushed utterance chunk. */
  private utteranceStart: number | null = null;
  /** Last interim remainder returned as a CHANGE (by push() or
   *  peekInterim()) — the honest-null-contract baseline (fix #A4):
   *  push() only signals `interim` when the freshly-computed remainder
   *  differs from this. */
  private lastInterim = "";

  /** New recognition session: result indices restart at 0. */
  reset(): void {
    this.flushedChars.clear();
    this.pendingSnapshots.clear();
    this.utteranceStart = null;
    this.lastInterim = "";
  }

  hasPendingInterim(): boolean {
    for (const [index, snapshot] of this.pendingSnapshots) {
      if (snapshot.slice(this.flushedChars.get(index) ?? 0).trim()) {
        return true;
      }
    }
    return false;
  }

  /** Feed the CHANGED results of one recognition event. */
  push(results: AssembleInput[], now: number): AssembleOutput {
    const finals: EmittedFinal[] = [];
    let sawRealFinal = false;

    for (const r of results) {
      if (r.isFinal) {
        sawRealFinal = true;
        const offset = this.flushedChars.get(r.index) ?? 0;
        // Revision-underflow guard (fix #A2): a real final's transcript
        // SHORTER than what's already committed (offset) means Chrome
        // revised its hypothesis down past text we already emitted as
        // a synthetic final (self-flush or flushStable). slice()
        // already handles this gracefully (returns "" — committed
        // wins, behavior unchanged), so this is pure observability:
        // surface it so the drop isn't silent. PRIVACY: lengths/
        // indices only, never transcript text.
        if (r.transcript.length < offset) {
          diagLog(
            "warn",
            "stt-revision-underflow",
            "late final shorter than committed prefix; correction dropped (committed wins)",
            `idx=${r.index} committedChars=${offset} finalChars=${r.transcript.length}`,
          );
        }
        const text = r.transcript.slice(offset).trim();
        this.flushedChars.delete(r.index);
        this.pendingSnapshots.delete(r.index);
        if (text) {
          finals.push({ text, startedAt: this.utteranceStart ?? now });
        }
        this.utteranceStart = null;
      } else {
        // Interim-shrink observability (fix #A6): a non-final snapshot
        // for the SAME index shrinking its unflushed portion by more
        // than the revision holdback means Chrome un-heard a chunk of
        // its own working hypothesis — surfaced (throttled) so a
        // subsequent revision-underflow on the eventual final isn't
        // the first sign anything happened.
        const offset = this.flushedChars.get(r.index) ?? 0;
        const prevSnapshot = this.pendingSnapshots.get(r.index);
        if (prevSnapshot !== undefined) {
          const prevUnflushed = Math.max(0, prevSnapshot.length - offset);
          const nextUnflushed = Math.max(0, r.transcript.length - offset);
          const shrinkBy = prevUnflushed - nextUnflushed;
          if (shrinkBy > FLUSH_HOLDBACK_CHARS) {
            maybeLogInterimShrink(shrinkBy, now);
          }
        }
        this.pendingSnapshots.set(r.index, r.transcript);
        if (this.utteranceStart === null) this.utteranceStart = now;
      }
    }

    // Self-flush check on the newest (growing) non-final result only.
    const lastIndex = this.lastPendingIndex();
    if (lastIndex !== null) {
      const snapshot = this.pendingSnapshots.get(lastIndex) ?? "";
      const offset = this.flushedChars.get(lastIndex) ?? 0;
      const unflushed = snapshot.slice(offset);
      const oldEnough =
        this.utteranceStart !== null &&
        now - this.utteranceStart >= FLUSH_AFTER_MS &&
        unflushed.length >= FLUSH_MIN_CHARS;
      if (unflushed.length >= FLUSH_MAX_CHARS || oldEnough) {
        const cut = findFlushCut(unflushed);
        if (cut > 0) {
          const text = unflushed.slice(0, cut).trim();
          if (text) {
            finals.push({ text, startedAt: this.utteranceStart ?? now });
          }
          this.flushedChars.set(lastIndex, offset + cut);
          // The remainder (holdback tail) restarts the utterance clock.
          this.utteranceStart = now;
        }
      }
    }

    // Honest interim contract (fix #A4): only signal a change when the
    // remainder actually differs from what was last surfaced (by this
    // method OR by peekInterim()) — `null` means "nothing to do",
    // `""` itself is a real signal (a retraction cleared what was
    // showing), never conflated with "unchanged".
    const remainder = this.interimRemainder();
    const interim = remainder === this.lastInterim ? null : remainder;
    this.lastInterim = remainder;

    return { finals, interim, sawRealFinal };
  }

  /** Public read of the current unflushed remainder that ALSO updates
   *  the honest-interim-contract baseline (fix #A1's prerequisite): a
   *  caller that surfaces this value itself (webSpeech.ts's
   *  flushRotationTail, re-showing the held-back tail after a rotation
   *  flush) needs push()'s NEXT null/changed diff computed against
   *  what it just displayed, not a stale earlier value — otherwise the
   *  next push() could either wrongly re-signal the same text as
   *  "changed" or wrongly suppress a genuine change that happens to
   *  match this peeked snapshot. */
  peekInterim(): string {
    const remainder = this.interimRemainder();
    this.lastInterim = remainder;
    return remainder;
  }

  /** Flush EVERYTHING unflushed, including the revision-prone tail.
   *  For engine.stop() ONLY — once that caller tears down, no further
   *  event (in particular no trailing real final) will ever be
   *  processed, so this is the only chance to rescue the tail; a late
   *  real final would still dedup correctly against flushedChars if it
   *  somehow arrived (reset() only runs at relaunch), but nothing
   *  guarantees it does once the caller has stopped listening. */
  flushAll(now: number): EmittedFinal | null {
    const parts: string[] = [];
    for (const [index, snapshot] of [...this.pendingSnapshots.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      const offset = this.flushedChars.get(index) ?? 0;
      const tail = snapshot.slice(offset).trim();
      if (tail) parts.push(tail);
      this.flushedChars.set(index, snapshot.length);
    }
    const startedAt = this.utteranceStart ?? now;
    this.utteranceStart = null;
    if (parts.length === 0) return null;
    return { text: parts.join(" "), startedAt };
  }

  /** Flush only the SAFE (non-revision-prone) prefix of every pending
   *  index, using the same findFlushCut boundary the growth-triggered
   *  self-flush in push() uses. For rotation/recovery/steer: the
   *  caller keeps watching this session (it only just called or is
   *  about to call stop(), not tear down), so the dying session's own
   *  trailing real final reliably completes whatever gets held back
   *  here. Unlike flushAll, does NOT clear utteranceStart or fully
   *  consume an index it could only partially cut — that index is
   *  still "the same ongoing utterance" pending its trailing final. */
  flushStable(now: number): EmittedFinal | null {
    const parts: string[] = [];
    for (const [index, snapshot] of [...this.pendingSnapshots.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      const offset = this.flushedChars.get(index) ?? 0;
      const unflushed = snapshot.slice(offset);
      const cut = findFlushCut(unflushed);
      // Too short / all revision-prone to safely cut — STOP here
      // rather than skipping ahead to a later index (2026-07
      // VAD-supervisor review finding #5): indices are processed
      // oldest-first because that's chronological recognition order,
      // so flushing a LATER index's safe prefix before an EARLIER
      // one's still-pending final would land text out of order —
      // [idx1-prefix, idx0-final, idx1-tail] instead of
      // [idx0-final, idx1-prefix, idx1-tail]. Leaving idx1 (and
      // anything after it) fully pending is strictly safer than
      // reordering the transcript.
      if (cut <= 0) break;
      const text = unflushed.slice(0, cut).trim();
      if (text) parts.push(text);
      this.flushedChars.set(index, offset + cut);
    }
    if (parts.length === 0) return null;
    return { text: parts.join(" "), startedAt: this.utteranceStart ?? now };
  }

  private lastPendingIndex(): number | null {
    let last: number | null = null;
    for (const index of this.pendingSnapshots.keys()) {
      if (last === null || index > last) last = index;
    }
    return last;
  }

  private interimRemainder(): string {
    const parts: string[] = [];
    for (const [index, snapshot] of [...this.pendingSnapshots.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      const tail = snapshot.slice(this.flushedChars.get(index) ?? 0);
      if (tail.trim()) parts.push(tail.trim());
    }
    return parts.join(" ");
  }
}
