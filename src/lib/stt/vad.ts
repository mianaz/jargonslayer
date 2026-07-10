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

import { VadCore, type VadState } from "./vadCore";

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
  // True digital silence (rms=0) has no finite dB — treat it as
  // "arbitrarily quiet"; VadCore's floor+margin classification always
  // reads -Infinity as quiet, so this is safe.
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

export class SpeechActivityDetector implements VadHandle {
  private core = new VadCore();
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  get available(): boolean {
    return this.started;
  }

  get state(): VadState {
    return this.core.state;
  }

  async start(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
      });
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

      this.started = true;
      this.sampleTimer = setInterval(() => this.sample(), VAD_SAMPLE_MS);
      return true;
    } catch {
      this.teardown();
      return false;
    }
  }

  private sample(): void {
    if (!this.analyser || !this.buffer) return;
    const db = computeDb(this.analyser, this.buffer);
    this.core.sample(db, Date.now());
  }

  stop(): void {
    this.teardown();
  }

  private teardown(): void {
    this.started = false;
    if (this.sampleTimer !== null) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    this.analyser = null;
    this.buffer = null;
  }
}
