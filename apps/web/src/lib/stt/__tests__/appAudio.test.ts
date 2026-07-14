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
import type { ChannelFactory, InvokeFn, ListenFn, PcmChannel, UnlistenFn } from "../../desktop/tauriApi";
import { clearDiag, getDiagEntries } from "../../diag/log";

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

/** Wires the default fakes (capabilities: supported; start/stop_app_audio/
 *  pause_app_audio/resume_app_audio: succeed) into the mocked tauriApi
 *  module, with per-command overrides for tests that need a specific
 *  command to fail/defer. */
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
    // F4-js: pinned contract, Rust worker adds these as idempotent,
    // no-arg commands — see AppAudioEngine.pause()/resume()'s own doc.
    pause_app_audio: () => undefined,
    resume_app_audio: () => undefined,
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
    // Isolate each test's diag ring-buffer entries (S9 live-failure
    // investigation's own new stt-appaudio markers below) — additive/
    // no-op for every pre-existing test, which never reads the diag
    // buffer at all.
    clearDiag();
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
  // F3 (adversarial review, HIGH, both reviewers converged): a helper-
  // side TERMINAL status (permission-denied et al) that arrives BEFORE
  // stop() is ever called must not force stop() to burn its own full
  // STOP_ENDED_TIMEOUT_MS wait — the helper is already dead by then, so
  // no "ended" will ever arrive to resolve that wait early.
  // ---------------------------------------------------------------

  it("permission-denied arriving pre-stop lets stop() resolve immediately, without consuming the 4s wait", async () => {
    const { emit } = wireFakes();
    const engine = new AppAudioEngine();
    const events = noopEvents();
    await engine.start(events, { ...DEFAULT_SETTINGS, engine: "appaudio" });

    emit("audiocap://status", { kind: "permission-denied", message: "" });

    vi.useFakeTimers();
    let resolved = false;
    const stopP = engine.stop().then(() => {
      resolved = true;
    });
    // Only trivial microtask flushing below — deliberately NO
    // vi.advanceTimersByTimeAsync() call at all, so this fails loudly
    // (never resolves) on pre-fix code instead of passing by accident.
    await settle();

    expect(resolved).toBe(true);
    await stopP;
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

  // F2 (adversarial review, HIGH): stop() can land WHILE listen() itself
  // is still in flight — this.unlistenStatus is still null at that exact
  // moment, so the pre-fix code's post-acquire re-checks (both placed
  // AFTER an await had already returned) saw nothing to unregister and
  // returned; once listen() finally resolved, start() installed the
  // listener anyway, and nothing was left to ever unlisten it — a leaked
  // `audiocap://status` subscription.
  it("stop() landing WHILE listen() itself is still in flight leaves zero listeners — the just-installed listener is unregistered, not leaked", async () => {
    const listenGate = deferred<UnlistenFn>();
    const unlistenSpy = vi.fn();
    const { calls } = wireFakes();
    currentListen = (async () => {
      await listenGate.promise;
      return unlistenSpy;
    }) as ListenFn;

    const engine = new AppAudioEngine();
    const events = noopEvents();

    const startP = engine.start(events, { ...DEFAULT_SETTINGS, engine: "appaudio" });
    // Let capabilities resolve — start() is now stuck awaiting listen(),
    // which listenGate holds open.
    await flushUntil(() => calls.some((c) => c.cmd === "audiocap_capabilities"));
    await settle();

    // stop() runs to full completion while listen() is STILL pending —
    // nothing it can see yet includes the not-yet-installed listener.
    await engine.stop();

    // THEN listen() finally resolves and start() would (pre-fix) install
    // the listener — AFTER stop() already finished and will never call
    // it again.
    listenGate.resolve(unlistenSpy);
    await startP;

    expect(unlistenSpy).toHaveBeenCalledTimes(1);
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

  // F4-js (adversarial review, HIGH — pinned contract: pause_app_audio()/
  // resume_app_audio() are idempotent, no-arg Rust commands the worker
  // adds alongside this fix): pause must gate in Rust too, not only via
  // the JS-side transport.pauseFeed() belt-and-suspenders — ordering is
  // pinned as invoke() THEN the local gate.
  it("pause() invokes pause_app_audio BEFORE gating PCM locally via transport.pauseFeed() — ordering pinned", async () => {
    const pauseAppAudio = deferred<undefined>();
    const { emit, channels, calls } = wireFakes({
      pause_app_audio: () => pauseAppAudio.promise,
    });
    const engine = new AppAudioEngine();
    const events = noopEvents();
    const ws = await startAndCapture(engine, events, emit, wsInstances);

    const pauseP = engine.pause();
    await flushUntil(() => calls.some((c) => c.cmd === "pause_app_audio"));

    // Still awaiting the Rust-side invoke — the local gate must not have
    // engaged yet (fails loudly, not silently, if pause() never actually
    // calls pause_app_audio at all: flushUntil throws).
    ws.sent = [];
    const chunkDuringInvoke = new ArrayBuffer(8);
    channels[channels.length - 1].onmessage(chunkDuringInvoke);
    expect(ws.sent).toEqual([chunkDuringInvoke]);

    pauseAppAudio.resolve(undefined);
    await pauseP;

    // NOW gated, belt-and-suspenders.
    ws.sent = [];
    channels[channels.length - 1].onmessage(new ArrayBuffer(8));
    expect(ws.sent).toEqual([]);
  });

  it("resume() invokes resume_app_audio BEFORE restoring local PCM forwarding via transport.resumeFeed() — ordering pinned", async () => {
    const resumeAppAudio = deferred<undefined>();
    const { emit, channels, calls } = wireFakes({
      resume_app_audio: () => resumeAppAudio.promise,
    });
    const engine = new AppAudioEngine();
    const events = noopEvents();
    const ws = await startAndCapture(engine, events, emit, wsInstances);
    await engine.pause();

    const resumeP = engine.resume();
    await flushUntil(() => calls.some((c) => c.cmd === "resume_app_audio"));

    // Still awaiting the Rust-side invoke — still gated locally.
    ws.sent = [];
    channels[channels.length - 1].onmessage(new ArrayBuffer(8));
    expect(ws.sent).toEqual([]);

    resumeAppAudio.resolve(undefined);
    await resumeP;

    const chunk = new ArrayBuffer(8);
    channels[channels.length - 1].onmessage(chunk);
    expect(ws.sent).toEqual([chunk]);
  });

  it("a pause_app_audio invoke() rejection is logged-not-fatal — the JS-side gate (transport.pauseFeed()) still holds", async () => {
    const { emit, channels } = wireFakes({
      pause_app_audio: () => {
        throw new Error("ipc failure");
      },
    });
    const engine = new AppAudioEngine();
    const events = noopEvents();
    const ws = await startAndCapture(engine, events, emit, wsInstances);

    await expect(engine.pause()).resolves.toBeUndefined();

    ws.sent = [];
    channels[channels.length - 1].onmessage(new ArrayBuffer(8));
    expect(ws.sent).toEqual([]);
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

  // ---------------------------------------------------------------
  // S9 live-failure investigation: diag markers + defensive Channel
  // payload normalization. `channels[n].onmessage(...)` is typed
  // `(data: ArrayBuffer) => void` (PcmChannel's own declared shape) —
  // every non-ArrayBuffer value pushed through it below is deliberately
  // cast `as unknown as ArrayBuffer` at the CALL SITE only, simulating
  // exactly the "the real runtime shape doesn't match the declared
  // type" scenario this normalization exists to defend against.
  // ---------------------------------------------------------------

  describe("diag markers + Channel payload normalization", () => {
    function sttAppaudioEntries(): ReturnType<typeof getDiagEntries> {
      return getDiagEntries().filter((e) => e.tag === "stt-appaudio");
    }

    it("start() logs an 'engine start requested' marker synchronously", async () => {
      wireFakes();
      const engine = new AppAudioEngine();
      const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "appaudio" });

      // Logged before ANY await — observable even if start() never
      // resolves for some other reason.
      expect(sttAppaudioEntries().some((e) => e.message.includes("启动请求"))).toBe(true);
      await startP;
    });

    it("logs a marker for every audiocap://status kind received", async () => {
      const { emit } = wireFakes();
      const engine = new AppAudioEngine();
      await engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "appaudio" });

      emit("audiocap://status", { kind: "starting", message: "" });
      emit("audiocap://status", { kind: "capturing", message: "" });
      emit("audiocap://status", { kind: "permission-denied", message: "拒绝了" });

      const statusEntries = sttAppaudioEntries().filter((e) => e.message.includes("audiocap://status"));
      expect(statusEntries.map((e) => e.message)).toEqual([
        expect.stringContaining("starting"),
        expect.stringContaining("capturing"),
        expect.stringContaining("permission-denied"),
      ]);
      expect(statusEntries[2].detail).toBe("拒绝了");
    });

    it("the FIRST Channel message logs a runtime-shape marker ({ctor, byteLength, isArray}), exactly once per session", async () => {
      const { emit, channels } = wireFakes();
      const engine = new AppAudioEngine();
      await engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "appaudio" });
      emit("audiocap://status", { kind: "capturing", message: "" });

      const chunk = new ArrayBuffer(8);
      channels[channels.length - 1].onmessage(chunk);
      channels[channels.length - 1].onmessage(new ArrayBuffer(8)); // second message — must NOT log again

      const firstMsgEntries = sttAppaudioEntries().filter((e) => e.message.includes("首个 Channel 消息"));
      expect(firstMsgEntries).toHaveLength(1);
      const shape = JSON.parse(firstMsgEntries[0].detail ?? "{}");
      expect(shape).toEqual({ ctor: "ArrayBuffer", byteLength: 8, isArray: false });
    });

    it("a real ArrayBuffer is forwarded as-is (same reference, never copied)", async () => {
      const { emit, channels } = wireFakes();
      const engine = new AppAudioEngine();
      const ws = await startAndCapture(engine, noopEvents(), emit, wsInstances);

      const chunk = new ArrayBuffer(16);
      ws.sent = [];
      channels[channels.length - 1].onmessage(chunk);

      expect(ws.sent).toEqual([chunk]);
      expect(ws.sent[0]).toBe(chunk);
      expect(sttAppaudioEntries().some((e) => e.level === "warn" || e.level === "error")).toBe(false);
    });

    it("an ArrayBufferView (TypedArray) is forwarded as an EXACT-WINDOW copy of its buffer, not the whole backing buffer", async () => {
      const { emit, channels } = wireFakes();
      const engine = new AppAudioEngine();
      const ws = await startAndCapture(engine, noopEvents(), emit, wsInstances);

      // A 16-byte backing buffer; the view only spans bytes [4, 10) —
      // the surrounding bytes must never leak into what's forwarded.
      const backing = new ArrayBuffer(16);
      new Uint8Array(backing).set([9, 9, 9, 9, 1, 2, 3, 4, 5, 6, 9, 9, 9, 9, 9, 9]);
      const view = new Uint8Array(backing, 4, 6); // [1,2,3,4,5,6]

      ws.sent = [];
      channels[channels.length - 1].onmessage(view as unknown as ArrayBuffer);

      expect(ws.sent).toHaveLength(1);
      const forwarded = ws.sent[0] as ArrayBuffer;
      expect(forwarded).toBeInstanceOf(ArrayBuffer);
      expect(forwarded).not.toBe(backing); // a copy, never the original backing buffer
      expect(Array.from(new Uint8Array(forwarded))).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("a DataView is also normalized via its own exact byte window", async () => {
      const { emit, channels } = wireFakes();
      const engine = new AppAudioEngine();
      const ws = await startAndCapture(engine, noopEvents(), emit, wsInstances);

      const backing = new ArrayBuffer(8);
      new Uint8Array(backing).set([1, 2, 3, 4, 5, 6, 7, 8]);
      const view = new DataView(backing, 2, 4); // [3,4,5,6]

      ws.sent = [];
      channels[channels.length - 1].onmessage(view as unknown as ArrayBuffer);

      expect(ws.sent).toHaveLength(1);
      expect(Array.from(new Uint8Array(ws.sent[0] as ArrayBuffer))).toEqual([3, 4, 5, 6]);
    });

    it("a plain JS number array (the serde JSON-degraded fallback) is converted and forwarded, with a ONE-TIME warn diag marker", async () => {
      const { emit, channels } = wireFakes();
      const engine = new AppAudioEngine();
      const ws = await startAndCapture(engine, noopEvents(), emit, wsInstances);

      ws.sent = [];
      channels[channels.length - 1].onmessage([1, 2, 3] as unknown as ArrayBuffer);
      channels[channels.length - 1].onmessage([4, 5] as unknown as ArrayBuffer);

      expect(ws.sent).toHaveLength(2);
      expect(Array.from(new Uint8Array(ws.sent[0] as ArrayBuffer))).toEqual([1, 2, 3]);
      expect(Array.from(new Uint8Array(ws.sent[1] as ArrayBuffer))).toEqual([4, 5]);

      const warnEntries = sttAppaudioEntries().filter((e) => e.level === "warn" && e.message.includes("JSON 数组"));
      expect(warnEntries).toHaveLength(1); // logged once, not once per message
    });

    it("an unrecognized payload (never an ArrayBuffer/view/array) is dropped — never forwarded to the ws — with a ONE-TIME error diag marker", async () => {
      const { emit, channels } = wireFakes();
      const engine = new AppAudioEngine();
      const ws = await startAndCapture(engine, noopEvents(), emit, wsInstances);

      ws.sent = [];
      channels[channels.length - 1].onmessage({ not: "a buffer" } as unknown as ArrayBuffer);
      channels[channels.length - 1].onmessage("also not a buffer" as unknown as ArrayBuffer);

      expect(ws.sent).toEqual([]); // never ws.send() a non-buffer value

      const errorEntries = sttAppaudioEntries().filter((e) => e.level === "error");
      expect(errorEntries).toHaveLength(1); // logged once, not once per message
    });

    it("logs a cumulative Channel message count+bytes marker at stop()", async () => {
      const { emit, channels } = wireFakes();
      const engine = new AppAudioEngine();
      const ws = await startAndCapture(engine, noopEvents(), emit, wsInstances);

      channels[channels.length - 1].onmessage(new ArrayBuffer(10));
      channels[channels.length - 1].onmessage(new ArrayBuffer(6));

      await stopViaEnded(engine, emit, ws);

      const stopEntries = sttAppaudioEntries().filter((e) => e.message.includes("引擎停止"));
      expect(stopEntries).toHaveLength(1);
      expect(stopEntries[0].detail).toBe("channelMessages=2 channelBytes=16");
    });
  });
});
