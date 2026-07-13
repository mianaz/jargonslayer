// AppAudioEngine (S9.3, docs/design-explorations/s9-app-audio-tap-
// blueprint.md): WsTransport itself is NOT module-mocked here (unlike
// acquireCancellation.test.ts's TabAudioEngine coverage) — "bytes
// flow"/"drain" are exactly what this engine's own contract needs
// proving, so tests run the REAL WsTransport against a fake WebSocket
// (fakeWs.ts), same approach as wsTransport.test.ts itself.
// invoke/listen/Channel are faked via fakeTauri.ts (mirrors desktop/
// __tests__/provisionRunner.test.ts's own invoke/listen seam) with the
// whole tauriApi.ts module mocked out — appAudio.ts imports zero
// `@tauri-apps/*` itself, same "ONLY module" contract that file's own
// header documents.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type STTEvents } from "@jargonslayer/core/types";
import {
  FakeWebSocket,
  installFakeAudioGraph,
  installFakeWebSocket,
  uninstallFakeAudioGraph,
  uninstallFakeWebSocket,
  type FakeAudioContext,
  type FakeAudioWorkletNode,
} from "./fakeWs";
import { deferred } from "./fakeMedia";
import { makeFakeChannelFactory, makeFakeInvoke, makeFakeListen, type FakeInvokeCall } from "./fakeTauri";
import type { ChannelFactory, InvokeFn, ListenFn, PcmChannel } from "../../desktop/tauriApi";

// Mirrors appAudio.ts's own (unexported) STOP_ENDED_TIMEOUT_MS — kept
// in sync by the timeout-fallback test below, same convention as
// wsTransport.test.ts's own STOP_DRAIN_TIMEOUT_MS/RECONNECT_DELAY_MS
// mirrors.
const STOP_ENDED_TIMEOUT_MS = 4000;

// vi.mock is hoisted above these `let`s, but the factory below only
// ever READS them from inside closures invoked much later (once a test
// has assigned them) — same "reference, don't eagerly read" shape
// acquireCancellation.test.ts/soniox.test.ts's own `vi.mock("../
// wsTransport"/"../sonioxTransport", ...)` already rely on.
let currentInvoke!: InvokeFn;
let currentListen!: ListenFn;
let currentCreateChannel!: ChannelFactory;

vi.mock("../../desktop/tauriApi", () => ({
  getInvoke: () => Promise.resolve(currentInvoke),
  getListen: () => Promise.resolve(currentListen),
  getChannelFactory: () => Promise.resolve(currentCreateChannel),
}));

import { AppAudioEngine } from "../appAudio";
import { createEngine } from "../index";

function noopEvents(): STTEvents {
  return {
    onInterim: () => {},
    onFinal: () => {},
    onStatus: () => {},
    onNotice: () => {},
    onSpeakerUpdate: () => {},
    onDiarStatus: () => {},
  } as unknown as STTEvents;
}

/** Polls a microtask at a time until `check()` is true — robust
 *  against exactly how many internal awaits (getInvoke/getListen/
 *  getChannelFactory/invoke's own async wrapper/listen's own async
 *  wrapper) sit between a call and a given OBSERVABLE milestone,
 *  instead of a brittle hardcoded `await Promise.resolve()` count.
 *  Throws if `check()` never becomes true within maxTicks, so a
 *  genuinely broken wiring fails loudly rather than hanging. */
async function flushUntil(check: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (check()) return;
    await Promise.resolve();
  }
  if (!check()) throw new Error("flushUntil: condition never became true");
}

/** Flushes a generous, fixed number of microtasks — used ONLY as a
 *  safety margin past an already-observed milestone (flushUntil above)
 *  to bridge an internal await with no public observable of its own
 *  (e.g. stop()'s invoke("stop_app_audio") resolving, right before it
 *  calls waitForEndedOrTimeout()). Safe to over-wait; every fake here
 *  is otherwise idle in between, so extra ticks change nothing. */
async function settle(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const SUPPORTED_CAPS = { appAudioSupported: true, reason: null as string | null };

/** Wires the default fakes (capabilities: supported; start/stop_app_audio:
 *  succeed) into the mocked tauriApi module, with per-command overrides
 *  for tests that need a specific command to fail/defer. */
function wireFakes(invokeOverrides: Record<string, (args?: Record<string, unknown>) => unknown> = {}): {
  calls: FakeInvokeCall[];
  emit: (event: string, payload: unknown) => void;
  activeCount: (event: string) => number;
  channels: PcmChannel[];
} {
  const { invoke, calls } = makeFakeInvoke({
    audiocap_capabilities: () => SUPPORTED_CAPS,
    start_app_audio: () => undefined,
    stop_app_audio: () => undefined,
    ...invokeOverrides,
  });
  currentInvoke = invoke;
  const { listen, emit, activeCount } = makeFakeListen();
  currentListen = listen;
  const { createChannel, channels } = makeFakeChannelFactory();
  currentCreateChannel = createChannel;
  return { calls, emit, activeCount, channels };
}

/** Drives an engine through start() -> "capturing" -> an OPEN ws, the
 *  shared setup every stop()/pause()/post-stop test below needs. */
async function startAndCapture(
  engine: AppAudioEngine,
  events: STTEvents,
  emit: (event: string, payload: unknown) => void,
  wsInstances: FakeWebSocket[],
): Promise<FakeWebSocket> {
  await engine.start(events, { ...DEFAULT_SETTINGS, engine: "appaudio" });
  emit("audiocap://status", { kind: "capturing", message: "" });
  const ws = wsInstances[wsInstances.length - 1];
  ws.simulateOpen();
  return ws;
}

/** Drives a full stop() to completion via the real "ended" status
 *  (not the timeout fallback) — used by tests whose focus is elsewhere
 *  (idempotency, post-stop drop) and just need stop() to actually
 *  settle without waiting out STOP_ENDED_TIMEOUT_MS for real. */
async function stopViaEnded(
  engine: AppAudioEngine,
  emit: (event: string, payload: unknown) => void,
  ws: FakeWebSocket,
): Promise<void> {
  const stopP = engine.stop();
  await settle(); // let invoke("stop_app_audio") resolve and reach waitForEndedOrTimeout()
  emit("audiocap://status", { kind: "ended", message: "" });
  await flushUntil(() => ws.sent.some((m) => typeof m === "string" && JSON.parse(m).type === "stop"));
  ws.simulateMessage({ type: "stopped" });
  await stopP;
}

describe("AppAudioEngine", () => {
  let wsInstances: FakeWebSocket[];
  let contexts: FakeAudioContext[];
  let workletNodes: FakeAudioWorkletNode[];

  beforeEach(() => {
    ({ instances: wsInstances } = installFakeWebSocket());
    ({ contexts, workletNodes } = installFakeAudioGraph());
  });

  afterEach(() => {
    uninstallFakeWebSocket();
    uninstallFakeAudioGraph();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports kind: appaudio", () => {
    expect(new AppAudioEngine().kind).toBe("appaudio");
  });

  it("createEngine('appaudio') builds an AppAudioEngine (factory wiring)", () => {
    expect(createEngine("appaudio")).toBeInstanceOf(AppAudioEngine);
  });

  it("pause()/resume() are no-ops before start() ever attaches a transport", async () => {
    const engine = new AppAudioEngine();
    await expect(engine.pause()).resolves.toBeUndefined();
    await expect(engine.resume()).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------
  // start() — capabilities gating
  // ---------------------------------------------------------------

  describe("start() — capabilities gating", () => {
    it("unsupported: onStatus(error, reason) and never registers a status listener or requests a capture", async () => {
      const { calls, activeCount } = wireFakes({
        audiocap_capabilities: () => ({
          appAudioSupported: false,
          reason: "需要 macOS 14.4 或更高版本",
        }),
      });
      const engine = new AppAudioEngine();
      const onStatus = vi.fn();
      const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

      await engine.start(events, { ...DEFAULT_SETTINGS, engine: "appaudio" });

      expect(onStatus).toHaveBeenCalledWith("error", "需要 macOS 14.4 或更高版本");
      expect(calls.some((c) => c.cmd === "start_app_audio")).toBe(false);
      expect(activeCount("audiocap://status")).toBe(0);
    });

    it("unsupported with no reason falls back to a generic zh message naming the 14.4 floor", async () => {
      wireFakes({
        audiocap_capabilities: () => ({ appAudioSupported: false, reason: null }),
      });
      const engine = new AppAudioEngine();
      const onStatus = vi.fn();
      const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

      await engine.start(events, { ...DEFAULT_SETTINGS, engine: "appaudio" });

      expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining("14.4"));
    });

    it("a capabilities() invoke() rejection surfaces a zh error and never requests a capture", async () => {
      const { calls } = wireFakes({
        audiocap_capabilities: () => {
          throw new Error("ipc failure");
        },
      });
      const engine = new AppAudioEngine();
      const onStatus = vi.fn();
      const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

      await engine.start(events, { ...DEFAULT_SETTINGS, engine: "appaudio" });

      expect(onStatus).toHaveBeenCalledWith("error", expect.any(String));
      expect(calls.some((c) => c.cmd === "start_app_audio")).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // full happy path
  // ---------------------------------------------------------------

  it("full happy path: capabilities -> capturing -> bytes flow -> stop -> ended -> drain", async () => {
    const { calls, emit, channels } = wireFakes();
    const engine = new AppAudioEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

    await engine.start(events, { ...DEFAULT_SETTINGS, engine: "appaudio" });
    expect(calls.some((c) => c.cmd === "start_app_audio")).toBe(true);

    // attachPcmFeed() hasn't run yet (no "capturing" so far) — no audio
    // graph and no ws yet either way.
    expect(contexts.length).toBe(0);
    expect(workletNodes.length).toBe(0);
    expect(wsInstances.length).toBe(0);

    // "capturing" -> attachPcmFeed() -> ws connects (still no audio graph).
    emit("audiocap://status", { kind: "capturing", message: "" });
    expect(contexts.length).toBe(0);
    expect(workletNodes.length).toBe(0);
    const ws = wsInstances[wsInstances.length - 1];
    expect(ws).toBeTruthy();
    ws.simulateOpen();

    // bytes flow: a Channel message pushes PCM straight to the ws,
    // untouched (arrival-shape pin — same reference, never copied).
    ws.sent = [];
    const chunk = new ArrayBuffer(16);
    channels[channels.length - 1].onmessage(chunk);
    expect(ws.sent).toEqual([chunk]);
    expect(ws.sent[0]).toBe(chunk);

    // stop -> ended -> drain.
    let resolved = false;
    const stopP = engine.stop().then(() => {
      resolved = true;
    });
    await flushUntil(() => calls.some((c) => c.cmd === "stop_app_audio"));
    expect(resolved).toBe(false);
    await settle(); // let invoke("stop_app_audio") resolve, reaching waitForEndedOrTimeout()

    emit("audiocap://status", { kind: "ended", message: "" });
    await flushUntil(() => ws.sent.some((m) => typeof m === "string" && JSON.parse(m).type === "stop"));
    expect(resolved).toBe(false); // still draining the ws — stopped ack not sent yet

    ws.simulateMessage({ type: "stopped" });
    await stopP;

    expect(resolved).toBe(true);
    expect(ws.closeCalls).toBe(1);
  });

  // ---------------------------------------------------------------
  // status mapping
  // ---------------------------------------------------------------

  describe("audiocap://status mapping", () => {
    it("permission-denied maps to onStatus(error, zh guidance mentioning 系统设置/隐私与安全性/屏幕与系统音频录制)", async () => {
      const { emit } = wireFakes();
      const engine = new AppAudioEngine();
      const onStatus = vi.fn();
      const events = { ...noopEvents(), onStatus } as unknown as STTEvents;
      await engine.start(events, { ...DEFAULT_SETTINGS, engine: "appaudio" });

      emit("audiocap://status", { kind: "permission-denied", message: "" });

      expect(onStatus).toHaveBeenCalledWith(
        "error",
        expect.stringMatching(/系统设置.*隐私与安全性.*屏幕与系统音频录制/),
      );
    });

    it.each(["device-changed", "crashed"] as const)("%s maps to onStatus(error, zh)", async (kind) => {
      const { emit } = wireFakes();
      const engine = new AppAudioEngine();
      const onStatus = vi.fn();
      const events = { ...noopEvents(), onStatus } as unknown as STTEvents;
      await engine.start(events, { ...DEFAULT_SETTINGS, engine: "appaudio" });

      emit("audiocap://status", { kind, message: "" });

      expect(onStatus).toHaveBeenCalledWith("error", expect.any(String));
    });

    it("exclude-pid-inactive is ignored (informational only, never an error)", async () => {
      const { emit } = wireFakes();
      const engine = new AppAudioEngine();
      const onStatus = vi.fn();
      const events = { ...noopEvents(), onStatus } as unknown as STTEvents;
      await engine.start(events, { ...DEFAULT_SETTINGS, engine: "appaudio" });

      emit("audiocap://status", {
        kind: "exclude-pid-inactive",
        message: "self-exclusion skipped: HAL-absent pid",
      });

      expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());
    });

    it("an unexpected ended (no stop() called) surfaces onStatus(idle, capture_ended) like tabAudio's track-ended handler", async () => {
      const { emit } = wireFakes();
      const engine = new AppAudioEngine();
      const onStatus = vi.fn();
      const events = { ...noopEvents(), onStatus } as unknown as STTEvents;
      await engine.start(events, { ...DEFAULT_SETTINGS, engine: "appaudio" });

      emit("audiocap://status", { kind: "ended", message: "" });

      expect(onStatus).toHaveBeenCalledWith("idle", "capture_ended");
    });
  });

  // ---------------------------------------------------------------
  // stop() landing while start() is still in flight (post-acquire
  // re-check, mirrors tabAudio.ts's own guard)
  // ---------------------------------------------------------------

  it("stop() landing while start_app_audio is still in flight tears down cleanly — a later capturing never attaches the feed", async () => {
    const startAppAudio = deferred<undefined>();
    const { calls, emit } = wireFakes({
      start_app_audio: () => startAppAudio.promise,
    });
    const engine = new AppAudioEngine();
    const events = noopEvents();

    const startP = engine.start(events, { ...DEFAULT_SETTINGS, engine: "appaudio" });
    // start_app_audio is now in flight, blocked on the deferred promise.
    await flushUntil(() => calls.some((c) => c.cmd === "start_app_audio"));

    vi.useFakeTimers();
    const stopP = engine.stop();
    await flushUntil(() => calls.some((c) => c.cmd === "stop_app_audio"));

    startAppAudio.resolve(undefined);
    await startP;

    // "capturing" arriving after stop() must never attach the feed.
    emit("audiocap://status", { kind: "capturing", message: "" });
    expect(wsInstances.length).toBe(0);

    // No listener was registered when stop()'s own wait started (it
    // WAS registered by the time stop_app_audio fired — see start()'s
    // sequencing — so "ended" would normally unblock it; here we just
    // prove the timeout path also converges cleanly).
    await vi.advanceTimersByTimeAsync(STOP_ENDED_TIMEOUT_MS);
    await stopP;

    // stop_app_audio idempotent per the wire contract — called at least
    // once (stop()'s own call; possibly a second time from start()'s
    // own post-acquire re-check, which is fine).
    expect(calls.filter((c) => c.cmd === "stop_app_audio").length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------
  // post-stop message/event drop (D5 generation guard)
  // ---------------------------------------------------------------

  it("drops a Channel message and a status event that arrive after stop() has already settled", async () => {
    const { emit, channels } = wireFakes();
    const engine = new AppAudioEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;
    const ws = await startAndCapture(engine, events, emit, wsInstances);

    await stopViaEnded(engine, emit, ws);

    onStatus.mockClear();
    ws.sent = [];

    channels[channels.length - 1].onmessage(new ArrayBuffer(8));
    expect(ws.sent).toEqual([]);

    emit("audiocap://status", { kind: "device-changed", message: "" });
    expect(onStatus).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // pause() / resume()
  // ---------------------------------------------------------------

  it("pause() gates PCM forwarding via transport.pauseFeed(); resume() restores it", async () => {
    const { emit, channels } = wireFakes();
    const engine = new AppAudioEngine();
    const events = noopEvents();
    const ws = await startAndCapture(engine, events, emit, wsInstances);

    await engine.pause();
    ws.sent = [];
    channels[channels.length - 1].onmessage(new ArrayBuffer(8));
    expect(ws.sent).toEqual([]);

    await engine.resume();
    const chunk = new ArrayBuffer(8);
    channels[channels.length - 1].onmessage(chunk);
    expect(ws.sent).toEqual([chunk]);
  });

  // ---------------------------------------------------------------
  // stop() safe to call twice
  // ---------------------------------------------------------------

  it("stop() is idempotent — a second call is a no-op", async () => {
    const { calls, emit } = wireFakes();
    const engine = new AppAudioEngine();
    const events = noopEvents();
    const ws = await startAndCapture(engine, events, emit, wsInstances);

    await stopViaEnded(engine, emit, ws);
    await engine.stop(); // reentrant — must be a clean no-op

    expect(calls.filter((c) => c.cmd === "stop_app_audio").length).toBe(1);
  });
});
