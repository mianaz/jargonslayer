// STT engine factory — picks the concrete implementation by kind.

import type { STTEngine, STTEngineKind } from "@jargonslayer/core/types";
import { WebSpeechEngine } from "./webSpeech";
import { WhisperSocketEngine } from "./whisperSocket";
import { TabAudioEngine } from "./tabAudio";
import { DemoEngine } from "./demo";

export function createEngine(kind: STTEngineKind): STTEngine {
  switch (kind) {
    case "webspeech":
      return new WebSpeechEngine();
    case "whisper":
      return new WhisperSocketEngine();
    case "tabaudio":
      return new TabAudioEngine();
    case "demo":
      return new DemoEngine();
    case "soniox":
      // v0.4 S4 chunk 5 lands SonioxEngine here (blueprint decision E);
      // the kind exists ahead of it only so the shared types prelude
      // ships in one commit. Unreachable from the UI until chunk 6 adds
      // the engine card — this throw guards a hand-edited settings blob.
      throw new Error("createEngine: soniox engine not yet implemented (S4 chunk 5)");
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
