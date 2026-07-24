// Local Whisper (privacy mode) engine: streams 16kHz mono PCM from
// the mic, via an AudioWorklet downsampler, over a WebSocket to the
// sidecar (sidecar/whisper_server.py) for transcription. The
// AudioWorklet/WebSocket plumbing itself lives in wsTransport.ts,
// shared with tabAudio.ts.

import type { MeetingLexicon, STTEngine, STTEngineKind, STTEvents, Settings } from "@jargonslayer/core/types";
import { IS_DESKTOP } from "../platform/desktop";
import { WsTransport } from "./wsTransport";

export class WhisperSocketEngine implements STTEngine {
  readonly kind: STTEngineKind = "whisper";

  private transport: WsTransport | null = null;
  private stream: MediaStream | null = null;
  private stopping = false;

  async start(events: STTEvents, settings: Settings, lexicon?: MeetingLexicon): Promise<void> {
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
    // (codex review 2026-07-10).
    if (this.stopping) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;

    const transport = new WsTransport({
      events,
      settings,
      lexicon,
      // Field-test fix B (verified root cause): this is the BACKSTOP —
      // useMeeting.ts's own session-start preflight (desktop, managed
      // sidecar mode) already catches the ordinary "never installed"
      // case before a connect is even attempted, opening the install
      // wizard instead of reaching here. This still fires for whatever
      // that preflight can't cover (a sidecar that was healthy moments
      // ago and died right as this connected, external/unmanaged mode,
      // etc.) — the web copy's "cd sidecar && python whisper_server.py"
      // instruction is nonsense for a desktop-app user with no terminal
      // workflow of their own, so IS_DESKTOP gets its own copy pointing
      // at the in-app installer instead. Web keeps the original copy
      // unchanged — those users legitimately run the sidecar by hand.
      connectFailureMessage: (url) =>
        IS_DESKTOP
          ? "无法连接本地 Whisper。请在 设置 → 转录引擎 完成安装或检查本地服务状态"
          : `无法连接本地 Whisper（${url}）。请先启动本地 Whisper 服务：cd sidecar && python whisper_server.py（详见 README）`,
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
