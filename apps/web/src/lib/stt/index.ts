// STT engine factory — picks the concrete implementation by kind.

import type { STTEngine, STTEngineKind } from "@jargonslayer/core/types";
import { WebSpeechEngine } from "./webSpeech";
import { WhisperSocketEngine } from "./whisperSocket";
import { TabAudioEngine } from "./tabAudio";
import { AppAudioEngine } from "./appAudio";
import { OsSpeechEngine } from "./osSpeech";
import { DemoEngine } from "./demo";
import { SonioxEngine } from "./soniox";
import { DeepgramEngine } from "./deepgram";
import { TabAudioCloudEngine } from "./tabAudioCloud";

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
    case "osspeech":
      // S11 (docs/design-explorations/s11-osspeech-blueprint.md) —
      // desktop-only, macOS 26+ Zero-Install 系统识别. Still unreachable
      // from the UI until engineOptions.ts's gate + the caps probe
      // resolve it supported (see osspeechCaps.ts).
      return new OsSpeechEngine();
    case "demo":
      return new DemoEngine();
    case "soniox":
      // v0.4 S4 chunk 5 (blueprint decision E) — BYOK cloud engine, no
      // local sidecar. Live opt-in engine: reachable via ENGINE_CARDS
      // (SettingsDialog.tsx) and ENGINE_OPTIONS (engineOptions.ts,
      // byokOnly-gated), same preview-tier coercion path as every
      // other engine.
      return new SonioxEngine();
    case "deepgram":
      // v0.4.7 (docs/design-explorations/stt-provider-wiring-2026-07.md,
      // Lane D) — second BYOK cloud engine, same triple gate as soniox
      // above (ENGINE_CARDS/ENGINE_OPTIONS byokOnly + store.ts
      // applyTierDefaults coercion + key field disabled).
      return new DeepgramEngine();
    case "tabaudio-cloud":
      // v0.5 Wave-1 Feature 4 (docs/design-explorations/v05-wave1-
      // blueprint.md §1 Feature 4 + §5 A4) — getDisplayMedia capture
      // routed into a BYOK cloud transport (Soniox/Deepgram, see
      // Settings.tabAudioCloudProvider) instead of the local sidecar.
      // Live opt-in engine as of this lane: reachable via ENGINE_CARDS
      // (SettingsDialog.tsx) and ENGINE_OPTIONS (engineOptions.ts,
      // byokOnly + web-only gated), same preview-tier coercion path as
      // soniox/deepgram above.
      return new TabAudioCloudEngine();
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
