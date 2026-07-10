// Video-file audio extraction (#43 phase 2b) — ffmpeg.wasm SINGLE-
// THREAD core only. Deliberately the single-thread `@ffmpeg/core`
// build, not `@ffmpeg/core-mt`: multithread needs SharedArrayBuffer,
// which needs COOP/COEP response headers this project explicitly does
// not set (see whisper.worker.ts's own WASM-thread note) — zero infra
// change was a hard constraint for this phase. `ffmpeg.load()` for the
// single-thread core takes no `workerURL`, only `coreURL`/`wasmURL`.
//
// @ffmpeg/ffmpeg + @ffmpeg/util are tiny JS glue (~tens of kB); the
// ~31MB core wasm is served same-origin from /public/ffmpeg at
// runtime, never bundled — same "heavy weights stay out of the page
// bundle, browser HTTP-caches them across imports" shape as
// @huggingface/transformers in whisper.worker.ts.
//
// Output is called from importAudio.ts, which feeds the resulting
// 16kHz mono wav bytes into the SAME decode/transcribe/detect/
// translate pipeline #43 phase 2a already ships for native audio
// files — this module's only job is turning "a video file" into "a
// wav ArrayBuffer", nothing else.

// The runtime trio (class worker.js + ffmpeg-core.js/.wasm) is served
// SAME-ORIGIN from /public/ffmpeg, copied out of node_modules by
// scripts/copy-ffmpeg-assets.mjs on postinstall. Two live-E2E dead
// ends (2026-07-06) forced this: (1) letting the FFmpeg class spawn
// its own worker fails — webpack rewrites its internal
// `new URL("./worker.js", import.meta.url)` into a broken URL and
// load() rejects; (2) the README's CDN + toBlobURL pattern also fails
// here — a Worker constructed from a blob: URL cannot dynamically
// import() anything (null base), so load() hangs forever with zero
// console output. Same-origin real URLs sidestep both, and the wasm
// stays out of git (see .gitignore) and out of the JS bundle.

import { withBase } from "../basePath";

const MAX_VIDEO_BYTES = 400 * 1024 * 1024;
const LOAD_TIMEOUT_MS = 60_000;

export class VideoTooLargeError extends Error {
  constructor(message = "视频过大（超过 400 MB），请先在本地提取音频后再导入") {
    super(message);
    this.name = "VideoTooLargeError";
  }
}

export class VideoExtractError extends Error {
  constructor(message = "无法从该视频提取音频，请转成 mp4/webm 后重试") {
    super(message);
    this.name = "VideoExtractError";
  }
}

const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "mkv", "m4v"];
const AUDIO_EXTENSIONS = ["m4a", "mp3", "wav", "flac"];

/** Pure — no ffmpeg/File I/O — so HistoryDrawer's file-input routing
 *  and importAudio's own routing can both call it synchronously.
 *  Checks MIME first (cheap, and Safari/Windows sometimes leave a
 *  video file's extension case-mixed or the MIME blank on non-http
 *  sources), then falls back to the extension allowlist. */
export function isVideoFile(file: { name: string; type: string }): boolean {
  if (file.type.startsWith("video/")) return true;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext !== undefined && VIDEO_EXTENSIONS.includes(ext);
}

/** ImportHub's 文件 tab staging guard (#58 review fix 8) — the native
 *  `<input accept>` is advisory only (some OS pickers/drag-drop paths
 *  ignore it entirely), so without this a non-media file (a PDF, say)
 *  could get staged and become a doomed transcription task. Same MIME-
 *  then-extension shape as isVideoFile above: audio/* or video/* MIME
 *  wins outright, else fall back to the exact extension allowlist
 *  ImportHub's own FILE_ACCEPT string advertises. */
export function isSupportedMediaFile(file: { name: string; type: string }): boolean {
  if (file.type.startsWith("audio/") || isVideoFile(file)) return true;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext !== undefined && AUDIO_EXTENSIONS.includes(ext);
}

/** Extracts the audio track from `file` as a 16kHz mono wav, entirely
 *  in-browser via ffmpeg.wasm's single-thread core. The size guard
 *  runs FIRST, before the (dynamic, lazy) ffmpeg import — the whole
 *  file is loaded into wasm FS memory, so the cap has to apply before
 *  any download, not just before exec. `ffmpeg.terminate()` always
 *  runs in a `finally`, mirroring whisperBrowser.ts's own #860-style
 *  discipline: single-use per call, no pooling, no lingering wasm
 *  memory between imports. */
export async function extractAudioFromVideo(
  file: File,
  onProgress?: (ratio: number) => void,
): Promise<ArrayBuffer> {
  if (file.size > MAX_VIDEO_BYTES) {
    throw new VideoTooLargeError();
  }

  // Dynamic imports, never top-level — same lazy-boundary discipline
  // as whisper.worker.ts's @huggingface/transformers import, so this
  // ~72KB of glue only reaches the browser when a video is actually
  // picked, never in the page's first-load JS.
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const { fetchFile } = await import("@ffmpeg/util");

  // globalThis (not window): identical in the browser main thread,
  // and keeps this constructible under vitest's node environment
  // where the ffmpeg module is fully mocked anyway.
  const base = `${globalThis.location?.origin ?? ""}${withBase("/ffmpeg")}`;
  const ffmpeg = new FFmpeg();

  try {
    if (onProgress) {
      ffmpeg.on("progress", ({ progress }) => onProgress(progress));
    }

    try {
      // The upstream FFmpeg class registers no worker `error` handler:
      // if the class worker dies at module-graph load (e.g. an asset
      // 404), load() HANGS forever instead of rejecting — so race it
      // against a timeout rather than trusting it to settle.
      await Promise.race([
        ffmpeg.load({
          coreURL: `${base}/ffmpeg-core.js`,
          wasmURL: `${base}/ffmpeg-core.wasm`,
          // Absolute same-origin URL: the class worker is a normal
          // module worker whose import(coreURL) is plain same-origin
          // ESM (see the module header for why blob:/CDN both fail).
          classWorkerURL: `${base}/worker.js`,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new VideoExtractError()), LOAD_TIMEOUT_MS),
        ),
      ]);
    } catch {
      // Assets missing (postinstall not run) or worker construction
      // failed — same zh-ready error as an extraction failure; the
      // user-visible remedy is identical (retry / convert locally).
      throw new VideoExtractError();
    }

    await ffmpeg.writeFile("input", await fetchFile(file));

    let exitCode: number;
    try {
      exitCode = await ffmpeg.exec(["-i", "input", "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "out.wav"]);
    } catch {
      throw new VideoExtractError();
    }
    if (exitCode !== 0) {
      throw new VideoExtractError();
    }

    const data = await ffmpeg.readFile("out.wav");
    // No encoding arg was passed to readFile, so this is always the
    // binary Uint8Array form of FileData, never the string form.
    const bytes = data as Uint8Array;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } finally {
    ffmpeg.terminate();
  }
}
