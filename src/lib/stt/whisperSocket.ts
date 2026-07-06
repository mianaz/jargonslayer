// Local Whisper (privacy mode) engine: streams 16kHz mono PCM from
// the mic, via an AudioWorklet downsampler, over a WebSocket to the
// sidecar (sidecar/whisper_server.py) for transcription.

import type { STTEngine, STTEngineKind, STTEvents, Settings } from "../types";

const RECONNECT_DELAY_MS = 1000;

interface PartialMessage {
  type: "partial";
  text: string;
}
interface FinalMessage {
  type: "final";
  text: string;
  start?: number;
  end?: number;
}
type ServerMessage = PartialMessage | FinalMessage | { type: string };

export class WhisperSocketEngine implements STTEngine {
  readonly kind: STTEngineKind = "whisper";

  private events: STTEvents | null = null;
  private settings: Settings | null = null;
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private muteNode: GainNode | null = null;
  private userStopped = false;
  private reconnectAttempted = false;
  private stopping = false;

  async start(events: STTEvents, settings: Settings): Promise<void> {
    this.events = events;
    this.settings = settings;
    this.userStopped = false;
    this.reconnectAttempted = false;
    this.stopping = false;

    try {
      await this.setupAudioGraph(settings);
    } catch {
      events.onStatus(
        "error",
        "无法访问麦克风，请检查浏览器权限或选择的输入设备",
      );
      return;
    }

    this.connect();
  }

  private async setupAudioGraph(settings: Settings): Promise<void> {
    const audioConstraints: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    };
    if (settings.micId) {
      audioConstraints.deviceId = { exact: settings.micId };
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });

    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.audioWorklet.addModule("/worklets/pcm-processor.js");

    this.sourceNode = ctx.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(ctx, "pcm-processor");

    this.workletNode.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(ev.data);
      }
    };

    this.sourceNode.connect(this.workletNode);

    // Worklet doesn't need to reach speakers, but some browsers only
    // pump the audio graph (and thus `process()`) if the node chain
    // reaches destination — route through a muted gain node.
    this.muteNode = ctx.createGain();
    this.muteNode.gain.value = 0;
    this.workletNode.connect(this.muteNode);
    this.muteNode.connect(ctx.destination);
  }

  private connect(): void {
    if (!this.events || !this.settings || this.stopping) return;
    const settings = this.settings;
    const events = this.events;

    events.onStatus("connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(settings.whisperUrl);
    } catch {
      this.handleConnectionFailure();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      if (this.stopping) return;
      const config = {
        type: "config",
        sampleRate: 16000,
        language: settings.language.split("-")[0],
      };
      ws.send(JSON.stringify(config));
      this.reconnectAttempted = false;
      events.onStatus("listening");
    };

    ws.onmessage = (ev: MessageEvent<string>) => {
      if (typeof ev.data !== "string") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "partial") {
        events.onInterim((msg as PartialMessage).text);
      } else if (msg.type === "final") {
        const final = msg as FinalMessage;
        events.onFinal(final.text);
      }
    };

    ws.onclose = () => this.handleDisconnect();
    ws.onerror = () => {
      // onclose fires right after onerror for WebSocket failures;
      // let onclose drive the reconnect/error flow to avoid double
      // handling.
    };
  }

  private handleDisconnect(): void {
    if (this.userStopped || this.stopping) return;
    this.handleConnectionFailure();
  }

  private handleConnectionFailure(): void {
    if (this.userStopped || this.stopping || !this.events || !this.settings) {
      return;
    }

    if (!this.reconnectAttempted) {
      this.reconnectAttempted = true;
      setTimeout(() => {
        if (this.userStopped || this.stopping) return;
        this.connect();
      }, RECONNECT_DELAY_MS);
      return;
    }

    const url = this.settings.whisperUrl;
    this.events.onStatus(
      "error",
      `无法连接本地 Whisper（${url}）。请先启动 sidecar：cd sidecar && python whisper_server.py（详见 README）`,
    );
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.userStopped = true;

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "stop" }));
        }
      } catch {
        // ignore — closing anyway
      }
      try {
        ws.close();
      } catch {
        // already closed
      }
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }
    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
      this.workletNode.port.onmessage = null;
      this.workletNode = null;
    }
    if (this.muteNode) {
      try {
        this.muteNode.disconnect();
      } catch {
        // ignore
      }
      this.muteNode = null;
    }

    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        // already closed
      }
    }

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    this.events = null;
    this.settings = null;
  }
}
