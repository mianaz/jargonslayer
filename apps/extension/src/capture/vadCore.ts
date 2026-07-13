// Pure, DOM-free voice-activity classifier (vad.ts is the thin browser
// shell around this, mirroring the webSpeechSession.ts pattern).
//
// Why this exists: the STT supervisor (sttSupervisor.ts) needs to tell
// apart "the recognizer is silent because the room is silent" from
// "the recognizer is silent even though someone is still talking" —
// the two failure modes need opposite treatment (do nothing / recover
// respectively). This module turns a stream of dB samples into that
// signal: a debounced `speaking` boolean plus `lastSpeechAt`, so the
// supervisor can compute a "how long since real audio energy" gap
// independent of whatever the recognizer itself is doing.
//
// Two behaviors, both intentionally simple (no FFT/spectral work —
// vad.ts's AnalyserNode already gives us RMS→dB, this module only
// debounces + adapts the threshold):
//
//  - attack/release debounce: a single loud/quiet sample never flips
//    `speaking` — avoids chair-creak/cough spikes reading as "speech
//    resumed" and a normal word-to-word micro-gap reading as
//    "silence". VAD_ATTACK_MS of continuous loud audio before flipping
//    on; VAD_RELEASE_MS of continuous quiet before flipping off.
//  - adaptive noise floor: a room's baseline hiss/hum drifts (AC
//    cycling, other speakers, mic AGC settling) — an EMA tracks it,
//    updated ONLY on quiet samples (never during speech, or a loud
//    sustained utterance would drag the floor up and eventually get
//    misclassified as background noise).
//
// `lastSpeechAt` deliberately only advances once a loud run has
// cleared the attack debounce (i.e. while `speaking` is true) — a
// sub-attack blip must not reset the supervisor's pause-gap clock, or
// a noisy-but-silent room could block rotation forever. It freezes the
// instant audio goes quiet (not gated by the release debounce), so the
// gap starts growing from the true acoustic pause, not from whenever
// the hysteresis eventually flips `speaking` off.

export const VAD_SAMPLE_MS = 50;
export const VAD_ATTACK_MS = 100;
export const VAD_RELEASE_MS = 250;
export const VAD_NOISE_MARGIN_DB = 8;
export const VAD_FLOOR_EMA = 0.05;
export const VAD_FLOOR_INIT_DB = -60;
// Defensive floor for every sample this core is fed. The shell's own
// RMS->dB conversion should already clamp digital silence (rms=0,
// mathematically -Infinity dB) to a finite minimum (see vad.ts's
// computeDb) — but sample() re-clamps here too, so this pure core can
// never be poisoned by a non-finite input regardless of the caller.
// Without this, one -Infinity sample drags the quiet-frame floor EMA
// toward -Infinity, and `-Infinity >= floor(-Infinity) + margin` is
// TRUE — digital silence would then misclassify as permanent speech
// (false stall "recoveries" + steer spam, pause-rotation dead; the
// 2026-07 VAD-supervisor review's blocking finding #1).
export const VAD_MIN_DB = -90;

export interface VadState {
  speaking: boolean;
  lastSpeechAt: number;
}

export class VadCore {
  private floor = VAD_FLOOR_INIT_DB;
  private speaking = false;
  // -Infinity: "no speech observed yet" — any gap computed against
  // this is Infinity, i.e. "as silent as it gets", the correct
  // starting posture before the first sample arrives.
  private lastSpeechAt = -Infinity;
  private loudSince: number | null = null;
  private quietSince: number | null = null;

  /** Current noise floor estimate, dB. Exposed for tests only. */
  get floorDb(): number {
    return this.floor;
  }

  get state(): VadState {
    return { speaking: this.speaking, lastSpeechAt: this.lastSpeechAt };
  }

  /** Feed one dB sample at wall-clock `now`. Returns the updated state. */
  sample(db: number, now: number): VadState {
    // Clamp non-finite/absurdly-low input to VAD_MIN_DB (see its doc
    // comment) — this is what actually stops -Infinity from ever
    // reaching the floor EMA below.
    const safeDb = Number.isFinite(db) ? Math.max(db, VAD_MIN_DB) : VAD_MIN_DB;
    const loud = safeDb >= this.floor + VAD_NOISE_MARGIN_DB;

    if (loud) {
      this.quietSince = null;
      if (this.loudSince === null) this.loudSince = now;
      if (!this.speaking && now - this.loudSince >= VAD_ATTACK_MS) {
        this.speaking = true;
      }
      if (this.speaking) this.lastSpeechAt = now;
    } else {
      this.loudSince = null;
      if (this.quietSince === null) this.quietSince = now;
      if (this.speaking && now - this.quietSince >= VAD_RELEASE_MS) {
        this.speaking = false;
      }
      // Adapt the floor only on quiet frames — a loud, sustained
      // utterance must never drag the floor up.
      this.floor = this.floor * (1 - VAD_FLOOR_EMA) + safeDb * VAD_FLOOR_EMA;
    }

    return this.state;
  }
}
