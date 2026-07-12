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
  type FakeAudioWorkletNode,
} from "./fakeWs";
import { WsTransport } from "../wsTransport";

// Mirrors wsTransport.ts's own (unexported) constants — kept in sync
// by the tests below that specifically exercise the boundary.
const STOP_DRAIN_TIMEOUT_MS = 8000;
const RECONNECT_DELAY_MS = 1000;

describe("WsTransport — protocol v2", () => {
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
    events = {
      onInterim,
      onFinal,
      onStatus,
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
    expect(onFinal).toHaveBeenCalledWith("trailing words", { sttSeg: 7 });

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
});
