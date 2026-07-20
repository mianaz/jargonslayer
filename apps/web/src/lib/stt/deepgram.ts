// Deepgram cloud STT (BYOK, experimental — v0.4.7 stt-provider-wiring,
// Lane D): streams 16kHz mono PCM from the mic, via the same AudioWorklet
// downsampler whisperSocket.ts/tabAudio.ts/soniox.ts use, straight to
// Deepgram's real-time endpoint (wss://api.deepgram.com/v1/listen) — no
// local sidecar involved. The WebSocket/audio-graph plumbing plus the
// Deepgram wire protocol live in deepgramTransport.ts (modeled on
// sonioxTransport.ts, NOT sharing it — see that file's own header for
// why). No pause/resume: canPause is a chunk-6 UI concern (useMeeting's
// teardown-pause fallback already covers any engine that doesn't
// implement the optional STTEngine.pause/resume methods) — mirrors
// soniox.ts's identical posture.
//
// Lane B/D8 note: useMeeting.ts's attachEngine calls every engine's
// start() with a THIRD (lexicon: MeetingLexicon) argument — Soniox's own
// start() now accepts and forwards it (context.terms, default-on, D1).
// DeepgramEngine deliberately does NOT declare a 3rd parameter (STTEngine
// .start's own doc comment confirms TS structurally allows an
// implementation with fewer params — the extra call-site argument is
// simply dropped, no error) — Deepgram's keyterm bias is D1's ONE
// price-disclosed-opt-in exception (+27% billed add-on), and no 术语偏置
// toggle exists yet to gate it, so silently threading the always-built
// lexicon into a keyterm= param here would turn the add-on on for every
// session by default the moment any glossary/pack term exists — exactly
// the "silent BYOK spend" D1 forbids. See deepgramTransport.ts's own
// BuildDeepgramUrlOpts.keyterms doc comment for the seam a future
// toggle+lexicon.ts projection would wire through instead.

import type { STTEngine, STTEngineKind, STTEvents, Settings } from "@jargonslayer/core/types";
import { DeepgramTransport } from "./deepgramTransport";

export class DeepgramEngine implements STTEngine {
  readonly kind: STTEngineKind = "deepgram";

  private transport: DeepgramTransport | null = null;
  private stream: MediaStream | null = null;
  private stopping = false;

  async start(events: STTEvents, settings: Settings): Promise<void> {
    this.stopping = false;

    let stream: MediaStream;
    try {
      stream = await this.acquireStream(settings);
    } catch {
      events.onStatus(
        "error",
        "无法访问麦克风，请检查浏览器权限或选择的输入设备",
      );
      return;
    }
    // stop() can land while getUserMedia is awaiting the permission
    // prompt/device — without this re-check the acquired stream would
    // attach AFTER teardown and leave a hot mic on a stopped engine
    // (same guard as soniox.ts/whisperSocket.ts's own).
    if (this.stopping) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;

    // keyterms: see this file's own header (D1 opt-in exception). diarize:
    // same "no live Settings field yet" posture (D2) — both are inert
    // extension points DeepgramTransport defaults off.
    const transport = new DeepgramTransport({ events, settings });
    this.transport = transport;

    try {
      await transport.attachStream(stream);
    } catch {
      events.onStatus("error", "无法初始化音频处理，请刷新页面重试");
      stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  private async acquireStream(settings: Settings): Promise<MediaStream> {
    const audioConstraints: MediaTrackConstraints = {
      channelCount: 1,
      // Transcription capture, not a call — see whisperSocket.ts's own
      // doc for the full rationale (echo cancellation would actively
      // remove exactly the audio meant to be transcribed; noise
      // suppression garbles far-field speech; auto gain lifts
      // quiet/distant sources).
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    };
    if (settings.micId) {
      audioConstraints.deviceId = { exact: settings.micId };
    }
    return navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    const transport = this.transport;
    this.transport = null;
    if (transport) {
      await transport.stop();
    }

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
