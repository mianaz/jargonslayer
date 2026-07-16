// Shared internal transport: AudioWorklet downsampling (16kHz mono
// int16) piped over a WebSocket to the local Whisper sidecar, plus
// the sidecar wire protocol (config JSON out; partial/final JSON in).
// Used by whisperSocket.ts (mic) and tabAudio.ts (tab/system audio) via
// attachStream() — the only difference between those two engines is how
// they obtain the source MediaStream — and by appAudio.ts (S9.3, native
// app/system audio) via attachPcmFeed()/pushPcm(), which skip the
// MediaStream/AudioContext/worklet entirely: the native helper already
// delivers 16kHz mono i16 PCM, fed in over a Tauri Channel instead of a
// browser audio graph (see D5, docs/design-explorations/s9-app-audio-
// tap-blueprint.md). Both feed paths share the ONE pushPcm() guard.

import type { STTEvents, Settings } from "@jargonslayer/core/types";
import { withBase } from "../basePath";
import { pushLagSample } from "./latencyStats";

const RECONNECT_DELAY_MS = 1000;

// STT protocol v2: stop() sends {"type":"stop"} and waits for the
// sidecar's drain ack ({"type":"stopped"}, sent once its tail final —
// if any — has actually gone out) before closing, so the last gray
// interim never gets stuck. This bounds that wait — a sidecar that
// never acks (crashed mid-drain, very old server build predating the
// protocol) must not hang the UI's End button forever.
const STOP_DRAIN_TIMEOUT_MS = 8000;

// Post-stop diarization linger: when realtime diarization is on, the
// sidecar's own drain-ack handling (whisper_server.py's
// _finalize_diar_then_close) runs one final diarization pass — over
// whatever trailing audio the periodic ~20s cadence never caught up to
// — AFTER sending "stopped", then closes the connection itself. stop()
// resolves as soon as the ack arrives (the audio graph is already torn
// down by then — see stop() below) instead of waiting for that pass,
// but keeps THIS SAME ws open just long enough to still receive its
// speaker_update. Bounds how long a sidecar that never closes (crashed
// mid-pass, an old server build predating this) is allowed to hold the
// connection open for.
const POST_STOP_LINGER_MS = 12000;

/** Why stop()'s drain wait resolved — see stopDrainResolve's own doc
 *  and stop() below (only the "ack" case starts a post-stop linger). */
type DrainReason = "ack" | "timeout" | "closed";

interface PartialMessage {
  type: "partial";
  text: string;
  // S10 field-fix #5: per-inference transcribe wall-time in ms, when
  // the sidecar sends one (additive/optional — absent on an older
  // server build). See latencyStats.ts's own pushLagSample.
  lag_ms?: number;
}
interface FinalMessage {
  type: "final";
  text: string;
  start?: number;
  end?: number;
  seg_id?: number;
  lag_ms?: number;
}
// STT protocol v2: drain ack for a {"type":"stop"} — see stop() below.
interface StoppedMessage {
  type: "stopped";
}
// Realtime speaker diarization (beta) — see whisper_server.py's
// run_realtime_diar / _maybe_trigger_realtime_diar. Post-stop
// diarization linger (see POST_STOP_LINGER_MS above): the sidecar's
// own final pass after "stopped" can still send exactly one more of
// these before it closes the ws itself — see stop() below.
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
// FB6 (S12b fix round B, Sol6=Opus2, MED): the parakeet backend's
// single-active-stream rejection (whisper_server.py's
// ParakeetMlxServer.handle, `try_acquire_stream()` failing) — sent once,
// immediately followed by the server closing the connection itself
// (`await ws.close()`, no further messages). `detail` is the server's
// own bilingual zh/en copy, shown verbatim (see onmessage's own new
// branch below) — never re-worded here.
interface ParakeetBusyMessage {
  type: "parakeet-busy";
  detail: string;
}
type ServerMessage =
  | PartialMessage
  | FinalMessage
  | StoppedMessage
  | SpeakerUpdateMessage
  | DiarStatusMessage
  | ParakeetBusyMessage
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

  // FB6 (S12b fix round B): mirrors userStopped/stopping's own idiom —
  // a boolean handleDisconnect()/handleConnectionFailure() both check
  // before ever attempting a reconnect — for a SERVER-initiated terminal
  // condition rather than a user- or stop()-initiated one. Set the
  // instant a typed parakeet-busy event arrives (onmessage below): the
  // server closes the connection right after sending it, and reconnecting
  // into the SAME single-active-stream rejection would just repeat
  // forever for no reason — the user already got the real zh reason via
  // onStatus("error", ...) and must act on it (stop, or wait for the
  // other session to end), not watch a pointless reconnect cycle land on
  // a generic "无法连接" a few seconds later.
  private terminalFailure = false;

  // Soft pause (STT protocol v2, tabaudio/appaudio only — see pauseFeed/
  // resumeFeed below): gates pushPcm()'s forwarding (both the worklet's
  // PCM and appAudio.ts's Channel-fed PCM) without touching the ws or
  // audio graph. Deliberately NOT reset in connect() — a reconnect
  // landing while soft-paused (e.g. a transient network drop) must stay
  // paused, not silently resume sending audio.
  private feedPaused = false;

  // stop()'s drain wait (STT protocol v2): resolved by the "stopped"
  // ack (see connect()'s onmessage), by the ws closing on its own
  // during the wait (see connect()'s onclose), or by STOP_DRAIN_
  // TIMEOUT_MS, whichever first — the resolved DrainReason itself
  // gates the post-stop diarization linger below (only an actual "ack"
  // starts one; see stop()). null whenever no stop() is currently
  // waiting on it.
  private stopDrainResolve: ((reason: DrainReason) => void) | null = null;

  // Post-stop diarization linger (see POST_STOP_LINGER_MS's own doc):
  // true for the whole window between stop()'s drain-ack resolving
  // (with realtimeDiarize on) and the linger actually ending. Gates
  // onmessage (see connect()) down to speaker_update only — every
  // other message type is silently ignored while lingering, matching
  // the fact that transcription/audio capture are already fully torn
  // down by this point.
  private lingering = false;

  // The ws kept alive for the linger — a SEPARATE field from `ws`
  // (which is nulled the moment stop() starts, same as always) so
  // nothing else on this class ever mistakes a lingering connection
  // for a live/attached one (pauseFeed/resumeFeed, a future reconnect,
  // etc.). Non-null exactly while `lingering` is true.
  private lingerWs: WebSocket | null = null;

  // Caps the linger — see POST_STOP_LINGER_MS's own doc. Cleared the
  // moment any of the linger's end conditions fires first (server
  // close, this timeout, or the transport being re-stopped); see
  // endLinger().
  private lingerTimeoutId: ReturnType<typeof setTimeout> | null = null;

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

    // D5 (S9.3): routes through the SAME guard pushPcm() below uses —
    // see that method's own doc comment for what each check protects
    // against. No duplicated guard logic between this browser-audio-
    // graph path and appAudio.ts's Channel-fed path.
    this.workletNode.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      this.pushPcm(ev.data);
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

  /** D5 (S9.3, docs/design-explorations/s9-app-audio-tap-blueprint.md):
   * starts the sidecar connection for a PCM feed with NO browser audio
   * graph — appAudio.ts's AppAudioEngine already receives fully-formed
   * 16kHz mono i16 PCM from the native helper (over a Tauri Channel),
   * so there's no MediaStream/AudioContext/worklet to build here, just
   * the same connect() attachStream() uses. Caller forwards each
   * arriving chunk itself via pushPcm() below. */
  attachPcmFeed(): void {
    this.connect();
  }

  /** D5 (S9.3): the ONE guard path for forwarding a PCM chunk to the
   * sidecar — shared by the AudioWorklet's port.onmessage (attachStream()
   * above) and appAudio.ts's Channel onmessage (attachPcmFeed() above),
   * so the two feed sources can never drift into two different-but-
   * similar drop conditions. */
  pushPcm(data: ArrayBuffer): void {
    if (this.feedPaused) return; // soft pause — keep the graph/feed running, drop PCM
    // stop()'s drain wait (STT protocol v2 fix): `stopping` flips
    // SYNCHRONOUSLY before stop() ever awaits anything, but a feed
    // source (worklet port, or appAudio.ts's Channel) keeps posting
    // frames for the whole up-to-8s drain since it isn't torn down
    // until AFTER the wait — without this check, PCM captured during
    // that wait would keep streaming to a sidecar that's already
    // draining, enqueuing behind (or, on an old server predating
    // protocol v2, getting transcribed after) the stop sentinel.
    if (this.stopping) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
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
      // Post-stop diarization linger (see POST_STOP_LINGER_MS above):
      // once lingering, every message except a trailing speaker_update
      // is silently ignored — transcription/audio capture are already
      // fully torn down by this point, so nothing else is meaningful.
      if (this.lingering && msg.type !== "speaker_update") return;
      if (msg.type === "partial") {
        const partial = msg as PartialMessage;
        events.onInterim(partial.text);
        // S10 field-fix #5: additive passthrough only — absent/non-
        // finite lag_ms (older sidecar build) is silently ignored.
        if (Number.isFinite(partial.lag_ms)) pushLagSample(partial.lag_ms as number);
      } else if (msg.type === "final") {
        const final = msg as FinalMessage;
        events.onFinal(final.text, {
          // F2 fix: map through this connection's epoch — see
          // connEpoch's own doc above. Absent seg_id stays absent
          // (nothing to map — matches today's behavior for a final
          // with no seg_id at all).
          sttSeg: final.seg_id !== undefined ? this.mapSegId(final.seg_id) : undefined,
        });
        if (Number.isFinite(final.lag_ms)) pushLagSample(final.lag_ms as number);
      } else if (msg.type === "stopped") {
        // Drain ack for stop()'s wait — see stop() below. Resolving
        // here (rather than closing anything) is exactly why onmessage
        // must stay wired through the whole wait: this branch IS that
        // "stay live" contract.
        this.stopDrainResolve?.("ack");
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
      } else if (msg.type === "parakeet-busy") {
        // FB6: the server sends this ONCE then closes the connection
        // itself (whisper_server.py's ParakeetMlxServer.handle) — surface
        // its own zh/en detail verbatim (never invent/re-word copy here)
        // and mark this failure terminal BEFORE that close's onclose ever
        // runs, so handleDisconnect() skips the automatic reconnect (see
        // terminalFailure's own doc comment) instead of cycling once more
        // into the exact same rejection and only THEN surfacing a
        // generic "无法连接" a second or two later.
        const busy = msg as ParakeetBusyMessage;
        this.terminalFailure = true;
        events.onStatus("error", busy.detail);
      }
    };

    ws.onclose = () => {
      // stop()'s drain wait must also resolve if the ws closes on its
      // own during the wait (crash, network drop mid-drain) — never
      // hang the wait until STOP_DRAIN_TIMEOUT_MS for that case.
      if (this.stopDrainResolve) {
        const resolve = this.stopDrainResolve;
        this.stopDrainResolve = null;
        resolve("closed");
        return;
      }
      // Post-stop diarization linger (see POST_STOP_LINGER_MS above):
      // the sidecar closing the ws itself, after its own final diar
      // pass, is the EXPECTED end of the linger — not a disconnect to
      // reconnect from (handleDisconnect() would already no-op here too,
      // since `stopping` is set for the whole linger, but this is what
      // actually ends the linger's own bookkeeping/timeout).
      if (this.lingering) {
        this.endLinger();
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
    // FB6: terminalFailure joins userStopped/stopping in this SAME guard
    // idiom — see that field's own doc comment.
    if (this.userStopped || this.stopping || this.terminalFailure) return;
    this.handleConnectionFailure();
  }

  private handleConnectionFailure(): void {
    if (this.userStopped || this.stopping || this.terminalFailure) return;

    if (!this.reconnectAttempted) {
      this.reconnectAttempted = true;
      setTimeout(() => {
        if (this.userStopped || this.stopping || this.terminalFailure) return;
        this.connect();
      }, RECONNECT_DELAY_MS);
      return;
    }

    this.events.onStatus(
      "error",
      this.connectFailureMessage(this.settings.whisperUrl),
    );
  }

  /** Soft pause (STT protocol v2, tabaudio/appaudio only): stop
   * forwarding PCM — the ws connection (and, for tabaudio, the audio
   * graph) both stay alive, so resume needs no reconnect and no
   * re-picker/re-tap. Best-effort "flush" so the
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
   * only the first call has effect; a second/reentrant call instead
   * ends an active post-stop diarization linger, if one is running
   * (see endLinger()). Does NOT touch the source MediaStream's tracks
   * — the caller (which acquired the stream) owns stopping those. */
  async stop(): Promise<void> {
    if (this.stopping) {
      this.endLinger();
      return;
    }
    this.stopping = true;
    this.userStopped = true;

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      let drainReason: DrainReason | null = null;
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "stop" }));
          // Wait for the sidecar's drain ack ({"type":"stopped"}) or
          // STOP_DRAIN_TIMEOUT_MS, whichever first — onmessage (still
          // wired to this same `ws`, untouched here) stays live for
          // the whole wait, so a trailing drain final flows through
          // the normal onFinal path exactly like any other final. The
          // wait also resolves if `ws` closes on its own (see
          // connect()'s onclose). WHICH of the three ways it resolved
          // is what gates the post-stop diarization linger below.
          drainReason = await new Promise<DrainReason>((resolve) => {
            this.stopDrainResolve = resolve;
            setTimeout(() => {
              if (this.stopDrainResolve === resolve) {
                this.stopDrainResolve = null;
                resolve("timeout");
              }
            }, STOP_DRAIN_TIMEOUT_MS);
          });
        } catch {
          // ignore — closing anyway
        }
      }
      // Post-stop diarization linger (see POST_STOP_LINGER_MS's own
      // doc): only the ACK case means the sidecar is actually still
      // there to run its own final pass — a timeout or the ws closing
      // on its own mid-wait both mean there's nothing left to linger
      // on, so those fall through to the same immediate close as when
      // diarization is off.
      if (drainReason === "ack" && this.settings.realtimeDiarize) {
        this.startLinger(ws);
      } else {
        try {
          ws.close();
        } catch {
          // already closed
        }
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

  /** Starts the post-stop diarization linger on `ws` (still OPEN at
   * this point, and not yet closed by the caller) — see
   * POST_STOP_LINGER_MS's own doc. Purely synchronous bookkeeping: does
   * NOT delay stop()'s own resolution — the audio graph teardown right
   * after this call (still inside stop()) runs immediately regardless. */
  private startLinger(ws: WebSocket): void {
    this.lingering = true;
    this.lingerWs = ws;
    this.lingerTimeoutId = setTimeout(() => this.endLinger(), POST_STOP_LINGER_MS);
  }

  /** Ends the post-stop diarization linger — idempotent (safe to call
   * from any of its 3 end conditions: the sidecar closing the ws, this
   * linger's own POST_STOP_LINGER_MS timeout, or a reentrant stop()),
   * and a no-op if no linger is currently active. Nulls every handler
   * on the lingering ws BEFORE closing it client-side, so this class's
   * own close() call below never re-triggers the very onclose it's
   * called from (the server-close end condition). */
  private endLinger(): void {
    if (!this.lingering) return;
    this.lingering = false;
    if (this.lingerTimeoutId) {
      clearTimeout(this.lingerTimeoutId);
      this.lingerTimeoutId = null;
    }
    const ws = this.lingerWs;
    this.lingerWs = null;
    if (ws) {
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }
}
