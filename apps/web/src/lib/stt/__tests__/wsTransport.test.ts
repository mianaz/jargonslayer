// STT protocol v2 — WsTransport's client side: stop() drain-ack wait,
// pauseFeed()/resumeFeed() soft pause, and feedPaused surviving a
// reconnect. Mocked WebSocket + minimal AudioContext/AudioWorkletNode
// graph (see fakeWs.ts — wsTransport.ts references these as BARE
// globals, unlike vad.ts's `window.AudioContext`, so the fakes install
// straight onto globalThis).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type STTEvents, type Settings } from "@jargonslayer/core/types";
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
