// STT engine factory — picks the concrete implementation by kind.

import type { STTEngine, STTEngineKind } from "@jargonslayer/core/types";
import { WebSpeechEngine } from "./webSpeech";
import { WhisperSocketEngine } from "./whisperSocket";
import { TabAudioEngine } from "./tabAudio";
import { AppAudioEngine } from "./appAudio";
import { DemoEngine } from "./demo";
import { SonioxEngine } from "./soniox";

export function createEngine(kind: STTEngineKind): STTEngine {
  switch (kind) {
    case "webspeech":
      return new WebSpeechEngine();
    case "whisper":
      return new WhisperSocketEngine();
    case "tabaudio":
      return new TabAudioEngine();
    case "appaudio":
      // S9 (docs/design-explorations/s9-app-audio-tap-blueprint.md) —
      // desktop-only native app/system audio capture. Still unreachable
      // from the UI until S9.4 adds the engine card/gating (D6/D7).
      return new AppAudioEngine();
    case "demo":
      return new DemoEngine();
    case "soniox":
      // v0.4 S4 chunk 5 (blueprint decision E) — BYOK cloud engine, no
      // local sidecar. Still unreachable from the UI until chunk 6
      // adds the engine card/gating (ENGINE_CARDS, Header
      // ENGINE_OPTIONS, applyTierDefaults' preview coercion).
      return new SonioxEngine();
    case "import":
      // "import" (#43) is never a live capture engine — imported
      // sessions are built fully offline by importText.ts and never
      // go through settings.engine/createEngine at all.
      throw new Error('createEngine: "import" is not a live capture engine');
    case "browser-whisper":
      // "browser-whisper" (#43 phase 2a) is never a live capture
      // engine either — sessions are built by importAudio.ts from an
      // uploaded file, transcribed entirely in-browser, and never go
      // through settings.engine/createEngine at all.
      throw new Error('createEngine: "browser-whisper" is not a live capture engine');
  }
}
