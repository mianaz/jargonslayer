import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhisperWorkerOutMessage } from "../whisper.worker";

// A minimal fake Worker whose test drives message/error delivery by
// hand (no real thread, no real @huggingface/transformers — the
// point of this suite is the main-thread lifecycle contract around
// terminate(), not real transcription, which needs a manual browser
// check per the task's verification note).
class FakeWorker {
  onmessage: ((e: MessageEvent<WhisperWorkerOutMessage>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();

  emit(data: WhisperWorkerOutMessage) {
    this.onmessage?.({ data } as MessageEvent<WhisperWorkerOutMessage>);
  }

  emitError(message: string, filename?: string, lineno?: number) {
    this.onerror?.({ message, filename, lineno } as ErrorEvent);
  }

  emitMessageError() {
    this.onmessageerror?.();
  }
}

let lastWorker: FakeWorker;

// A constructor function (not an arrow) so `new Worker(...)` in the
// module under test actually invokes it as `new` — vi.fn() wrapping
// an arrow function fails that (arrow functions can never be
// constructors).
function FakeWorkerConstructor() {
  lastWorker = new FakeWorker();
  return lastWorker;
}
vi.stubGlobal("Worker", vi.fn(FakeWorkerConstructor));

import { transcribeInBrowser } from "../whisperBrowser";

describe("transcribeInBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a Worker, posts the transcribe message with the audio buffer transferred, and resolves with segments on done", async () => {
    const audio = new Float32Array([0.1, 0.2, 0.3]);
    const promise = transcribeInBrowser(audio, "onnx-community/whisper-base");

    expect(lastWorker.postMessage).toHaveBeenCalledTimes(1);
    const [msg, transferList] = lastWorker.postMessage.mock.calls[0];
    expect(msg).toEqual({ type: "transcribe", audio, modelId: "onnx-community/whisper-base" });
    expect(transferList).toEqual([audio.buffer]);

    lastWorker.emit({
      type: "done",
      segments: [{ start: 0, end: 1.5, text: "hello" }],
    });

    const segments = await promise;
    expect(segments).toEqual([{ start: 0, end: 1.5, text: "hello" }]);
  });

  it("terminate() is called after a successful done — the anti-leak guarantee", async () => {
    const promise = transcribeInBrowser(new Float32Array([0]), "onnx-community/whisper-base");
    lastWorker.emit({ type: "done", segments: [] });
    await promise;

    expect(lastWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminate() is ALSO called when the worker reports an error, and the promise rejects", async () => {
    const promise = transcribeInBrowser(new Float32Array([0]), "onnx-community/whisper-base");
    lastWorker.emit({ type: "error", message: "模型加载失败" });

    await expect(promise).rejects.toThrow("模型加载失败");
    expect(lastWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminate() is called on an uncaught worker-thread error (onerror), and the promise rejects", async () => {
    const promise = transcribeInBrowser(new Float32Array([0]), "onnx-community/whisper-base");
    lastWorker.emitError("Uncaught ReferenceError in worker");

    await expect(promise).rejects.toThrow("Uncaught ReferenceError in worker");
    expect(lastWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it("forwards progress messages (download and transcribe phases) to onProgress without resolving/terminating", async () => {
    const onProgress = vi.fn();
    const promise = transcribeInBrowser(new Float32Array([0]), "onnx-community/whisper-base", onProgress);

    lastWorker.emit({ type: "ready", backend: "wasm" });
    lastWorker.emit({ type: "progress", phase: "download", ratio: 0.5, detail: "model.onnx" });
    lastWorker.emit({ type: "progress", phase: "transcribe", ratio: 1 });

    expect(onProgress).toHaveBeenNthCalledWith(1, { phase: "download", ratio: 0.5, detail: "model.onnx" });
    expect(onProgress).toHaveBeenNthCalledWith(2, { phase: "transcribe", ratio: 1, detail: undefined });
    expect(lastWorker.terminate).not.toHaveBeenCalled();

    lastWorker.emit({ type: "done", segments: [] });
    await promise;
  });

  it("maps an EMPTY onerror (the worker-script-failed-to-load signature) to the load-failure message, not the generic one", async () => {
    const promise = transcribeInBrowser(new Float32Array([0]), "onnx-community/whisper-base");
    lastWorker.emitError("");

    await expect(promise).rejects.toThrow("转录组件加载失败");
    expect(lastWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it("includes the chunk basename:line when the ErrorEvent carries a location", async () => {
    const promise = transcribeInBrowser(new Float32Array([0]), "onnx-community/whisper-base");
    lastWorker.emitError(
      "Out of memory",
      "http://localhost:3000/_next/static/chunks/whisper.worker.abc123.js",
      17,
    );

    await expect(promise).rejects.toThrow(
      "浏览器转录 worker 出错：Out of memory @ whisper.worker.abc123.js:17",
    );
    expect(lastWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects (rather than hanging forever) on onmessageerror, and still terminates", async () => {
    const promise = transcribeInBrowser(new Float32Array([0]), "onnx-community/whisper-base");
    lastWorker.emitMessageError();

    await expect(promise).rejects.toThrow("浏览器转录 worker 消息解码失败");
    expect(lastWorker.terminate).toHaveBeenCalledTimes(1);
  });
});
