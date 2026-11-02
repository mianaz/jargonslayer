// Out-of-box defaults: the desktop first-run 开始前检查 (pre-flight check).
//
// Drives the REAL capture engine for a short session, the way
// iosSpike.ts's stepSession already does, so the user leaves the wizard
// knowing capture works end to end: macOS permission prompts answered,
// speech model ready, and each channel actually producing text. That
// beats finding out from a toast halfway through their first meeting.
//
// A channel passes on the first interim or final transcript attributed
// to it. Recognized text is stronger proof than an audio-level reading:
// it shows capture, the speech model and the channel tagging all work.
// The engine is stopped as soon as every channel the chosen mode needs
// has passed, or when the user stops the check, or after a timeout.
//
// Pure state machine around an injected engine factory, so it's
// unit-testable without Tauri. Transcript text stays in memory for the
// on-screen echo only; nothing here logs or persists it.

import type { STTEngine, STTEvents, Settings } from "@jargonslayer/core/types";
import { CH_MIC_SPEAKER, CH_SYS_SPEAKER } from "../store";

export type SoundCheckMode = "dual" | "system-audio";

export type SoundCheckPhase =
  /** Not started yet. */
  | "idle"
  /** engine.start() in flight (permission prompts, model load). */
  | "starting"
  /** Capturing; waiting for every required channel to be heard. */
  | "listening"
  /** Every required channel produced text; the engine is stopped. */
  | "passed"
  /** Listened for the whole timeout without hearing every channel. */
  | "timeout"
  /** The engine reported an error (permission denied, unsupported...). */
  | "error";

export interface SoundCheckChannel {
  heard: boolean;
  /** The last bit of recognized text, echoed back so the user can see
   *  it's really them / really the meeting. */
  sample: string | null;
}

export interface SoundCheckState {
  phase: SoundCheckPhase;
  mic: SoundCheckChannel;
  system: SoundCheckChannel;
  /** The engine's own error copy (already user-facing zh), when phase is "error". */
  error: string | null;
  /** The engine's latest non-fatal notice (e.g. speech model downloading). */
  notice: string | null;
}

export const SOUND_CHECK_TIMEOUT_MS = 60_000;
const SAMPLE_MAX_CHARS = 48;

export function initialSoundCheckState(): SoundCheckState {
  return {
    phase: "idle",
    mic: { heard: false, sample: null },
    system: { heard: false, sample: null },
    error: null,
    notice: null,
  };
}

/** Which channels the given mode has to hear before the check passes. */
export function requiredChannels(mode: SoundCheckMode): ("mic" | "system")[] {
  return mode === "dual" ? ["mic", "system"] : ["system"];
}

/** Maps a transcript's stable channel speaker id to a channel. A
 *  channel-less transcript (a single-source system-audio session) is the
 *  meeting audio. */
export function channelForSttSpeaker(sttSpeaker: string | undefined): "mic" | "system" {
  if (sttSpeaker === CH_MIC_SPEAKER) return "mic";
  if (sttSpeaker === CH_SYS_SPEAKER) return "system";
  return "system";
}

function clipSample(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > SAMPLE_MAX_CHARS ? `…${trimmed.slice(-SAMPLE_MAX_CHARS)}` : trimmed;
}

export interface SoundCheckDeps {
  createEngine: () => STTEngine;
  /** Settings to start the engine with. The caller has already applied
   *  the chosen mode (engine "osspeech", mode dual/system-audio). */
  settings: Settings;
  mode: SoundCheckMode;
  onChange: (state: SoundCheckState) => void;
  timeoutMs?: number;
}

export interface SoundCheckHandle {
  start: () => Promise<void>;
  /** Idempotent. Safe to call from an unmount. */
  stop: () => Promise<void>;
}

export function createSoundCheck(deps: SoundCheckDeps): SoundCheckHandle {
  const timeoutMs = deps.timeoutMs ?? SOUND_CHECK_TIMEOUT_MS;
  const required = requiredChannels(deps.mode);
  let state = initialSoundCheckState();
  let engine: STTEngine | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // True once we've decided the session is over (passed/timeout/error/
  // user stop). Late engine events after that point are ignored, so the
  // engine's own "idle" on teardown can't read as a failure.
  let finished = false;

  const emit = (patch: Partial<SoundCheckState>) => {
    state = { ...state, ...patch };
    deps.onChange(state);
  };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const teardown = async () => {
    clearTimer();
    const running = engine;
    engine = null;
    if (running) {
      try {
        await running.stop();
      } catch {
        // best effort: a stop failing must not wedge the wizard
      }
    }
  };

  const finish = (patch: Partial<SoundCheckState>) => {
    if (finished) return;
    finished = true;
    emit(patch);
    void teardown();
  };

  const hear = (text: string, sttSpeaker: string | undefined) => {
    if (finished || !text.trim()) return;
    const channel = channelForSttSpeaker(sttSpeaker);
    // A dual session only ever tags mic text CH_MIC, so the fallback in
    // channelForSttSpeaker can't mislabel it. In system-audio mode there is
    // no mic channel to credit.
    if (!required.includes(channel)) return;
    emit({ [channel]: { heard: true, sample: clipSample(text) } });
    if (required.every((c) => state[c].heard)) finish({ phase: "passed" });
  };

  const events: STTEvents = {
    onInterim: (text, _speaker, sttSpeaker) => hear(text, sttSpeaker),
    onFinal: (text, opts) => hear(text, opts?.sttSpeaker),
    onStatus: (status, detail) => {
      if (finished) return;
      if (status === "listening") {
        if (state.phase !== "listening") emit({ phase: "listening" });
        if (timer === null) {
          timer = setTimeout(() => finish({ phase: "timeout" }), timeoutMs);
        }
      } else if (status === "error") {
        finish({ phase: "error", error: detail ?? "收音失败，请重试" });
      } else if (status === "idle" && state.phase === "listening") {
        // The engine ended on its own mid-check. Its idle detail is an
        // internal code ("capture_ended"), not user copy.
        finish({ phase: "error", error: "收音意外结束，请重试" });
      }
    },
    onNotice: (msg) => {
      if (!finished) emit({ notice: msg });
    },
  };

  return {
    start: async () => {
      await teardown();
      finished = false;
      state = initialSoundCheckState();
      emit({ phase: "starting" });
      const next = deps.createEngine();
      engine = next;
      try {
        await next.start(events, deps.settings);
      } catch (err) {
        finish({ phase: "error", error: err instanceof Error ? err.message : String(err) });
      }
    },
    stop: async () => {
      finished = true;
      await teardown();
    },
  };
}
