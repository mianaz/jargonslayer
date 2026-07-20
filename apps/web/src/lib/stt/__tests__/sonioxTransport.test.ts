// Soniox transport (v0.4 S4 chunk 5, blueprint decision E): config
// builder purity, the token->interim/final mapper, and the transport's
// stop-drain/error-frame wire sequencing against a mocked WebSocket +
// minimal AudioContext/AudioWorkletNode graph (reusing wsTransport.
// test.ts's own fakeWs.ts harness — same worklet, same bare-global
// convention sonioxTransport.ts/wsTransport.ts both rely on). Zero
// network — see sonioxTransport.ts's own header for the verified wire
// protocol this exercises.

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
  SonioxTokenMapper,
  SonioxTransport,
  buildSonioxConfig,
  type SonioxToken,
} from "../sonioxTransport";

// Mirrors sonioxTransport.ts's own (unexported) constant — kept in
// sync by the timeout-path test below (same convention as
// wsTransport.test.ts's own STOP_DRAIN_TIMEOUT_MS mirror).
const STOP_DRAIN_TIMEOUT_MS = 8000;

function token(overrides: Partial<SonioxToken>): SonioxToken {
  return { text: "", is_final: false, ...overrides };
}

// ---------------------------------------------------------------
// buildSonioxConfig — pure config builder
// ---------------------------------------------------------------

describe("buildSonioxConfig", () => {
  it("threads settings.sonioxKey through as api_key via the default identity mintToken", async () => {
    const config = await buildSonioxConfig({ ...DEFAULT_SETTINGS, sonioxKey: "sk-real-key" });
    expect(config.api_key).toBe("sk-real-key");
  });

  it("threads the api_key through an injected mintToken override instead", async () => {
    const mintToken = vi.fn(async (key: string) => `minted:${key}`);
    const config = await buildSonioxConfig(
      { ...DEFAULT_SETTINGS, sonioxKey: "sk-real-key" },
      { mintToken },
    );
    expect(mintToken).toHaveBeenCalledWith("sk-real-key");
    expect(config.api_key).toBe("minted:sk-real-key");
  });

  it("fixes model/audio_format/sample_rate/num_channels/enable_endpoint_detection", async () => {
    const config = await buildSonioxConfig(DEFAULT_SETTINGS);
    expect(config.model).toBe("stt-rt-v5");
    // MUST be "pcm_s16le", not "s16le" — soniox.com/docs/stt/rt/
    // real-time-transcription's raw-audio audio_format values are
    // pcm_s8/s16/s24/s32 with le/be suffixes; "s16le" (the blueprint's
    // own wrong anchor) gets every real session rejected at config (S4
    // review finding 1, re-verified 2026-07-12). Pinned as an exact
    // literal — not `.toContain`/a regex — so this can't silently
    // regress back to the wrong anchor.
    expect(config.audio_format).toBe("pcm_s16le");
    expect(config.sample_rate).toBe(16000);
    expect(config.num_channels).toBe(1);
    expect(config.enable_endpoint_detection).toBe(true);
  });

  it("derives language_hints from settings.language + zh, deduped", async () => {
    const en = await buildSonioxConfig({ ...DEFAULT_SETTINGS, language: "en-US" });
    expect(en.language_hints).toEqual(["en", "zh"]);

    const zh = await buildSonioxConfig({ ...DEFAULT_SETTINGS, language: "zh-CN" });
    expect(zh.language_hints).toEqual(["zh"]); // base is already "zh" — deduped, not ["zh","zh"]
  });

  it("never includes a diarization flag (deferred to a later chunk)", async () => {
    const config = await buildSonioxConfig(DEFAULT_SETTINGS);
    expect(config).not.toHaveProperty("enable_speaker_diarization");
  });

  // ---------------------------------------------------------------
  // v0.4.7 Lane B (glossary -> recognizer bias, D8/doc §3): context.
  // terms ONLY (no translation_terms/general/text yet).
  // ---------------------------------------------------------------

  it("omits context entirely when no lexicon is provided", async () => {
    const config = await buildSonioxConfig(DEFAULT_SETTINGS);
    expect(config).not.toHaveProperty("context");
  });

  it("omits context when the lexicon projects to nothing (empty terms)", async () => {
    const config = await buildSonioxConfig(DEFAULT_SETTINGS, { lexicon: { terms: [] } });
    expect(config).not.toHaveProperty("context");
  });

  it("a provided lexicon reaches context.terms, priority order preserved (a prefix, never reordered — unlike whisper's initial_prompt)", async () => {
    const config = await buildSonioxConfig(DEFAULT_SETTINGS, {
      lexicon: { terms: ["scRNA-seq", "UMAP"] },
    });
    expect(config.context).toEqual({ terms: ["scRNA-seq", "UMAP"] });
  });
});

// ---------------------------------------------------------------
// SonioxTokenMapper — pure, DOM-free token accumulation
// ---------------------------------------------------------------

describe("SonioxTokenMapper", () => {
  it("accumulates non-final tokens into the interim tail, replacing it wholesale each ingest()", () => {
    const mapper = new SonioxTokenMapper(0);
    const first = mapper.ingest([token({ text: "Hel", is_final: false })]);
    expect(first).toEqual({ interim: "Hel", finals: [] });

    const second = mapper.ingest([
      token({ text: "Hello", is_final: false }),
      token({ text: " wor", is_final: false }),
    ]);
    // Replaced wholesale, not appended onto the first batch's "Hel".
    expect(second).toEqual({ interim: "Hello wor", finals: [] });
  });

  it("clears the non-final SUFFIX to empty once a message carries no non-final tokens, but keeps showing the now-pending final text (S4 review finding 3)", () => {
    const mapper = new SonioxTokenMapper(0);
    mapper.ingest([token({ text: "Hel", is_final: false })]);
    const { interim } = mapper.ingest([token({ text: "Hello", is_final: true })]);
    // "Hello" finalized but hasn't crossed its own <end> yet — it must
    // stay visible in the interim rather than vanishing until <end>
    // arrives (doc'd mixed-batch behavior: finalized tokens arrive
    // BEFORE <end>).
    expect(interim).toBe("Hello");
  });

  it("interim is the pending (not-yet-<end>ed) final text PLUS the current non-final tail, in a single mixed ingest() batch", () => {
    const mapper = new SonioxTokenMapper(0);
    const { interim } = mapper.ingest([
      token({ text: "Hello", is_final: true }),
      token({ text: " wor", is_final: false }),
    ]);
    expect(interim).toBe("Hello wor");
  });

  it("keeps already-buffered (not-yet-<end>ed) final text visible in a LATER ingest()'s interim, not just the batch where it finalized", () => {
    const mapper = new SonioxTokenMapper(0);
    mapper.ingest([token({ text: "Hello", is_final: true })]);
    const { interim } = mapper.ingest([token({ text: " wor", is_final: false })]);
    expect(interim).toBe("Hello wor");
  });

  it("emits onFinal exactly once per utterance on the <end> boundary token, stripping <end> from the text", () => {
    const mapper = new SonioxTokenMapper(0);
    mapper.ingest([
      token({ text: "Hello", is_final: true }),
      token({ text: " world", is_final: true }),
    ]);
    const { finals } = mapper.ingest([token({ text: "<end>", is_final: true })]);
    expect(finals).toEqual([{ text: "Hello world", speaker: undefined, startedAt: undefined }]);
  });

  it("a bare/duplicate <end> with nothing buffered emits nothing (never an empty onFinal)", () => {
    const mapper = new SonioxTokenMapper(0);
    const { finals } = mapper.ingest([token({ text: "<end>", is_final: true })]);
    expect(finals).toEqual([]);
  });

  it("accumulates final tokens across multiple messages before the <end> arrives in a later one", () => {
    const mapper = new SonioxTokenMapper(0);
    mapper.ingest([token({ text: "One", is_final: true })]);
    mapper.ingest([token({ text: " two", is_final: true })]);
    const { finals } = mapper.ingest([
      token({ text: " three", is_final: true }),
      token({ text: "<end>", is_final: true }),
    ]);
    expect(finals).toEqual([{ text: "One two three", speaker: undefined, startedAt: undefined }]);
  });

  it("handles a single message interleaving a final utterance, its <end> boundary, and the next utterance's non-final tail", () => {
    const mapper = new SonioxTokenMapper(0);
    const { interim, finals } = mapper.ingest([
      token({ text: "Hello", is_final: true }),
      token({ text: "<end>", is_final: true }),
      token({ text: "Nex", is_final: false }),
    ]);
    expect(finals).toEqual([{ text: "Hello", speaker: undefined, startedAt: undefined }]);
    expect(interim).toBe("Nex");
  });

  it("carries the utterance's speaker best-effort (first token in the utterance that has one)", () => {
    const mapper = new SonioxTokenMapper(0);
    mapper.ingest([
      token({ text: "Hi", is_final: true }),
      token({ text: " there", is_final: true, speaker: "1" }),
      token({ text: "!", is_final: true, speaker: "2" }),
    ]);
    const { finals } = mapper.ingest([token({ text: "<end>", is_final: true })]);
    expect(finals[0].speaker).toBe("1");
  });

  it("never surfaces a speaker when no token in the utterance carried one", () => {
    const mapper = new SonioxTokenMapper(0);
    mapper.ingest([token({ text: "Hi", is_final: true })]);
    const { finals } = mapper.ingest([token({ text: "<end>", is_final: true })]);
    expect(finals[0].speaker).toBeUndefined();
  });

  it("maps startedAt = streamStartMs + the utterance's first defined start_ms", () => {
    const mapper = new SonioxTokenMapper(1_000_000);
    mapper.ingest([
      token({ text: "Hi", is_final: true, start_ms: 250, end_ms: 400 }),
      token({ text: " there", is_final: true, start_ms: 400, end_ms: 700 }),
    ]);
    const { finals } = mapper.ingest([token({ text: "<end>", is_final: true })]);
    expect(finals[0].startedAt).toBe(1_000_250);
  });

  it("leaves startedAt undefined when no token in the utterance carried a start_ms", () => {
    const mapper = new SonioxTokenMapper(1_000_000);
    mapper.ingest([token({ text: "Hi", is_final: true })]);
    const { finals } = mapper.ingest([token({ text: "<end>", is_final: true })]);
    expect(finals[0].startedAt).toBeUndefined();
  });

  it("flushPending() force-flushes a trailing utterance that never crossed an <end> boundary", () => {
    const mapper = new SonioxTokenMapper(1_000_000);
    mapper.ingest([token({ text: "trailing", is_final: true, start_ms: 50 })]);
    expect(mapper.flushPending()).toEqual({
      text: "trailing",
      speaker: undefined,
      startedAt: 1_000_050,
    });
  });

  it("flushPending() returns null when nothing is pending", () => {
    const mapper = new SonioxTokenMapper(0);
    expect(mapper.flushPending()).toBeNull();
    mapper.ingest([token({ text: "done", is_final: true })]);
    mapper.ingest([token({ text: "<end>", is_final: true })]);
    // Already flushed via <end> above — nothing left pending.
    expect(mapper.flushPending()).toBeNull();
  });
});

// ---------------------------------------------------------------
// SonioxTransport — wire sequencing against a mocked WebSocket
// ---------------------------------------------------------------

describe("SonioxTransport", () => {
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

  function makeTransport(overrides: Partial<Settings> = {}): SonioxTransport {
    return new SonioxTransport({
      events,
      settings: { ...DEFAULT_SETTINGS, sonioxKey: "sk-should-never-leak", ...overrides },
    });
  }

  /** Flushes the microtask chain sendConfig()'s `await buildSonioxConfig(...)`
   *  (itself awaiting the default identity mintToken's `Promise.
   *  resolve(key)`) needs to actually run — a gap wsTransport.ts's
   *  synchronous config-send never had. Plain microtask ticks, not a
   *  timer: works identically whether or not the test also has fake
   *  timers installed (vitest's fake timers never touch native Promise
   *  resolution, only setTimeout/Date). */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  async function attachAndOpen(transport: SonioxTransport): Promise<FakeWebSocket> {
    await transport.attachStream(fakeMediaStream());
    const ws = wsInstances[wsInstances.length - 1];
    ws.simulateOpen();
    await flushMicrotasks();
    return ws;
  }

  function sentConfig(ws: FakeWebSocket): Record<string, unknown> {
    return JSON.parse(ws.sent[0] as string) as Record<string, unknown>;
  }

  // ---------------------------------------------------------------
  // connect / config-first-then-PCM ordering
  // ---------------------------------------------------------------

  it("goes connecting -> listening and sends the config as the socket's first message", async () => {
    const transport = makeTransport({ sonioxKey: "sk-abc", language: "en-US" });
    const ws = await attachAndOpen(transport);

    expect(onStatus.mock.calls[0]).toEqual(["connecting"]);
    expect(onStatus.mock.calls[1]).toEqual(["listening"]);
    expect(ws.sent.length).toBe(1);
    const config = sentConfig(ws);
    expect(config).toMatchObject({
      api_key: "sk-abc",
      model: "stt-rt-v5",
      audio_format: "pcm_s16le", // see buildSonioxConfig's own test for the doc citation
      sample_rate: 16000,
      num_channels: 1,
      language_hints: ["en", "zh"],
      enable_endpoint_detection: true,
    });
  });

  it("never forwards a worklet PCM frame before the config message has actually been sent", async () => {
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    const ws = wsInstances[wsInstances.length - 1];
    const worklet = workletNodes[workletNodes.length - 1];
    ws.simulateOpen();
    // Deliberately NOT flushed yet — sendConfig()'s mint is still
    // in-flight at this exact synchronous point, so configSent is
    // still false even though the socket itself is already OPEN.
    worklet.port.onmessage?.({ data: new ArrayBuffer(4) });
    expect(ws.sent).toEqual([]);
  });

  it("forwards worklet PCM frames once the config has been sent", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);
    const worklet = workletNodes[workletNodes.length - 1];

    const chunk = new ArrayBuffer(4);
    worklet.port.onmessage?.({ data: chunk });
    expect(ws.sent[ws.sent.length - 1]).toBe(chunk);
  });

  // ---------------------------------------------------------------
  // stop() drain-ack wait
  // ---------------------------------------------------------------

  it("stop() stops feeding PCM, sends one empty TEXT frame, and waits for {finished:true} before closing", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);
    const worklet = workletNodes[workletNodes.length - 1];

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();

    // The empty frame was sent as the very next message after config.
    // S13.1 live-key finding: MUST be the empty STRING sentinel — the
    // live server does not recognize an empty BINARY frame as end-of-
    // audio (it 408s ~21s later instead of acking {finished:true});
    // see sonioxTransport.ts's own stop() comment for the verification
    // record. This assertion pins the exact frame TYPE, not just
    // emptiness, so a regression back to ArrayBuffer(0) goes red.
    const lastSent = ws.sent[ws.sent.length - 1];
    expect(lastSent).toBe("");
    expect(resolved).toBe(false);
    expect(ws.closeCalls).toBe(0);

    // PCM delivered mid-drain must never be forwarded.
    ws.sent = [];
    worklet.port.onmessage?.({ data: new ArrayBuffer(4) });
    expect(ws.sent).toEqual([]);

    ws.simulateMessage({ tokens: [], finished: true });
    await stopP;

    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(1);
  });

  it("stop() resolves via STOP_DRAIN_TIMEOUT_MS and closes anyway if Soniox never acks", async () => {
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

  it("stop() also resolves immediately if the ws closes on its own during the drain wait", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    ws.simulateServerClose(); // crashed mid-drain, no "finished" ever arrives
    await stopP;
    expect(resolved).toBe(true);
  });

  it("stop() closes immediately without waiting when the ws isn't OPEN", async () => {
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
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
    expect(ws.sent).toEqual([]); // never sent the empty-frame sentinel
  });

  it("stop() during the pre-config window (ws OPEN but config not yet sent) closes without sending anything and resolves (S4 review finding 4)", async () => {
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    const ws = wsInstances[wsInstances.length - 1];
    ws.simulateOpen();
    // Deliberately NOT flushed yet — sendConfig()'s mint is still
    // in-flight at this exact synchronous point (same gap the PCM-
    // forwarding test above exercises), so configSent is still false
    // even though the socket itself is already OPEN.

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(1);
    // The empty end-of-audio frame must never become this socket's
    // first-ever message — and since sendConfig() itself bails once
    // `stopping` is true, nothing else gets sent either.
    expect(ws.sent).toEqual([]);
    await stopP;
  });

  it("a late final (via a trailing <end>) arriving during the drain wait still reaches onFinal", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    const stopP = transport.stop();
    await Promise.resolve();

    ws.simulateMessage({
      tokens: [
        { text: "trailing words", is_final: true },
        { text: "<end>", is_final: true },
      ],
    });
    expect(onFinal).toHaveBeenCalledWith("trailing words", {
      speaker: undefined,
      startedAt: undefined,
    });

    ws.simulateMessage({ tokens: [], finished: true });
    await stopP;
  });

  it("on {finished:true}, force-flushes a trailing utterance that never crossed its own <end> boundary", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    const stopP = transport.stop();
    await Promise.resolve();

    // The last utterance got cut off mid-sentence — finalized tokens
    // arrived, but audio ended before any "<end>" token did.
    ws.simulateMessage({ tokens: [{ text: "cut off mid", is_final: true }] });
    expect(onFinal).not.toHaveBeenCalled();

    ws.simulateMessage({ tokens: [], finished: true });
    await stopP;

    expect(onFinal).toHaveBeenCalledWith("cut off mid", {
      speaker: undefined,
      startedAt: undefined,
    });
  });

  it("stop() resolving via STOP_DRAIN_TIMEOUT_MS also force-flushes a trailing utterance that never crossed its own <end> boundary", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    const stopP = transport.stop();
    await vi.advanceTimersByTimeAsync(0);

    ws.simulateMessage({ tokens: [{ text: "cut off, server hung", is_final: true }] });
    expect(onFinal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STOP_DRAIN_TIMEOUT_MS);
    await stopP;

    expect(onFinal).toHaveBeenCalledWith("cut off, server hung", {
      speaker: undefined,
      startedAt: undefined,
    });
  });

  it("a close during the drain wait (crash — {finished:true} never arrives) still force-flushes a trailing utterance that never crossed its own <end> boundary (S4 review finding 5)", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    const stopP = transport.stop();
    await Promise.resolve();

    // The last utterance got cut off mid-sentence — finalized tokens
    // arrived, but the connection crashes before any "<end>" (or
    // "finished") arrives.
    ws.simulateMessage({ tokens: [{ text: "cut off by a crash", is_final: true }] });
    expect(onFinal).not.toHaveBeenCalled();

    ws.simulateServerClose();
    await stopP;

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("cut off by a crash", {
      speaker: undefined,
      startedAt: undefined,
    });
  });

  it("a stray {finished:true} arriving after a close-during-drain flush does not re-deliver the same utterance", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    const stopP = transport.stop();
    await Promise.resolve();

    ws.simulateMessage({ tokens: [{ text: "cut off by a crash", is_final: true }] });
    ws.simulateServerClose(); // force-flushes "cut off by a crash" exactly once
    await stopP;

    // Nothing in this class unwires onmessage after close, so a late/
    // stray "finished" (never expected from a real closed socket, but
    // belt-and-suspenders) must not double-deliver the same utterance
    // — SonioxTokenMapper.flushPending() is one-shot, so this is a
    // no-op the second time.
    ws.simulateMessage({ tokens: [], finished: true });

    expect(onFinal).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------
  // normal token-stream forwarding
  // ---------------------------------------------------------------

  it("forwards interim text and finals from ordinary token messages, and never calls onSpeakerUpdate", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    ws.simulateMessage({ tokens: [{ text: "Hel", is_final: false }] });
    expect(onInterim).toHaveBeenLastCalledWith("Hel");

    ws.simulateMessage({
      tokens: [
        { text: "Hello", is_final: true },
        { text: " world", is_final: true, speaker: "1", start_ms: 120 },
        { text: "<end>", is_final: true },
      ],
    });
    expect(onFinal).toHaveBeenCalledWith(
      "Hello world",
      expect.objectContaining({ speaker: "1" }),
    );
    // Soniox diarization is field-only in v0.4 (blueprint decision E)
    // — onSpeakerUpdate must never be wired up.
    expect(onSpeakerUpdate).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // error-frame path
  // ---------------------------------------------------------------

  it("a 401 error frame maps to the fixed 'API Key 无效或无权限' bucket and never echoes error_message/error_type/request_id", async () => {
    const transport = makeTransport({ sonioxKey: "sk-should-never-leak" });
    const ws = await attachAndOpen(transport);

    ws.simulateMessage({
      tokens: [],
      error_code: 401,
      error_type: "unauthenticated",
      error_message: "invalid api key",
      request_id: "req_1",
    });

    const errorCalls = onStatus.mock.calls.filter((c) => c[0] === "error");
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0][1]).toBe("Soniox API Key 无效或无权限");
  });

  it("a 403 error frame maps to the same 'API Key 无效或无权限' bucket as 401", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    ws.simulateMessage({
      tokens: [],
      error_code: 403,
      error_type: "temp_api_key_session_expired",
    });

    const errorCalls = onStatus.mock.calls.filter((c) => c[0] === "error");
    expect(errorCalls[0][1]).toBe("Soniox API Key 无效或无权限");
  });

  it("a 429 error frame maps to the fixed '配额或速率限制' bucket", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    ws.simulateMessage({ tokens: [], error_code: 429, error_type: "limit_exceeded" });

    const errorCalls = onStatus.mock.calls.filter((c) => c[0] === "error");
    expect(errorCalls[0][1]).toBe("Soniox 配额或速率限制");
  });

  it("any other error_code falls into the generic bucket, surfacing only the numeric code", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    ws.simulateMessage({
      tokens: [],
      error_code: 500,
      error_type: "internal_error",
      error_message: "stack trace details nobody should see",
    });

    const errorCalls = onStatus.mock.calls.filter((c) => c[0] === "error");
    expect(errorCalls[0][1]).toBe("Soniox 服务错误（代码 500）");
  });

  it("never forwards error_message even when it echoes back the literal configured api_key", async () => {
    const transport = makeTransport({ sonioxKey: "sk-should-never-leak" });
    const ws = await attachAndOpen(transport);

    ws.simulateMessage({
      tokens: [],
      error_code: 400,
      error_type: "invalid_request",
      error_message: "malformed config: api_key sk-should-never-leak is not valid base64",
    });

    const errorCalls = onStatus.mock.calls.filter((c) => c[0] === "error");
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0][1]).not.toContain("sk-should-never-leak");
  });

  it("a duplicate error surface is suppressed when the server closes right after its own error frame", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    ws.simulateMessage({ tokens: [], error_code: 500, error_type: "internal_error" });
    ws.simulateServerClose();

    const errorCalls = onStatus.mock.calls.filter((c) => c[0] === "error");
    expect(errorCalls.length).toBe(1);
  });

  it("an unexpected close outside of stop()/an error frame surfaces one generic error", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    ws.simulateServerClose();

    const errorCalls = onStatus.mock.calls.filter((c) => c[0] === "error");
    expect(errorCalls.length).toBe(1);
    const [, message] = errorCalls[0] as [string, string];
    expect(message).not.toContain("sk-should-never-leak");
  });
});
