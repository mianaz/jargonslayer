// AudioWorkletProcessor: downsamples mic input (channel 0) to 16kHz
// mono Int16 PCM and posts ArrayBuffers back to the main thread every
// ~8192 output samples (~512ms @ 16kHz). Plain JS — runs in the
// AudioWorkletGlobalScope, no bundler/imports available here.

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 8192;

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global provided by AudioWorkletGlobalScope —
    // the native rate of the audio graph (e.g. 44100/48000).
    this.step = sampleRate / TARGET_SAMPLE_RATE;
    this.readPos = 0; // fractional read cursor into the accumulated buffer
    this.acc = new Float32Array(0);
    this.outBuf = new Int16Array(CHUNK_SAMPLES);
    this.outPos = 0;
  }

  /** Append new input frames to the accumulation buffer. */
  appendInput(chunk) {
    if (chunk.length === 0) return;
    const merged = new Float32Array(this.acc.length + chunk.length);
    merged.set(this.acc, 0);
    merged.set(chunk, this.acc.length);
    this.acc = merged;
  }

  /** Drain as many downsampled output samples as are available. */
  drain() {
    while (this.readPos < this.acc.length) {
      const idx = Math.floor(this.readPos);
      if (idx >= this.acc.length) break;

      const sample = this.acc[idx];
      const clamped = Math.max(-1, Math.min(1, sample));
      this.outBuf[this.outPos++] =
        clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

      if (this.outPos >= CHUNK_SAMPLES) {
        this.flush();
      }

      this.readPos += this.step;
    }

    // Drop consumed samples, keep the fractional remainder aligned.
    const consumed = Math.floor(this.readPos);
    if (consumed > 0) {
      this.acc = this.acc.slice(consumed);
      this.readPos -= consumed;
    }
  }

  flush() {
    if (this.outPos === 0) return;
    const view =
      this.outPos === CHUNK_SAMPLES
        ? this.outBuf
        : this.outBuf.slice(0, this.outPos);
    const buffer = view.buffer.slice(0, view.length * 2);
    this.port.postMessage(buffer, [buffer]);
    this.outBuf = new Int16Array(CHUNK_SAMPLES);
    this.outPos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    // No input connected / silence: input[0] may be missing or empty —
    // just keep the processor alive, nothing to accumulate.
    if (input && input[0] && input[0].length > 0) {
      this.appendInput(input[0]);
      this.drain();
    }
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
