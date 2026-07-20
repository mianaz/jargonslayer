// Deepgram cloud STT transport (v0.4.7 stt-provider-wiring, Lane D —
// docs/design-explorations/stt-provider-wiring-2026-07.md §5/§9). SAME
// AudioWorklet downsampling (16kHz mono int16 PCM) sonioxTransport.ts
// uses — reusing /worklets/pcm-processor.js verbatim — piped over a
// WebSocket to Deepgram's real-time listen endpoint. Modeled on
// SonioxTransport (same audio-graph shape, same stop-drain idea) but
// NOT a refactor of it, same "own module" rationale sonioxTransport.ts's
// own header already established relative to wsTransport.ts. The
// protocol differs from Soniox in three structural ways this file's own
// comments call out as they come up: (1) auth rides the WS HANDSHAKE
// itself (Sec-WebSocket-Protocol), not a first post-connect message, so
// the API key must be resolved BEFORE the WebSocket is even
// constructed; (2) each Results message covers one time WINDOW of audio
// (a self-contained transcript for that window), not an incremental
// token delta — interim revisions replace the CURRENT window's text
// wholesale, finalized windows accumulate until an utterance boundary;
// (3) Deepgram never echoes request text back on error the way Soniox's
// error_message/error_type can — auth/quota failures surface as a plain
// WS close, not an in-band JSON error the way Soniox's error_code is.
//
// Wire protocol verified against developers.deepgram.com (2026-07-19):
// docs/live-streaming-audio + reference/speech-to-text/listen-streaming
// (WS URL wss://api.deepgram.com/v1/listen; query params model/
// language/encoding/sample_rate/channels/interim_results/keyterm/
// diarize_model/mip_opt_out; KeepAlive {"type":"KeepAlive"}/CloseStream
// {"type":"CloseStream"}; Results response shape); docs/
// using-the-sec-websocket-protocol (auth: `new WebSocket(url,
// ["token", apiKey])` — the literal "token" first-protocol-element the
// blueprint's own D-record pins); docs/audio-keep-alive (10s idle
// timeout, NET-0001, send KeepAlive every 3-5s as a TEXT frame);
// docs/keyterm (keyterm= repeated singular param, 500-token aggregate
// cap, Nova-3-only, plain terms no weight syntax); docs/diarization
// (diarize_model=latest|v1, diarize=true deprecated, per-word integer
// speaker index on channel.alternatives[].words[].speaker);
// docs/models-languages-overview (Nova-3 English locales: en/en-US/
// en-AU/en-GB/en-IN/en-NZ — a superset of this app's own LANGUAGE_
// OPTIONS; language=multi excludes Chinese, which is why v0.4.7 stays
// single-language English-only here). The exact JSON shape of a
// non-auth application error frame (if any — e.g. mid-session quota)
// could NOT be independently confirmed against live docs in this lane
// (every documentation page checked either 404'd or omitted it) — see
// this file's own onmessage for how that unverified gap is handled
// (never parsed beyond a bare `type` discriminator, never trusted).

import type { STTEvents, Settings } from "@jargonslayer/core/types";
import { withBase } from "../basePath";

const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";
const DEEPGRAM_MODEL = "nova-3";

// Mirrors sonioxTransport.ts's own STOP_DRAIN_TIMEOUT_MS (name + value,
// deliberately NOT imported — see this file's own header). Same
// rationale: a server that never finishes flushing (crashed, or an old/
// hung endpoint) must not hang the UI's End button forever.
const STOP_DRAIN_TIMEOUT_MS = 8000;

// developers.deepgram.com/docs/audio-keep-alive: the connection closes
// (NET-0001) after 10s with no audio AND no KeepAlive; their own
// guidance is "every 3-5 seconds" — 5s leaves a comfortable margin
// without spamming the socket.
const KEEPALIVE_INTERVAL_MS = 5000;

const DEEPGRAM_CONNECT_ERROR =
  "无法连接 Deepgram 云端识别服务，请检查网络连接和 API Key 后重试";

// ---------------------------------------------------------------
// Result mapping (pure, unit-testable, no DOM/WebSocket references).
// ---------------------------------------------------------------

/** One word off a Results message's `channel.alternatives[0].words`
 *  array. `speaker` is a 0-based integer index, present ONLY when
 *  diarize_model was requested — absent (undefined) on an ordinary
 *  (non-diarized) session, which is the v0.4.7 default (see
 *  BuildDeepgramUrlOpts.diarize below). */
export interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start?: number; // seconds, stream-relative
  end?: number;
  speaker?: number;
}

export interface DeepgramAlternative {
  transcript: string;
  words?: DeepgramWord[];
}

/** One message off the wire. `type` covers every kind Deepgram sends
 *  (Results/Metadata/SpeechStarted/UtteranceEnd/anything else) — only
 *  "Results" carries the fields below that DeepgramResultMapper.ingest
 *  actually reads; every other type is routed generically by
 *  DeepgramTransport's own onmessage rather than represented here. */
export interface DeepgramResultsMessage {
  type: "Results";
  is_final: boolean;
  speech_final?: boolean;
  start?: number; // seconds, stream-relative
  channel: { alternatives: DeepgramAlternative[] };
}

export interface DeepgramMappedFinal {
  text: string;
  speaker?: string;
  /** Epoch ms — streamStartMs (stamped by the transport right as
   *  streaming begins) plus this utterance's first word/window's
   *  stream-relative `start` (SECONDS on the wire, unlike Soniox's own
   *  start_ms — converted here). undefined when nothing in the
   *  utterance carried a start. */
  startedAt?: number;
}

export interface DeepgramIngestResult {
  /** The still-open window's latest revision (replace-wholesale, not
   *  accumulated across interim messages for the SAME window — see this
   *  file's header) PREFIXED with whatever's been finalized but hasn't
   *  crossed its own speech_final yet, space-joined (mirrors
   *  SonioxTokenMapper's identical "pending-final-prefix" contract, S4
   *  review finding 3 — without it, already-locked-in words would
   *  vanish from the caption until the utterance's speech_final
   *  arrives). Fully replaces whatever the last ingest() call returned. */
  interim: string;
  /** Zero or more utterances that just crossed a speech_final boundary
   *  in this message, oldest first. More than one only when diarization
   *  is on and the utterance's words split into multiple contiguous
   *  speaker runs (D2 mapper spec) — otherwise at most one. */
  finals: DeepgramMappedFinal[];
}

interface PendingWindow {
  transcript: string;
  words?: DeepgramWord[];
  /** This window's own epoch-ms start, if any word/the window itself
   *  carried one — used as the RUN's startedAt when no per-word start
   *  is available for the diarized split path. */
  startMs?: number;
}

/** Accumulates a Deepgram real-time Results stream into interim text
 *  plus discrete finalized utterances. One instance per connection —
 *  build it with the epoch-ms moment that connection started streaming
 *  audio (same contract as SonioxTokenMapper's own streamStartMs). */
export class DeepgramResultMapper {
  private pending: PendingWindow[] = [];
  private interimTail = "";

  constructor(private readonly streamStartMs: number) {}

  /** Process one "Results" message. Non-final (is_final:false) messages
   *  REPLACE the current window's interim tail wholesale (Deepgram
   *  itself already re-sends the growing full text for that still-open
   *  window each time — a fundamentally different accumulation grain
   *  than Soniox's per-token deltas, see this file's header). A final
   *  (is_final:true) message locks that window's text into the pending
   *  buffer; once one also carries speech_final:true, the WHOLE
   *  utterance (every window buffered since the last flush) is flushed
   *  into finals — one entry normally, or one PER contiguous speaker run
   *  when any buffered word carries a `speaker` (D2 mapper spec). */
  ingest(msg: DeepgramResultsMessage): DeepgramIngestResult {
    const alt = msg.channel?.alternatives?.[0];
    const transcript = alt?.transcript ?? "";

    if (!msg.is_final) {
      this.interimTail = transcript;
      return { interim: this.currentInterim(), finals: [] };
    }

    this.interimTail = "";
    if (transcript || (alt?.words && alt.words.length > 0)) {
      const firstStart = alt?.words?.[0]?.start ?? msg.start;
      this.pending.push({
        transcript,
        words: alt?.words,
        startMs: firstStart !== undefined ? this.streamStartMs + Math.round(firstStart * 1000) : undefined,
      });
    }

    if (!msg.speech_final) return { interim: this.currentInterim(), finals: [] };
    // flush() FIRST, as its own statement — it mutates `this.pending`
    // (clears it), and currentInterim() below reads that same field, so
    // computing both inside one object literal (interim: ..., finals:
    // this.flush()) would evaluate `interim` BEFORE the flush's mutation
    // even runs (JS's own left-to-right property evaluation order),
    // stamping the just-finalized text into `interim` for one extra tick
    // instead of clearing it.
    const finals = this.flush();
    return { interim: this.currentInterim(), finals };
  }

  /** Force-flushes whatever's been finalized but never crossed a
   *  speech_final boundary — used by the transport's stop-drain when the
   *  stream ends so a trailing utterance cut off mid-sentence still
   *  reaches onFinal instead of being silently dropped (mirrors
   *  SonioxTransport.flushPendingFinal's identical rationale). Returns
   *  an empty array when nothing was pending. Deliberately does NOT also
   *  flush the current non-final interim tail — never confirmed by the
   *  model, same "let an unconfirmed guess fade" contract every other
   *  engine already follows. */
  flushPending(): DeepgramMappedFinal[] {
    return this.flush();
  }

  private flush(): DeepgramMappedFinal[] {
    const windows = this.pending;
    this.pending = [];
    if (windows.length === 0) return [];

    const allWords = windows.flatMap((w) => w.words ?? []);
    if (allWords.length > 0 && allWords.some((w) => w.speaker !== undefined)) {
      return this.splitBySpeaker(allWords);
    }

    const text = windows.map((w) => w.transcript).filter(Boolean).join(" ");
    if (!text) return [];
    return [{ text, startedAt: windows.find((w) => w.startMs !== undefined)?.startMs }];
  }

  /** D2 mapper spec (Sol F9): Deepgram finals are word-level
   *  multi-speaker while STTEvents.onFinal is single-speaker — split the
   *  whole utterance's buffered words into contiguous same-speaker runs
   *  and emit one ordered final per run. */
  private splitBySpeaker(words: DeepgramWord[]): DeepgramMappedFinal[] {
    const finals: DeepgramMappedFinal[] = [];
    let run: DeepgramWord[] = [];
    let runSpeaker: number | undefined;
    let runStartedAt: number | undefined;

    const flushRun = () => {
      if (run.length === 0) return;
      finals.push({
        text: run.map((w) => w.punctuated_word ?? w.word).join(" "),
        speaker: runSpeaker !== undefined ? String(runSpeaker) : undefined,
        startedAt: runStartedAt,
      });
      run = [];
    };

    for (const w of words) {
      if (run.length > 0 && w.speaker !== runSpeaker) flushRun();
      if (run.length === 0) {
        runStartedAt = w.start !== undefined ? this.streamStartMs + Math.round(w.start * 1000) : undefined;
      }
      runSpeaker = w.speaker;
      run.push(w);
    }
    flushRun();
    return finals;
  }

  private currentInterim(): string {
    const pendingText = this.pending.map((w) => w.transcript).filter(Boolean).join(" ");
    return [pendingText, this.interimTail].filter(Boolean).join(" ");
  }
}

// ---------------------------------------------------------------
// URL builder (pure, exported)
// ---------------------------------------------------------------

const KEYTERM_TOKEN_CAP = 500;

/** Deepgram's own documented limit: 500 tokens max, AGGREGATE, across
 *  every keyterm in one request (exceeding it is a hard rejection of the
 *  whole request, not a per-term drop) — doc §9 D1/Sol F11. No live
 *  caller passes keyterms yet (see BuildDeepgramUrlOpts.keyterms's own
 *  doc comment) — this cap exists so a future caller can't accidentally
 *  blow the request up.
 *  ponytail: `length/4` is a rough chars-per-token proxy (the common BPE
 *  rule of thumb), not Deepgram's actual tokenizer — safe to stay
 *  approximate since this only needs to stay UNDER the true limit, and
 *  the server itself is still the real enforcement boundary (a request
 *  that still overshoots gets a clear, named rejection, not silent data
 *  loss). Upgrade path: swap in Deepgram's real tokenizer if this proxy
 *  ever proves too loose in practice. */
export function capKeyterms(terms: string[]): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const term of terms) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    const cost = Math.max(1, Math.ceil(trimmed.length / 4));
    if (used + cost > KEYTERM_TOKEN_CAP) break;
    kept.push(trimmed);
    used += cost;
  }
  return kept;
}

export interface BuildDeepgramUrlOpts {
  /** Extension point for Lane B's shared 术语偏置 toggle (doc §9 D1) —
   *  Deepgram's keyterm prompting is a billed add-on (+$0.0013/min,
   *  ≈+27% on streaming — Sol F1), so THIS adapter must never turn it on
   *  by itself: the actual setting field is foundation-owned and not yet
   *  wired anywhere. Defaults to [] (no keyterm= params emitted at all,
   *  the cheapest possible request shape); a future caller passes the
   *  resolved+capped lexicon here once that setting lands — this
   *  function's own capKeyterms still re-caps defensively either way. */
  keyterms?: string[];
  /** Deepgram-scoped diarization knob (doc §9 D2) — deliberately NOT the
   *  shared realtimeDiarize setting (that implies free/local
   *  pyannote+hfToken today and mutates canPause's post-stop linger;
   *  overloading it here would be a billing surprise AND a pause
   *  mis-gate). Not yet wired to any live Settings field — a future
   *  deepgram-scoped settings block flips this. Defaults to false
   *  (diarize_model omitted entirely). */
  diarize?: boolean;
}

/** Builds the full wss:// URL Deepgram's streaming Listen API expects —
 *  every parameter rides the QUERY STRING (unlike Soniox's first-message
 *  JSON config); the API key itself never appears here at all (it rides
 *  the WS handshake's Sec-WebSocket-Protocol instead — see
 *  DeepgramTransport.connect). Language is single-value, sourced
 *  straight from settings.language (already English-only across this
 *  app's own LANGUAGE_OPTIONS — no zh variant exists to accidentally
 *  forward) rather than Soniox's multi-hint array: Nova-3's own
 *  `language=multi` excludes Chinese, so there is no code-switching mode
 *  to opt into here — v0.4.7 Deepgram is honestly single-language
 *  English-only (Soniox keeps the zh-en story). mip_opt_out is sent
 *  UNCONDITIONALLY (doc §9 D7) — this is what makes this integration
 *  honestly cloud-transient rather than cloud-stored. */
export function buildDeepgramUrl(settings: Settings, opts: BuildDeepgramUrlOpts = {}): string {
  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    language: settings.language,
    // "linear16" = 16-bit little-endian signed PCM — the exact shape
    // /worklets/pcm-processor.js already emits (same worklet Soniox/
    // whisper/tabaudio share).
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
  });
  if (opts.diarize) params.set("diarize_model", "latest"); // diarize=true is deprecated (Sol F2)
  for (const term of capKeyterms(opts.keyterms ?? [])) params.append("keyterm", term);
  params.set("mip_opt_out", "true");
  return `${DEEPGRAM_WS_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------
// Transport: owns the AudioContext/worklet graph + the WebSocket +
// the Deepgram protocol.
// ---------------------------------------------------------------

export interface DeepgramTransportCallbacks {
  events: STTEvents;
  settings: Settings;
  /** BYOK -> temp-token boundary (mirrors SonioxTransportCallbacks'
   *  identical seam, doc §6): v0.4.7 sends the real key directly —
   *  default identity. A future hosted-preview/extension caller drops in
   *  a real scoped-token mint here without this shape changing. */
  mintToken?: (key: string) => Promise<string>;
  /** See BuildDeepgramUrlOpts.keyterms — no live caller passes this yet. */
  keyterms?: string[];
  /** See BuildDeepgramUrlOpts.diarize — no live caller passes this yet. */
  diarize?: boolean;
}

/** Owns the AudioContext/worklet graph for a given source stream and the
 *  WebSocket connection + Deepgram protocol. One instance per engine
 *  session; call `stop()` exactly once to tear everything down. No
 *  reconnect-on-drop (mirrors SonioxTransport): an unexpected mid-session
 *  close surfaces onStatus("error") once rather than silently retrying
 *  against a paid BYOK endpoint. */
export class DeepgramTransport {
  private events: STTEvents;
  private settings: Settings;
  private mintToken?: (key: string) => Promise<string>;
  private keyterms: string[];
  private diarize: boolean;

  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private muteNode: GainNode | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  private mapper: DeepgramResultMapper | null = null;
  private stopping = false;
  // Guards against a duplicate onStatus("error", ...): a fatal close is
  // usually preceded/followed by nothing else meaningful, but mirrors
  // SonioxTransport's identical guard against double-reporting the same
  // drop from two different listeners.
  private erroredOut = false;
  private stopDrainResolve: (() => void) | null = null;

  constructor(cb: DeepgramTransportCallbacks) {
    this.events = cb.events;
    this.settings = cb.settings;
    this.mintToken = cb.mintToken;
    this.keyterms = cb.keyterms ?? [];
    this.diarize = cb.diarize ?? false;
  }

  /** Build the AudioContext -> worklet -> (muted) destination graph for
   *  the given stream and start streaming its audio to Deepgram. Throws
   *  if the worklet module or audio graph fails to set up — caller
   *  decides how to translate that into an onStatus("error"). Identical
   *  shape to SonioxTransport.attachStream (same worklet, same graph). */
  async attachStream(stream: MediaStream): Promise<void> {
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(withBase("/worklets/pcm-processor.js"));

    this.sourceNode = ctx.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(ctx, "pcm-processor");

    this.workletNode.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (this.stopping || this.erroredOut) return;
      // No separate "config sent" gate the way SonioxTransport needs
      // one — Deepgram's auth rides the WS handshake itself (see
      // connect() below), so ANY message sent once the socket is OPEN
      // is already authenticated; readyState alone is the whole gate.
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(ev.data);
      }
    };

    this.sourceNode.connect(this.workletNode);

    // Worklet doesn't need to reach speakers, but some browsers only
    // pump the audio graph if the node chain reaches destination — route
    // through a muted gain node (same as SonioxTransport.attachStream).
    this.muteNode = ctx.createGain();
    this.muteNode.gain.value = 0;
    this.workletNode.connect(this.muteNode);
    this.muteNode.connect(ctx.destination);

    void this.connect();
  }

  /** Async (unlike SonioxTransport.connect, which is sync and sends
   *  config as a post-connect message): Deepgram's auth rides the WS
   *  handshake's Sec-WebSocket-Protocol, so the real api_key must be
   *  resolved BEFORE the WebSocket is even constructed — there is no
   *  socket yet for a bad/slow mint to race against, unlike Soniox's
   *  configSent window. */
  private async connect(): Promise<void> {
    if (this.stopping) return;
    this.events.onStatus("connecting");

    let apiKey: string;
    try {
      const mint = this.mintToken ?? ((key: string) => Promise.resolve(key));
      apiKey = await mint(this.settings.deepgramKey);
    } catch {
      this.emitError("无法准备 Deepgram 连接（获取密钥失败）");
      return;
    }
    // stop() can land while the mint above was in flight — never open a
    // socket for a session that's already done. Unlike SonioxTransport's
    // equivalent guard, there is no `ws` yet at all at this point, so
    // this bail IS the entire guard for this race, not a supplement to
    // one closing an already-open socket.
    if (this.stopping) return;

    const url = buildDeepgramUrl(this.settings, { keyterms: this.keyterms, diarize: this.diarize });
    let ws: WebSocket;
    try {
      // The literal "token" first-protocol-element is Deepgram's own
      // documented browser-auth mechanism (developers.deepgram.com/docs/
      // using-the-sec-websocket-protocol) — a first-message JSON config
      // the way Soniox does it does NOT authenticate here (doc §9,
      // Sol F12).
      ws = new WebSocket(url, ["token", apiKey]);
    } catch {
      this.emitError(DEEPGRAM_CONNECT_ERROR);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      if (this.stopping) return;
      this.mapper = new DeepgramResultMapper(Date.now());
      this.startKeepAlive(ws);
      this.events.onStatus("listening");
    };

    ws.onmessage = (ev: MessageEvent<string>) => {
      if (typeof ev.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      // Read `type` off the raw `unknown` parse first, rather than
      // casting straight to `{ type?: string } & Partial<
      // DeepgramResultsMessage>` — that intersection collapses `type`
      // down to the NARROWER `"Results" | undefined` (DeepgramResults
      // Message's own literal), which silently makes the `=== "Error"`
      // check below a TS2367 compile error (no overlap) instead of the
      // loose string comparison it needs to be.
      const type = (parsed as { type?: unknown } | null)?.type;
      if (type === "Error") {
        // The exact field shape of a Deepgram application-error frame
        // (if any arrives over an otherwise-open connection — e.g. a
        // mid-session quota trip) could not be independently verified
        // against live docs in this lane (see this file's own header) —
        // deliberately never read/forwarded beyond this bare `type`
        // discriminator, same "never trust provider-controlled text"
        // posture sonioxTransport.ts's own formatSonioxError/
        // scrubApiKey establish. Auth failures never reach here at all
        // (a bad key fails the WS handshake itself — see onclose below).
        this.emitError(DEEPGRAM_CONNECT_ERROR);
        return;
      }
      if (type !== "Results" || !this.mapper) return; // Metadata/SpeechStarted/UtteranceEnd/unknown — inert
      const { interim, finals } = this.mapper.ingest(parsed as DeepgramResultsMessage);
      this.events.onInterim(interim);
      for (const f of finals) {
        this.events.onFinal(f.text, { speaker: f.speaker, startedAt: f.startedAt });
      }
    };

    ws.onclose = () => {
      this.stopKeepAlive();
      // stop()'s drain wait must also resolve if the ws closes on its
      // own during the wait (crash, network drop mid-drain, or the
      // server's own self-close right after CloseStream) — never hang
      // the wait until STOP_DRAIN_TIMEOUT_MS for that case. A trailing
      // finalized-but-un-speech_final'd utterance must still reach
      // onFinal instead of being silently discarded (mirrors
      // SonioxTransport's identical S4 review finding 5).
      if (this.stopDrainResolve) {
        const resolve = this.stopDrainResolve;
        this.stopDrainResolve = null;
        this.flushPendingFinal();
        resolve();
        return;
      }
      if (this.stopping) return;
      // Unexpected close outside of a user-initiated stop() — this is
      // ALSO how a bad API key surfaces (the WS handshake itself is
      // rejected, so onopen never fires and no in-band error message is
      // ever possible) — surface it once (emitError no-ops if an
      // "Error"-typed message already reported this same drop a moment
      // earlier).
      this.emitError(DEEPGRAM_CONNECT_ERROR);
    };
    ws.onerror = () => {
      // onclose fires right after onerror for WebSocket failures; let
      // onclose drive the error/status flow (mirrors sonioxTransport.ts).
    };
  }

  private startKeepAlive(ws: WebSocket): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          // TEXT frame — developers.deepgram.com/docs/audio-keep-alive
          // is explicit that a KeepAlive must NOT be sent as binary.
          ws.send(JSON.stringify({ type: "KeepAlive" }));
        } catch {
          // ignore — onclose/onerror handles a genuinely dead socket
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private emitError(message: string): void {
    if (this.erroredOut) return;
    this.erroredOut = true;
    // No scrubApiKey-equivalent (contrast sonioxTransport.ts): every
    // string this transport ever passes to onStatus("error", ...) is
    // ONE of the fixed constants above — provider-controlled text is
    // never read into any of them in the first place (see the "Error"
    // message branch's own comment), so there is nothing to scrub.
    this.events.onStatus("error", message);
  }

  /** Force-flushes any trailing finalized-but-un-speech_final'd
   *  utterance the mapper is still holding and delivers each returned
   *  entry through the normal onFinal path exactly once. Shared by both
   *  ways stop()'s drain wait can end — the ws closing on its own or
   *  STOP_DRAIN_TIMEOUT_MS — mirrors SonioxTransport.flushPendingFinal's
   *  identical rationale, adapted for flushPending() now returning an
   *  ARRAY (0, 1, or N speaker-run entries) rather than one nullable
   *  final (D2 mapper spec). */
  private flushPendingFinal(): void {
    const trailing = this.mapper?.flushPending() ?? [];
    for (const f of trailing) {
      this.events.onFinal(f.text, { speaker: f.speaker, startedAt: f.startedAt });
    }
  }

  /** Tear down the WS + audio graph. Safe to call multiple times — only
   *  the first call has effect. Does NOT touch the source MediaStream's
   *  tracks — the caller (which acquired the stream) owns stopping those
   *  (same contract as SonioxTransport.stop()). */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.stopKeepAlive();

    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        // CloseStream — developers.deepgram.com/reference/speech-to-
        // text/listen-streaming's own documented TEXT-frame shape to
        // flush trailing finals and end the session gracefully (mirrors
        // KeepAlive's own TEXT-frame requirement above).
        ws.send(JSON.stringify({ type: "CloseStream" }));
        await new Promise<void>((resolve) => {
          this.stopDrainResolve = resolve;
          setTimeout(() => {
            if (this.stopDrainResolve === resolve) {
              this.stopDrainResolve = null;
              // Same force-flush as the other way the drain wait can
              // end (onclose above) — a server that never closes at all
              // must not silently drop a trailing finalized-but-un-
              // speech_final'd utterance either.
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
