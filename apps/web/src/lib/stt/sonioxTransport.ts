// Soniox cloud STT transport (v0.4 S4, blueprint decision E): the SAME
// AudioWorklet downsampling (16kHz mono int16 PCM) wsTransport.ts uses
// — reusing /worklets/pcm-processor.js verbatim — piped over a
// WebSocket straight to Soniox's real-time endpoint instead of the
// local Whisper sidecar. Modeled on wsTransport.ts's WsTransport (same
// audio-graph shape, same stop-drain idea) but NOT a refactor of it —
// wsTransport.ts is load-bearing for whisper/tabaudio and stays
// untouched (docs/design-explorations/s4-model-wizard-blueprint.md's
// decision E is explicit about this). Only the protocol adapter
// differs: Soniox's token-stream wire shape (SonioxTokenMapper below)
// instead of whisper_server.py's partial/final messages, BYOK auth
// instead of a local sidecar, and no diarization/pause support in
// v0.4 (blueprint decision E / risk register).
//
// Wire protocol verified against soniox.com/docs/stt/api-reference/
// websocket-api, soniox.com/docs/stt/rt/endpoint-detection, and
// soniox.com/docs/stt/rt/real-time-transcription (2026-07-12,
// alongside the blueprint's own anchors — the real-time-transcription
// page is what caught the blueprint's own audio_format anchor being
// wrong; see buildSonioxConfig below): the first message is JSON
// config (api_key/model/audio_format/sample_rate/num_channels/
// language_hints/enable_endpoint_detection); audio frames are binary
// s16 little-endian PCM; responses carry `tokens:[{text,start_ms,
// end_ms,is_final,speaker,...}]`; ending the stream is an EMPTY ws
// frame, acked by `{tokens:[],finished:true}` before the server closes
// on its own; errors are `{tokens:[],error_code,error_type,
// error_message,request_id}` — error_type/error_message are provider-
// controlled text and NEVER forwarded to the UI verbatim (S4 review
// finding 2 — see formatSonioxError below). Endpoint detection
// (enable_endpoint_detection:true) does NOT add a top-level "endpoint"
// field — it inserts a literal `{text:"<end>",is_final:true}` sentinel
// token into the final token stream at each utterance boundary;
// SonioxTokenMapper below is what actually reads that sentinel.

import type { STTEvents, Settings } from "@jargonslayer/core/types";
import { withBase } from "../basePath";

const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const SONIOX_MODEL = "stt-rt-v5";

// Mirrors wsTransport.ts's STOP_DRAIN_TIMEOUT_MS (name + value) —
// deliberately NOT imported from it (sonioxTransport.ts is its own
// module per the blueprint's "do not refactor wsTransport"
// constraint). Same rationale: a server that never acks the drain
// (crashed, or an old/hung endpoint) must not hang the UI's End button
// forever (risk register item 3).
const STOP_DRAIN_TIMEOUT_MS = 8000;

const SONIOX_CONNECT_ERROR =
  "无法连接 Soniox 云端识别服务，请检查网络连接和 API Key 后重试";

// ---------------------------------------------------------------
// Token mapping (pure, unit-testable, no DOM/WebSocket references —
// blueprint decision E). Soniox's own accumulation model (verified
// against the real-time-transcription doc): each message's `tokens`
// array holds ONLY newly-seen tokens, not the full transcript so far.
// Final tokens are sent exactly once and never repeated — accumulate
// them permanently. Non-final tokens may be re-sent/revised until they
// stabilize — each message's non-final tokens fully REPLACE the
// previous interim tail, they don't accumulate. Token text already
// carries its own leading whitespace (confirmed against the docs'
// token-evolution example, which shows standalone `{"text":" "}`
// tokens) — every join below is a plain "" concatenation, never
// space-inserting. Finalized tokens are also doc'd to arrive
// incrementally BEFORE their utterance's own "<end>" — so the interim
// this mapper returns must keep showing everything finalized so far
// that hasn't crossed "<end>" yet (ahead of the current non-final
// tail), or those words visibly vanish from the live caption until the
// utterance ends (S4 review finding 3).
// ---------------------------------------------------------------

/** One entry of a Soniox response's `tokens` array. `language`/
 *  `confidence`/`translation_status` are part of the real wire shape
 *  but unused here (no translation/language-id consumer in v0.4) —
 *  left off this type entirely rather than declared-and-ignored. */
export interface SonioxToken {
  text: string;
  start_ms?: number;
  end_ms?: number;
  is_final: boolean;
  speaker?: string;
}

// The literal endpoint-detection boundary marker (verified against
// soniox.com/docs/stt/rt/endpoint-detection's own example): always
// `is_final:true`, and a control signal, never part of the spoken
// transcript — SonioxTokenMapper strips it rather than appending it.
const END_TOKEN = "<end>";

export interface SonioxMappedFinal {
  text: string;
  speaker?: string;
  /** Epoch ms, matching TranscriptSegment.startedAt / STTEvents.
   *  onFinal's `startedAt` opt — the mapper's own `streamStartMs`
   *  (stamped by the transport right as streaming begins) plus this
   *  utterance's first token's `start_ms`. `undefined` when no token
   *  in the utterance carried a `start_ms` — the caller (store.ts's
   *  addFinal) already falls back to its own receipt-time stamp for
   *  that case, same as every other engine. NOTE: Soniox's `end_ms`
   *  has no matching field on STTEvents.onFinal's opts at all —
   *  TranscriptSegment.endedAt is always receipt-time / store.ts-owned
   *  for every engine, whisper included (wsTransport.ts never forwards
   *  a `final.end` either, despite FinalMessage declaring one) — so
   *  there is nothing for end_ms to populate; it's carried on
   *  SonioxToken purely for wire fidelity. */
  startedAt?: number;
}

export interface SonioxIngestResult {
  /** Whatever's been finalized but hasn't crossed its own "<end>" yet
   *  (oldest first) PLUS the current non-final tail, "" -joined
   *  (blueprint decision E's leading-whitespace-is-in-the-token-text
   *  rule applies across this join too) — fully replacing whatever the
   *  last ingest() call returned (never a partial update), mirroring
   *  wsTransport's own "always forward the latest partial" contract.
   *  Both halves are needed: without the pending-final prefix,
   *  already-finalized words disappear from the caption the instant
   *  they finalize, only to reappear as part of the NEXT onFinal once
   *  "<end>" arrives (S4 review finding 3). */
  interim: string;
  /** Zero or more utterances that just crossed an endpoint boundary in
   *  this batch, oldest first. Usually 0 or 1; only >1 if a single
   *  message packs multiple short utterances back to back. */
  finals: SonioxMappedFinal[];
}

/** Accumulates a Soniox real-time token stream into interim text plus
 *  discrete finalized utterances. One instance per connection — build
 *  it with the epoch-ms moment that connection started streaming
 *  audio, used to translate every token's stream-relative start_ms
 *  into the epoch ms STTEvents.onFinal expects. */
export class SonioxTokenMapper {
  private finalBuffer: SonioxToken[] = [];

  constructor(private readonly streamStartMs: number) {}

  /** Process one message's `tokens` array. Finalized (is_final:true,
   *  non-"<end>") tokens accumulate permanently across calls; an
   *  "<end>" token flushes everything accumulated so far into exactly
   *  one SonioxMappedFinal (the "emit onFinal exactly once per
   *  finalized utterance stretch" contract) and is itself never
   *  included in any text. Non-final tokens replace the returned
   *  interim tail's own suffix wholesale — including with "" once
   *  nothing is pending, so a stale gray tail never lingers past its
   *  own finalization. The returned interim is prefixed with whatever
   *  is STILL buffered as finalized-but-not-yet-"<end>"ed after this
   *  call (which includes anything this same call just flushed OUT via
   *  its own "<end>" — that text left the buffer into `finals`, so it
   *  correctly does NOT reappear here) — see SonioxIngestResult.interim
   *  above (S4 review finding 3). */
  ingest(tokens: SonioxToken[]): SonioxIngestResult {
    const finals: SonioxMappedFinal[] = [];
    const nonFinalTexts: string[] = [];
    for (const t of tokens) {
      if (!t.is_final) {
        nonFinalTexts.push(t.text);
        continue;
      }
      if (t.text === END_TOKEN) {
        const final = this.flush();
        if (final) finals.push(final);
        continue;
      }
      this.finalBuffer.push(t);
    }
    const pendingFinalText = this.finalBuffer.map((t) => t.text).join("");
    return { interim: pendingFinalText + nonFinalTexts.join(""), finals };
  }

  /** Force-flushes whatever's been finalized but never crossed an
   *  "<end>" boundary — used by the transport's stop-drain (risk 3)
   *  when the stream ends (empty-frame -> {finished:true}) so a
   *  trailing utterance cut off mid-sentence still reaches onFinal
   *  instead of being silently dropped. Returns null when nothing was
   *  pending (the common case: the last utterance already flushed
   *  normally via its own "<end>"). Deliberately does NOT also flush
   *  the current non-final interim tail — that text was never
   *  confirmed by the model, so letting it fade away (rather than
   *  promoting an unconfirmed guess to a permanent segment) matches
   *  every other engine's behavior for an interim that never
   *  finalizes. */
  flushPending(): SonioxMappedFinal | null {
    return this.flush();
  }

  private flush(): SonioxMappedFinal | null {
    if (this.finalBuffer.length === 0) return null;
    const tokens = this.finalBuffer;
    this.finalBuffer = [];
    const text = tokens.map((t) => t.text).join("");
    const speaker = tokens.find((t) => t.speaker)?.speaker;
    const startMs = tokens.find((t) => t.start_ms !== undefined)?.start_ms;
    return {
      text,
      speaker,
      startedAt: startMs !== undefined ? this.streamStartMs + startMs : undefined,
    };
  }
}

// ---------------------------------------------------------------
// Config builder (pure, exported — blueprint decision E)
// ---------------------------------------------------------------

export interface SonioxConfigMessage {
  api_key: string;
  model: string;
  // "pcm_s16le", NOT "s16le" — see this file's header comment and
  // buildSonioxConfig below (S4 review finding 1).
  audio_format: "pcm_s16le";
  sample_rate: number;
  num_channels: number;
  language_hints: string[];
  enable_endpoint_detection: boolean;
}

export interface BuildSonioxConfigOpts {
  /** BYOK -> temp-key boundary (blueprint decision E): v0.4 desktop
   *  sends the real key directly — default identity. A future hosted-
   *  preview/MV3 caller drops in a real `create_temporary_api_key`
   *  mint here without this function's shape changing at all. */
  mintToken?: (key: string) => Promise<string>;
}

/** Builds the first (JSON) message Soniox's websocket protocol
 *  expects. Async only because minting the actual api_key can be
 *  (mintToken's whole point) — v0.4's default identity mint resolves
 *  synchronously in practice. */
export async function buildSonioxConfig(
  settings: Settings,
  opts: BuildSonioxConfigOpts = {},
): Promise<SonioxConfigMessage> {
  const mintToken = opts.mintToken ?? ((key: string) => Promise.resolve(key));
  const apiKey = await mintToken(settings.sonioxKey);
  return {
    api_key: apiKey,
    model: SONIOX_MODEL,
    // MUST be "pcm_s16le" — soniox.com/docs/stt/rt/real-time-
    // transcription's raw-audio audio_format values are pcm_s8/s16/
    // s24/s32 with le/be suffixes; the blueprint's own anchor of
    // "s16le" (no "pcm_" prefix) gets every real session rejected at
    // config (S4 review finding 1, re-verified 2026-07-12).
    audio_format: "pcm_s16le",
    sample_rate: 16000,
    num_channels: 1,
    language_hints: buildLanguageHints(settings.language),
    enable_endpoint_detection: true,
    // No enable_speaker_diarization — v0.4 defers diarization entirely
    // (blueprint decision E); adding the flag later is a one-line
    // change here, not a shape change.
  };
}

/** settings.language is BCP-47 (e.g. "en-US" — the same field
 *  wsTransport.ts reads via `settings.language.split("-")[0]`) plus
 *  "zh" always, deduped — e.g. "en-US" -> ["en","zh"], "zh-CN" ->
 *  ["zh"]. */
function buildLanguageHints(language: string): string[] {
  const base = language.split("-")[0];
  return Array.from(new Set([base, "zh"]));
}

// ---------------------------------------------------------------
// Transport: owns the AudioContext/worklet graph + the WebSocket +
// the Soniox protocol.
// ---------------------------------------------------------------

interface SonioxServerMessage {
  tokens: SonioxToken[];
  finished?: boolean;
  error_code?: number;
  // error_type/error_message are part of the real wire shape but
  // deliberately never read into anything user-facing — see
  // formatSonioxError below (S4 review finding 2).
  error_type?: string;
  error_message?: string;
  request_id?: string;
}

// error_message/error_type are provider-controlled text straight off
// the wire — Soniox's own error responses can echo back pieces of the
// request that caused them (e.g. a malformed-config error describing
// the bad field), and the request includes the raw api_key. Forwarding
// either into onStatus/toast/diag would risk leaking sonioxKey through
// a UI surface never meant to hold secrets (S4 review finding 2), so
// NEITHER is ever read here — only the numeric error_code, mapped to a
// fixed zh string. Codes verified against soniox.com/docs/stt/api-
// reference/websocket-api#error-response (2026-07-12): 401
// (unauthenticated) / 403 (temp_api_key_session_expired) are both
// auth/permission failures; 429 (limit_exceeded) is a rate/quota
// failure; everything else (400 malformed request, 402 budget
// exhausted, 408/413 timeouts, 500/503 server-side, or any other/
// future code) falls into one generic bucket that still surfaces the
// numeric code for support purposes.
function formatSonioxError(msg: SonioxServerMessage): string {
  const code = msg.error_code;
  if (code === 401 || code === 403) return "Soniox API Key 无效或无权限";
  if (code === 429) return "Soniox 配额或速率限制";
  return `Soniox 服务错误（代码 ${code}）`;
}

/** Belt-and-suspenders for S4 review finding 2: strips every
 *  occurrence of the configured sonioxKey out of a string before it's
 *  allowed to leave the transport. formatSonioxError() above already
 *  never reads error_message/error_type in the first place, but this
 *  is a second, independent guard applied at emitError() below — the
 *  SINGLE choke point every onStatus("error", ...) call passes through
 *  — so it also covers SONIOX_CONNECT_ERROR/the mint-failure message
 *  and any string built here in the future, not just this function's
 *  own output. */
function scrubApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join("[REDACTED]");
}

export interface SonioxTransportCallbacks {
  events: STTEvents;
  settings: Settings;
  mintToken?: (key: string) => Promise<string>;
}

/** Owns the AudioContext/worklet graph for a given source stream and
 *  the WebSocket connection + Soniox protocol. One instance per engine
 *  session; call `stop()` exactly once to tear everything down. No
 *  reconnect-on-drop (unlike WsTransport): an unexpected mid-session
 *  close surfaces onStatus("error") once rather than silently retrying
 *  against a paid BYOK endpoint — the S4 blueprint scopes Soniox as
 *  opt-in experimental, not a drop-in whisper/tabaudio replacement. */
export class SonioxTransport {
  private events: STTEvents;
  private settings: Settings;
  private mintToken?: (key: string) => Promise<string>;

  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private muteNode: GainNode | null = null;

  private mapper: SonioxTokenMapper | null = null;
  // Guards the worklet's PCM forward against ever racing ahead of the
  // JSON config message (Soniox requires config to be the socket's
  // FIRST message) — sendConfig() flips this true only right after
  // ws.send(JSON.stringify(config)) actually happens.
  private configSent = false;
  private stopping = false;
  // Guards against a duplicate onStatus("error", ...): a fatal
  // error_code message is usually followed by the server closing the
  // socket on its own, which would otherwise ALSO trip onclose's
  // generic "dropped mid-session" branch right after.
  private erroredOut = false;
  private stopDrainResolve: (() => void) | null = null;

  constructor(cb: SonioxTransportCallbacks) {
    this.events = cb.events;
    this.settings = cb.settings;
    this.mintToken = cb.mintToken;
  }

  /** Build the AudioContext -> worklet -> (muted) destination graph
   *  for the given stream and start streaming its audio to Soniox.
   *  Throws if the worklet module or audio graph fails to set up —
   *  caller decides how to translate that into an onStatus("error").
   *  Identical shape to WsTransport.attachStream (same worklet, same
   *  graph) — see this file's header for why it isn't shared code. */
  async attachStream(stream: MediaStream): Promise<void> {
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(withBase("/worklets/pcm-processor.js"));

    this.sourceNode = ctx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(ctx, "pcm-processor");

    this.workletNode.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (this.stopping || this.erroredOut) return;
      if (!this.configSent) return; // config must stay the socket's first message
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(ev.data);
      }
    };

    this.sourceNode.connect(this.workletNode);

    // Worklet doesn't need to reach speakers, but some browsers only
    // pump the audio graph (and thus `process()`) if the node chain
    // reaches destination — route through a muted gain node (same as
    // wsTransport.ts's attachStream).
    this.muteNode = ctx.createGain();
    this.muteNode.gain.value = 0;
    this.workletNode.connect(this.muteNode);
    this.muteNode.connect(ctx.destination);

    this.connect();
  }

  private connect(): void {
    if (this.stopping) return;
    this.events.onStatus("connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(SONIOX_WS_URL);
    } catch {
      this.emitError(SONIOX_CONNECT_ERROR);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      if (this.stopping) return;
      void this.sendConfig(ws);
    };

    ws.onmessage = (ev: MessageEvent<string>) => {
      if (typeof ev.data !== "string") return;
      let msg: SonioxServerMessage;
      try {
        msg = JSON.parse(ev.data) as SonioxServerMessage;
      } catch {
        return;
      }
      if (msg.error_code !== undefined) {
        this.emitError(formatSonioxError(msg));
        return;
      }
      if (msg.finished) {
        // Stop-drain (risk 3): a trailing utterance that never crossed
        // an endpoint before the stream ended must still reach
        // onFinal, not be silently dropped.
        this.flushPendingFinal();
        this.stopDrainResolve?.();
        this.stopDrainResolve = null;
        return;
      }
      const tokens = msg.tokens ?? [];
      if (!this.mapper || tokens.length === 0) return;
      const { interim, finals } = this.mapper.ingest(tokens);
      this.events.onInterim(interim);
      for (const f of finals) {
        this.events.onFinal(f.text, { speaker: f.speaker, startedAt: f.startedAt });
      }
    };

    ws.onclose = () => {
      // stop()'s drain wait must also resolve if the ws closes on its
      // own during the wait (crash, network drop mid-drain, or the
      // server's own self-close right after "finished") — never hang
      // the wait until STOP_DRAIN_TIMEOUT_MS for that case. A close
      // landing here means the server's own {finished:true} ack never
      // arrived, so THAT flush (above) never ran — the same
      // force-flush must run here too, or a trailing finalized-but-
      // un-<end>ed utterance is silently discarded instead of reaching
      // onFinal (S4 review finding 5). flushPendingFinal() is safe to
      // call even when the finished-ack flush already ran first (e.g.
      // a stray message after close) — SonioxTokenMapper.flushPending()
      // returns null once already drained, so this never double-
      // delivers the same utterance.
      if (this.stopDrainResolve) {
        const resolve = this.stopDrainResolve;
        this.stopDrainResolve = null;
        this.flushPendingFinal();
        resolve();
        return;
      }
      if (this.stopping) return;
      // Unexpected close outside of a user-initiated stop() — surface
      // it once (emitError no-ops if an error_code message already
      // reported this same drop a moment earlier).
      this.emitError(SONIOX_CONNECT_ERROR);
    };
    ws.onerror = () => {
      // onclose fires right after onerror for WebSocket failures; let
      // onclose drive the error/status flow (mirrors wsTransport.ts).
    };
  }

  /** Mints the api_key (async — see buildSonioxConfig) and sends the
   *  config as the socket's first message. Split out of connect() (a
   *  plain sync method, matching WsTransport's own connect()) purely
   *  because Soniox's mintToken boundary forces an await whisper's
   *  wire protocol never needed. */
  private async sendConfig(ws: WebSocket): Promise<void> {
    let config: SonioxConfigMessage;
    try {
      config = await buildSonioxConfig(this.settings, { mintToken: this.mintToken });
    } catch {
      this.emitError("无法准备 Soniox 连接（获取密钥失败）");
      try {
        ws.close();
      } catch {
        // already closed
      }
      return;
    }
    // stop() (or a fatal error) can land while the mint above was in
    // flight — never send a config for a session that's already done.
    if (this.stopping || this.erroredOut) return;
    // Reference epoch for turning Soniox's stream-relative token
    // start_ms into the epoch-ms STTEvents.onFinal expects — stamped
    // right as audio actually starts flowing (immediately after this
    // send, from attachStream's already-wired worklet).
    this.mapper = new SonioxTokenMapper(Date.now());
    try {
      ws.send(JSON.stringify(config));
    } catch {
      this.emitError(SONIOX_CONNECT_ERROR);
      return;
    }
    this.configSent = true;
    this.events.onStatus("listening");
  }

  private emitError(message: string): void {
    if (this.erroredOut) return;
    this.erroredOut = true;
    // scrubApiKey: the single choke point every error string passes
    // through before reaching onStatus (S4 review finding 2).
    this.events.onStatus("error", scrubApiKey(message, this.settings.sonioxKey));
  }

  /** Force-flushes any trailing finalized-but-un-<end>ed utterance the
   *  mapper is still holding and, if there was one, delivers it through
   *  the normal onFinal path exactly once. Shared by every way stop()'s
   *  drain wait can end — the server's own {finished:true} ack, the ws
   *  closing on its own mid-drain, or STOP_DRAIN_TIMEOUT_MS — so a
   *  trailing utterance reaches onFinal no matter which of those three
   *  actually fires (S4 review finding 5), and reaches it exactly once:
   *  SonioxTokenMapper.flushPending() is itself one-shot per pending
   *  utterance (returns null once already flushed), so calling this
   *  more than once for the same drain is always safe. */
  private flushPendingFinal(): void {
    const trailing = this.mapper?.flushPending();
    if (trailing) {
      this.events.onFinal(trailing.text, {
        speaker: trailing.speaker,
        startedAt: trailing.startedAt,
      });
    }
  }

  /** Tear down the WS + audio graph. Safe to call multiple times —
   *  only the first call has effect. Does NOT touch the source
   *  MediaStream's tracks — the caller (which acquired the stream)
   *  owns stopping those (same contract as WsTransport.stop()). */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    const ws = this.ws;
    this.ws = null;
    // configSent gate (S4 review finding 4): stop() can land while
    // sendConfig()'s mint is still in flight — the ws is already OPEN
    // by then (onopen already fired), but nothing has been sent on it
    // yet. Soniox requires the JSON config to be the socket's FIRST
    // message; sending the empty end-of-audio frame in that window
    // would make the terminator the first (and, since sendConfig()
    // bails once `stopping` is true, only) message this connection
    // ever sends. Skip straight to the close() below instead — there's
    // nothing to drain from a server that was never sent a config.
    if (ws && ws.readyState === WebSocket.OPEN && this.configSent) {
      try {
        // Empty TEXT frame = Soniox's end-of-audio sentinel (no
        // {"type":"stop"} JSON envelope like whisper_server.py's
        // protocol — this IS the whole message). S13.1 LIVE-KEY FINDING
        // (2026-07-19): this was `new ArrayBuffer(0)` — an empty BINARY
        // frame — which the live server does NOT recognize as end-of-
        // audio: it keeps waiting for more audio and 408s ~21s later,
        // so every stop burned the full drain timeout below and the
        // trailing utterance flushed locally instead of server-acked.
        // The api-reference page claims "binary or text" both work; the
        // rt-transcription page's `""` is what the live service actually
        // honors (verified: binary→408, ""→finished ack in <100ms, same
        // key, same audio). onmessage stays wired to this same `ws` for
        // the whole wait below, so a trailing drain final flows through
        // the normal onFinal path exactly like any other final (risk 3).
        ws.send("");
        await new Promise<void>((resolve) => {
          this.stopDrainResolve = resolve;
          setTimeout(() => {
            if (this.stopDrainResolve === resolve) {
              this.stopDrainResolve = null;
              // Same force-flush as the other two ways the drain wait
              // can end (S4 review finding 5) — a server that never
              // acks at all must not silently drop a trailing
              // finalized-but-un-<end>ed utterance either.
              this.flushPendingFinal();
              resolve();
            }
          }, STOP_DRAIN_TIMEOUT_MS);
        });
      } catch {
        // ignore — closing anyway
      }
    }
    if (ws) {
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
