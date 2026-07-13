// Soniox cloud STT (BYOK, experimental — v0.4 S4 blueprint decision
// E): streams 16kHz mono PCM from the mic, via the same AudioWorklet
// downsampler whisperSocket.ts/tabAudio.ts use, straight to Soniox's
// real-time endpoint (wss://stt-rt.soniox.com/transcribe-websocket) —
// no local sidecar involved. The WebSocket/audio-graph plumbing plus
// the Soniox wire protocol live in sonioxTransport.ts (modeled on
// wsTransport.ts, NOT sharing it — see that file's own header for
// why). No pause/resume: canPause is a chunk-6 UI concern
// (useMeeting's teardown-pause fallback already covers any engine that
// doesn't implement the optional STTEngine.pause/resume methods).

import type { STTEngine, STTEngineKind, STTEvents, Settings } from "@jargonslayer/core/types";
import { SonioxTransport } from "./sonioxTransport";

export class SonioxEngine implements STTEngine {
  readonly kind: STTEngineKind = "soniox";

  private transport: SonioxTransport | null = null;
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
    // (same guard as whisperSocket.ts's own, codex review 2026-07-10).
    if (this.stopping) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;

    const transport = new SonioxTransport({ events, settings });
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
