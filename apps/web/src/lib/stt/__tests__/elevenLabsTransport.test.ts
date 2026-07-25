// ElevenLabs Scribe realtime transport (v0.6 round 2): token mint,
// URL-builder purity, the base64 audio-chunk envelope, the error
// classification, and the transport's connect/session-start/stop-drain/
// error-frame wire sequencing against a mocked WebSocket + minimal
// AudioContext/AudioWorkletNode graph (reusing fakeWs.ts's own harness —
// same worklet, same bare-global convention sonioxTransport.ts/
// deepgramTransport.ts both rely on). Zero real network — fetch is
// mocked for every mint test. See elevenLabsTransport.ts's own header
// for the verified wire protocol this exercises.

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
import { clearDiag, getDiagEntries } from "../../diag/log";
import {
  ElevenLabsTransport,
  arrayBufferToBase64,
  buildAudioChunk,
  buildElevenLabsUrl,
  formatElevenLabsError,
  mintElevenLabsToken,
} from "../elevenLabsTransport";

// Mirrors elevenLabsTransport.ts's own (unexported) STOP_DRAIN_TIMEOUT_MS
// (name + value, deliberately NOT imported — same convention as
// sonioxTransport.test.ts/deepgramTransport.test.ts's own mirrors).
const STOP_DRAIN_TIMEOUT_MS = 8000;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  clearDiag();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------
// mintElevenLabsToken — client-side single-use-token mint
// ---------------------------------------------------------------

describe("mintElevenLabsToken", () => {
  it("POSTs the verified single-use-token endpoint with the key ONLY in the xi-api-key header, and resolves to json.token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ token: "sutkn_abc123" }, 200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(mintElevenLabsToken("sk-real")).resolves.toBe("sutkn_abc123");
    // The raw key must never appear as a query param or body — asserting
    // the exact URL string (a fixed constant, no interpolation possible)
    // plus headers-only key placement covers both at once.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
      expect.objectContaining({ method: "POST", headers: { "xi-api-key": "sk-real" } }),
    );
  });

  it("classifies a 401 as the bad-key zh message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "unauthorized" }, 401)));
    await expect(mintElevenLabsToken("sk-bad")).rejects.toThrow("ElevenLabs API Key 无效或无权限");
  });

  it("classifies a 403 as the bad-key zh message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "forbidden" }, 403)));
    await expect(mintElevenLabsToken("sk-bad")).rejects.toThrow("ElevenLabs API Key 无效或无权限");
  });

  it("classifies any other non-OK status as a generic mint-failure message, never echoing the response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "should never be surfaced" }, 500)));
    const err = await mintElevenLabsToken("sk-x").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("无法准备 ElevenLabs 连接（获取密钥失败）");
    expect((err as Error).message).not.toContain("should never be surfaced");
  });

  it("classifies a network failure (fetch itself rejects) as the generic connect-error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(mintElevenLabsToken("sk-x")).rejects.toThrow(
      "无法连接 ElevenLabs 云端识别服务，请检查网络连接和 API Key 后重试",
    );
  });

  it("classifies an unparseable JSON body on an OK response as a mint failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    await expect(mintElevenLabsToken("sk-x")).rejects.toThrow("无法准备 ElevenLabs 连接（获取密钥失败）");
  });

  it("classifies a missing/non-string token field on an OK response as a mint failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 200)));
    await expect(mintElevenLabsToken("sk-x")).rejects.toThrow("无法准备 ElevenLabs 连接（获取密钥失败）");
  });
});

// ---------------------------------------------------------------
// buildElevenLabsUrl — pure URL builder
// ---------------------------------------------------------------

describe("buildElevenLabsUrl", () => {
  function params(url: string): URLSearchParams {
    return new URL(url).searchParams;
  }

  it("uses the verified wss://api.elevenlabs.io/v1/speech-to-text/realtime endpoint", () => {
    const url = buildElevenLabsUrl(DEFAULT_SETTINGS, "tok");
    expect(url.startsWith("wss://api.elevenlabs.io/v1/speech-to-text/realtime?")).toBe(true);
  });

  it("fixes model_id/audio_format/commit_strategy/enable_logging and carries the minted token", () => {
    const p = params(buildElevenLabsUrl(DEFAULT_SETTINGS, "sutkn_xyz"));
    expect(p.get("model_id")).toBe("scribe_v2_realtime");
    expect(p.get("token")).toBe("sutkn_xyz");
    expect(p.get("audio_format")).toBe("pcm_16000");
    expect(p.get("commit_strategy")).toBe("manual");
    expect(p.get("enable_logging")).toBe("false");
  });

  it("derives language_code as the bare ISO 639-1 base of settings.language (BCP-47 region stripped)", () => {
    expect(params(buildElevenLabsUrl({ ...DEFAULT_SETTINGS, language: "en-US" }, "t")).get("language_code")).toBe(
      "en",
    );
    expect(params(buildElevenLabsUrl({ ...DEFAULT_SETTINGS, language: "zh-CN" }, "t")).get("language_code")).toBe(
      "zh",
    );
  });

  it("never includes a keyterms param when the lexicon is omitted or empty", () => {
    expect(params(buildElevenLabsUrl(DEFAULT_SETTINGS, "t")).getAll("keyterms")).toEqual([]);
    expect(params(buildElevenLabsUrl(DEFAULT_SETTINGS, "t", { lexicon: { terms: [] } })).getAll("keyterms")).toEqual(
      [],
    );
  });

  it("emits keyterms as a REPEATED query param (mirrors Deepgram's own keyterm= pattern) when a lexicon is provided", () => {
    const p = params(buildElevenLabsUrl(DEFAULT_SETTINGS, "t", { lexicon: { terms: ["scRNA-seq", "pseudobulk"] } }));
    expect(p.getAll("keyterms")).toEqual(["scRNA-seq", "pseudobulk"]);
  });

  it("caps keyterms through projectForElevenLabsKeyterms's own count cap (belt-and-suspenders — see lexicon.test.ts for the cap's own unit coverage)", () => {
    const terms = Array.from({ length: 150 }, (_, i) => `t${i}`);
    const p = params(buildElevenLabsUrl(DEFAULT_SETTINGS, "t", { lexicon: { terms } }));
    expect(p.getAll("keyterms").length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------
// arrayBufferToBase64 / buildAudioChunk — pure
// ---------------------------------------------------------------

describe("arrayBufferToBase64", () => {
  it("matches btoa's own encoding for a known small buffer", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(arrayBufferToBase64(bytes.buffer)).toBe(btoa("Hello"));
  });

  it("encodes an empty buffer to an empty string", () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe("");
  });

  it("round-trips a buffer larger than the internal chunking window (0x8000 bytes)", () => {
    const bytes = new Uint8Array(0x8000 + 10).fill(65); // 'A' repeated
    const encoded = arrayBufferToBase64(bytes.buffer);
    const decoded = atob(encoded);
    expect(decoded.length).toBe(bytes.length);
    expect(decoded[0]).toBe("A");
    expect(decoded[decoded.length - 1]).toBe("A");
  });
});

describe("buildAudioChunk", () => {
  it("builds the exact required InputAudioChunk shape (message_type/audio_base_64/commit/sample_rate)", () => {
    const chunk = buildAudioChunk(new Uint8Array([1, 2, 3]).buffer, false);
    expect(chunk).toEqual({
      message_type: "input_audio_chunk",
      audio_base_64: arrayBufferToBase64(new Uint8Array([1, 2, 3]).buffer),
      commit: false,
      sample_rate: 16000,
    });
  });

  it("threads commit:true through unchanged", () => {
    expect(buildAudioChunk(new ArrayBuffer(0), true).commit).toBe(true);
  });
});

// ---------------------------------------------------------------
// formatElevenLabsError — pure, never reads provider text
// ---------------------------------------------------------------

describe("formatElevenLabsError", () => {
  it("maps every documented error message_type to a distinct, non-empty zh string", () => {
    const types = [
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
    ];
    for (const type of types) {
      expect(formatElevenLabsError(type).length).toBeGreaterThan(0);
    }
  });

  it("auth_error maps to the same bad-key message mintElevenLabsToken's own 401/403 classification uses (one consistent story)", () => {
    expect(formatElevenLabsError("auth_error")).toBe("ElevenLabs API Key 无效或无权限");
  });

  it("falls back to a generic message for an unrecognized/future message_type", () => {
    expect(formatElevenLabsError("some_future_error_type").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------
// ElevenLabsTransport — wire sequencing against a mocked WebSocket
// ---------------------------------------------------------------

describe("ElevenLabsTransport", () => {
  let wsInstances: FakeWebSocket[];
  let workletNodes: FakeAudioWorkletNode[];
  let onInterim: ReturnType<typeof vi.fn>;
  let onFinal: ReturnType<typeof vi.fn>;
  let onStatus: ReturnType<typeof vi.fn>;
  let events: STTEvents;

  beforeEach(() => {
    ({ instances: wsInstances } = installFakeWebSocket());
    ({ workletNodes } = installFakeAudioGraph());
    onInterim = vi.fn();
    onFinal = vi.fn();
    onStatus = vi.fn();
    events = { onInterim, onFinal, onStatus } as unknown as STTEvents;
  });

  afterEach(() => {
    uninstallFakeWebSocket();
    uninstallFakeAudioGraph();
    vi.useRealTimers();
  });

  function makeTransport(
    overrides: Partial<Settings> = {},
    opts: { mintToken?: (key: string) => Promise<string> } = {},
  ): ElevenLabsTransport {
    return new ElevenLabsTransport({
      events,
      settings: { ...DEFAULT_SETTINGS, elevenLabsKey: "sk-should-never-leak", ...overrides },
      mintToken: opts.mintToken ?? (async (key: string) => `minted:${key}`),
    });
  }

  /** Flushes the microtask chain connect()'s `await this.mintToken(...)`
   *  needs to actually run BEFORE `new WebSocket(...)` executes — mirrors
   *  deepgramTransport.test.ts's own identical helper (auth here ALSO
   *  rides the connect URL, so the ws instance does not exist at all
   *  until this resolves). */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  async function attachAndOpenAndStartSession(transport: ElevenLabsTransport): Promise<FakeWebSocket> {
    await transport.attachStream(fakeMediaStream());
    await flushMicrotasks();
    const ws = wsInstances[wsInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage({ message_type: "session_started", session_id: "sess_1" });
    return ws;
  }

  // ---------------------------------------------------------------
  // connect / auth / session lifecycle
  // ---------------------------------------------------------------

  it("resolves the token through the injected mintToken BEFORE constructing the socket, and bakes it into the connect URL's own token= param", async () => {
    const mintToken = vi.fn(async (key: string) => `minted:${key}`);
    const transport = makeTransport({ elevenLabsKey: "sk-real" }, { mintToken });
    await transport.attachStream(fakeMediaStream());
    await flushMicrotasks();

    expect(mintToken).toHaveBeenCalledWith("sk-real");
    const ws = wsInstances[wsInstances.length - 1];
    expect(new URL(ws.url).searchParams.get("token")).toBe("minted:sk-real");
  });

  it("goes connecting -> (open, still not listening) -> listening only once session_started actually arrives", async () => {
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    await flushMicrotasks();
    const ws = wsInstances[wsInstances.length - 1];

    expect(onStatus.mock.calls[0]).toEqual(["connecting"]);
    ws.simulateOpen();
    expect(onStatus.mock.calls.some((c) => c[0] === "listening")).toBe(false);

    ws.simulateMessage({ message_type: "session_started", session_id: "sess_1" });
    expect(onStatus.mock.calls.some((c) => c[0] === "listening")).toBe(true);
  });

  it("stop() landing while the token mint is still in flight tears down cleanly and never constructs a WebSocket at all", async () => {
    let resolveMint: ((v: string) => void) | undefined;
    const mintToken = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveMint = resolve;
        }),
    );
    const transport = makeTransport({}, { mintToken });
    await transport.attachStream(fakeMediaStream());
    await flushMicrotasks();
    expect(wsInstances.length).toBe(0);

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await flushMicrotasks();
    expect(resolved).toBe(true);

    resolveMint?.("sk-late");
    await flushMicrotasks();
    await stopP;
    expect(wsInstances.length).toBe(0); // connect()'s own post-mint stopping check bails first
  });

  it("a mint failure surfaces its own classified message verbatim (never a generic fallback) and never constructs a socket", async () => {
    const transport = makeTransport({}, { mintToken: async () => {
      throw new Error("ElevenLabs API Key 无效或无权限");
    } });
    await transport.attachStream(fakeMediaStream());
    await flushMicrotasks();

    expect(wsInstances.length).toBe(0);
    expect(onStatus).toHaveBeenCalledWith("error", "ElevenLabs API Key 无效或无权限");
  });

  // ---------------------------------------------------------------
  // PCM forwarding — base64 JSON envelope, gated on session_started
  // ---------------------------------------------------------------

  it("never forwards a worklet PCM frame before session_started arrives, even once the socket is OPEN", async () => {
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    await flushMicrotasks();
    const ws = wsInstances[wsInstances.length - 1];
    const worklet = workletNodes[workletNodes.length - 1];
    ws.simulateOpen(); // open, but no session_started yet

    worklet.port.onmessage?.({ data: new Uint8Array([1, 2]).buffer });
    expect(ws.sent).toEqual([]);
  });

  it("forwards worklet PCM frames as a base64 JSON input_audio_chunk envelope once session_started has arrived", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);
    const worklet = workletNodes[workletNodes.length - 1];

    const raw = new Uint8Array([10, 20, 30]).buffer;
    worklet.port.onmessage?.({ data: raw });

    expect(ws.sent.length).toBe(1);
    expect(typeof ws.sent[0]).toBe("string"); // JSON text, never a raw ArrayBuffer (this wire has no binary-frame option)
    expect(JSON.parse(ws.sent[0] as string)).toEqual({
      message_type: "input_audio_chunk",
      audio_base_64: arrayBufferToBase64(raw),
      commit: false,
      sample_rate: 16000,
    });
  });

  // ---------------------------------------------------------------
  // normal partial/final stream forwarding
  // ---------------------------------------------------------------

  it("forwards partial_transcript verbatim (replace-wholesale, not accumulated) as onInterim", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);

    ws.simulateMessage({ message_type: "partial_transcript", text: "hello wor" });
    expect(onInterim).toHaveBeenLastCalledWith("hello wor");

    ws.simulateMessage({ message_type: "partial_transcript", text: "hello world" });
    expect(onInterim).toHaveBeenLastCalledWith("hello world");
  });

  it("promotes final_transcript to onFinal and clears the interim tail", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);

    ws.simulateMessage({ message_type: "partial_transcript", text: "hello wor" });
    ws.simulateMessage({ message_type: "final_transcript", text: "hello world" });

    expect(onFinal).toHaveBeenCalledWith("hello world", {});
    expect(onInterim).toHaveBeenLastCalledWith("");
  });

  it("also promotes final_transcript_with_timestamps (the same FINAL_MESSAGE_TYPES set) to onFinal", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);

    ws.simulateMessage({
      message_type: "final_transcript_with_timestamps",
      text: "hello world",
      language_code: "en",
      words: [],
    });
    expect(onFinal).toHaveBeenCalledWith("hello world", {});
  });

  it("never emits an empty onFinal for a final_transcript with no/empty text, but still clears the interim tail", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);

    ws.simulateMessage({ message_type: "partial_transcript", text: "..." });
    ws.simulateMessage({ message_type: "final_transcript", text: "" });

    expect(onFinal).not.toHaveBeenCalled();
    expect(onInterim).toHaveBeenLastCalledWith("");
  });

  it("committed_transcript is NEVER promoted to a second onFinal (drain-ack only — see this file's own header)", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);

    ws.simulateMessage({ message_type: "final_transcript", text: "hello world" });
    expect(onFinal).toHaveBeenCalledTimes(1);

    ws.simulateMessage({ message_type: "committed_transcript", text: "hello world" });
    expect(onFinal).toHaveBeenCalledTimes(1); // still just the one
  });

  // ---------------------------------------------------------------
  // error path
  // ---------------------------------------------------------------

  it("an in-band auth_error message surfaces the classified bad-key message, never the provider's own `error` text", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);

    ws.simulateMessage({ message_type: "auth_error", error: "should never be surfaced verbatim" });

    const errorCalls = onStatus.mock.calls.filter((c) => c[0] === "error");
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0][1]).toBe("ElevenLabs API Key 无效或无权限");
    expect(errorCalls[0][1]).not.toContain("should never be surfaced");
  });

  it("a rate_limited message surfaces its own classified message", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);

    ws.simulateMessage({ message_type: "rate_limited", error: "slow down" });
    expect(onStatus).toHaveBeenCalledWith("error", "ElevenLabs 请求过于频繁，请稍后重试");
  });

  it("an unexpected close outside of stop()/an error message surfaces one generic connect-error", async () => {
    const transport = makeTransport({ elevenLabsKey: "sk-should-never-leak" });
    const ws = await attachAndOpenAndStartSession(transport);

    ws.simulateServerClose();

    const errorCalls = onStatus.mock.calls.filter((c) => c[0] === "error");
    expect(errorCalls.length).toBe(1);
    const [, message] = errorCalls[0] as [string, string];
    expect(message).not.toContain("sk-should-never-leak");
  });

  it("a duplicate error surface is suppressed when the server closes right after its own error message", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);

    ws.simulateMessage({ message_type: "transcriber_error", error: "oops" });
    ws.simulateServerClose();

    const errorCalls = onStatus.mock.calls.filter((c) => c[0] === "error");
    expect(errorCalls.length).toBe(1);
  });

  it("ignores an unrecognized/future message_type entirely (never forwarded as interim, never treated as an error)", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);

    ws.simulateMessage({ message_type: "some_future_message_type", text: "??" });

    expect(onInterim).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
    expect(onStatus.mock.calls.filter((c) => c[0] === "error")).toEqual([]);
  });

  // ---------------------------------------------------------------
  // diagnostics — no key material or transcript text ever reaches diagLog
  // ---------------------------------------------------------------

  it("an error path logs to diagLog under the stt-elevenlabs tag, without the API key or any transcript text", async () => {
    const transport = makeTransport({ elevenLabsKey: "sk-should-never-leak" });
    const ws = await attachAndOpenAndStartSession(transport);

    ws.simulateMessage({ message_type: "partial_transcript", text: "secret meeting content" });
    ws.simulateMessage({ message_type: "auth_error", error: "sk-should-never-leak was rejected" });

    const entries = getDiagEntries().filter((e) => e.tag === "stt-elevenlabs");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const blob = `${entry.message} ${entry.detail ?? ""}`;
      expect(blob).not.toContain("sk-should-never-leak");
      expect(blob).not.toContain("secret meeting content");
    }
  });

  // ---------------------------------------------------------------
  // stop() drain-ack wait
  // ---------------------------------------------------------------

  it("stop() sends one final commit:true input_audio_chunk (empty payload) and waits for a committed_transcript ack before resolving", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);
    const worklet = workletNodes[workletNodes.length - 1];

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();

    const lastSent = JSON.parse(ws.sent[ws.sent.length - 1] as string);
    expect(lastSent).toEqual({
      message_type: "input_audio_chunk",
      audio_base_64: "",
      commit: true,
      sample_rate: 16000,
    });
    expect(resolved).toBe(false);
    expect(ws.closeCalls).toBe(0);

    // PCM delivered mid-drain must never be forwarded.
    ws.sent = [];
    worklet.port.onmessage?.({ data: new ArrayBuffer(4) });
    expect(ws.sent).toEqual([]);

    ws.simulateMessage({ message_type: "committed_transcript", text: "hello world" });
    await stopP;

    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(1);
  });

  it("stop() also resolves if the server closes the socket during the drain wait instead of acking", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();

    ws.simulateServerClose();
    await stopP;

    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(1);
  });

  it("stop() resolves via STOP_DRAIN_TIMEOUT_MS and closes anyway if ElevenLabs never acks or closes", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);

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

  it("stop() closes immediately without waiting when session_started never arrived (nothing to drain)", async () => {
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    await flushMicrotasks();
    const ws = wsInstances[wsInstances.length - 1];
    ws.simulateOpen(); // open, but never got session_started

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(1);
    expect(ws.sent).toEqual([]); // never sent a commit chunk to a session that never started
  });

  it("stop() is idempotent — a second call is a no-op", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);

    const stopP = transport.stop();
    await Promise.resolve();
    ws.simulateMessage({ message_type: "committed_transcript", text: "x" });
    await stopP;

    await transport.stop();
    expect(ws.closeCalls).toBe(1);
  });

  // ---------------------------------------------------------------
  // audio graph teardown
  // ---------------------------------------------------------------

  it("stop() disconnects the worklet/source/mute nodes and closes the AudioContext", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpenAndStartSession(transport);
    ws.simulateMessage({ message_type: "committed_transcript", text: "" }); // pre-empt the drain wait below

    const stopP = transport.stop();
    await Promise.resolve();
    ws.simulateServerClose();
    await stopP;

    expect(ws.closeCalls).toBe(1);
  });
});
