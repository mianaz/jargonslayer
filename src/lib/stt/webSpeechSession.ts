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
// The session-rotation / stall-watchdog timing constants for the
// shell live here too so they are unit-visible.

export const FLUSH_MAX_CHARS = 200; // self-flush when unflushed grows past this
export const FLUSH_AFTER_MS = 15_000; // …or the utterance is older than this
export const FLUSH_MIN_CHARS = 80; // time trigger needs at least this much text
export const FLUSH_HOLDBACK_CHARS = 48; // revision-prone tail, never flushed
export const FLUSH_MIN_EMIT_CHARS = 24; // don't emit crumbs

// Proactively rotate the recognition session well under the observed
// ~1–2min continuous-speech stall. Rotation prefers a natural pause
// (a real final) and force-flushes after the grace window.
export const SESSION_ROTATE_MS = 45_000;
export const ROTATE_GRACE_MS = 15_000;
// Watchdog: interim pending but no events → the session died mid-
// speech; no events at all for much longer → died silently (Chrome
// normally fires no-speech/onend well before this in real silence).
export const STALL_SPEECH_MS = 12_000;
export const STALL_SILENCE_MS = 30_000;

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
  /** Unflushed interim remainder to display (null = no change signal). */
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

  /** New recognition session: result indices restart at 0. */
  reset(): void {
    this.flushedChars.clear();
    this.pendingSnapshots.clear();
    this.utteranceStart = null;
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
        const text = r.transcript.slice(offset).trim();
        this.flushedChars.delete(r.index);
        this.pendingSnapshots.delete(r.index);
        if (text) {
          finals.push({ text, startedAt: this.utteranceStart ?? now });
        }
        this.utteranceStart = null;
      } else {
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

    return { finals, interim: this.interimRemainder(), sawRealFinal };
  }

  /** Flush EVERYTHING unflushed (rotation / stall recovery / user
   *  stop). A late real final from the dying session still dedups
   *  against flushedChars because reset() only runs at relaunch. */
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
