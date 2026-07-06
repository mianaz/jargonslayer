// Shared internal transport: AudioWorklet downsampling (16kHz mono
// int16) piped over a WebSocket to the local Whisper sidecar, plus
// the sidecar wire protocol (config JSON out; partial/final JSON in).
// Used by both whisperSocket.ts (mic) and tabAudio.ts (tab/system
// audio) — the only difference between those engines is how they
// obtain the source MediaStream.

import type { STTEvents, Settings } from "../types";

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

export interface WsTransportCallbacks {
  events: STTEvents;
  settings: Settings;
  /** Message shown once the single reconnect attempt also fails. */
  connectFailureMessage: (whisperUrl: string) => string;
}

/** Owns the AudioContext/worklet graph for a given source stream and
 * the WebSocket connection + sidecar protocol. One instance per
 * engine session; call `stop()` exactly once to tear everything down. */
export class WsTransport {
  private events: STTEvents;
  private settings: Settings;
  private connectFailureMessage: (whisperUrl: string) => string;

  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private muteNode: GainNode | null = null;

  private userStopped = false;
  private reconnectAttempted = false;
  private stopping = false;

  constructor(cb: WsTransportCallbacks) {
    this.events = cb.events;
    this.settings = cb.settings;
    this.connectFailureMessage = cb.connectFailureMessage;
  }

  /** Build the AudioContext -> worklet -> (muted) destination graph
   * for the given stream and start streaming its audio over the WS.
   * Throws if the worklet module or audio graph fails to set up —
   * caller decides how to translate that into an onStatus("error"). */
  async attachStream(stream: MediaStream): Promise<void> {
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.audioWorklet.addModule("/worklets/pcm-processor.js");

    this.sourceNode = ctx.createMediaStreamSource(stream);
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

    this.connect();
  }

  private connect(): void {
    if (this.stopping) return;
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
    if (this.userStopped || this.stopping) return;

    if (!this.reconnectAttempted) {
      this.reconnectAttempted = true;
      setTimeout(() => {
        if (this.userStopped || this.stopping) return;
        this.connect();
      }, RECONNECT_DELAY_MS);
      return;
    }

    this.events.onStatus(
      "error",
      this.connectFailureMessage(this.settings.whisperUrl),
    );
  }

  /** Tear down the WS + audio graph. Safe to call multiple times —
   * only the first call has effect. Does NOT touch the source
   * MediaStream's tracks; the caller (which acquired the stream) owns
   * stopping those. */
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
  }
}
