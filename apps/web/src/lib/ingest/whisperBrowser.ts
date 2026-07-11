// Main-thread wrapper around whisper.worker.ts (#43 phase 2a) — owns
// the Worker's lifecycle so the #860 memory-leak guarantee lives in
// exactly one place: `worker.terminate()` runs in a `finally`, on
// BOTH the success and the error path, after every single import.
// Model weights stay HTTP-cached across imports (the browser, not
// this process, holds that cache) so paying re-init cost on the next
// import is cheap; what is NOT cheap is leaving GPU/WASM memory
// resident between imports, which terminate() is the only guaranteed
// way to reclaim (see whisper.worker.ts's own belt-and-suspenders
// dispose() call before it posts "done").
//
// Deliberately NO import of @huggingface/transformers here or
// anywhere else on this module's import graph — that stays inside
// whisper.worker.ts so it never leaks into the main bundle (see
// importAudio.ts/HistoryDrawer.tsx for where the worker itself gets
// lazily instantiated).

import type { WhisperWorkerInMessage, WhisperWorkerOutMessage } from "./whisper.worker";

export { mapChunksToSegments } from "./whisper.worker";

export type TranscribeProgress = {
  phase: "download" | "transcribe";
  // Optional (#43 phase-2a follow-up): the download phase's ratio is
  // undefined when the CDN response carries no Content-Length header —
  // see whisper.worker.ts's progress_callback for why the underlying
  // transformers.js number can't be trusted in that case.
  ratio?: number;
  detail?: string;
};

export interface TranscribedSegment {
  start: number;
  end: number;
  text: string;
}

/** Runs one transcription in a dedicated Worker and resolves with the
 *  mapped {start,end,text} segments. Rejects on a worker "error"
 *  message or an uncaught worker-thread failure (e.g. the model
 *  failed to load). Either way, terminate() always fires — the worker
 *  is single-use by design, there is no pooling. */
export function transcribeInBrowser(
  audio: Float32Array,
  modelId: string,
  onProgress?: (progress: TranscribeProgress) => void,
): Promise<TranscribedSegment[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), {
      type: "module",
    });

    const finish = (fn: () => void) => {
      try {
        fn();
      } finally {
        worker.terminate();
      }
    };

    worker.onmessage = (e: MessageEvent<WhisperWorkerOutMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case "ready":
          // No UI signal today — reserved for a future "GPU/CPU"
          // status line; the phase-labeled progress below is what
          // importAudio.ts actually surfaces.
          break;
        case "progress":
          onProgress?.({ phase: msg.phase, ratio: msg.ratio, detail: msg.detail });
          break;
        case "done":
          finish(() => resolve(msg.segments));
          break;
        case "error":
          finish(() => reject(new Error(msg.message)));
          break;
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      // An ErrorEvent with no message/filename is what the browser
      // delivers when the worker SCRIPT itself failed to fetch/parse
      // (server stopped mid-session, network dropped, stale deploy) —
      // the worker's own catch/post("error") never got a chance to
      // run. Name that case; a generic "worker 出错" reads like a
      // transcription bug and sends debugging in the wrong direction.
      const where = e.filename ? ` @ ${e.filename.split("/").pop()}:${e.lineno}` : "";
      const detail = e.message ? `${e.message}${where}` : "";
      finish(() =>
        reject(
          new Error(
            detail
              ? `浏览器转录 worker 出错：${detail}`
              : "转录组件加载失败（多为网络中断或本地服务器已停止），请刷新页面后重试",
          ),
        ),
      );
    };

    // A structured-clone failure on a worker reply would otherwise
    // leave this promise pending forever: no error, no diag entry,
    // an import task spinning until tab close.
    worker.onmessageerror = () => {
      finish(() => reject(new Error("浏览器转录 worker 消息解码失败，请刷新页面后重试")));
    };

    const inMsg: WhisperWorkerInMessage = { type: "transcribe", audio, modelId };
    // Float32Array's underlying buffer is transferred (not copied) —
    // it's a multi-MB decoded audio buffer, and the main thread has no
    // further use for it once handed to the worker.
    worker.postMessage(inMsg, [audio.buffer]);
  });
}
