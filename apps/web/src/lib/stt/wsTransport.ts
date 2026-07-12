// Shared internal transport: AudioWorklet downsampling (16kHz mono
// int16) piped over a WebSocket to the local Whisper sidecar, plus
// the sidecar wire protocol (config JSON out; partial/final JSON in).
// Used by both whisperSocket.ts (mic) and tabAudio.ts (tab/system
// audio) — the only difference between those engines is how they
// obtain the source MediaStream.

import type { STTEvents, Settings } from "@jargonslayer/core/types";
import { withBase } from "../basePath";

const RECONNECT_DELAY_MS = 1000;

// STT protocol v2: stop() sends {"type":"stop"} and waits for the
// sidecar's drain ack ({"type":"stopped"}, sent once its tail final —
// if any — has actually gone out) before closing, so the last gray
// interim never gets stuck. This bounds that wait — a sidecar that
// never acks (crashed mid-drain, very old server build predating the
// protocol) must not hang the UI's End button forever.
const STOP_DRAIN_TIMEOUT_MS = 8000;

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
// STT protocol v2: drain ack for a {"type":"stop"} — see stop() below.
interface StoppedMessage {
  type: "stopped";
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
  // "ready" (STT protocol v2 item f): diarization arming actually
  // succeeded on the sidecar (diarize + token + pyannote all held).
  state: "unavailable" | "error" | "ready";
  detail?: string;
}
type ServerMessage =
  | PartialMessage
  | FinalMessage
  | StoppedMessage
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

  // Soft pause (STT protocol v2, tabaudio only — see pauseFeed/
  // resumeFeed below): gates the worklet's PCM forwarding without
  // touching the ws or audio graph. Deliberately NOT reset in
  // connect() — a reconnect landing while soft-paused (e.g. a
  // transient network drop) must stay paused, not silently resume
  // sending audio.
  private feedPaused = false;

  // stop()'s drain wait (STT protocol v2): resolved by the "stopped"
  // ack (see connect()'s onmessage), by the ws closing on its own
  // during the wait (see connect()'s onclose), or by STOP_DRAIN_
  // TIMEOUT_MS, whichever first. null whenever no stop() is currently
  // waiting on it.
  private stopDrainResolve: (() => void) | null = null;

  // Realtime speaker diarization (beta): drop any speaker_update whose
  // gen is <= the last one we accepted (out-of-order delivery isn't
  // expected over a single ws, but this also cleanly ignores a stray
  // update from a connection we've since reconnected past). Reset to 0
  // per connect() — the sidecar's ConnectionState.diar_gen also starts
  // at 0 for a fresh connection.
  private lastDiarGen = 0;

  // Reconnect epoch (STT protocol v2 fix, codex v2 review F2): the
  // sidecar's own per-connection `next_seg_id` restarts at 0 on every
  // fresh connection (pre-existing sidecar behavior, NOT changed here
  // — this fix works against old AND new sidecars) — a mid-meeting
  // reconnect (transient drop, or one during a soft pause, which stays
  // on this SAME WsTransport instance) would otherwise make a new
  // connection's `seg_id`s collide with an EARLIER connection's
  // already-mapped `sttSeg`/`segId` values (store.ts's
  // applySpeakerUpdate/addFinal match purely by that id), silently
  // relabeling/misattributing unrelated rows. Incremented once per
  // connect() (starts at 0, so the first connection's own epoch is
  // already 1 by the time any message can arrive) and folded into
  // EVERY raw seg_id via mapSegId() before it ever reaches STTEvents —
  // the raw sidecar id must never leave this class unmapped (every
  // message field that carries one goes through mapSegId:
  // FinalMessage.seg_id and SpeakerUpdateMessage.assignments[].seg_id,
  // the only two places a seg_id is read from the wire).
  // Deliberately NOT reset anywhere (unlike lastDiarGen above) — it
  // must stay monotonic ACROSS reconnects within one meeting, since
  // the whole point is keeping every reconnect's ids in a disjoint
  // range from every earlier one in the SAME WsTransport instance's
  // lifetime. A hard pause/resume that tears down this instance and
  // attaches a brand new WsTransport is a separate, still-open gap
  // (mapping restarts with the new instance) — see Header.tsx's
  // canPause doc for that known limitation.
  private connEpoch = 0;

  private mapSegId(segId: number): number {
    return this.connEpoch * 1_000_000 + segId;
  }

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
      if (this.feedPaused) return; // soft pause — keep the graph running, drop PCM
      // stop()'s drain wait (STT protocol v2 fix): `stopping` flips
      // SYNCHRONOUSLY before stop() ever awaits anything, but the
      // worklet keeps running (and this port keeps posting frames)
      // for the whole up-to-8s drain since the audio graph itself
      // isn't torn down until AFTER the wait — without this check,
      // PCM captured during that wait would keep streaming to a
      // sidecar that's already draining, enqueuing behind (or, on an
      // old server predating protocol v2, getting transcribed after)
      // the stop sentinel.
      if (this.stopping) return;
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
    // F2 fix: bump BEFORE this connection can send/receive anything —
    // see connEpoch's own doc above.
    this.connEpoch += 1;

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
        // STT protocol v2: always sent explicitly (never omitted) —
        // this is what lets the app's own 实时转录预览 setting override
        // the sidecar's --partials CLI default per connection instead
        // of only at server-launch time.
        partials: settings.partials,
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
        events.onFinal(final.text, {
          // F2 fix: map through this connection's epoch — see
          // connEpoch's own doc above. Absent seg_id stays absent
          // (nothing to map — matches today's behavior for a final
          // with no seg_id at all).
          sttSeg: final.seg_id !== undefined ? this.mapSegId(final.seg_id) : undefined,
        });
      } else if (msg.type === "stopped") {
        // Drain ack for stop()'s wait — see stop() below. Resolving
        // here (rather than closing anything) is exactly why onmessage
        // must stay wired through the whole wait: this branch IS that
        // "stay live" contract.
        this.stopDrainResolve?.();
        this.stopDrainResolve = null;
      } else if (msg.type === "speaker_update") {
        const update = msg as SpeakerUpdateMessage;
        if (update.gen <= this.lastDiarGen) return; // stale/out-of-order — drop
        this.lastDiarGen = update.gen;
        events.onSpeakerUpdate?.(
          // F2 fix: map through this connection's epoch too — see
          // connEpoch's own doc above.
          update.assignments.map((a) => ({ segId: this.mapSegId(a.seg_id), speaker: a.speaker })),
          update.speakers,
        );
      } else if (msg.type === "diar_status") {
        const status = msg as DiarStatusMessage;
        events.onDiarStatus?.(status.state, status.detail);
      }
    };

    ws.onclose = () => {
      // stop()'s drain wait must also resolve if the ws closes on its
      // own during the wait (crash, network drop mid-drain) — never
      // hang the wait until STOP_DRAIN_TIMEOUT_MS for that case.
      if (this.stopDrainResolve) {
        const resolve = this.stopDrainResolve;
        this.stopDrainResolve = null;
        resolve();
        return;
      }
      this.handleDisconnect();
    };
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

  /** Soft pause (STT protocol v2, tabaudio only): stop forwarding PCM
   * — the ws connection and audio graph both stay alive, so resume
   * needs no reconnect and no re-picker. Best-effort "flush" so the
   * sidecar finalizes whatever it was mid-segment on, rather than
   * leaving it hanging until resume's next frame; the flush itself is
   * fire-and-forget (no ack — see wsTransport's protocol). */
  pauseFeed(): void {
    this.feedPaused = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "flush" }));
      } catch {
        // ignore — best-effort
      }
    }
  }

  /** Resume forwarding PCM after pauseFeed(). */
  resumeFeed(): void {
    this.feedPaused = false;
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
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "stop" }));
          // Wait for the sidecar's drain ack ({"type":"stopped"}) or
          // STOP_DRAIN_TIMEOUT_MS, whichever first — onmessage (still
          // wired to this same `ws`, untouched here) stays live for
          // the whole wait, so a trailing drain final flows through
          // the normal onFinal path exactly like any other final. The
          // wait also resolves if `ws` closes on its own (see
          // connect()'s onclose).
          await new Promise<void>((resolve) => {
            this.stopDrainResolve = resolve;
            setTimeout(() => {
              if (this.stopDrainResolve === resolve) {
                this.stopDrainResolve = null;
                resolve();
              }
            }, STOP_DRAIN_TIMEOUT_MS);
          });
        } catch {
          // ignore — closing anyway
        }
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
