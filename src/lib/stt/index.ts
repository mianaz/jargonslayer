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
  }
}
