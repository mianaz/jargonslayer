// In-browser Whisper transcription worker (#43 phase 2a) — the ONLY
// place @huggingface/transformers is imported. Runs entirely inside a
// dedicated Web Worker so the ~150MB+ of ONNX model weights and the
// WASM/WebGPU inference session live on a thread that gets
// `terminate()`d after every import (see whisperBrowser.ts) rather
// than accumulating in the main thread's memory across repeated
// imports (#860 leak class). Model weights themselves stay HTTP-cached
// by the browser, so a fresh worker + re-init next time is cheap.
//
// Backend selection: WebGPU when available (`navigator.gpu` present
// AND an adapter is actually obtainable — a GPU-capable browser can
// still fail to grant an adapter, e.g. disabled in about:flags or a
// headless CI runner) at higher precision (q4), else WASM forced to a
// single thread (q8) — multi-thread WASM needs SharedArrayBuffer,
// which needs COOP/COEP response headers we are explicitly NOT adding
// (would require touching next.config/nginx, out of scope for this
// phase; WebGPU needs no such isolation, so most users hit the fast
// path anyway).

export interface WhisperWorkerInMessage {
  type: "transcribe";
  audio: Float32Array;
  modelId: string;
}

export type WhisperWorkerOutMessage =
  | { type: "ready"; backend: "webgpu" | "wasm" }
  | { type: "progress"; phase: "download" | "transcribe"; ratio?: number; detail?: string }
  | { type: "done"; segments: { start: number; end: number; text: string }[] }
  | { type: "error"; message: string };

function post(msg: WhisperWorkerOutMessage): void {
  postMessage(msg);
}

/** Chunks with a null/undefined start (whisper occasionally emits a
 *  trailing chunk whose timestamp never closed, e.g. cut off mid-
 *  word at the audio's tail) are dropped — a segment with no start
 *  time cannot be placed on the session's timeline. Exported so
 *  whisperBrowser.ts's tests can exercise this pure mapping without
 *  spinning up a real worker/model. */
export function mapChunksToSegments(
  chunks: { text: string; timestamp: [number | null | undefined, number | null | undefined] }[],
): { start: number; end: number; text: string }[] {
  const segments: { start: number; end: number; text: string }[] = [];
  for (const chunk of chunks) {
    const [start, end] = chunk.timestamp;
    if (start === null || start === undefined) continue;
    segments.push({
      start,
      end: end ?? start,
      text: chunk.text.trim(),
    });
  }
  return segments;
}

/** Pure download-progress mapping (item 1: honest download-phase
 *  progress) — exported so whisperBrowser.ts's tests can exercise the
 *  ratio guard without a real transformers.js progress_callback
 *  invocation, same reasoning as mapChunksToSegments above.
 *
 *  A well-formed 0-100 `progress` percentage needs BOTH a finite
 *  number (transformers.js CAN emit NaN — hub.js's readResponse leaves
 *  `total` at 0 if a stream's very first chunk happens to arrive
 *  empty, giving 0/0) AND `loaded < total`. The second condition is
 *  the one that actually matters in the field: when the CDN response
 *  carries no Content-Length header (confirmed against the exact
 *  "Unable to determine content-length from response headers" console
 *  warning transformers.js itself logs in that case), hub.js's
 *  readResponse (verified against the installed @huggingface/
 *  transformers@3.8.1, node_modules/@huggingface/transformers/src/
 *  utils/hub.js:726-769 — traced, not guessed) starts `total` at 0 and
 *  then silently RE-EXPANDS it to equal `loaded` on EVERY single
 *  chunk. That makes `progress` read as a constant, meaningless 100
 *  for the ENTIRE download — never NaN — because `loaded` can then
 *  never be < `total`. Only `loaded < total` proves a REAL, fixed
 *  total (Content-Length genuinely known) backs the fraction; that's
 *  the one signal a single progress event can offer with no
 *  cross-event state.
 *
 *  `loaded` itself is real/monotonic regardless of whether `total` can
 *  be trusted — surfacing it as MB gives the user something honest to
 *  watch even when the ratio can't be shown (see importAudio.ts's
 *  stage-label use of this detail). */
export function mapDownloadProgress(info: {
  progress: number;
  loaded: number;
  total: number;
  file: string;
}): { ratio?: number; detail: string } {
  const known = Number.isFinite(info.progress) && info.total > 0 && info.loaded < info.total;
  const mb = info.loaded / (1024 * 1024);
  const detail = Number.isFinite(mb) ? `${info.file} ${mb.toFixed(1)}MB` : info.file;
  return { ratio: known ? info.progress / 100 : undefined, detail };
}

async function detectBackend(): Promise<{ device: "webgpu" | "wasm"; dtype: "q4" | "q8" }> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter) return { device: "webgpu", dtype: "q4" };
    } catch {
      // requestAdapter can throw in some locked-down environments —
      // fall through to WASM exactly like a null adapter would.
    }
  }
  return { device: "wasm", dtype: "q8" };
}

async function run(msg: WhisperWorkerInMessage): Promise<void> {
  const { pipeline, env } = await import("@huggingface/transformers");

  // No local /models/ directory is shipped — every model load must go
  // to the HF Hub (then the browser's HTTP cache) rather than probing
  // for a filesystem path that only exists in Node.
  env.allowLocalModels = false;
  // Force single-thread WASM: multi-thread needs SharedArrayBuffer,
  // which needs COOP/COEP headers this project deliberately does not
  // set (see file header). Only takes effect on the WASM path; WebGPU
  // ignores it.
  env.backends.onnx.wasm!.numThreads = 1;

  const backend = await detectBackend();
  post({ type: "ready", backend: backend.device });

  const transcriber = await pipeline("automatic-speech-recognition", msg.modelId, {
    device: backend.device,
    dtype: backend.dtype,
    progress_callback: (info) => {
      if (info.status === "progress") {
        post({ type: "progress", phase: "download", ...mapDownloadProgress(info) });
      }
    },
  });

  try {
    // chunk_length_s/stride_length_s: transformers.js internally
    // splits + stitches timestamps for audio longer than Whisper's
    // native 30s window — no hand-rolled chunking here. There is no
    // public per-chunk progress hook on the ASR pipeline's call
    // signature (re-verified against the installed @huggingface/
    // transformers@3.8.1: no `chunk_callback` anywhere in src/dist/
    // types, and the ASR pipeline's own documented options —
    // AutomaticSpeechRecognitionSpecificParams in src/pipelines.js —
    // enumerate return_timestamps/chunk_length_s/stride_length_s/
    // force_full_sequences/language/task/num_frames and nothing else;
    // the per-chunk `for` loop in `_call_whisper` never invokes a
    // caller-supplied hook), so the "transcribe" phase can only report
    // start (0) and finish (1), not interim ratios.
    post({ type: "progress", phase: "transcribe", ratio: 0 });
    const output = await transcriber(msg.audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    });
    const result = Array.isArray(output) ? output[0] : output;
    const segments = mapChunksToSegments(result.chunks ?? []);
    post({ type: "progress", phase: "transcribe", ratio: 1 });

    // Belt-and-suspenders GPU/session reclaim ahead of the worker's
    // own terminate() (see whisperBrowser.ts) — dispose() releases the
    // ONNX inference session explicitly rather than relying solely on
    // the worker thread teardown.
    await transcriber.dispose?.();
    post({ type: "done", segments });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : "转录失败" });
  }
}

// Guarded rather than an unconditional top-level assignment: this
// file also gets a plain (non-worker) `import type` + a value
// re-export of mapChunksToSegments from whisperBrowser.ts/
// importAudio.ts (both need the pure mapping function without paying
// for a real Worker in tests) — `self` doesn't exist in that plain-
// import context (Node/vitest), so assigning to it unconditionally
// would throw ReferenceError just from importing this module, not
// from actually running as a worker.
if (typeof self !== "undefined") {
  self.onmessage = (e: MessageEvent<WhisperWorkerInMessage>) => {
    if (e.data.type !== "transcribe") return;
    void run(e.data).catch((err) => {
      post({ type: "error", message: err instanceof Error ? err.message : "转录失败" });
    });
  };
}
