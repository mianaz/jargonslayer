// ElevenLabsEngine (v0.6 round 2): the thin mic-acquisition shell around
// ElevenLabsTransport — mirrors deepgram.test.ts's own coverage of
// DeepgramEngine's identical shape, with ElevenLabsTransport
// module-mocked so "a transport was constructed at all" / "attachStream
// was called at all" are the observable signals, without dragging in
// the real WebSocket/AudioContext machinery elevenLabsTransport.test.ts
// already covers directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeMediaStream,
  installFakeMediaDevices,
  uninstallFakeMediaDevices,
} from "./fakeMedia";
import { clearDiag, getDiagEntries } from "../../diag/log";

const elevenLabsTransportCtor = vi.fn();
const attachStreamMock = vi.fn((..._args: unknown[]) => Promise.resolve());
const transportStopMock = vi.fn(() => Promise.resolve());
vi.mock("../elevenLabsTransport", () => ({
  ElevenLabsTransport: class {
    private events: { onStatus: (status: string) => void };
    constructor(...args: unknown[]) {
      elevenLabsTransportCtor(...args);
      this.events = (args[0] as { events: { onStatus: (status: string) => void } }).events;
    }
    async attachStream(...args: unknown[]) {
      const result = await attachStreamMock(...args);
      // S7 fix (v0.6 round-2 review): the real transport fires
      // onStatus("listening") once the server actually confirms the
      // session (session_started) — ElevenLabsEngine's own
      // streamStartedAt now hooks THAT, not attachStream()'s own
      // resolution, so this mock simulates it.
      this.events.onStatus("listening");
      return result;
    }
    stop() {
      return transportStopMock();
    }
  },
}));

const recordSttSecondsMock = vi.fn();
vi.mock("../usageTracking", () => ({
  recordSttSeconds: (...args: unknown[]) => recordSttSecondsMock(...args),
}));

import { ElevenLabsEngine } from "../elevenLabs";
import { DEFAULT_SETTINGS, type STTEvents } from "@jargonslayer/core/types";

function noopEvents(): STTEvents {
  return {
    onInterim: () => {},
    onFinal: () => {},
    onStatus: () => {},
  } as unknown as STTEvents;
}

beforeEach(() => {
  clearDiag();
});

afterEach(() => {
  uninstallFakeMediaDevices();
  elevenLabsTransportCtor.mockClear();
  attachStreamMock.mockClear();
  transportStopMock.mockClear();
  recordSttSecondsMock.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reports kind: elevenlabs", () => {
  expect(new ElevenLabsEngine().kind).toBe("elevenlabs");
});

describe("ElevenLabsEngine.start()", () => {
  it("acquires a mic stream, constructs an ElevenLabsTransport, and attaches the stream to it", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new ElevenLabsEngine();
    const events = noopEvents();
    const settings = { ...DEFAULT_SETTINGS, engine: "elevenlabs" as const, elevenLabsKey: "sk-key" };

    const startP = engine.start(events, settings);
    const stream = new FakeMediaStream();
    gumCalls[0].resolve(stream);
    await startP;

    expect(elevenLabsTransportCtor).toHaveBeenCalledTimes(1);
    // S7 fix (v0.6 round-2 review): events is wrapped now — onInterim/
    // onFinal forward through unchanged (same references), onStatus is
    // intercepted (a new closure) to stamp streamStartedAt on
    // "listening" before forwarding — see the dedicated usage-ledger
    // describe block below for that behavior itself.
    const ctorArgs = elevenLabsTransportCtor.mock.calls[0][0] as {
      events: STTEvents;
      settings: unknown;
      lexicon: unknown;
    };
    expect(ctorArgs.settings).toBe(settings);
    expect(ctorArgs.lexicon).toBeUndefined();
    expect(ctorArgs.events.onInterim).toBe(events.onInterim);
    expect(ctorArgs.events.onFinal).toBe(events.onFinal);
    expect(ctorArgs.events.onStatus).not.toBe(events.onStatus);
    expect(attachStreamMock).toHaveBeenCalledWith(stream);
  });

  it("logs a stt-elevenlabs '启动请求' diag marker, and never logs the key material even when the key is present in settings", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new ElevenLabsEngine();
    const settings = { ...DEFAULT_SETTINGS, engine: "elevenlabs" as const, elevenLabsKey: "sk-should-never-leak" };

    const startP = engine.start(noopEvents(), settings);
    expect(getDiagEntries().some((e) => e.tag === "stt-elevenlabs" && e.message.includes("启动请求"))).toBe(true);
    gumCalls[0].resolve(new FakeMediaStream());
    await startP;

    for (const entry of getDiagEntries().filter((e) => e.tag === "stt-elevenlabs")) {
      expect(`${entry.message} ${entry.detail ?? ""}`).not.toContain("sk-should-never-leak");
    }
  });

  it("threads the lexicon snapshot through to the transport constructor", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new ElevenLabsEngine();
    const lexicon = { terms: ["ARR", "pseudobulk"] };

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "elevenlabs" as const }, lexicon);
    gumCalls[0].resolve(new FakeMediaStream());
    await startP;

    expect(elevenLabsTransportCtor.mock.calls[0][0]).toEqual(
      expect.objectContaining({ lexicon: { terms: ["ARR", "pseudobulk"] } }),
    );
  });

  it("surfaces a zh mic-permission error and never constructs a transport when getUserMedia rejects", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new ElevenLabsEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

    const startP = engine.start(events, { ...DEFAULT_SETTINGS, engine: "elevenlabs" as const });
    gumCalls[0].reject(new Error("permission denied"));
    await startP;

    expect(onStatus).toHaveBeenCalledWith(
      "error",
      "无法访问麦克风，请检查浏览器权限或选择的输入设备",
    );
    expect(elevenLabsTransportCtor).not.toHaveBeenCalled();
  });

  it("surfaces a zh audio-init error and stops the acquired tracks when attachStream throws", async () => {
    attachStreamMock.mockImplementationOnce(() => Promise.reject(new Error("no worklet")));
    const { gumCalls } = installFakeMediaDevices();
    const engine = new ElevenLabsEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

    const startP = engine.start(events, { ...DEFAULT_SETTINGS, engine: "elevenlabs" as const });
    const stream = new FakeMediaStream();
    gumCalls[0].resolve(stream);
    await startP;

    expect(onStatus).toHaveBeenCalledWith("error", "无法初始化音频处理，请刷新页面重试");
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
  });

  it("stop() landing while getUserMedia is still awaiting the permission prompt stops the late-granted tracks and never constructs a transport", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new ElevenLabsEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "elevenlabs" as const });
    await engine.stop();

    const stream = new FakeMediaStream();
    expect(gumCalls.length).toBe(1);
    gumCalls[0].resolve(stream);
    await startP.catch(() => {});

    expect(stream.getTracks().length).toBeGreaterThan(0);
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
    expect(elevenLabsTransportCtor).not.toHaveBeenCalled();
  });
});

describe("ElevenLabsEngine.stop()", () => {
  it("tears down the transport and stops every mic track", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new ElevenLabsEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "elevenlabs" as const });
    const stream = new FakeMediaStream();
    gumCalls[0].resolve(stream);
    await startP;

    await engine.stop();

    expect(transportStopMock).toHaveBeenCalledTimes(1);
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
  });

  it("is idempotent — a second stop() call is a no-op", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new ElevenLabsEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "elevenlabs" as const });
    gumCalls[0].resolve(new FakeMediaStream());
    await startP;

    await engine.stop();
    await engine.stop();

    expect(transportStopMock).toHaveBeenCalledTimes(1);
  });
});

// S7 fix (v0.6 round-2 review): streamStartedAt now stamps on the
// transport's own onStatus("listening") — the actual authenticated/
// streaming start — instead of at attachStream()'s own resolution,
// and stop() now captures the END timestamp BEFORE transport.stop()'s
// own (up to several seconds) drain wait, instead of after it. Mirrors
// soniox.test.ts/deepgram.test.ts's identical coverage of their own
// siblings' matching fix.
describe("ElevenLabsEngine usage-ledger instrumentation (T2, S7 fix)", () => {
  it("records wall-clock elapsed streaming seconds via recordSttSeconds at stop()", async () => {
    vi.useFakeTimers();
    const { gumCalls } = installFakeMediaDevices();
    const engine = new ElevenLabsEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "elevenlabs" as const });
    gumCalls[0].resolve(new FakeMediaStream());
    await startP;

    vi.advanceTimersByTime(5000);
    await engine.stop();

    expect(recordSttSecondsMock).toHaveBeenCalledTimes(1);
    expect(recordSttSecondsMock).toHaveBeenCalledWith("elevenlabs", 5);
  });

  it("never records when attachStream never succeeded (mic permission denied)", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new ElevenLabsEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "elevenlabs" as const });
    gumCalls[0].reject(new Error("permission denied"));
    await startP;

    await engine.stop();

    expect(recordSttSecondsMock).not.toHaveBeenCalled();
  });

  it("never records when attachStream itself throws (never reaches onStatus('listening'))", async () => {
    attachStreamMock.mockImplementationOnce(() => Promise.reject(new Error("no worklet")));
    const { gumCalls } = installFakeMediaDevices();
    const engine = new ElevenLabsEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "elevenlabs" as const });
    gumCalls[0].resolve(new FakeMediaStream());
    await startP;

    await engine.stop();

    expect(recordSttSecondsMock).not.toHaveBeenCalled();
  });

  it("a second stop() call never double-records", async () => {
    vi.useFakeTimers();
    const { gumCalls } = installFakeMediaDevices();
    const engine = new ElevenLabsEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "elevenlabs" as const });
    gumCalls[0].resolve(new FakeMediaStream());
    await startP;

    vi.advanceTimersByTime(1000);
    await engine.stop();
    await engine.stop();

    expect(recordSttSecondsMock).toHaveBeenCalledTimes(1);
  });

  // The actual S7 regression: stop() must not bill the drain wait as
  // more streaming time. Fails against pre-fix code, which read
  // Date.now() AFTER transport.stop() resolved — that mocked
  // transportStopMock resolves instantly here, so this test alone can't
  // observe seconds directly, but it pins the CONTRACT precisely:
  // recordSttSeconds is computed from the instant stop() was CALLED
  // (5000ms after start), not from whenever transport.stop() happens
  // to finish (simulated as taking an extra 3000ms below via fake
  // timers) — pre-fix code would report 8 (5+3), not 5.
  it("does not bill transport.stop()'s own drain wait as additional streaming time", async () => {
    vi.useFakeTimers();
    transportStopMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 3000); // simulates the up-to-8s server drain ack
        }),
    );
    const { gumCalls } = installFakeMediaDevices();
    const engine = new ElevenLabsEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "elevenlabs" as const });
    gumCalls[0].resolve(new FakeMediaStream());
    await startP;

    vi.advanceTimersByTime(5000);
    const stopP = engine.stop();
    await vi.advanceTimersByTimeAsync(3000); // let the drain-wait promise inside stop() resolve
    await stopP;

    expect(recordSttSecondsMock).toHaveBeenCalledWith("elevenlabs", 5); // NOT 8
  });
});
