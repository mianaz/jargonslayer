// ElevenLabs Scribe realtime cloud STT (BYOK — v0.6 round 2): streams
// 16kHz mono PCM from the mic, via the same AudioWorklet downsampler
// sonioxTransport.ts/deepgramTransport.ts use, straight to ElevenLabs'
// realtime endpoint — no local sidecar involved, and no server-minted
// preview lane either (unlike soniox.ts's own SONIOX_PREVIEW_LANE —
// BYOK-only by design for this engine). The WebSocket/audio-graph
// plumbing plus the ElevenLabs wire protocol live in
// elevenLabsTransport.ts (modeled on DeepgramTransport/SonioxTransport,
// NOT sharing either — see that file's own header for why). No
// pause/resume: canPause is a chunk-6 UI concern (useMeeting's
// teardown-pause fallback already covers any engine that doesn't
// implement the optional STTEngine.pause/resume methods) — mirrors
// soniox.ts/deepgram.ts's identical posture.

import type { MeetingLexicon, STTEngine, STTEngineKind, STTEvents, Settings } from "@jargonslayer/core/types";
import { diagLog } from "../diag/log";
import { ElevenLabsTransport } from "./elevenLabsTransport";
import { recordSttSeconds } from "./usageTracking";

export class ElevenLabsEngine implements STTEngine {
  readonly kind: STTEngineKind = "elevenlabs";

  private transport: ElevenLabsTransport | null = null;
  private stream: MediaStream | null = null;
  private stopping = false;
  private streamStartedAt: number | null = null;

  async start(events: STTEvents, settings: Settings, lexicon?: MeetingLexicon): Promise<void> {
    diagLog("info", "stt-elevenlabs", "ElevenLabs 引擎启动请求");
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
    // (same guard as soniox.ts/deepgram.ts's own).
    if (this.stopping) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;

    const transport = new ElevenLabsTransport({ events, settings, lexicon });
    this.transport = transport;

    try {
      await transport.attachStream(stream);
      this.streamStartedAt = Date.now();
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
    diagLog("info", "stt-elevenlabs", "ElevenLabs 引擎停止");

    const transport = this.transport;
    this.transport = null;
    if (transport) {
      await transport.stop();
    }

    if (this.streamStartedAt !== null) {
      recordSttSeconds(this.kind, (Date.now() - this.streamStartedAt) / 1000);
      this.streamStartedAt = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
