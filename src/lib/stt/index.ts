// STT engine factory — picks the concrete implementation by kind.

import type { STTEngine, STTEngineKind } from "../types";
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
    case "import":
      // "import" (#43) is never a live capture engine — imported
      // sessions are built fully offline by importText.ts and never
      // go through settings.engine/createEngine at all.
      throw new Error('createEngine: "import" is not a live capture engine');
  }
}
