// STT protocol v2 — WsTransport's client side: stop() drain-ack wait,
// pauseFeed()/resumeFeed() soft pause, and feedPaused surviving a
// reconnect. Mocked WebSocket + minimal AudioContext/AudioWorkletNode
// graph (see fakeWs.ts — wsTransport.ts references these as BARE
// globals, unlike vad.ts's `window.AudioContext`, so the fakes install
// straight onto globalThis).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type STTEvents, type Settings } from "@jargonslayer/core/types";
import * as diagLogModule from "../../diag/log";
import {
  FakeWebSocket,
  fakeMediaStream,
  installFakeAudioGraph,
  installFakeWebSocket,
  uninstallFakeAudioGraph,
  uninstallFakeWebSocket,
  type FakeAudioContext,
  type FakeAudioWorkletNode,
} from "./fakeWs";
import { WsTransport } from "../wsTransport";
import { useLatencyStats } from "../latencyStats";

// Mirrors wsTransport.ts's own (unexported) constants — kept in sync
// by the tests below that specifically exercise the boundary.
const STOP_DRAIN_TIMEOUT_MS = 8000;
const RECONNECT_DELAY_MS = 1000;
const POST_STOP_LINGER_MS = 12000;
// Long-session hardening item 6 mirrors — see wsTransport.ts's own doc
// comments on MAX_RECONNECT_DELAY_MS/HEALTHY_CONNECTION_MS/
// FLAP_NOTICE_THRESHOLD.
const MAX_RECONNECT_DELAY_MS = 30_000;
// Fix round v0.7.7 (F3b): raised 10s -> 30s — see wsTransport.ts's own
// doc comment on HEALTHY_CONNECTION_MS.
const HEALTHY_CONNECTION_MS = 30_000;
const FLAP_NOTICE_THRESHOLD = 5;
// Fix round v0.7.7 (F3c) mirror — see wsTransport.ts's own doc comment
// on FLAP_RENOTICE_INTERVAL_MS.
const FLAP_RENOTICE_INTERVAL_MS = 5 * 60 * 1000;

describe("WsTransport — protocol v2", () => {
  let wsInstances: FakeWebSocket[];
  let workletNodes: FakeAudioWorkletNode[];
  let contexts: FakeAudioContext[];
  let onInterim: ReturnType<typeof vi.fn>;
  let onFinal: ReturnType<typeof vi.fn>;
  let onStatus: ReturnType<typeof vi.fn>;
  let onSpeakerUpdate: ReturnType<typeof vi.fn>;
  let events: STTEvents;

  beforeEach(() => {
    ({ instances: wsInstances } = installFakeWebSocket());
    ({ workletNodes, contexts } = installFakeAudioGraph());
    onInterim = vi.fn();
    onFinal = vi.fn();
    onStatus = vi.fn();
    onSpeakerUpdate = vi.fn();
    events = {
      onInterim,
      onFinal,
      onStatus,
      onSpeakerUpdate,
    } as unknown as STTEvents;
  });

  afterEach(() => {
    uninstallFakeWebSocket();
    uninstallFakeAudioGraph();
    vi.useRealTimers();
    // Item 6 tests spy on diagLogModule.diagLog — without this, an
    // un-restored spy's call history bleeds into the next test (same
    // convention as translate/__tests__/queue.test.ts's own afterEach).
    vi.restoreAllMocks();
  });

  function makeTransport(overrides: Partial<Settings> = {}): WsTransport {
    return new WsTransport({
      events,
      settings: { ...DEFAULT_SETTINGS, ...overrides },
      connectFailureMessage: (url) => `failed: ${url}`,
    });
  }

  async function attachAndOpen(transport: WsTransport): Promise<FakeWebSocket> {
    await transport.attachStream(fakeMediaStream());
    const ws = wsInstances[wsInstances.length - 1];
    ws.simulateOpen();
    return ws;
  }

  // ---------------------------------------------------------------
  // config gains partials
  // ---------------------------------------------------------------

  it("always sends settings.partials explicitly in the config message", async () => {
    const transport = makeTransport({ partials: false });
    const ws = await attachAndOpen(transport);
    const config = JSON.parse(ws.sent[0] as string);
    expect(config.partials).toBe(false);
  });

  // ---------------------------------------------------------------
  // v0.4.7 Lane B (glossary -> recognizer bias, D8): config gains
  // initial_prompt when a lexicon is provided — whisper/tabaudio/
  // appaudio all ride this SAME shared transport, so one test here
  // covers all three sidecar-backed engines.
  // ---------------------------------------------------------------

  it("omits initial_prompt from the config message when no lexicon is provided", async () => {
    const transport = new WsTransport({
      events,
      settings: { ...DEFAULT_SETTINGS },
      connectFailureMessage: (url) => `failed: ${url}`,
    });
    const ws = await attachAndOpen(transport);
    const config = JSON.parse(ws.sent[0] as string);
    expect(config).not.toHaveProperty("initial_prompt");
  });

  it("omits initial_prompt when the lexicon projects to nothing (empty terms)", async () => {
    const transport = new WsTransport({
      events,
      settings: { ...DEFAULT_SETTINGS },
      connectFailureMessage: (url) => `failed: ${url}`,
      lexicon: { terms: [] },
    });
    const ws = await attachAndOpen(transport);
    const config = JSON.parse(ws.sent[0] as string);
    expect(config).not.toHaveProperty("initial_prompt");
  });

  it("a provided lexicon reaches the config message as initial_prompt, highest-priority term LAST (D3 END-priority)", async () => {
    const transport = new WsTransport({
      events,
      settings: { ...DEFAULT_SETTINGS },
      connectFailureMessage: (url) => `failed: ${url}`,
      lexicon: { terms: ["scRNA-seq", "UMAP"] },
    });
    const ws = await attachAndOpen(transport);
    const config = JSON.parse(ws.sent[0] as string);
    // "scRNA-seq" is the higher-priority term (lexicon.terms[0]) — it
    // must land LAST so faster-whisper's own last-223-tokens
    // truncation keeps it (see lexicon.ts's projectForInitialPrompt).
    expect(config.initial_prompt).toBe("UMAP, scRNA-seq");
  });

  // ---------------------------------------------------------------
  // stop() drain-ack wait
  // ---------------------------------------------------------------

  it("stop() sends {type:stop} and waits for the stopped-ack before resolving/closing", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.parse(ws.sent[ws.sent.length - 1] as string)).toEqual({ type: "stop" });
    expect(resolved).toBe(false);
    expect(ws.closeCalls).toBe(0);

    ws.simulateMessage({ type: "stopped" });
    await stopP;

    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(1);
  });

  it("stop() resolves via STOP_DRAIN_TIMEOUT_MS if the sidecar never acks", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    const ws = wsInstances[wsInstances.length - 1];
    ws.simulateOpen();

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(STOP_DRAIN_TIMEOUT_MS);
    await stopP;

    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(1);
  });

  it("stop() also resolves immediately if the ws closes on its own during the wait", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    ws.simulateServerClose(); // crashed mid-drain, no "stopped" ever arrives
    await stopP;
    expect(resolved).toBe(true);
  });

  it("a drain final arriving during the stop() wait reaches onFinal via the normal path", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    const stopP = transport.stop();
    ws.simulateMessage({ type: "final", text: "trailing words", seg_id: 7 });
    // sttSeg is epoch-mapped (F2 fix) — this is the transport's first
    // (and only) connection, so epoch 1: 1_000_000 * 1 + 7.
    expect(onFinal).toHaveBeenCalledWith("trailing words", { sttSeg: 1_000_007 });

    ws.simulateMessage({ type: "stopped" });
    await stopP;
  });

  it("stop() closes immediately without waiting when the ws isn't OPEN", async () => {
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    const ws = wsInstances[wsInstances.length - 1];
    // Never opened (still CONNECTING) — today's behavior: no wait.

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(1);
    // Never sent {"type":"stop"} — the ws was never open enough to.
    expect(ws.sent.some((m) => typeof m === "string" && JSON.parse(m).type === "stop")).toBe(
      false,
    );
    await stopP;
  });

  // ---------------------------------------------------------------
  // post-stop diarization linger (realtimeDiarize on): after the
  // drain-ack, stop() resolves immediately (the audio graph is torn
  // down as usual) but the ws is kept open a bit longer so a trailing
  // speaker_update from the sidecar's own post-stop final diar pass
  // (whisper_server.py's _finalize_diar_then_close) still reaches
  // onSpeakerUpdate. See POST_STOP_LINGER_MS's own doc in wsTransport.ts.
  // ---------------------------------------------------------------

  it("realtimeDiarize on: stop() resolves right after the ack WITHOUT closing the ws, and a late speaker_update still reaches onSpeakerUpdate during the linger", async () => {
    const transport = makeTransport({ realtimeDiarize: true });
    const ws = await attachAndOpen(transport);

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    ws.simulateMessage({ type: "stopped" });
    await stopP;

    // stop() already resolved, and — unlike realtimeDiarize off — the
    // ws was NOT closed alongside it.
    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(0);

    // A trailing speaker_update arrives strictly AFTER stop() settled.
    ws.simulateMessage({
      type: "speaker_update",
      gen: 1,
      assignments: [{ seg_id: 3, speaker: "SPEAKER_1" }],
      speakers: ["SPEAKER_1"],
    });
    expect(onSpeakerUpdate).toHaveBeenCalledTimes(1);
    // connEpoch mapping (F2) still applies to a lingering update — this
    // is the transport's first (and only) connection, epoch 1.
    expect(onSpeakerUpdate).toHaveBeenCalledWith(
      [{ segId: 1_000_003, speaker: "SPEAKER_1" }],
      ["SPEAKER_1"],
    );
  });

  it("realtimeDiarize on: the linger ends when the server closes the ws (expected path) — handlers are nulled and no reconnect is attempted", async () => {
    const transport = makeTransport({ realtimeDiarize: true });
    const ws = await attachAndOpen(transport);

    const stopP = transport.stop();
    ws.simulateMessage({ type: "stopped" });
    await stopP;
    expect(ws.closeCalls).toBe(0);

    ws.simulateServerClose(); // the sidecar's own final pass finished, closes its side

    expect(ws.onmessage).toBeNull();
    expect(ws.onclose).toBeNull();
    // No new connection was opened — a post-linger close must never
    // trigger the reconnect path (stopping is set for the whole linger).
    expect(wsInstances.length).toBe(1);

    // A message somehow still delivered after the handler was nulled
    // (shouldn't happen once truly closed) is a genuine no-op, proving
    // the linger is really over, not just about to end.
    ws.simulateMessage({
      type: "speaker_update",
      gen: 1,
      assignments: [{ seg_id: 0, speaker: "SPEAKER_1" }],
      speakers: ["SPEAKER_1"],
    });
    expect(onSpeakerUpdate).not.toHaveBeenCalled();
  });

  it("realtimeDiarize on: the linger ends at POST_STOP_LINGER_MS if the sidecar never closes its side", async () => {
    vi.useFakeTimers();
    const transport = makeTransport({ realtimeDiarize: true });
    await transport.attachStream(fakeMediaStream());
    const ws = wsInstances[wsInstances.length - 1];
    ws.simulateOpen();

    const stopP = transport.stop();
    ws.simulateMessage({ type: "stopped" });
    await stopP;
    expect(ws.closeCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(POST_STOP_LINGER_MS - 1);
    expect(ws.closeCalls).toBe(0); // not yet

    await vi.advanceTimersByTimeAsync(1);
    expect(ws.closeCalls).toBe(1);
  });

  it("realtimeDiarize on: a reentrant stop() call ends an active linger immediately (transport reused/re-stopped)", async () => {
    const transport = makeTransport({ realtimeDiarize: true });
    const ws = await attachAndOpen(transport);

    const stopP = transport.stop();
    ws.simulateMessage({ type: "stopped" });
    await stopP;
    expect(ws.closeCalls).toBe(0);

    await transport.stop(); // reentrant — must end the linger right away
    expect(ws.closeCalls).toBe(1);
  });

  it("realtimeDiarize on: during the linger, every message except speaker_update is silently ignored", async () => {
    const transport = makeTransport({ realtimeDiarize: true });
    const ws = await attachAndOpen(transport);

    const stopP = transport.stop();
    ws.simulateMessage({ type: "stopped" });
    await stopP;

    ws.simulateMessage({ type: "final", text: "must not land during the linger", seg_id: 9 });
    ws.simulateMessage({ type: "partial", text: "must not land either" });
    expect(onFinal).not.toHaveBeenCalled();
    expect(onInterim).not.toHaveBeenCalled();

    // speaker_update is the one exception — still gets through.
    ws.simulateMessage({
      type: "speaker_update",
      gen: 1,
      assignments: [{ seg_id: 1, speaker: "SPEAKER_1" }],
      speakers: ["SPEAKER_1"],
    });
    expect(onSpeakerUpdate).toHaveBeenCalledTimes(1);
  });

  it("realtimeDiarize off: stop() closes the ws immediately after the ack — no linger", async () => {
    const transport = makeTransport({ realtimeDiarize: false });
    const ws = await attachAndOpen(transport);

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    ws.simulateMessage({ type: "stopped" });
    await stopP;

    expect(resolved).toBe(true);
    // Same as pre-linger behavior: closed right alongside resolving,
    // not kept open — this is the exact "no linger" contract.
    expect(ws.closeCalls).toBe(1);
  });

  // ---------------------------------------------------------------
  // pauseFeed / resumeFeed (soft pause)
  // ---------------------------------------------------------------

  it("pauseFeed() stops forwarding worklet PCM and sends a flush", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);
    const worklet = workletNodes[workletNodes.length - 1];

    ws.sent = []; // drop the initial config send for a clean assertion
    transport.pauseFeed();
    expect(ws.sent).toEqual([JSON.stringify({ type: "flush" })]);

    const chunk = new ArrayBuffer(4);
    worklet.port.onmessage?.({ data: chunk });
    // No new frame — PCM forwarding stayed gated.
    expect(ws.sent).toEqual([JSON.stringify({ type: "flush" })]);
  });

  it("resumeFeed() restores PCM forwarding", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);
    const worklet = workletNodes[workletNodes.length - 1];

    transport.pauseFeed();
    transport.resumeFeed();
    ws.sent = [];

    const chunk = new ArrayBuffer(4);
    worklet.port.onmessage?.({ data: chunk });
    expect(ws.sent).toEqual([chunk]);
  });

  it("stop() after pauseFeed() still drains normally — feedPaused never blocks the stop protocol", async () => {
    // End while soft-paused (useMeeting.ts's doStop) must still work:
    // pauseFeed() only gates the worklet's PCM forwarding, never the
    // ws/stop machinery itself.
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);
    transport.pauseFeed();
    ws.sent = []; // drop config + flush for a clean assertion

    let resolved = false;
    const stopP = transport.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.parse(ws.sent[ws.sent.length - 1] as string)).toEqual({ type: "stop" });
    expect(resolved).toBe(false);

    ws.simulateMessage({ type: "final", text: "tail after pause" });
    expect(onFinal).toHaveBeenCalledWith("tail after pause", { sttSeg: undefined });

    ws.simulateMessage({ type: "stopped" });
    await stopP;
    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(1);
  });

  it("stop() gates the worklet too — no PCM is sent for a frame delivered during the drain wait (F1)", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);
    const worklet = workletNodes[workletNodes.length - 1];

    const stopP = transport.stop();
    await Promise.resolve();
    ws.sent = []; // drop the {"type":"stop"} send for a clean assertion

    // A PCM chunk delivered while the drain wait is still in flight —
    // the worklet/audio graph isn't torn down until AFTER the wait, so
    // this can genuinely still happen.
    const chunk = new ArrayBuffer(4);
    worklet.port.onmessage?.({ data: chunk });
    expect(ws.sent).toEqual([]); // never forwarded

    ws.simulateMessage({ type: "stopped" });
    await stopP;
  });

  it("a reconnect while soft-paused does not resume sending audio (feedPaused survives connect())", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    const ws1 = wsInstances[0];
    ws1.simulateOpen();

    transport.pauseFeed();
    ws1.simulateServerClose(); // unexpected drop — not a user stop()

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    expect(wsInstances.length).toBe(2);
    const ws2 = wsInstances[1];
    ws2.simulateOpen();

    const worklet = workletNodes[workletNodes.length - 1];
    ws2.sent = [];
    const chunk = new ArrayBuffer(4);
    worklet.port.onmessage?.({ data: chunk });
    expect(ws2.sent).toEqual([]); // still paused across the reconnect

    transport.resumeFeed();
    worklet.port.onmessage?.({ data: chunk });
    expect(ws2.sent).toEqual([chunk]);
  });

  // ---------------------------------------------------------------
  // seg_id reconnect-epoch mapping (F2, codex v2 review)
  // ---------------------------------------------------------------

  it("a reconnect's raw seg_id 0 does not collide with a pre-reconnect segment's own mapped sttSeg", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    const ws1 = wsInstances[0];
    ws1.simulateOpen();

    ws1.simulateMessage({ type: "final", text: "before drop", seg_id: 0 });
    const firstMappedSeg = onFinal.mock.calls[0][1].sttSeg as number;

    ws1.simulateServerClose(); // transient drop — not a user stop()
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    expect(wsInstances.length).toBe(2);
    const ws2 = wsInstances[1];
    ws2.simulateOpen();

    // Fresh sidecar connection — its own seg_id namespace restarts at 0.
    ws2.simulateMessage({ type: "final", text: "after reconnect", seg_id: 0 });
    const secondMappedSeg = onFinal.mock.calls[1][1].sttSeg as number;

    expect(secondMappedSeg).not.toBe(firstMappedSeg);

    // Same collision risk on the speaker_update path store.ts actually
    // matches by (applySpeakerUpdateToSegments's bySegId.get(s.sttSeg)).
    ws2.simulateMessage({
      type: "speaker_update",
      gen: 1,
      assignments: [{ seg_id: 0, speaker: "SPEAKER_1" }],
      speakers: ["SPEAKER_1"],
    });
    const [updateAssignments] = onSpeakerUpdate.mock.calls[0];
    expect(updateAssignments[0].segId).toBe(secondMappedSeg);
    expect(updateAssignments[0].segId).not.toBe(firstMappedSeg);
  });

  // ---------------------------------------------------------------
  // FB6 (S12b fix round B, Sol6=Opus2, MED): parakeet-busy — the
  // parakeet backend's single-active-stream rejection
  // (whisper_server.py's ParakeetMlxServer.handle, try_acquire_stream()
  // failing). Pre-fix, this typed event had NO onmessage branch at all:
  // it fell through silently, and the server's own immediate close right
  // after sending it triggered the NORMAL reconnect path, which (after
  // RECONNECT_DELAY_MS, landing right back in the same rejection) only
  // THEN surfaced a generic "无法连接" a full cycle late.
  // ---------------------------------------------------------------

  it("parakeet-busy: surfaces the server's own detail verbatim via onStatus(error, detail)", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    const detail =
      "本机同一时间仅支持一个 Apple 芯片本地转录会话 / only one local Apple-Silicon transcription session is supported at a time on this machine";
    ws.simulateMessage({ type: "parakeet-busy", detail });

    // Verbatim — never re-worded/wrapped here (see onmessage's own doc
    // comment: the server's copy is shown exactly as sent).
    expect(onStatus).toHaveBeenCalledWith("error", detail);
  });

  it("parakeet-busy: marks the failure terminal — the server's own close (its protocol: message, THEN close) never triggers a reconnect, and never lands on a second, generic connectFailureMessage", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    const ws = wsInstances[0];
    ws.simulateOpen();

    ws.simulateMessage({ type: "parakeet-busy", detail: "busy" });
    ws.simulateServerClose(); // mirrors the server's own `await ws.close()` right after the message

    // Deliberately advance well past RECONNECT_DELAY_MS (and the
    // SECOND-attempt give-up path) — pre-fix, this would have opened a
    // second connection straight back into the exact same rejection.
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 2);
    expect(wsInstances.length).toBe(1);

    // Exactly one "error" status — the real parakeet-busy detail, never
    // a SECOND, generic "failed: <url>" connectFailureMessage from a
    // reconnect cycle that (pre-fix) would eventually give up on its own.
    const errorCalls = onStatus.mock.calls.filter((call) => call[0] === "error");
    expect(errorCalls).toEqual([["error", "busy"]]);
  });

  it("parakeet-busy arriving mid-session (not just on the initial connect) is equally terminal — no reconnect", async () => {
    // Mirrors the "reconnect while soft-paused" test's own shape above,
    // but proves the OPPOSITE outcome for this one event: a transport
    // that's already been streaming for a while can still receive
    // parakeet-busy (e.g. the OTHER client won the single-active-stream
    // race after this one had already connected) and must equally never
    // reconnect into it.
    vi.useFakeTimers();
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    const ws = wsInstances[0];
    ws.simulateOpen();

    ws.simulateMessage({ type: "final", text: "already streaming", seg_id: 0 });
    expect(onFinal).toHaveBeenCalledTimes(1);

    ws.simulateMessage({ type: "parakeet-busy", detail: "busy" });
    ws.simulateServerClose();

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 2);
    expect(wsInstances.length).toBe(1);
  });

  // ---------------------------------------------------------------
  // FB-follow-up (v0.4.4 release-prep sweep): parakeet-error — FB5's own
  // server-side typed terminal event (whisper_server.py's
  // ParakeetMlxConnectionHandler._terminate_on_model_error), sent once on
  // a CONTAINED model-call failure, then the server closes the socket
  // itself. Exactly parallel to parakeet-busy above; mirrors that same
  // three-test shape. Pre-fix, this event had no onmessage branch either:
  // it fell through, and the server's own close right after it triggered
  // the normal (pointless) reconnect path against a slot the server's own
  // finally had, by then, already freed.
  // ---------------------------------------------------------------

  it("parakeet-error: surfaces the server's own detail verbatim via onStatus(error, detail)", async () => {
    const transport = makeTransport();
    const ws = await attachAndOpen(transport);

    const detail =
      "本地转录出现内部错误，连接已关闭，请重新开始 / a local transcription error occurred; the connection has been closed — please start again";
    ws.simulateMessage({ type: "parakeet-error", detail });

    // Verbatim — never re-worded/wrapped here (see onmessage's own doc
    // comment: the server's copy is shown exactly as sent).
    expect(onStatus).toHaveBeenCalledWith("error", detail);
  });

  it("parakeet-error: marks the failure terminal — the server's own close (its protocol: message, THEN close) never triggers a reconnect, and never lands on a second, generic connectFailureMessage", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    const ws = wsInstances[0];
    ws.simulateOpen();

    ws.simulateMessage({ type: "parakeet-error", detail: "internal error" });
    ws.simulateServerClose(); // mirrors the server's own `await ws.close()` right after the message

    // Deliberately advance well past RECONNECT_DELAY_MS (and the
    // SECOND-attempt give-up path) — pre-fix, this would have opened a
    // second connection straight back against a now-freed slot.
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 2);
    expect(wsInstances.length).toBe(1);

    // Exactly one "error" status — the real parakeet-error detail, never
    // a SECOND, generic "failed: <url>" connectFailureMessage from a
    // reconnect cycle that (pre-fix) would eventually give up on its own.
    const errorCalls = onStatus.mock.calls.filter((call) => call[0] === "error");
    expect(errorCalls).toEqual([["error", "internal error"]]);
  });

  it("parakeet-error arriving mid-session (not just on the initial connect) is equally terminal — no reconnect", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    await transport.attachStream(fakeMediaStream());
    const ws = wsInstances[0];
    ws.simulateOpen();

    ws.simulateMessage({ type: "final", text: "already streaming", seg_id: 0 });
    expect(onFinal).toHaveBeenCalledTimes(1);

    ws.simulateMessage({ type: "parakeet-error", detail: "internal error" });
    ws.simulateServerClose();

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 2);
    expect(wsInstances.length).toBe(1);
  });

  // ---------------------------------------------------------------
  // attachPcmFeed() / pushPcm() — D5 seam (S9.3, docs/design-
  // explorations/s9-app-audio-tap-blueprint.md): appAudio.ts's
  // AppAudioEngine feeds already-downsampled PCM in from a Tauri
  // Channel instead of a browser AudioContext/worklet graph. pushPcm()
  // is the ONE guard path both feed sources go through — see
  // wsTransport.ts's own doc comment on each method.
  // ---------------------------------------------------------------

  describe("attachPcmFeed() / pushPcm()", () => {
    it("attachPcmFeed() calls connect() (same as attachStream()) and forwards pushPcm() chunks once the ws is OPEN", async () => {
      const transport = makeTransport();
      transport.attachPcmFeed();
      const ws = wsInstances[wsInstances.length - 1];
      expect(ws).toBeTruthy();
      ws.simulateOpen();
      ws.sent = []; // drop the initial config send for a clean assertion

      const chunk = new ArrayBuffer(8);
      transport.pushPcm(chunk);
      expect(ws.sent).toEqual([chunk]);
    });

    it("pushPcm() drops the chunk while feedPaused", async () => {
      const transport = makeTransport();
      transport.attachPcmFeed();
      const ws = wsInstances[wsInstances.length - 1];
      ws.simulateOpen();
      transport.pauseFeed();
      ws.sent = [];

      transport.pushPcm(new ArrayBuffer(8));
      expect(ws.sent).toEqual([]);
    });

    it("pushPcm() drops the chunk while stopping (drain wait in flight)", async () => {
      const transport = makeTransport();
      transport.attachPcmFeed();
      const ws = wsInstances[wsInstances.length - 1];
      ws.simulateOpen();

      const stopP = transport.stop();
      await Promise.resolve();
      ws.sent = []; // drop the {"type":"stop"} send for a clean assertion

      transport.pushPcm(new ArrayBuffer(8));
      expect(ws.sent).toEqual([]); // never forwarded

      ws.simulateMessage({ type: "stopped" });
      await stopP;
    });

    it("pushPcm() drops the chunk when there is no OPEN ws (e.g. still CONNECTING)", async () => {
      const transport = makeTransport();
      transport.attachPcmFeed();
      const ws = wsInstances[wsInstances.length - 1];
      // Never opened — still CONNECTING.

      transport.pushPcm(new ArrayBuffer(8));
      expect(ws.sent).toEqual([]);
    });

    it("the worklet's onmessage handler routes through pushPcm() — no duplicated guard logic", async () => {
      const transport = makeTransport();
      const ws = await attachAndOpen(transport);
      const worklet = workletNodes[workletNodes.length - 1];
      const pushPcmSpy = vi.spyOn(transport, "pushPcm");
      ws.sent = [];

      const chunk = new ArrayBuffer(4);
      worklet.port.onmessage?.({ data: chunk });

      expect(pushPcmSpy).toHaveBeenCalledTimes(1);
      expect(pushPcmSpy).toHaveBeenCalledWith(chunk);
      expect(ws.sent).toEqual([chunk]); // the real guard path still ran (forwarded)
    });

    it("attachPcmFeed() builds no AudioContext/AudioWorkletNode, and stop() still runs the full drain handshake against the null audio nodes", async () => {
      const transport = makeTransport();
      transport.attachPcmFeed();
      const ws = wsInstances[wsInstances.length - 1];
      ws.simulateOpen();

      expect(contexts.length).toBe(0);
      expect(workletNodes.length).toBe(0);

      let resolved = false;
      const stopP = transport.stop().then(() => {
        resolved = true;
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(JSON.parse(ws.sent[ws.sent.length - 1] as string)).toEqual({ type: "stop" });
      expect(resolved).toBe(false);

      ws.simulateMessage({ type: "stopped" });
      await stopP;

      expect(resolved).toBe(true);
      expect(ws.closeCalls).toBe(1);
      // Still no audio graph, even after a full stop() — attachPcmFeed()
      // truly never touches AudioContext/AudioWorkletNode.
      expect(contexts.length).toBe(0);
      expect(workletNodes.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // Long-session hardening item 6: reconnect backoff, dropped-frame
  // counter, and the flap notice — a 90-minute seminar shouldn't free-
  // run an unthrottled 1s reconnect loop against a flapping sidecar,
  // silently lose audio with no trail, or ever permanently strand a
  // session that could still recover.
  // ---------------------------------------------------------------

  describe("reconnect backoff (item 6)", () => {
    it("backs off exponentially (1s, 2s, 4s, 8s, 16s) then caps at 30s across repeated failures with no healthy connection in between", async () => {
      vi.useFakeTimers();
      const transport = makeTransport();
      await transport.attachStream(fakeMediaStream());
      let ws = wsInstances[wsInstances.length - 1];

      const delays = [1000, 2000, 4000, 8000, 16000, MAX_RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS];
      for (const delay of delays) {
        const before = wsInstances.length;
        ws.simulateServerClose(); // never opened — an immediate connection failure
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(wsInstances.length).toBe(before); // not yet — still waiting out this delay
        await vi.advanceTimersByTimeAsync(1);
        expect(wsInstances.length).toBe(before + 1); // fires right at the boundary
        ws = wsInstances[wsInstances.length - 1];
      }
    });

    it("stop() during an active reconnect backoff clears the pending timer — no reconnect fires afterward (F3a)", async () => {
      vi.useFakeTimers();
      const transport = makeTransport();
      await transport.attachStream(fakeMediaStream());
      const ws = wsInstances[wsInstances.length - 1];
      ws.simulateOpen();

      ws.simulateServerClose(); // drops mid-session, schedules a reconnect at the base delay
      expect(wsInstances.length).toBe(1);

      await transport.stop();

      // The scheduled reconnect must never fire — advancing well past
      // even the capped 30s backoff creates no new connection once
      // stop() has torn the transport down.
      await vi.advanceTimersByTimeAsync(MAX_RECONNECT_DELAY_MS);
      expect(wsInstances.length).toBe(1);
    });

    it("an accept-then-close sidecar (opens, then closes almost immediately) still backs off — onopen alone is not proof of recovery", async () => {
      vi.useFakeTimers();
      const transport = makeTransport();
      await transport.attachStream(fakeMediaStream());
      let ws = wsInstances[wsInstances.length - 1];

      // Cycle 1: opens, then closes well under HEALTHY_CONNECTION_MS —
      // this is the exact pre-fix bug shape.
      ws.simulateOpen();
      ws.simulateServerClose();
      await vi.advanceTimersByTimeAsync(1000); // first-ever failure: base delay
      expect(wsInstances.length).toBe(2);
      ws = wsInstances[1];

      // Cycle 2: same accept-then-close shape again.
      ws.simulateOpen();
      ws.simulateServerClose();

      // The pre-fix bug: reconnectAttempted reset in onopen meant this
      // ALSO reconnected at the flat base delay forever. Post-fix, this
      // must be the doubled 2s delay instead.
      await vi.advanceTimersByTimeAsync(1999);
      expect(wsInstances.length).toBe(2); // still not yet
      await vi.advanceTimersByTimeAsync(1);
      expect(wsInstances.length).toBe(3);
    });

    it("resets the backoff to the base delay once a connection survives the healthy window, not merely on onopen", async () => {
      vi.useFakeTimers();
      const transport = makeTransport();
      await transport.attachStream(fakeMediaStream());
      let ws = wsInstances[wsInstances.length - 1];

      // First failure, never opened — backs off to 2s for the next attempt.
      ws.simulateServerClose();
      await vi.advanceTimersByTimeAsync(1000);
      expect(wsInstances.length).toBe(2);
      ws = wsInstances[1];

      // This one opens and survives the full healthy window before dying.
      ws.simulateOpen();
      await vi.advanceTimersByTimeAsync(HEALTHY_CONNECTION_MS);
      ws.simulateServerClose();

      // Next reconnect must use the BASE delay again (1000ms), not the
      // 4000ms this streak would otherwise have climbed to.
      await vi.advanceTimersByTimeAsync(999);
      expect(wsInstances.length).toBe(2); // not yet
      await vi.advanceTimersByTimeAsync(1);
      expect(wsInstances.length).toBe(3);
    });

    it("pushPcm() drops while disconnected are counted and diagLog'd once per flap cycle, not per frame — and once more, separately, when a reconnect actually succeeds (F3d)", async () => {
      vi.useFakeTimers();
      const diagSpy = vi.spyOn(diagLogModule, "diagLog");
      const transport = makeTransport();
      transport.attachPcmFeed();
      const ws1 = wsInstances[wsInstances.length - 1];

      transport.pushPcm(new ArrayBuffer(8));
      transport.pushPcm(new ArrayBuffer(8));
      transport.pushPcm(new ArrayBuffer(8));
      ws1.simulateServerClose(); // logs synchronously, then schedules the retry

      expect(diagSpy).toHaveBeenCalledWith(
        "warn",
        "stt-ws-transport",
        expect.any(String),
        expect.stringContaining("droppedFrames=3"),
      );
      diagSpy.mockClear();

      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
      const ws2 = wsInstances[wsInstances.length - 1];
      expect(ws2).not.toBe(ws1);

      // Fix round v0.7.7 (F3d, adversarial review): frames dropped WHILE
      // ws2 is still connecting (not yet OPEN) belong to THIS outage —
      // flushed the moment the reconnect actually succeeds, not left to
      // bleed into whatever failure (if any, possibly much later) comes
      // next.
      transport.pushPcm(new ArrayBuffer(8));
      transport.pushPcm(new ArrayBuffer(8));
      ws2.simulateOpen();
      expect(diagSpy).toHaveBeenCalledWith(
        "warn",
        "stt-ws-transport",
        expect.any(String),
        expect.stringContaining("droppedFrames=2"),
      );
      diagSpy.mockClear();

      // A single drop during a THIRD, later outage is logged on its own
      // — the counter was already reset by the success-flush above, so
      // this must read 1, not 3 (the two frames from the SECOND outage
      // must never get re-attributed here).
      ws2.simulateServerClose();
      await vi.advanceTimersByTimeAsync(MAX_RECONNECT_DELAY_MS); // whatever the current backoff is, this covers it
      const ws3 = wsInstances[wsInstances.length - 1];
      expect(ws3).not.toBe(ws2);

      transport.pushPcm(new ArrayBuffer(8));
      ws3.simulateServerClose();
      expect(diagSpy).toHaveBeenCalledWith(
        "warn",
        "stt-ws-transport",
        expect.any(String),
        expect.stringContaining("droppedFrames=1"),
      );
    });

    it("a healthy connection with no drops never diagLogs a flap summary", async () => {
      vi.useFakeTimers();
      const diagSpy = vi.spyOn(diagLogModule, "diagLog");
      const transport = makeTransport();
      const ws = await attachAndOpen(transport);

      transport.pushPcm(new ArrayBuffer(8)); // forwarded, not dropped — ws is OPEN
      ws.simulateServerClose();

      expect(diagSpy).not.toHaveBeenCalledWith("warn", "stt-ws-transport", expect.any(String), expect.any(String));
    });

    it("after FLAP_NOTICE_THRESHOLD consecutive failed cycles, surfaces the connect-failure message via onNotice — never onStatus('error') — keeps retrying at the 30s cap afterward, and re-arms the notice every additional 5 minutes of continuous failure (F3c)", async () => {
      vi.useFakeTimers();
      const onNotice = vi.fn();
      events.onNotice = onNotice;
      const transport = makeTransport();
      await transport.attachStream(fakeMediaStream());
      let ws = wsInstances[wsInstances.length - 1];

      const delays = [1000, 2000, 4000, 8000, 16000];
      expect(delays.length).toBe(FLAP_NOTICE_THRESHOLD);
      for (const delay of delays) {
        ws.simulateServerClose();
        await vi.advanceTimersByTimeAsync(delay);
        ws = wsInstances[wsInstances.length - 1];
      }

      expect(onNotice).toHaveBeenCalledTimes(1);
      expect(onNotice).toHaveBeenCalledWith(`failed: ${DEFAULT_SETTINGS.whisperUrl}`);
      // Advisory only — never routed through the fatal onStatus("error")
      // path (that would end the whole meeting via useMeeting.ts's stop
      // flow, directly contradicting "keep retrying regardless").
      expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());

      // A 6th failure must not re-fire the notice — well under 5 minutes
      // since the first one...
      ws.simulateServerClose();
      await vi.advanceTimersByTimeAsync(MAX_RECONNECT_DELAY_MS); // capped by now
      expect(onNotice).toHaveBeenCalledTimes(1);
      // ...but it keeps retrying regardless — never strands the session.
      expect(wsInstances.length).toBe(7);

      // F3c: keep failing at the (now-capped 30s) backoff — once enough
      // CONTINUOUS failure has accumulated to cross another
      // FLAP_RENOTICE_INTERVAL_MS (5min) since the first notice, it
      // fires again. 10 more 30s cycles crosses that mark.
      for (let i = 0; i < 10; i++) {
        ws.simulateServerClose();
        await vi.advanceTimersByTimeAsync(MAX_RECONNECT_DELAY_MS);
        ws = wsInstances[wsInstances.length - 1];
      }
      expect(onNotice).toHaveBeenCalledTimes(2);
      expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());
    });
  });
});

// ---------------------------------------------------------------
// S10 field-fix #5: lag_ms passthrough — additive parse only, the ONE
// change this byte-sensitive file gets for the latency indicator (see
// wsTransport.ts's own doc comments on both message interfaces).
// Exercises the real latencyStats store (a tiny pure zustand store, not
// worth mocking) rather than spying on pushLagSample.
// ---------------------------------------------------------------

describe("WsTransport — lag_ms passthrough (S10 field-fix #5)", () => {
  let wsInstances: FakeWebSocket[];
  let events: STTEvents;

  beforeEach(() => {
    ({ instances: wsInstances } = installFakeWebSocket());
    installFakeAudioGraph();
    events = {
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onStatus: vi.fn(),
    } as unknown as STTEvents;
    useLatencyStats.setState({ lagMs: null });
  });

  afterEach(() => {
    uninstallFakeWebSocket();
    uninstallFakeAudioGraph();
    useLatencyStats.setState({ lagMs: null });
  });

  async function connectedWs(): Promise<FakeWebSocket> {
    const transport = new WsTransport({
      events,
      settings: DEFAULT_SETTINGS,
      connectFailureMessage: (url) => `failed: ${url}`,
    });
    await transport.attachStream(fakeMediaStream());
    const ws = wsInstances[wsInstances.length - 1];
    ws.simulateOpen();
    return ws;
  }

  it("a final message's lag_ms feeds latencyStats", async () => {
    const ws = await connectedWs();
    ws.simulateMessage({ type: "final", text: "hi", seg_id: 0, lag_ms: 2500 });
    expect(useLatencyStats.getState().lagMs).toBe(2500);
  });

  it("a partial message's lag_ms feeds latencyStats too", async () => {
    const ws = await connectedWs();
    ws.simulateMessage({ type: "partial", text: "hi", lag_ms: 1800 });
    expect(useLatencyStats.getState().lagMs).toBe(1800);
  });

  it("an absent lag_ms (older sidecar build) is silently ignored — no store write", async () => {
    const ws = await connectedWs();
    ws.simulateMessage({ type: "final", text: "hi", seg_id: 0 });
    expect(useLatencyStats.getState().lagMs).toBeNull();
  });

  it("a non-finite lag_ms is ignored rather than pushed as NaN", async () => {
    const ws = await connectedWs();
    ws.simulateMessage({ type: "final", text: "hi", seg_id: 0, lag_ms: Number.NaN });
    expect(useLatencyStats.getState().lagMs).toBeNull();
  });
});
