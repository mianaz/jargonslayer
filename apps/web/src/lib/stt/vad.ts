// Browser shell around VadCore (see vadCore.ts for the pure debounce/
// floor-adaptation logic): turns live microphone audio into the
// speaking/silence signal sttSupervisor.ts's policy runs on.
//
// Capture posture mirrors whisperSocket.ts's acquireStream (mono,
// echo-cancellation/noise-suppression OFF, auto-gain ON) — this is a
// listening pass, not a call, so EC/NS would actively fight exactly
// the far-field/external audio this whole feature exists to notice.
// Runs as its OWN independent getUserMedia stream in this phase (see
// the design doc's Phase 2 note on sharing one raw-capture track with
// the recognizer) — acceptable duplication for Phase 1's scope.
//
// Strict enhancement: start() returns false on ANY failure (API
// missing, permission denied, AudioContext unavailable, ...) and never
// throws — webSpeech.ts must run exactly as well as it did with no VAD
// at all when that happens (see sttSupervisor.ts's vadAvailable=false
// legacy branch).

import { VAD_MIN_DB, VadCore, type VadState } from "./vadCore";

const VAD_SAMPLE_MS = 50;
const FFT_SIZE = 1024;

export interface VadHandle {
  /** Resolves true once live sampling has started, false on any
   *  failure (never throws/rejects). */
  start(): Promise<boolean>;
  stop(): void;
  readonly available: boolean;
  readonly state: VadState;
}

function computeDb(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i++) {
    sumSquares += buffer[i] * buffer[i];
  }
  const rms = Math.sqrt(sumSquares / buffer.length);
  // True digital silence (rms=0) has no finite dB (log(0) = -Infinity)
  // — clamp to VAD_MIN_DB instead. An unclamped -Infinity would drag
  // VadCore's quiet-frame floor EMA toward -Infinity, at which point
  // `-Infinity >= floor + margin` is TRUE and silence misclassifies as
  // permanent speech (see vadCore.ts's VAD_MIN_DB doc comment — that
  // module also re-clamps defensively, but this shell must not emit
  // the poison value in the first place either).
  return rms > 0 ? Math.max(VAD_MIN_DB, 20 * Math.log10(rms)) : VAD_MIN_DB;
}

export class SpeechActivityDetector implements VadHandle {
  private core = new VadCore();
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  // Set by stop() and checked right after start()'s only await
  // (getUserMedia) — real cancellation, not just "the caller stopped
  // caring". Without this, a stop() that races the pending
  // getUserMedia() call tears down an instance that owns nothing yet;
  // the stream/context/interval start() goes on to acquire afterward
  // then live on with nothing referencing them — hot mic until reload
  // (2026-07 VAD-supervisor review's blocking finding #2). webSpeech.ts
  // additionally captures its OWN local reference to this instance so
  // a start/stop/start race can't lose track of WHICH detector needs
  // stopping — the two fixes are independent layers of the same race.
  private cancelled = false;
  // "ended" on every acquired track (device revoked/unplugged, OS
  // permission pulled mid-meeting) and AudioContext "statechange" to
  // "closed" both mean this instance is dead — neither ever reaches us
  // any other way. Without tearing down and flipping `available` off
  // here, the supervisor keeps trusting a VAD that will never report
  // speech again: silence forever, so all recovery stays suppressed
  // (finding #7).
  private trackEndedHandler: (() => void) | null = null;
  private contextStateHandler: (() => void) | null = null;

  get available(): boolean {
    return this.started;
  }

  get state(): VadState {
    return this.core.state;
  }

  async start(): Promise<boolean> {
    this.cancelled = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
      });
      if (this.cancelled) {
        // stop() ran while getUserMedia() was pending — this handle
        // has already been abandoned by its caller; we still own this
        // MediaStream and must release it ourselves; nothing else
        // references it.
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      this.stream = stream;

      const AudioCtxCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtxCtor) {
        this.teardown();
        return false;
      }

      const audioCtx = new AudioCtxCtor();
      this.audioCtx = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      source.connect(analyser);
      this.analyser = analyser;
      this.buffer = new Float32Array(analyser.fftSize);

      this.attachLifecycleListeners();
      this.started = true;
      this.sampleTimer = setInterval(() => this.sample(), VAD_SAMPLE_MS);
      return true;
    } catch {
      this.teardown();
      return false;
    }
  }

  private attachLifecycleListeners(): void {
    if (this.stream) {
      const handler = () => this.handleLifecycleDeath();
      this.trackEndedHandler = handler;
      for (const track of this.stream.getTracks()) {
        track.addEventListener("ended", handler);
      }
    }
    if (this.audioCtx) {
      const handler = () => {
        if (this.audioCtx?.state === "closed") this.handleLifecycleDeath();
      };
      this.contextStateHandler = handler;
      this.audioCtx.addEventListener("statechange", handler);
    }
  }

  private handleLifecycleDeath(): void {
    if (!this.started) return; // already torn down (e.g. our own stop())
    this.teardown();
  }

  private sample(): void {
    if (!this.analyser || !this.buffer) return;
    const db = computeDb(this.analyser, this.buffer);
    this.core.sample(db, Date.now());
  }

  stop(): void {
    this.cancelled = true;
    this.teardown();
  }

  private teardown(): void {
    this.started = false;
    if (this.sampleTimer !== null) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.stream) {
      if (this.trackEndedHandler) {
        const handler = this.trackEndedHandler;
        for (const track of this.stream.getTracks()) {
          track.removeEventListener("ended", handler);
        }
      }
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioCtx) {
      if (this.contextStateHandler) {
        this.audioCtx.removeEventListener("statechange", this.contextStateHandler);
      }
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    this.trackEndedHandler = null;
    this.contextStateHandler = null;
    this.analyser = null;
    this.buffer = null;
  }
}
