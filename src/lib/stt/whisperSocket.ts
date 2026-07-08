// Local Whisper (privacy mode) engine: streams 16kHz mono PCM from
// the mic, via an AudioWorklet downsampler, over a WebSocket to the
// sidecar (sidecar/whisper_server.py) for transcription. The
// AudioWorklet/WebSocket plumbing itself lives in wsTransport.ts,
// shared with tabAudio.ts.

import type { STTEngine, STTEngineKind, STTEvents, Settings } from "../types";
import { WsTransport } from "./wsTransport";

export class WhisperSocketEngine implements STTEngine {
  readonly kind: STTEngineKind = "whisper";

  private transport: WsTransport | null = null;
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
    this.stream = stream;

    const transport = new WsTransport({
      events,
      settings,
      connectFailureMessage: (url) =>
        `无法连接本地 Whisper（${url}）。请先启动 sidecar：cd sidecar && python whisper_server.py（详见 README）`,
    });
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
      // This is a transcription capture, not a call: echo cancellation
      // exists to stop the far side hearing themselves and works by
      // REMOVING audio that correlates with system output — i.e. it
      // actively cancels exactly the "meeting playing on my speakers"
      // audio users point the mic at. Noise suppression is tuned for
      // near-field voice and garbles far-field speech (Whisper is
      // noise-robust anyway). Auto gain lifts quiet/distant sources.
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
