// DeepgramEngine (v0.4.7 stt-provider-wiring, Lane D): the thin
// mic-acquisition shell around DeepgramTransport — mirrors soniox.test.ts's
// own coverage of SonioxEngine's identical shape, with DeepgramTransport
// module-mocked so "a transport was constructed at all" / "attachStream
// was called at all" are the observable signals, without dragging in the
// real WebSocket/AudioContext machinery deepgramTransport.test.ts already
// covers directly.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeMediaStream,
  installFakeMediaDevices,
  uninstallFakeMediaDevices,
} from "./fakeMedia";

const deepgramTransportCtor = vi.fn();
const attachStreamMock = vi.fn((..._args: unknown[]) => Promise.resolve());
const transportStopMock = vi.fn(() => Promise.resolve());
vi.mock("../deepgramTransport", () => ({
  DeepgramTransport: class {
    private events: { onStatus: (status: string) => void };
    constructor(...args: unknown[]) {
      deepgramTransportCtor(...args);
      this.events = (args[0] as { events: { onStatus: (status: string) => void } }).events;
    }
    async attachStream(...args: unknown[]) {
      const result = await attachStreamMock(...args);
      // S7 fix (v0.6 round-2 review): the real transport fires
      // onStatus("listening") once the WebSocket actually opens —
      // DeepgramEngine's own streamStartedAt now hooks THAT, not
      // attachStream()'s own resolution, so this mock simulates it.
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

import { DeepgramEngine } from "../deepgram";
import { DEFAULT_SETTINGS, type STTEvents } from "@jargonslayer/core/types";

function noopEvents(): STTEvents {
  return {
    onInterim: () => {},
    onFinal: () => {},
    onStatus: () => {},
  } as unknown as STTEvents;
}

afterEach(() => {
  uninstallFakeMediaDevices();
  deepgramTransportCtor.mockClear();
  attachStreamMock.mockClear();
  transportStopMock.mockClear();
  recordSttSecondsMock.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reports kind: deepgram", () => {
  expect(new DeepgramEngine().kind).toBe("deepgram");
});

describe("DeepgramEngine.start()", () => {
  it("acquires a mic stream, constructs a DeepgramTransport, and attaches the stream to it", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new DeepgramEngine();
    const events = noopEvents();
    const settings = { ...DEFAULT_SETTINGS, engine: "deepgram" as const, deepgramKey: "sk-key" };

    const startP = engine.start(events, settings);
    const stream = new FakeMediaStream();
    gumCalls[0].resolve(stream);
    await startP;

    expect(deepgramTransportCtor).toHaveBeenCalledTimes(1);
    // S7 fix (v0.6 round-2 review): events is wrapped now — onInterim/
    // onFinal forward through unchanged (same references), onStatus is
    // intercepted (a new closure) to stamp streamStartedAt on
    // "listening" before forwarding — see the usage-ledger describe
    // block below for that behavior itself.
    const ctorArgs = deepgramTransportCtor.mock.calls[0][0] as { events: STTEvents; settings: unknown };
    expect(ctorArgs.settings).toBe(settings);
    expect(ctorArgs.events.onInterim).toBe(events.onInterim);
    expect(ctorArgs.events.onFinal).toBe(events.onFinal);
    expect(ctorArgs.events.onStatus).not.toBe(events.onStatus);
    expect(attachStreamMock).toHaveBeenCalledWith(stream);
  });

  it("surfaces a zh mic-permission error and never constructs a transport when getUserMedia rejects", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new DeepgramEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

    const startP = engine.start(events, { ...DEFAULT_SETTINGS, engine: "deepgram" as const });
    gumCalls[0].reject(new Error("permission denied"));
    await startP;

    expect(onStatus).toHaveBeenCalledWith(
      "error",
      "无法访问麦克风，请检查浏览器权限或选择的输入设备",
    );
    expect(deepgramTransportCtor).not.toHaveBeenCalled();
  });

  it("surfaces a zh audio-init error and stops the acquired tracks when attachStream throws", async () => {
    attachStreamMock.mockImplementationOnce(() => Promise.reject(new Error("no worklet")));
    const { gumCalls } = installFakeMediaDevices();
    const engine = new DeepgramEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

    const startP = engine.start(events, { ...DEFAULT_SETTINGS, engine: "deepgram" as const });
    const stream = new FakeMediaStream();
    gumCalls[0].resolve(stream);
    await startP;

    expect(onStatus).toHaveBeenCalledWith("error", "无法初始化音频处理，请刷新页面重试");
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
  });

  it("stop() landing while getUserMedia is still awaiting the permission prompt stops the late-granted tracks and never constructs a transport", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new DeepgramEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "deepgram" as const });
    // stop() lands while the (deferred) permission prompt is open.
    await engine.stop();

    const stream = new FakeMediaStream();
    expect(gumCalls.length).toBe(1);
    gumCalls[0].resolve(stream);
    await startP.catch(() => {});

    expect(stream.getTracks().length).toBeGreaterThan(0);
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
    expect(deepgramTransportCtor).not.toHaveBeenCalled();
  });
});

describe("DeepgramEngine.stop()", () => {
  it("tears down the transport and stops every mic track", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new DeepgramEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "deepgram" as const });
    const stream = new FakeMediaStream();
    gumCalls[0].resolve(stream);
    await startP;

    await engine.stop();

    expect(transportStopMock).toHaveBeenCalledTimes(1);
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
  });

  it("is idempotent — a second stop() call is a no-op", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new DeepgramEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "deepgram" as const });
    gumCalls[0].resolve(new FakeMediaStream());
    await startP;

    await engine.stop();
    await engine.stop();

    expect(transportStopMock).toHaveBeenCalledTimes(1);
  });
});

describe("DeepgramEngine usage-ledger instrumentation (T2)", () => {
  it("records wall-clock elapsed streaming seconds via recordSttSeconds at stop()", async () => {
    vi.useFakeTimers();
    const { gumCalls } = installFakeMediaDevices();
    const engine = new DeepgramEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "deepgram" as const });
    gumCalls[0].resolve(new FakeMediaStream());
    await startP;

    vi.advanceTimersByTime(5000);
    await engine.stop();

    expect(recordSttSecondsMock).toHaveBeenCalledTimes(1);
    expect(recordSttSecondsMock).toHaveBeenCalledWith("deepgram", 5);
  });

  it("never records when attachStream never succeeded (mic permission denied)", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new DeepgramEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "deepgram" as const });
    gumCalls[0].reject(new Error("permission denied"));
    await startP;

    await engine.stop();

    expect(recordSttSecondsMock).not.toHaveBeenCalled();
  });

  it("never records when attachStream itself throws", async () => {
    attachStreamMock.mockImplementationOnce(() => Promise.reject(new Error("no worklet")));
    const { gumCalls } = installFakeMediaDevices();
    const engine = new DeepgramEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "deepgram" as const });
    gumCalls[0].resolve(new FakeMediaStream());
    await startP;

    await engine.stop();

    expect(recordSttSecondsMock).not.toHaveBeenCalled();
  });

  it("a second stop() call never double-records", async () => {
    vi.useFakeTimers();
    const { gumCalls } = installFakeMediaDevices();
    const engine = new DeepgramEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "deepgram" as const });
    gumCalls[0].resolve(new FakeMediaStream());
    await startP;

    vi.advanceTimersByTime(1000);
    await engine.stop();
    await engine.stop();

    expect(recordSttSecondsMock).toHaveBeenCalledTimes(1);
  });

  // S7 fix (v0.6 round-2 review): stop() must not bill
  // transport.stop()'s own drain wait as additional streaming time.
  // Fails against pre-fix code, which read Date.now() AFTER
  // transport.stop() resolved — this would report 8 (5+3), not 5.
  it("does not bill transport.stop()'s own drain wait as additional streaming time", async () => {
    vi.useFakeTimers();
    transportStopMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 3000); // simulates the transport's own multi-second drain ack wait
        }),
    );
    const { gumCalls } = installFakeMediaDevices();
    const engine = new DeepgramEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "deepgram" as const });
    gumCalls[0].resolve(new FakeMediaStream());
    await startP;

    vi.advanceTimersByTime(5000);
    const stopP = engine.stop();
    await vi.advanceTimersByTimeAsync(3000); // let the drain-wait promise inside stop() resolve
    await stopP;

    expect(recordSttSecondsMock).toHaveBeenCalledWith("deepgram", 5); // NOT 8
  });
});
