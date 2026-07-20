// Deepgram transport (v0.4.7 stt-provider-wiring, Lane D): URL-builder
// purity, the keyterm cap, the Results->interim/final mapper, and the
// transport's connect/stop-drain/error-frame wire sequencing against a
// mocked WebSocket + minimal AudioContext/AudioWorkletNode graph
// (reusing fakeWs.ts's own harness — same worklet, same bare-global
// convention sonioxTransport.ts/deepgramTransport.ts both rely on, and
// the SAME FakeWebSocket now extended with a `protocols` 2nd-constructor-
// arg capture Lane D added specifically for this file's own auth test).
// Zero network — see deepgramTransport.ts's own header for the verified
// wire protocol this exercises.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type STTEvents, type Settings } from "@jargonslayer/core/types";
import {
  FakeWebSocket,
  fakeMediaStream,
  installFakeAudioGraph,
  installFakeWebSocket,
  uninstallFakeAudioGraph,
  uninstallFakeWebSocket,
  type FakeAudioWorkletNode,
} from "./fakeWs";
import {
  DeepgramResultMapper,
  DeepgramTransport,
  buildDeepgramUrl,
  capKeyterms,
  type DeepgramResultsMessage,
  type DeepgramWord,
} from "../deepgramTransport";

// Mirrors deepgramTransport.ts's own (unexported) constants — kept in
// sync by the timeout/keepalive-path tests below (same convention as
// sonioxTransport.test.ts's own STOP_DRAIN_TIMEOUT_MS mirror).
const STOP_DRAIN_TIMEOUT_MS = 8000;
const KEEPALIVE_INTERVAL_MS = 5000;

function word(overrides: Partial<DeepgramWord> = {}): DeepgramWord {
  return { word: "hi", ...overrides };
}

function resultsMessage(overrides: Partial<DeepgramResultsMessage> = {}): DeepgramResultsMessage {
  return {
    type: "Results",
    is_final: false,
    channel: { alternatives: [{ transcript: "" }] },
    ...overrides,
  };
}

// ---------------------------------------------------------------
// buildDeepgramUrl — pure URL builder
// ---------------------------------------------------------------

describe("buildDeepgramUrl", () => {
  function params(url: string): URLSearchParams {
    return new URL(url).searchParams;
  }

  it("uses the verified wss://api.deepgram.com/v1/listen endpoint", () => {
    const url = buildDeepgramUrl(DEFAULT_SETTINGS);
    expect(url.startsWith("wss://api.deepgram.com/v1/listen?")).toBe(true);
  });

  it("fixes model/encoding/sample_rate/channels/interim_results", () => {
    const p = params(buildDeepgramUrl(DEFAULT_SETTINGS));
    expect(p.get("model")).toBe("nova-3");
    expect(p.get("encoding")).toBe("linear16");
    expect(p.get("sample_rate")).toBe("16000");
    expect(p.get("channels")).toBe("1");
    expect(p.get("interim_results")).toBe("true");
  });

  it("sources language straight from settings.language (single-value, no multi-language/zh mode)", () => {
    expect(params(buildDeepgramUrl({ ...DEFAULT_SETTINGS, language: "en-US" })).get("language")).toBe(
      "en-US",
    );
    expect(params(buildDeepgramUrl({ ...DEFAULT_SETTINGS, language: "en-GB" })).get("language")).toBe(
      "en-GB",
    );
  });

  it("sends mip_opt_out=true UNCONDITIONALLY, even with no opts at all (doc §9 D7 — the whole reason this integration is honestly cloud-transient)", () => {
    const p = params(buildDeepgramUrl(DEFAULT_SETTINGS));
    expect(p.get("mip_opt_out")).toBe("true");
  });

  it("never includes diarize_model when opts.diarize is omitted or false (D2: opt-in only)", () => {
    expect(params(buildDeepgramUrl(DEFAULT_SETTINGS)).has("diarize_model")).toBe(false);
    expect(params(buildDeepgramUrl(DEFAULT_SETTINGS, { diarize: false })).has("diarize_model")).toBe(
      false,
    );
  });

  it("includes diarize_model=latest (NOT diarize=true, which is deprecated) when opts.diarize is true", () => {
    const p = params(buildDeepgramUrl(DEFAULT_SETTINGS, { diarize: true }));
    expect(p.get("diarize_model")).toBe("latest");
    expect(p.has("diarize")).toBe(false);
  });

  it("never includes a keyterm param when opts.keyterms is omitted or empty (D1: opt-in only, no silent billed add-on)", () => {
    expect(params(buildDeepgramUrl(DEFAULT_SETTINGS)).getAll("keyterm")).toEqual([]);
    expect(params(buildDeepgramUrl(DEFAULT_SETTINGS, { keyterms: [] })).getAll("keyterm")).toEqual([]);
  });

  it("emits keyterm as a REPEATED singular query param (not a comma-joined keyterms= list) when opts.keyterms is provided", () => {
    const p = params(buildDeepgramUrl(DEFAULT_SETTINGS, { keyterms: ["scRNA-seq", "pseudobulk"] }));
    expect(p.getAll("keyterm")).toEqual(["scRNA-seq", "pseudobulk"]);
    expect(p.has("keyterms")).toBe(false);
  });

  it("re-caps opts.keyterms through capKeyterms defensively (belt-and-suspenders even for an already-capped caller)", () => {
    const huge = "x".repeat(3000); // costs > 500 tokens alone under the length/4 proxy
    const p = params(buildDeepgramUrl(DEFAULT_SETTINGS, { keyterms: ["ok", huge] }));
    expect(p.getAll("keyterm")).toEqual(["ok"]);
  });
});

// ---------------------------------------------------------------
// capKeyterms — pure 500-token aggregate cap
// ---------------------------------------------------------------

describe("capKeyterms", () => {
  it("keeps every term when comfortably under the 500-token cap", () => {
    expect(capKeyterms(["ARR", "scRNA-seq", "pseudobulk"])).toEqual(["ARR", "scRNA-seq", "pseudobulk"]);
  });

  it("returns [] for an empty input", () => {
    expect(capKeyterms([])).toEqual([]);
  });

  it("drops empty/whitespace-only terms without consuming any budget", () => {
    expect(capKeyterms(["", "   ", "real-term"])).toEqual(["real-term"]);
  });

  it("trims surrounding whitespace off kept terms", () => {
    expect(capKeyterms(["  padded  "])).toEqual(["padded"]);
  });

  it("stops adding once the running total would exceed the 500-token cap, and drops every later term too (fail-fast, not best-fit packing)", () => {
    // 250 short terms (cost 1 token each under length/4) fit comfortably.
    const short = Array.from({ length: 250 }, (_, i) => `t${i}`);
    // One term whose own cost alone (300 tokens) would push the running
    // total from 250 to 550, over the cap.
    const big = "x".repeat(1200); // Math.ceil(1200/4) = 300
    const after = "small"; // would fit in a FRESH budget, but must NOT be
    // reached once `big` already broke the loop.
    const kept = capKeyterms([...short, big, after]);
    expect(kept).toEqual(short);
    expect(kept).not.toContain(big);
    expect(kept).not.toContain(after);
  });

  it("drops a single term whose own cost alone exceeds the cap entirely (never partially includes it)", () => {
    const huge = "x".repeat(3000); // Math.ceil(3000/4) = 750 > 500
    expect(capKeyterms([huge])).toEqual([]);
  });
});

// ---------------------------------------------------------------
// DeepgramResultMapper — pure, DOM-free Results accumulation
// ---------------------------------------------------------------

describe("DeepgramResultMapper", () => {
  it("replaces the interim tail wholesale on each non-final message (Deepgram already re-sends the growing full window text, unlike Soniox's per-token deltas)", () => {
    const mapper = new DeepgramResultMapper(0);
    const first = mapper.ingest(resultsMessage({ is_final: false, channel: { alternatives: [{ transcript: "another big" }] } }));
    expect(first).toEqual({ interim: "another big", finals: [] });

    const second = mapper.ingest(
      resultsMessage({ is_final: false, channel: { alternatives: [{ transcript: "another big problem" }] } }),
    );
    // Replaced wholesale, not appended onto "another big".
    expect(second).toEqual({ interim: "another big problem", finals: [] });
  });

  it("an is_final:true window without speech_final keeps its text visible in later interim ticks instead of vanishing (mirrors S4 review finding 3's rationale)", () => {
    const mapper = new DeepgramResultMapper(0);
    const { interim } = mapper.ingest(
      resultsMessage({ is_final: true, channel: { alternatives: [{ transcript: "Hello" }] } }),
    );
    expect(interim).toBe("Hello");

    const next = mapper.ingest(
      resultsMessage({ is_final: false, channel: { alternatives: [{ transcript: "wor" }] } }),
    );
    expect(next.interim).toBe("Hello wor");
  });

  it("emits nothing on is_final:true without speech_final (utterance still open)", () => {
    const mapper = new DeepgramResultMapper(0);
    const { finals } = mapper.ingest(
      resultsMessage({ is_final: true, channel: { alternatives: [{ transcript: "Hello" }] } }),
    );
    expect(finals).toEqual([]);
  });

  it("flushes exactly one final on is_final:true + speech_final:true, and clears the interim tail", () => {
    const mapper = new DeepgramResultMapper(0);
    const { finals, interim } = mapper.ingest(
      resultsMessage({ is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "Hello world" }] } }),
    );
    expect(finals).toEqual([{ text: "Hello world", startedAt: undefined }]);
    expect(interim).toBe("");
  });

  it("accumulates multiple is_final windows (space-joined) before speech_final finally flushes them as ONE utterance", () => {
    const mapper = new DeepgramResultMapper(0);
    mapper.ingest(resultsMessage({ is_final: true, channel: { alternatives: [{ transcript: "One" }] } }));
    mapper.ingest(resultsMessage({ is_final: true, channel: { alternatives: [{ transcript: "two" }] } }));
    const { finals } = mapper.ingest(
      resultsMessage({ is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "three" }] } }),
    );
    expect(finals).toEqual([{ text: "One two three", startedAt: undefined }]);
  });

  it("a speech_final:true window with nothing pending and an empty transcript emits nothing (never an empty onFinal)", () => {
    const mapper = new DeepgramResultMapper(0);
    const { finals } = mapper.ingest(resultsMessage({ is_final: true, speech_final: true }));
    expect(finals).toEqual([]);
  });

  it("maps startedAt = streamStartMs + the utterance's first window's `start` (SECONDS on the wire, converted to ms)", () => {
    const mapper = new DeepgramResultMapper(1_000_000);
    const { finals } = mapper.ingest(
      resultsMessage({
        is_final: true,
        speech_final: true,
        start: 0.25,
        channel: { alternatives: [{ transcript: "Hi there" }] },
      }),
    );
    expect(finals[0].startedAt).toBe(1_000_250);
  });

  it("prefers a word's own `start` over the window-level `start` when words are present", () => {
    const mapper = new DeepgramResultMapper(1_000_000);
    const { finals } = mapper.ingest(
      resultsMessage({
        is_final: true,
        speech_final: true,
        start: 5, // window-level — should be ignored in favor of the word's own
        channel: {
          alternatives: [{ transcript: "Hi", words: [word({ word: "Hi", start: 0.1 })] }],
        },
      }),
    );
    expect(finals[0].startedAt).toBe(1_000_100);
  });

  it("leaves startedAt undefined when neither the window nor any word carried a start", () => {
    const mapper = new DeepgramResultMapper(1_000_000);
    const { finals } = mapper.ingest(
      resultsMessage({ is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "Hi" }] } }),
    );
    expect(finals[0].startedAt).toBeUndefined();
  });

  it("falls back to the bare `transcript` string when a window carries no `words` array at all (defensive, non-diarized path)", () => {
    const mapper = new DeepgramResultMapper(0);
    const { finals } = mapper.ingest(
      resultsMessage({ is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "no words here" }] } }),
    );
    expect(finals).toEqual([{ text: "no words here", startedAt: undefined }]);
  });

  it("flushPending() force-flushes a trailing utterance that never crossed speech_final", () => {
    const mapper = new DeepgramResultMapper(1_000_000);
    mapper.ingest(resultsMessage({ is_final: true, start: 0.05, channel: { alternatives: [{ transcript: "trailing" }] } }));
    expect(mapper.flushPending()).toEqual([{ text: "trailing", startedAt: 1_000_050 }]);
  });

  it("flushPending() returns [] when nothing is pending, including right after a normal speech_final flush", () => {
    const mapper = new DeepgramResultMapper(0);
    expect(mapper.flushPending()).toEqual([]);
    mapper.ingest(resultsMessage({ is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "done" }] } }));
    expect(mapper.flushPending()).toEqual([]);
  });

  // -------------------------------------------------------------
  // D2 mapper spec: diarized word-level speaker-run splitting
  // -------------------------------------------------------------

  describe("diarized speaker-run splitting (D2 mapper spec, Sol F9)", () => {
    it("a single-speaker utterance still yields exactly one final, with that speaker's index stringified", () => {
      const mapper = new DeepgramResultMapper(0);
      const { finals } = mapper.ingest(
        resultsMessage({
          is_final: true,
          speech_final: true,
          channel: {
            alternatives: [
              {
                transcript: "hi there",
                words: [word({ word: "hi", speaker: 0 }), word({ word: "there", speaker: 0 })],
              },
            ],
          },
        }),
      );
      expect(finals).toEqual([{ text: "hi there", speaker: "0", startedAt: undefined }]);
    });

    it("splits a multi-speaker utterance into contiguous ordered runs, one final per run", () => {
      const mapper = new DeepgramResultMapper(0);
      const { finals } = mapper.ingest(
        resultsMessage({
          is_final: true,
          speech_final: true,
          channel: {
            alternatives: [
              {
                transcript: "hi there bye now",
                words: [
                  word({ word: "hi", speaker: 0 }),
                  word({ word: "there", speaker: 0 }),
                  word({ word: "bye", speaker: 1 }),
                  word({ word: "now", speaker: 1 }),
                ],
              },
            ],
          },
        }),
      );
      expect(finals).toEqual([
        { text: "hi there", speaker: "0", startedAt: undefined },
        { text: "bye now", speaker: "1", startedAt: undefined },
      ]);
    });

    it("merges a same-speaker run across two separate is_final windows (the run isn't artificially cut at the window boundary)", () => {
      const mapper = new DeepgramResultMapper(0);
      mapper.ingest(
        resultsMessage({
          is_final: true,
          channel: { alternatives: [{ transcript: "hi", words: [word({ word: "hi", speaker: 0 })] }] },
        }),
      );
      const { finals } = mapper.ingest(
        resultsMessage({
          is_final: true,
          speech_final: true,
          channel: { alternatives: [{ transcript: "there", words: [word({ word: "there", speaker: 0 })] }] },
        }),
      );
      expect(finals).toEqual([{ text: "hi there", speaker: "0", startedAt: undefined }]);
    });

    it("prefers punctuated_word over word when joining a run's text", () => {
      const mapper = new DeepgramResultMapper(0);
      const { finals } = mapper.ingest(
        resultsMessage({
          is_final: true,
          speech_final: true,
          channel: {
            alternatives: [
              {
                transcript: "hi there",
                words: [
                  word({ word: "hi", punctuated_word: "Hi,", speaker: 0 }),
                  word({ word: "there", punctuated_word: "there.", speaker: 0 }),
                ],
              },
            ],
          },
        }),
      );
      expect(finals[0].text).toBe("Hi, there.");
    });

    it("each run's startedAt is that run's OWN first word's start, not the whole utterance's", () => {
      const mapper = new DeepgramResultMapper(1_000_000);
      const { finals } = mapper.ingest(
        resultsMessage({
          is_final: true,
          speech_final: true,
          channel: {
            alternatives: [
              {
                transcript: "hi bye",
                words: [
                  word({ word: "hi", start: 0.1, speaker: 0 }),
                  word({ word: "bye", start: 2, speaker: 1 }),
                ],
              },
            ],
          },
        }),
      );
      expect(finals[0].startedAt).toBe(1_000_100);
      expect(finals[1].startedAt).toBe(1_002_000);
    });

    it("a plain (non-diarized) session — no word ever carries a speaker — never triggers the split path even when words[] is present", () => {
      const mapper = new DeepgramResultMapper(0);
      const { finals } = mapper.ingest(
        resultsMessage({
          is_final: true,
          speech_final: true,
          channel: {
            alternatives: [
              { transcript: "hi there", words: [word({ word: "hi" }), word({ word: "there" })] },
            ],
          },
        }),
      );
      expect(finals).toEqual([{ text: "hi there", startedAt: undefined }]);
    });
  });
});

// ---------------------------------------------------------------
// DeepgramTransport — wire sequencing against a mocked WebSocket
// ---------------------------------------------------------------

describe("DeepgramTransport", () => {
  let wsInstances: FakeWebSocket[];
  let workletNodes: FakeAudioWorkletNode[];
  let onInterim: ReturnType<typeof vi.fn>;
  let onFinal: ReturnType<typeof vi.fn>;
  let onStatus: ReturnType<typeof vi.fn>;
  let onSpeakerUpdate: ReturnType<typeof vi.fn>;
  let events: STTEvents;

  beforeEach(() => {
    ({ instances: wsInstances } = installFakeWebSocket());
    ({ workletNodes } = installFakeAudioGraph());
    onInterim = vi.fn();
    onFinal = vi.fn();
    onStatus = vi.fn();
    onSpeakerUpdate = vi.fn();
    events = { onInterim, onFinal, onStatus, onSpeakerUpdate } as unknown as STTEvents;
  });

  afterEach(() => {
    uninstallFakeWebSocket();
    uninstallFakeAudioGraph();
    vi.useRealTimers();
  });

  function makeTransport(
    overrides: Partial<Settings> = {},
    opts: { mintToken?: (key: string) => Promise<string>; keyterms?: string[]; diarize?: boolean } = {},
  ): DeepgramTransport {
    return new DeepgramTransport({
      events,
      settings: { ...DEFAULT_SETTINGS, deepgramKey: "sk-should-never-leak", ...overrides },
      ...opts,
    });
  }

  /** Flushes the microtask chain connect()'s `await mint(...)` needs to
   *  actually run BEFORE `new WebSocket(...)` executes — Deepgram's auth
   *  rides the handshake itself, so (unlike SonioxTransport, which
   *  constructs its ws synchronously and only needs this flush before
   *  its post-open sendConfig) the ws instance does not exist at all
   *  until this resolves. Plain microtask ticks, not a timer — works
   *  identically whether or not the test also has fake timers installed. */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  async function attachAndOpen(transport: DeepgramTransport): Promise<FakeWebSocket> {
    await transport.attachStream(fakeMediaStream());
    await flushMicrotasks();
    const ws = wsInstances[wsInstances.length - 1];
    ws.simulateOpen();
    return ws;
  }

  // ---------------------------------------------------------------
  // connect / auth
  // ---------------------------------------------------------------

  it("goes connecting -> listening, authenticates via Sec-WebSocket-Protocol ['token', apiKey], and sends NO first message at all (auth rides the handshake, not a Soniox-style post-connect config)", async () => {
    const transport = makeTransport({ deepgramKey: "sk-abc" });
    const ws = await attachAndOpen(transport);

    expect(onStatus.mock.calls[0]).toEqual(["connecting"]);
    expect(onStatus.mock.calls[1]).toEqual(["listening"]);
    // THE regression pin: a literal Soniox-style copy (first-message
    // JSON config) fails Deepgram auth entirely (doc §9, Sol F12) — this
    // asserts BOTH halves of the real mechanism at once: the handshake
    // carries the token, and nothing rides the message channel instead.
    expect(ws.protocols).toEqual(["token", "sk-abc"]);
    expect(ws.sent).toEqual([]);
  });

  it("resolves the api_key through an injected mintToken override before constructing the socket", async () => {
    const mintToken = vi.fn(async (key: string) => `minted:${key}`);
    const transport = makeTransport({ deepgramKey: "sk-real" }, { mintToken });
    const ws = await attachAndOpen(transport);

    expect(mintToken).toHaveBeenCalledWith("sk-real");
    expect(ws.protocols).toEqual(["token", "minted:sk-real"]);
  });

  it("the connection URL carries mip_opt_out=true and no keyterm param by default (no live caller passes keyterms yet)", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    const params = new URL(ws.url).searchParams;
    expect(params.get("mip_opt_out")).toBe("true");
    expect(params.getAll("keyterm")).toEqual([]);
  });

  it("threads keyterms/diarize opts through into the connection URL when explicitly provided", async () => {
    const transport = makeTransport({}, { keyterms: ["ARR", "pseudobulk"], diarize: true });
    const ws = await attachAndOpen(transport);

    const params = new URL(ws.url).searchParams;
    expect(params.getAll("keyterm")).toEqual(["ARR", "pseudobulk"]);
    expect(params.get("diarize_model")).toBe("latest");
  });

  // ---------------------------------------------------------------
  // PCM forwarding
  // ---------------------------------------------------------------

  it("never forwards a worklet PCM frame before the socket is OPEN", async () => {
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    await flushMicrotasks();
    const ws = wsInstances[wsInstances.length - 1];
    const worklet = workletNodes[workletNodes.length - 1];
    // Deliberately NOT opened yet — still CONNECTING.

    worklet.port.onmessage?.({ data: new ArrayBuffer(4) });
    expect(ws.sent).toEqual([]);
  });

  it("forwards worklet PCM frames once the socket is OPEN (no separate configSent gate needed — auth already happened at the handshake)", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);
    const worklet = workletNodes[workletNodes.length - 1];

    const chunk = new ArrayBuffer(4);
    worklet.port.onmessage?.({ data: chunk });
    expect(ws.sent[ws.sent.length - 1]).toBe(chunk);
  });

  // ---------------------------------------------------------------
  // KeepAlive
  // ---------------------------------------------------------------

  it("sends a {\"type\":\"KeepAlive\"} TEXT frame every KEEPALIVE_INTERVAL_MS once listening, and stops once stopped", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(ws.sent).toEqual([JSON.stringify({ type: "KeepAlive" })]);

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(ws.sent).toEqual([
      JSON.stringify({ type: "KeepAlive" }),
      JSON.stringify({ type: "KeepAlive" }),
    ]);

    const stopP = transport.stop();
    ws.simulateMessage({ type: "Metadata" }); // harmless — stop()'s own drain-wait below still needs the ack/close
    ws.simulateServerClose();
    await stopP;

    ws.sent = [];
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 2);
    expect(ws.sent).toEqual([]);
  });

  // ---------------------------------------------------------------
  // stop() drain-ack wait
  // ---------------------------------------------------------------

  it("stop() stops feeding PCM, sends one {\"type\":\"CloseStream\"} TEXT frame, and waits for the ws to close before resolving", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);
    const worklet = workletNodes[workletNodes.length - 1];

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(ws.sent[ws.sent.length - 1]).toBe(JSON.stringify({ type: "CloseStream" }));
    expect(resolved).toBe(false);
    expect(ws.closeCalls).toBe(0);

    // PCM delivered mid-drain must never be forwarded.
    ws.sent = [];
    worklet.port.onmessage?.({ data: new ArrayBuffer(4) });
    expect(ws.sent).toEqual([]);

    ws.simulateServerClose(); // the server closes once it's done flushing
    await stopP;

    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(1);
  });

  it("stop() resolves via STOP_DRAIN_TIMEOUT_MS and closes anyway if Deepgram never closes the socket", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(STOP_DRAIN_TIMEOUT_MS);
    await stopP;

    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(1);
  });

  it("stop() closes immediately without waiting when the ws isn't OPEN yet", async () => {
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    await flushMicrotasks();
    const ws = wsInstances[wsInstances.length - 1];
    // Never opened (still CONNECTING) — no drain to wait on.

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(1);
    expect(ws.sent).toEqual([]); // never sent CloseStream to an un-OPEN socket
  });

  it("stop() landing while the api_key mint is still in flight (no socket constructed yet) tears down cleanly and never constructs a WebSocket at all", async () => {
    let resolveMint: ((key: string) => void) | undefined;
    const mintToken = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveMint = resolve;
        }),
    );
    const transport = makeTransport({}, { mintToken });
    await transport.attachStream(fakeMediaStream());
    await flushMicrotasks();
    expect(wsInstances.length).toBe(0); // mint never resolved — connect() is still awaiting it

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    // Nothing to close yet (no ws, only synchronous audio-node teardown
    // plus one `await ctx.close()` hop) — resolves promptly, well before
    // the mint below is ever released.
    await flushMicrotasks();
    expect(resolved).toBe(true);

    resolveMint?.("sk-late");
    await flushMicrotasks();
    await stopP;

    expect(wsInstances.length).toBe(0); // connect()'s own post-mint stopping check bails first
  });

  it("a late final (via speech_final) arriving during the drain wait still reaches onFinal", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    const stopP = transport.stop();
    await Promise.resolve();

    ws.simulateMessage(
      resultsMessage({ is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "trailing words" }] } }),
    );
    expect(onFinal).toHaveBeenCalledWith("trailing words", { speaker: undefined, startedAt: undefined });

    ws.simulateServerClose();
    await stopP;
  });

  it("a close during the drain wait force-flushes a trailing utterance that never crossed its own speech_final boundary", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    const stopP = transport.stop();
    await Promise.resolve();

    ws.simulateMessage(
      resultsMessage({ is_final: true, channel: { alternatives: [{ transcript: "cut off mid" }] } }),
    );
    expect(onFinal).not.toHaveBeenCalled();

    ws.simulateServerClose();
    await stopP;

    expect(onFinal).toHaveBeenCalledWith("cut off mid", { speaker: undefined, startedAt: undefined });
  });

  it("stop() resolving via STOP_DRAIN_TIMEOUT_MS also force-flushes a trailing utterance that never crossed its own speech_final boundary", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    const stopP = transport.stop();
    await vi.advanceTimersByTimeAsync(0);

    ws.simulateMessage(
      resultsMessage({ is_final: true, channel: { alternatives: [{ transcript: "cut off, server hung" }] } }),
    );
    expect(onFinal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STOP_DRAIN_TIMEOUT_MS);
    await stopP;

    expect(onFinal).toHaveBeenCalledWith("cut off, server hung", { speaker: undefined, startedAt: undefined });
  });

  // ---------------------------------------------------------------
  // normal Results-stream forwarding
  // ---------------------------------------------------------------

  it("forwards interim text and finals from ordinary Results messages, and never calls onSpeakerUpdate (diarization rides onFinal's own speaker field, not the realtime relabeling channel)", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    ws.simulateMessage(resultsMessage({ is_final: false, channel: { alternatives: [{ transcript: "Hel" }] } }));
    expect(onInterim).toHaveBeenLastCalledWith("Hel");

    ws.simulateMessage(
      resultsMessage({
        is_final: true,
        speech_final: true,
        channel: {
          alternatives: [
            { transcript: "Hello world", words: [word({ word: "Hello", speaker: 1 }), word({ word: "world", speaker: 1 })] },
          ],
        },
      }),
    );
    expect(onFinal).toHaveBeenCalledWith("Hello world", expect.objectContaining({ speaker: "1" }));
    expect(onSpeakerUpdate).not.toHaveBeenCalled();
  });

  it("ignores Metadata/SpeechStarted/UtteranceEnd/unknown message types entirely (never forwarded as interim, never treated as an error)", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    ws.simulateMessage({ type: "Metadata", request_id: "abc" });
    ws.simulateMessage({ type: "SpeechStarted" });
    ws.simulateMessage({ type: "UtteranceEnd" });
    ws.simulateMessage({ type: "SomethingFutureAndUnknown" });

    expect(onInterim).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
    expect(onStatus.mock.calls.filter((c) => c[0] === "error")).toEqual([]);
  });

  // ---------------------------------------------------------------
  // error path
  // ---------------------------------------------------------------

  it("an 'Error'-typed message triggers exactly one generic zh error, never echoing any other field off it", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    ws.simulateMessage({
      type: "Error",
      description: "should never be surfaced verbatim",
      message: "neither should this",
    });

    const errorCalls = onStatus.mock.calls.filter((c) => c[0] === "error");
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0][1]).toBe("无法连接 Deepgram 云端识别服务，请检查网络连接和 API Key 后重试");
    expect(errorCalls[0][1]).not.toContain("should never be surfaced");
  });

  it("an unexpected close outside of stop()/an Error message surfaces one generic error — this is ALSO how a bad API key surfaces, since a rejected WS handshake never fires onopen at all", async () => {
    const transport = makeTransport({ deepgramKey: "sk-should-never-leak" });
    await transport.attachStream(fakeMediaStream());
    await flushMicrotasks();
    const ws = wsInstances[wsInstances.length - 1];
    // Handshake rejected — onopen never fires, straight to onclose.
    ws.simulateServerClose();

    const errorCalls = onStatus.mock.calls.filter((c) => c[0] === "error");
    expect(errorCalls.length).toBe(1);
    const [, message] = errorCalls[0] as [string, string];
    expect(message).not.toContain("sk-should-never-leak");
  });

  it("a duplicate error surface is suppressed when the server closes right after its own Error message", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    ws.simulateMessage({ type: "Error" });
    ws.simulateServerClose();

    const errorCalls = onStatus.mock.calls.filter((c) => c[0] === "error");
    expect(errorCalls.length).toBe(1);
  });
});
