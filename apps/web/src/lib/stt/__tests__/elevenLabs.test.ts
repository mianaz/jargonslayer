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
    constructor(...args: unknown[]) {
      elevenLabsTransportCtor(...args);
    }
    attachStream(...args: unknown[]) {
      return attachStreamMock(...args);
    }
    stop() {
      return transportStopMock();
    }
  },
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
  vi.unstubAllGlobals();
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
    expect(elevenLabsTransportCtor).toHaveBeenCalledWith({ events, settings, lexicon: undefined });
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
