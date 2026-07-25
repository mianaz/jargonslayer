// ElevenLabs Scribe realtime cloud STT transport (v0.6 round 2): the
// SAME AudioWorklet downsampling (16kHz mono int16 PCM)
// sonioxTransport.ts/deepgramTransport.ts both use — reusing
// /worklets/pcm-processor.js verbatim — piped over a WebSocket to
// ElevenLabs' realtime endpoint. Modeled on DeepgramTransport (async
// connect() — auth must be resolved BEFORE the WebSocket is even
// constructed) and SonioxTransport (bounded stop-drain wait for a
// server ack) but NOT a refactor of either — same "own module"
// rationale sonioxTransport.ts's own header already established. The
// protocol differs from both siblings in ways this file's own comments
// call out as they come up; the two structurally biggest:
// (1) every audio chunk rides a JSON envelope (`input_audio_chunk`,
// base64 payload) — there is NO raw-binary-frame option on this wire at
// all, unlike Soniox/Deepgram's binary ws.send(ArrayBuffer);
// (2) auth rides a `token` QUERY PARAM baked into the connect URL, but
// that token is itself derived, client-side, from the user's BYOK key
// via a separate plain REST POST (a short-lived, single-use mint) — the
// raw key never touches the realtime websocket, or our server, in any
// form (BYOK-only constraint: no server-minted preview lane exists for
// this engine, unlike Soniox's SONIOX_PREVIEW_LANE).
//
// Wire protocol verified against elevenlabs.io/docs/api-reference/
// speech-to-text/v-1-speech-to-text-realtime (the endpoint's own
// AsyncAPI spec) + elevenlabs.io/docs/api-reference/tokens/create (the
// single-use-token mint) + elevenlabs.io/docs/changelog/2026/6/8 (GA
// confirmation — scribe_v1 deprecated in favor of scribe_v2/
// scribe_v2_realtime, AND the ASRConversationalConfig default itself
// moved to scribe_realtime, so this is a shipping, load-bearing default
// elsewhere in ElevenLabs' own product, not a beta/waitlist feature),
// all re-verified 2026-07-24:
//
// - Endpoint: GET wss://api.elevenlabs.io/v1/speech-to-text/realtime
//   (regional Production US/EU/India/Singapore variants also exist —
//   not used here, same "one default endpoint, no region picker" scope
//   Soniox/Deepgram both keep).
// - Auth: EITHER an `xi-api-key` header (impossible to set on a browser
//   WebSocket handshake — no such API exists) OR a `token` query param,
//   "generated from the single use token endpoint... Use tokens if you
//   want to transcribe audio from the client side" (the docs' own
//   words) — POST https://api.elevenlabs.io/v1/single-use-token/
//   realtime_scribe, `xi-api-key` header carrying the real BYOK key, no
//   body, 200 response `{"token":"sutkn_..."}`; "time bound... expires
//   after 15 minutes... consumed on use" — see mintElevenLabsToken
//   below, which mints a FRESH token per connection attempt (never
//   cached/reused across reconnects, since it's single-use).
// - Audio: `audio_format=pcm_16000` query param (16-bit LE PCM @ 16kHz —
//   the exact shape /worklets/pcm-processor.js already emits, same
//   worklet Soniox/Deepgram/whisper share) + every chunk sent as
//   `{message_type:"input_audio_chunk", audio_base_64, commit,
//   sample_rate}` — `commit`/`sample_rate` are REQUIRED on every single
//   chunk message (not just a query param), verified against the
//   endpoint's own InputAudioChunk schema.
// - Partial vs final: `{message_type:"partial_transcript", text}` is
//   the FULL current interim text (replace-wholesale each time, NOT a
//   token delta — mirrors DeepgramResultMapper's own "replace wholesale"
//   contract, NOT SonioxTokenMapper's accumulate-by-token one);
//   `{message_type:"final_transcript", text}` (or its
//   `_with_timestamps` sibling, not requested here — see below) is one
//   self-contained, complete utterance, fired independently of any
//   client `commit` action (verified against the endpoint's own
//   worked example: partial "hello wor" -> final_transcript "hello
//   world", BEFORE any commit:true chunk is ever sent). A SEPARATE
//   `{message_type:"committed_transcript", text}` fires only once the
//   client (or VAD, under commit_strategy=vad) actually triggers a
//   commit — its text duplicates whatever final_transcript already
//   delivered for a short single-utterance example, so this adapter
//   uses it ONLY as the stop()-time drain ack (mirrors Soniox's own
//   empty-frame -> {finished:true} ack and Deepgram's CloseStream ->
//   close() ack), never as a second onFinal source (see the wire-shape
//   ambiguity note in this file's own stop() doc for why double-firing
//   would be the wrong call here).
// - Language: `language_code` query param, ISO 639-1/639-3 (a single
//   value, not Soniox's multi-hint array) — settings.language's BCP-47
//   base code (e.g. "en-US" -> "en"), same extraction
//   sonioxTransport.ts's own buildLanguageHints already uses. A
//   `secondary_languages` param also exists but its exact semantics
//   (simultaneous code-switching vs detection-disambiguation only)
//   could not be verified from the docs pulled — NOT set here rather
//   than guessed at (this adapter is honestly single-language, like
//   Deepgram, not a second zh-en code-switching engine like Soniox).
// - Keyterm biasing: `keyterms` query param, array of strings, "List of
//   keyterms the model is biased towards" — NO documented count/byte
//   limit (unlike Soniox's verified ~8000-token ceiling or Deepgram's
//   documented 500-token hard cap) — see lexicon.ts's own
//   ELEVENLABS_MAX_KEYTERMS_TERMS/_BYTES doc comment for the
//   conservative cap chosen in that gap. Default-on (D1 "free
//   mechanism" posture, matching Soniox's own context.terms — nothing
//   in ElevenLabs' docs prices this as a billed add-on the way
//   Deepgram's own keyterm prompting is).
// - Errors: 13 distinct in-band `message_type`s (error/auth_error/
//   quota_exceeded/commit_throttled/unaccepted_terms/rate_limited/
//   queue_overflow/resource_exhausted/session_time_limit_exceeded/
//   input_error/chunk_size_exceeded/insufficient_audio_activity/
//   transcriber_error), each `{message_type, error}` — `error` is
//   provider-controlled text and, mirroring sonioxTransport.ts's own
//   formatSonioxError posture (S4 review finding 2), is NEVER read into
//   anything user-facing or diag-logged; only the fixed `message_type`
//   discriminator drives formatElevenLabsError's own zh string.
// - Close/end-of-stream: no documented graceful-shutdown message type at
//   all (same gap deepgramTransport.ts's own header calls out for
//   Deepgram's application-error shape) — this adapter signals
//   end-of-stream the same way Soniox does (one final client message,
//   `commit:true`, then a bounded wait for either the resulting
//   committed_transcript ack or the socket closing on its own).
//
// RETENTION HONESTY (engineCapabilities.ts's own elevenlabs row):
// ElevenLabs' `enable_logging:false` (zero-retention) is documented as
// "may only be used by enterprise customers" — the SAME enterprise-only
// gate their text-to-dialogue endpoint's own changelog entry describes
// (2026-06-08), so this reads as a platform-wide policy, not something
// special-cased for this one endpoint. Sent unconditionally below
// anyway (best-effort — a real no-op for anyone it doesn't apply to,
// same "send the opt-out flag unconditionally" posture Deepgram's own
// mip_opt_out=true takes), but NOT treated as earning the "云端·不留存"
// (cloud-transient) badge Soniox/Deepgram both honestly carry — a
// typical (non-enterprise) BYOK session's audio/transcript IS retained
// in ElevenLabs' own History by default. See engineCapabilities.ts's
// "elevenlabs" row for where this becomes the actual UI-facing
// retentionClass: "cloud-stored".

import type { MeetingLexicon, STTEvents, Settings } from "@jargonslayer/core/types";
import { withBase } from "../basePath";
import { diagLog } from "../diag/log";
import { projectForElevenLabsKeyterms } from "./lexicon";

const ELEVENLABS_WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const ELEVENLABS_TOKEN_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const ELEVENLABS_MODEL = "scribe_v2_realtime";

// Mirrors sonioxTransport.ts/deepgramTransport.ts's own
// STOP_DRAIN_TIMEOUT_MS (name + value, deliberately NOT imported — see
// this file's own header). Same rationale: a server that never acks the
// drain (crashed, or an old/hung endpoint) must not hang the UI's End
// button forever.
const STOP_DRAIN_TIMEOUT_MS = 8000;

const ELEVENLABS_AUTH_ERROR = "ElevenLabs API Key 无效或无权限";
const ELEVENLABS_CONNECT_ERROR =
  "无法连接 ElevenLabs 云端识别服务，请检查网络连接和 API Key 后重试";
const ELEVENLABS_MINT_FAILURE = "无法准备 ElevenLabs 连接（获取密钥失败）";

// ---------------------------------------------------------------
// Token mint (pure-ish — one fetch, no DOM/WebSocket references)
// ---------------------------------------------------------------

/** Mints a short-lived (15 min), SINGLE-USE token client-side from the
 *  user's own long-lived BYOK key (see Settings.elevenLabsKey's own doc,
 *  packages/core/src/types.ts, and this file's header) — the raw key
 *  rides ONLY this request's `xi-api-key` header, never our server,
 *  never the realtime websocket itself. Called fresh for every
 *  connection attempt (ElevenLabsTransport.connect below) — a minted
 *  token is consumed on first use, so it is never cached/reused across
 *  reconnects. Classifies the failure the same way an in-band auth_error
 *  message would (see formatElevenLabsError) so a bad key reads
 *  identically whichever way it actually surfaces. */
export async function mintElevenLabsToken(apiKey: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(ELEVENLABS_TOKEN_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
    });
  } catch {
    throw new Error(ELEVENLABS_CONNECT_ERROR);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(ELEVENLABS_AUTH_ERROR);
    throw new Error(ELEVENLABS_MINT_FAILURE);
  }
  let json: { token?: unknown };
  try {
    json = (await res.json()) as { token?: unknown };
  } catch {
    throw new Error(ELEVENLABS_MINT_FAILURE);
  }
  if (typeof json.token !== "string" || !json.token) throw new Error(ELEVENLABS_MINT_FAILURE);
  return json.token;
}

// ---------------------------------------------------------------
// URL builder (pure, exported — mirrors buildDeepgramUrl's own shape:
// every parameter rides the query string, unlike Soniox's first-message
// JSON config)
// ---------------------------------------------------------------

/** settings.language is BCP-47 (e.g. "en-US") — ElevenLabs' own
 *  language_code wants bare ISO 639-1/639-3 (e.g. "en"). Single value,
 *  unlike sonioxTransport.ts's own buildLanguageHints (which returns an
 *  array AND always adds "zh") — see this file's header for why this
 *  adapter stays honestly single-language rather than claiming
 *  unverified zh-en code-switching support. */
export function elevenLabsLanguageCode(language: string): string {
  return language.split("-")[0];
}

export interface BuildElevenLabsUrlOpts {
  /** v0.6 round 2 (mirrors soniox's own default-on context.terms): the
   *  ONE lexicon snapshot built at the meeting-start callsite, projected
   *  through lexicon.ts's projectForElevenLabsKeyterms under its own
   *  cap. */
  lexicon?: MeetingLexicon;
}

/** Builds the full wss:// URL ElevenLabs' realtime endpoint expects —
 *  `token` is the ALREADY-MINTED single-use token (mintElevenLabsToken
 *  above), never the raw BYOK key. */
export function buildElevenLabsUrl(
  settings: Settings,
  token: string,
  opts: BuildElevenLabsUrlOpts = {},
): string {
  const params = new URLSearchParams({
    model_id: ELEVENLABS_MODEL,
    token,
    // MUST be "pcm_16000" — the exact shape /worklets/pcm-processor.js
    // already emits (same worklet Soniox/Deepgram/whisper share).
    audio_format: "pcm_16000",
    language_code: elevenLabsLanguageCode(settings.language),
    // manual: this adapter's own stop()-time commit:true chunk is what
    // triggers committed_transcript (used purely as a drain ack, see
    // this file's header) — vad would ALSO auto-fire it mid-session on
    // natural silence gaps, which this adapter has no use for and would
    // rather not have to reason about.
    commit_strategy: "manual",
    // Best-effort zero-retention opt-out (enterprise-gated — see this
    // file's header's RETENTION HONESTY note); sent unconditionally,
    // same "send the opt-out flag regardless" posture Deepgram's own
    // mip_opt_out=true takes.
    enable_logging: "false",
  });
  for (const term of projectForElevenLabsKeyterms(opts.lexicon ?? { terms: [] })) {
    params.append("keyterms", term);
  }
  return `${ELEVENLABS_WS_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------
// Outbound audio-chunk envelope + base64 (pure, exported)
// ---------------------------------------------------------------

/** Browser-safe ArrayBuffer -> base64. ElevenLabs' `audio_base_64` field
 *  is the ONLY way audio rides this wire — unlike Soniox/Deepgram, there
 *  is no raw-binary-frame option at all (see this file's header) —
 *  every worklet chunk gets base64-encoded before it can be sent.
 *  Chunked through String.fromCharCode (not one `.apply()` call) to
 *  avoid a call-stack blowup on a large buffer; the shared worklet's own
 *  chunks (16384 bytes, ~512ms @ 16kHz) never get close to needing more
 *  than one pass, but this stays correct for the stop()-time synthetic
 *  empty chunk and any future chunk-size change either way. */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export interface InputAudioChunkMessage {
  message_type: "input_audio_chunk";
  audio_base_64: string;
  commit: boolean;
  sample_rate: number;
}

/** Builds one `input_audio_chunk` message — `commit`/`sample_rate` are
 *  REQUIRED on every chunk per the endpoint's own InputAudioChunk schema
 *  (verified — see this file's header), not just a one-time query
 *  param. */
export function buildAudioChunk(data: ArrayBuffer, commit: boolean): InputAudioChunkMessage {
  return {
    message_type: "input_audio_chunk",
    audio_base_64: arrayBufferToBase64(data),
    commit,
    sample_rate: 16000,
  };
}

// ---------------------------------------------------------------
// Error classification (pure, exported — never reads provider text)
// ---------------------------------------------------------------

const FINAL_MESSAGE_TYPES = new Set(["final_transcript", "final_transcript_with_timestamps"]);
// Drain-ack only (this file's header) — never a second onFinal source.
const COMMITTED_MESSAGE_TYPES = new Set([
  "committed_transcript",
  "committed_transcript_with_timestamps",
  "committed_transcript_entities",
]);
const ERROR_MESSAGE_TYPES = new Set([
  "error",
  "auth_error",
  "quota_exceeded",
  "commit_throttled",
  "unaccepted_terms",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "input_error",
  "chunk_size_exceeded",
  "insufficient_audio_activity",
  "transcriber_error",
]);

/** Maps one of the endpoint's 13 documented in-band error message_types
 *  to a fixed zh string — the sibling `error` field (provider-controlled
 *  text) is NEVER read (mirrors sonioxTransport.ts's own
 *  formatSonioxError, S4 review finding 2: a provider's own error
 *  response can in principle echo back request details, so nothing off
 *  the wire beyond this fixed discriminator is ever surfaced). */
export function formatElevenLabsError(messageType: string): string {
  switch (messageType) {
    case "auth_error":
      return ELEVENLABS_AUTH_ERROR;
    case "quota_exceeded":
      return "ElevenLabs 配额已用尽";
    case "rate_limited":
    case "commit_throttled":
      return "ElevenLabs 请求过于频繁，请稍后重试";
    case "unaccepted_terms":
      return "ElevenLabs 账户尚未接受服务条款，请前往 elevenlabs.io 处理后重试";
    case "queue_overflow":
    case "resource_exhausted":
      return "ElevenLabs 服务繁忙，请稍后重试";
    case "session_time_limit_exceeded":
      return "ElevenLabs 单次会话时长已达上限，请重新开始";
    case "input_error":
    case "chunk_size_exceeded":
    case "insufficient_audio_activity":
      return "ElevenLabs 音频输入异常，请重新开始";
    case "transcriber_error":
      return "ElevenLabs 识别服务出错";
    case "error":
    default:
      return "ElevenLabs 服务错误";
  }
}

/** Belt-and-suspenders (mirrors sonioxTransport.ts's own scrubApiKey, S4
 *  review finding 2): the raw elevenLabsKey structurally never rides any
 *  string this file builds (only the derived, short-lived token does,
 *  and even that never reaches onStatus/diagLog — see this file's
 *  header), so this should never have anything to strip in practice.
 *  Kept anyway as the SAME single choke point discipline emitError()
 *  below already is, so a future edit can't silently reintroduce a leak
 *  without this catching it. */
function scrubApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join("[REDACTED]");
}

// ---------------------------------------------------------------
// Transport: owns the AudioContext/worklet graph + the WebSocket +
// the ElevenLabs protocol.
// ---------------------------------------------------------------

interface ElevenLabsServerMessage {
  message_type: string;
  text?: string;
  // `error`/`session_id`/`config`/`words`/`language_code`/`entities` are
  // part of the real wire shape but deliberately unread — `error` for
  // the "never trust provider-controlled text" reason above; the rest
  // simply aren't needed by this adapter's own scope (no diarization/
  // timestamps requested — see this file's header).
}

export interface ElevenLabsTransportCallbacks {
  events: STTEvents;
  settings: Settings;
  /** Test-only injection seam (mirrors SonioxTransportCallbacks/
   *  DeepgramTransportCallbacks' identical `mintToken` field) — unlike
   *  those two, this is NOT a BYOK-vs-preview-lane switch (ElevenLabs
   *  has no server-minted preview lane at all, by design): every real
   *  caller (elevenLabs.ts's ElevenLabsEngine) leaves this undefined and
   *  gets the real mintElevenLabsToken, which itself never touches our
   *  server — only a test ever substitutes this, to avoid a real network
   *  call. */
  mintToken?: (key: string) => Promise<string>;
  /** v0.6 round 2 (mirrors soniox.ts's own D8 lexicon threading): the
   *  ONE lexicon snapshot built at the meeting-start callsite. */
  lexicon?: MeetingLexicon;
}

/** Owns the AudioContext/worklet graph for a given source stream and the
 *  WebSocket connection + ElevenLabs protocol. One instance per engine
 *  session; call `stop()` exactly once to tear everything down. No
 *  reconnect-on-drop (mirrors SonioxTransport/DeepgramTransport): an
 *  unexpected mid-session close surfaces onStatus("error") once rather
 *  than silently retrying against a paid BYOK endpoint. */
export class ElevenLabsTransport {
  private events: STTEvents;
  private settings: Settings;
  private mintToken: (key: string) => Promise<string>;
  private lexicon?: MeetingLexicon;

  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private muteNode: GainNode | null = null;

  // Gates the worklet's PCM forward against sending audio before the
  // server has actually confirmed the session (mirrors SonioxTransport's
  // identical `configSent` gate) — flips true only once a
  // `session_started` message actually arrives, not merely once the
  // socket is OPEN (auth here rides the connect URL, but ElevenLabs'
  // own documented auth failure, auth_error, is an IN-BAND message, not
  // a handshake rejection — see this file's header).
  private sessionStarted = false;
  private stopping = false;
  // Guards against a duplicate onStatus("error", ...) — mirrors both
  // siblings' identical guard against double-reporting the same drop
  // from two different listeners (an in-band error message usually
  // precedes the server closing the socket on its own right after).
  private erroredOut = false;
  private stopDrainResolve: (() => void) | null = null;

  constructor(cb: ElevenLabsTransportCallbacks) {
    this.events = cb.events;
    this.settings = cb.settings;
    this.mintToken = cb.mintToken ?? mintElevenLabsToken;
    this.lexicon = cb.lexicon;
  }

  /** Build the AudioContext -> worklet -> (muted) destination graph for
   *  the given stream and start streaming its audio to ElevenLabs.
   *  Throws if the worklet module or audio graph fails to set up —
   *  caller decides how to translate that into an onStatus("error").
   *  Identical shape to SonioxTransport/DeepgramTransport.attachStream
   *  (same worklet, same graph). */
  async attachStream(stream: MediaStream): Promise<void> {
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(withBase("/worklets/pcm-processor.js"));

    this.sourceNode = ctx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(ctx, "pcm-processor");

    this.workletNode.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (this.stopping || this.erroredOut) return;
      if (!this.sessionStarted) return; // wait for the server's own session_started ack
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(buildAudioChunk(ev.data, false)));
      }
    };

    this.sourceNode.connect(this.workletNode);

    // Worklet doesn't need to reach speakers, but some browsers only
    // pump the audio graph if the node chain reaches destination — route
    // through a muted gain node (same as Soniox/DeepgramTransport.
    // attachStream).
    this.muteNode = ctx.createGain();
    this.muteNode.gain.value = 0;
    this.workletNode.connect(this.muteNode);
    this.muteNode.connect(ctx.destination);

    void this.connect();
  }

  /** Async (mirrors DeepgramTransport.connect, not SonioxTransport's sync
   *  one): the token must be minted BEFORE the WebSocket is even
   *  constructed, since it rides the connect URL's own query string. */
  private async connect(): Promise<void> {
    if (this.stopping) return;
    this.events.onStatus("connecting");

    let token: string;
    try {
      token = await this.mintToken(this.settings.elevenLabsKey);
    } catch (err) {
      // A classified Error from mintElevenLabsToken (bad key / network /
      // generic mint failure) is already a real, user-readable zh
      // message — surface it verbatim rather than a one-size-fits-all
      // fallback (mirrors sonioxTransport.ts's own sendConfig catch,
      // which does the same for its preview-lane mint failures).
      const message = err instanceof Error && err.message ? err.message : ELEVENLABS_MINT_FAILURE;
      this.emitError(message);
      return;
    }
    // stop() can land while the mint above was in flight — never open a
    // socket for a session that's already done. There is no `ws` yet at
    // all at this point (mirrors DeepgramTransport's identical guard),
    // so this bail IS the entire guard for this race.
    if (this.stopping) return;

    const url = buildElevenLabsUrl(this.settings, token, { lexicon: this.lexicon });
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.emitError(ELEVENLABS_CONNECT_ERROR);
      return;
    }
    this.ws = ws;

    ws.onmessage = (ev: MessageEvent<string>) => {
      if (typeof ev.data !== "string") return;
      let msg: ElevenLabsServerMessage;
      try {
        msg = JSON.parse(ev.data) as ElevenLabsServerMessage;
      } catch {
        return;
      }
      const type = msg.message_type;
      if (ERROR_MESSAGE_TYPES.has(type)) {
        this.emitError(formatElevenLabsError(type));
        return;
      }
      if (type === "session_started") {
        this.sessionStarted = true;
        this.events.onStatus("listening");
        return;
      }
      if (type === "partial_transcript") {
        this.events.onInterim(msg.text ?? "");
        return;
      }
      if (FINAL_MESSAGE_TYPES.has(type)) {
        // Never an empty onFinal (mirrors Soniox/Deepgram's identical
        // discipline) — clear the interim tail either way so a
        // zero-text boundary doesn't leave a stale gray tail behind.
        if (msg.text) {
          this.events.onFinal(msg.text, {});
        }
        this.events.onInterim("");
        return;
      }
      if (COMMITTED_MESSAGE_TYPES.has(type)) {
        // Drain ack only (this file's header) — resolves stop()'s own
        // wait below when one is pending; a stray commit ack outside of
        // stop() (e.g. a future vad-driven mid-session commit) is inert.
        this.stopDrainResolve?.();
        this.stopDrainResolve = null;
        return;
      }
      // unrecognized/future message_type — inert, mirrors
      // deepgramTransport.ts's own Metadata/SpeechStarted/UtteranceEnd
      // posture.
    };

    ws.onclose = () => {
      // stop()'s drain wait must also resolve if the ws closes on its
      // own during the wait (crash, network drop mid-drain, or the
      // server's own self-close right after acking the commit) — never
      // hang the wait until STOP_DRAIN_TIMEOUT_MS for that case.
      if (this.stopDrainResolve) {
        const resolve = this.stopDrainResolve;
        this.stopDrainResolve = null;
        resolve();
        return;
      }
      if (this.stopping) return;
      // Unexpected close outside of a user-initiated stop() — surface it
      // once (emitError no-ops if an in-band error message already
      // reported this same drop a moment earlier).
      this.emitError(ELEVENLABS_CONNECT_ERROR);
    };
    ws.onerror = () => {
      // onclose fires right after onerror for WebSocket failures; let
      // onclose drive the error/status flow (mirrors sonioxTransport.ts/
      // deepgramTransport.ts).
    };
  }

  private emitError(message: string): void {
    if (this.erroredOut) return;
    this.erroredOut = true;
    // scrubApiKey: the single choke point every error string passes
    // through before reaching onStatus/diagLog (S4 review finding 2
    // posture). NEVER logs key material or transcript text — `message`
    // is always one of this file's own fixed zh strings, never
    // provider-controlled text or a settings value.
    const scrubbed = scrubApiKey(message, this.settings.elevenLabsKey);
    diagLog("warn", "stt-elevenlabs", scrubbed);
    this.events.onStatus("error", scrubbed);
  }

  /** Tear down the WS + audio graph. Safe to call multiple times — only
   *  the first call has effect. Does NOT touch the source MediaStream's
   *  tracks — the caller (which acquired the stream) owns stopping those
   *  (same contract as Soniox/DeepgramTransport.stop()). */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    const ws = this.ws;
    this.ws = null;
    // sessionStarted gate (mirrors SonioxTransport's own configSent
    // gate): stop() can land while connect()'s mint/session-start is
    // still in flight — skip straight to close() below when there's
    // nothing a server that never confirmed a session could drain.
    if (ws && ws.readyState === WebSocket.OPEN && this.sessionStarted) {
      try {
        // One final input_audio_chunk with commit:true — an EMPTY
        // payload is fine (no documented minimum chunk size; nothing in
        // the endpoint's error taxonomy names "chunk too small") — this
        // IS the end-of-stream signal (no other one is documented, see
        // this file's header). onmessage stays wired to this same `ws`
        // for the whole wait below, so a resulting committed_transcript
        // ack flows through the normal drain-resolve path above.
        ws.send(JSON.stringify(buildAudioChunk(new ArrayBuffer(0), true)));
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
