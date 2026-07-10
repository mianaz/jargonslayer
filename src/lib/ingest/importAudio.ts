// Audio-file import orchestration (#43 phase 2a, video routing added
// in phase 2b) — the browser-side counterpart to stt/upload.ts's
// sidecar/cloud recording import and importText.ts's transcript
// import: decode + resample a user-picked audio file on the MAIN
// thread (AudioContext isn't available inside a Worker in every
// target browser, and decode is fast enough it doesn't need to be
// off-thread), hand the raw samples to a Worker for the actual
// (heavy, model-driven) transcription, then converge on the exact
// same buildSessionFromSegments + runTranslation stages importText.ts/
// upload.ts already use. wav/mp3/m4a/flac all decode natively via the
// browser's own AudioContext — no ffmpeg involved for those. Video
// files (mp4/webm/mov/mkv/m4v, a browser's AudioContext genuinely
// can't decode a container) are routed through ffmpegExtract.ts FIRST
// to pull out a 16kHz mono wav track, then rejoin this exact same
// flow — see isVideoFile/extractAudioFromVideo below.
//
// Never touches the store and never throws to its caller in
// practice — every awaited step already produces zh-ready Error
// messages, and the caller (HistoryDrawer) wraps the call in try/
// catch as a last-resort net anyway, mirroring importTranscriptText's
// own division of labor.

import { type MeetingSession, type Settings } from "../types";
import { buildSessionFromSegments, type PlainTranscriptSegment } from "../stt/upload";
import { runTranslation } from "./importText";
import * as storage from "../history/storage";
import { transcribeInBrowser, type TranscribedSegment } from "./whisperBrowser";
import { isVideoFile, extractAudioFromVideo } from "./ffmpegExtract";

export { mapChunksToSegments } from "./whisperBrowser";
export { isVideoFile, isSupportedMediaFile } from "./ffmpegExtract";

// onnx-community/whisper-base (#43 settled decision): good enough
// accuracy for meeting speech, small enough to be a reasonable first-
// visit download over HTTP. whisper-tiny is kept only as an internal
// fallback constant — never surfaced as a user-facing model choice.
const DEFAULT_MODEL_ID = "onnx-community/whisper-base";
// Not wired to a call site in this phase — kept only as the settled,
// documented fallback should whisper-base prove too slow/heavy on a
// given device in a future revision.
const FALLBACK_MODEL_ID = "onnx-community/whisper-tiny";
void FALLBACK_MODEL_ID;

const TARGET_SAMPLE_RATE = 16_000;
const MAX_DURATION_S = 45 * 60;
// Lower than ffmpegExtract.ts's 400MB video cap: decodeAudioData below
// materializes the FULL decoded PCM in memory at once (no streaming),
// and compressed audio (mp3/m4a/flac) commonly expands 10x+ once
// decoded to float32 PCM — a size that's fine as a compressed video
// container can still blow up the tab's memory once decoded here.
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

export class AudioDecodeError extends Error {
  constructor(message = "无法解码该音频，请转成 wav/mp3 后重试") {
    super(message);
    this.name = "AudioDecodeError";
  }
}

export class AudioTooLongError extends Error {
  constructor(message = "音频过长（超过 45 分钟），请分段后再导入") {
    super(message);
    this.name = "AudioTooLongError";
  }
}

export class AudioTooLargeError extends Error {
  constructor(message = "音频过大（超过 200 MB），请改用本地 Whisper sidecar 转录") {
    super(message);
    this.name = "AudioTooLargeError";
  }
}

/** Hard duration cap so a multi-hour recording doesn't spend minutes
 *  decoding/transcribing before the user learns it won't work —
 *  checked right after decode (duration is known then), before the
 *  Worker (and its model download) is ever spawned. Pure/exported so
 *  tests can hit the 45-minute boundary without a real AudioContext
 *  (unavailable under vitest's node environment). */
export function assertDurationWithinLimit(durationS: number): void {
  if (durationS > MAX_DURATION_S) {
    throw new AudioTooLongError();
  }
}

/** Decode `arrayBuffer` via (Offline)AudioContext and resample to
 *  16kHz mono Float32 — the sample rate/channel layout Whisper's
 *  feature extractor expects. Wraps any decode failure (unsupported
 *  codec, corrupt file) into AudioDecodeError with the single zh
 *  message the spec calls for, rather than surfacing the browser's
 *  own (English, codec-specific) DOMException text. Takes the raw
 *  bytes rather than a File so a video's ffmpeg-extracted wav
 *  ArrayBuffer can feed the same decode path as a native audio File
 *  (see readFileBytes below for the thin File->ArrayBuffer step this
 *  used to do inline). */
async function decodeAndResample(arrayBuffer: ArrayBuffer): Promise<Float32Array> {
  // Safari lacks a global OfflineAudioContext-agnostic decode; a
  // throwaway AudioContext is the most broadly-supported way to
  // decode without also playing the audio.
  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AudioContextCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } catch {
    throw new AudioDecodeError();
  } finally {
    void decodeCtx.close();
  }

  assertDurationWithinLimit(decoded.duration);

  const targetLength = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  const offlineCtx = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

/** Thin File->ArrayBuffer step decodeAndResample used to do inline
 *  before its refactor to take an ArrayBuffer directly — used by the
 *  native-audio branch in importAudio() below. The video branch skips
 *  this entirely, since extractAudioFromVideo already returns the wav
 *  ArrayBuffer decodeAndResample needs (and applies its own size gate
 *  before that). The MAX_AUDIO_BYTES check runs on file.size BEFORE
 *  arrayBuffer() reads anything into memory — mirrors
 *  extractAudioFromVideo's own size-check-before-work ordering. */
async function readFileBytes(file: File): Promise<ArrayBuffer> {
  if (file.size > MAX_AUDIO_BYTES) {
    throw new AudioTooLargeError();
  }
  return file.arrayBuffer();
}

export interface ImportAudioOptions {
  file: File;
  translate: boolean;
  settings: Settings;
  onProgress: (progress: number, phase: string) => void;
}

export interface ImportAudioResult {
  sessionId: string;
  warnings: string[];
}

/** Orchestrates decode -> resample -> in-browser transcribe -> build
 *  session -> (optional) translate -> save, entirely client-side. The
 *  audio itself never leaves the browser at any step — only the
 *  transcribed TEXT reaches the detect/translate API calls, same
 *  privacy boundary as every other import path. */
export async function importAudio(opts: ImportAudioOptions): Promise<ImportAudioResult> {
  const { file, translate, settings, onProgress } = opts;

  // Video routing (#43 phase 2b): a browser's AudioContext can't
  // decode a video container directly, so extract the audio track to
  // a 16kHz mono wav via ffmpeg.wasm FIRST, then rejoin the exact same
  // decode->transcribe->build->translate flow below with those bytes.
  // The extracted wav is already 16k mono, so decodeAndResample's own
  // resample pass is a near-no-op for it — kept anyway for uniformity
  // (one decode path, not two divergent ones). AudioTooLongError still
  // applies after decode, same as any native audio file.
  let audioBytes: ArrayBuffer;
  if (isVideoFile(file)) {
    audioBytes = await extractAudioFromVideo(file, (ratio) => onProgress(ratio, "提取音频"));
  } else {
    onProgress(0, "读取音频");
    audioBytes = await readFileBytes(file);
  }

  const audio = await decodeAndResample(audioBytes);

  const rawSegments: TranscribedSegment[] = await transcribeInBrowser(
    audio,
    DEFAULT_MODEL_ID,
    (progress) => {
      const phaseLabel = progress.phase === "download" ? "下载模型" : "转录";
      onProgress(progress.ratio, phaseLabel);
    },
  );

  onProgress(1, "构建会话");
  const segments: PlainTranscriptSegment[] = rawSegments.map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text,
  }));

  const session: MeetingSession = await buildSessionFromSegments(segments, settings, {
    title: `导入 ${file.name}`,
    engine: "browser-whisper",
  });

  const warnings: string[] = [];
  if (translate && session.segments.length > 0) {
    const translations = await runTranslation(
      session.segments,
      settings,
      warnings,
      (_phase, done, total) => onProgress(total > 0 ? done / total : 0, "翻译"),
    );
    session.translations = translations;
  }

  await storage.saveSession(session);

  return { sessionId: session.id, warnings };
}
