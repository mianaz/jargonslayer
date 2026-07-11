// Shared internal transport: AudioWorklet downsampling (16kHz mono
// int16) piped over a WebSocket to the local Whisper sidecar, plus
// the sidecar wire protocol (config JSON out; partial/final JSON in).
// Used by both whisperSocket.ts (mic) and tabAudio.ts (tab/system
// audio) — the only difference between those engines is how they
// obtain the source MediaStream.

import type { STTEvents, Settings } from "@jargonslayer/core/types";
import { withBase } from "../basePath";

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
  seg_id?: number;
}
// Realtime speaker diarization (beta) — see whisper_server.py's
// run_realtime_diar / _maybe_trigger_realtime_diar.
interface SpeakerUpdateMessage {
  type: "speaker_update";
  gen: number;
  assignments: { seg_id: number; speaker: string }[];
  speakers: string[];
}
interface DiarStatusMessage {
  type: "diar_status";
  state: "unavailable" | "error";
  detail?: string;
}
type ServerMessage =
  | PartialMessage
  | FinalMessage
  | SpeakerUpdateMessage
  | DiarStatusMessage
  | { type: string };

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

  // Realtime speaker diarization (beta): drop any speaker_update whose
  // gen is <= the last one we accepted (out-of-order delivery isn't
  // expected over a single ws, but this also cleanly ignores a stray
  // update from a connection we've since reconnected past). Reset to 0
  // per connect() — the sidecar's ConnectionState.diar_gen also starts
  // at 0 for a fresh connection.
  private lastDiarGen = 0;

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
    await ctx.audioWorklet.addModule(withBase("/worklets/pcm-processor.js"));

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
    this.lastDiarGen = 0; // fresh connection -> sidecar's diar_gen also starts at 0

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
      const config: Record<string, unknown> = {
        type: "config",
        sampleRate: 16000,
        language: settings.language.split("-")[0],
      };
      // Realtime speaker diarization (beta): only sent when enabled —
      // the sidecar only arms it when BOTH diarize is truthy AND a
      // token is available (config's or its own --hf-token default),
      // so omitting hf_token here still lets the server-side default
      // apply if the user relies on that instead.
      if (settings.realtimeDiarize) {
        config.diarize = true;
        if (settings.hfToken) config.hf_token = settings.hfToken;
      }
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
        events.onFinal(final.text, { sttSeg: final.seg_id });
      } else if (msg.type === "speaker_update") {
        const update = msg as SpeakerUpdateMessage;
        if (update.gen <= this.lastDiarGen) return; // stale/out-of-order — drop
        this.lastDiarGen = update.gen;
        events.onSpeakerUpdate?.(
          update.assignments.map((a) => ({ segId: a.seg_id, speaker: a.speaker })),
          update.speakers,
        );
      } else if (msg.type === "diar_status") {
        const status = msg as DiarStatusMessage;
        events.onDiarStatus?.(status.state, status.detail);
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
