// STT engine factory — picks the concrete implementation by kind.

import type { STTEngine, STTEngineKind } from "../types";
import { WebSpeechEngine } from "./webSpeech";
import { WhisperSocketEngine } from "./whisperSocket";
import { DemoEngine } from "./demo";

export function createEngine(kind: STTEngineKind): STTEngine {
  switch (kind) {
    case "webspeech":
      return new WebSpeechEngine();
    case "whisper":
      return new WhisperSocketEngine();
    case "tabaudio":
      // Placeholder until the getDisplayMedia tab-audio engine lands
      // (phase 2). Not reachable from the UI before then.
      return {
        kind: "tabaudio",
        async start(events) {
          events.onStatus("error", "标签页音频引擎即将上线，请先使用其他引擎");
        },
        async stop() {},
      };
    case "demo":
      return new DemoEngine();
  }
}
