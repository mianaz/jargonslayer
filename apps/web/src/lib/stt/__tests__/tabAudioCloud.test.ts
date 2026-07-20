// TabAudioCloudEngine (v0.5 Wave-1 Feature 4, docs/design-explorations/
// v05-wave1-blueprint.md §1 Feature 4 + §5 A4): getDisplayMedia capture
// (mirrors tabAudio.ts/acquireCancellation.test.ts's own coverage of
// that shape) routed into a module-mocked SonioxTransport/
// DeepgramTransport — "a transport was constructed at all, with the
// right ctor args" / "attachStream was called with the captured stream"
// are the observable signals, without dragging in the real WebSocket/
// AudioContext machinery sonioxTransport.test.ts/deepgramTransport.
// test.ts already cover directly.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeMediaStream,
  installFakeMediaDevices,
  uninstallFakeMediaDevices,
} from "./fakeMedia";

const sonioxTransportCtor = vi.fn();
const sonioxAttachStreamMock = vi.fn((..._args: unknown[]) => Promise.resolve());
const sonioxStopMock = vi.fn(() => Promise.resolve());
vi.mock("../sonioxTransport", () => ({
  SonioxTransport: class {
    constructor(...args: unknown[]) {
      sonioxTransportCtor(...args);
    }
    attachStream(...args: unknown[]) {
      return sonioxAttachStreamMock(...args);
    }
    stop() {
      return sonioxStopMock();
    }
  },
}));

const deepgramTransportCtor = vi.fn();
const deepgramAttachStreamMock = vi.fn((..._args: unknown[]) => Promise.resolve());
const deepgramStopMock = vi.fn(() => Promise.resolve());
vi.mock("../deepgramTransport", () => ({
  DeepgramTransport: class {
    constructor(...args: unknown[]) {
      deepgramTransportCtor(...args);
    }
    attachStream(...args: unknown[]) {
      return deepgramAttachStreamMock(...args);
    }
    stop() {
      return deepgramStopMock();
    }
  },
}));

import { TabAudioCloudEngine } from "../tabAudioCloud";
import { DEFAULT_SETTINGS, type STTEvents } from "@jargonslayer/core/types";

function noopEvents(): STTEvents {
  return {
    onInterim: () => {},
    onFinal: () => {},
    onStatus: () => {},
  } as unknown as STTEvents;
}

// tabAudioCloud reads getAudioTracks(); fakeMedia's stream only exposes
// getTracks() — same shape fix acquireCancellation.test.ts's own
// FakeDisplayStream already established for tabAudio.ts's identical
// getDisplayMedia call.
class FakeDisplayStream extends FakeMediaStream {
  getAudioTracks() {
    return this.getTracks();
  }
}

function installFakeDisplayMedia(impl: () => Promise<FakeDisplayStream>) {
  installFakeMediaDevices();
  const gdm = vi.fn(impl);
  (navigator.mediaDevices as unknown as Record<string, unknown>).getDisplayMedia = gdm;
  return gdm;
}

afterEach(() => {
  uninstallFakeMediaDevices();
  sonioxTransportCtor.mockClear();
  sonioxAttachStreamMock.mockClear();
  sonioxStopMock.mockClear();
  deepgramTransportCtor.mockClear();
  deepgramAttachStreamMock.mockClear();
  deepgramStopMock.mockClear();
  vi.unstubAllGlobals();
});

it("reports kind: tabaudio-cloud", () => {
  expect(new TabAudioCloudEngine().kind).toBe("tabaudio-cloud");
});

describe("TabAudioCloudEngine.start() — provider key gate (A4)", () => {
  it("missing Soniox key (default provider): zh error naming Soniox, never opens the share picker or constructs a transport", async () => {
    const gdm = installFakeDisplayMedia(() => Promise.resolve(new FakeDisplayStream()));
    const engine = new TabAudioCloudEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

    await engine.start(events, { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud" as const, sonioxKey: "" });

    expect(onStatus).toHaveBeenCalledWith(
      "error",
      "标签页音频·云端需要 Soniox API Key，请前往设置填写后重试",
    );
    expect(gdm).not.toHaveBeenCalled();
    expect(sonioxTransportCtor).not.toHaveBeenCalled();
    expect(deepgramTransportCtor).not.toHaveBeenCalled();
  });

  it("missing Deepgram key (provider explicitly deepgram): zh error naming Deepgram", async () => {
    const gdm = installFakeDisplayMedia(() => Promise.resolve(new FakeDisplayStream()));
    const engine = new TabAudioCloudEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

    await engine.start(events, {
      ...DEFAULT_SETTINGS,
      engine: "tabaudio-cloud" as const,
      tabAudioCloudProvider: "deepgram",
      deepgramKey: "",
    });

    expect(onStatus).toHaveBeenCalledWith(
      "error",
      "标签页音频·云端需要 Deepgram API Key，请前往设置填写后重试",
    );
    expect(gdm).not.toHaveBeenCalled();
    expect(deepgramTransportCtor).not.toHaveBeenCalled();
  });

  it("an invalid persisted provider string sanitizes to soniox (A4) — gates on sonioxKey, not deepgramKey", async () => {
    installFakeDisplayMedia(() => Promise.resolve(new FakeDisplayStream()));
    const engine = new TabAudioCloudEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

    await engine.start(events, {
      ...DEFAULT_SETTINGS,
      engine: "tabaudio-cloud" as const,
      tabAudioCloudProvider: "azure" as unknown as "soniox" | "deepgram",
      sonioxKey: "",
      deepgramKey: "dg-key",
    });

    expect(onStatus).toHaveBeenCalledWith(
      "error",
      "标签页音频·云端需要 Soniox API Key，请前往设置填写后重试",
    );
  });
});

describe("TabAudioCloudEngine.start() — capture + provider transport dispatch", () => {
  it("soniox (default provider): captures the tab, constructs a SonioxTransport with the lexicon, and attaches the stream", async () => {
    const stream = new FakeDisplayStream();
    const gdm = installFakeDisplayMedia(() => Promise.resolve(stream));
    const engine = new TabAudioCloudEngine();
    const events = noopEvents();
    const settings = { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud" as const, sonioxKey: "sk-key" };
    const lexicon = { terms: ["foo"] };

    await engine.start(events, settings, lexicon);

    expect(gdm).toHaveBeenCalledWith({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    expect(sonioxTransportCtor).toHaveBeenCalledTimes(1);
    expect(sonioxTransportCtor).toHaveBeenCalledWith({ events, settings, lexicon });
    expect(sonioxAttachStreamMock).toHaveBeenCalledWith(stream);
    expect(deepgramTransportCtor).not.toHaveBeenCalled();
  });

  it("deepgram provider: constructs a DeepgramTransport WITHOUT a lexicon field (D1 — no keyterm-bias toggle exists yet) and attaches the stream", async () => {
    const stream = new FakeDisplayStream();
    installFakeDisplayMedia(() => Promise.resolve(stream));
    const engine = new TabAudioCloudEngine();
    const events = noopEvents();
    const settings = {
      ...DEFAULT_SETTINGS,
      engine: "tabaudio-cloud" as const,
      tabAudioCloudProvider: "deepgram" as const,
      deepgramKey: "dg-key",
    };

    await engine.start(events, settings, { terms: ["bar"] });

    expect(deepgramTransportCtor).toHaveBeenCalledTimes(1);
    expect(deepgramTransportCtor).toHaveBeenCalledWith({ events, settings });
    expect(deepgramAttachStreamMock).toHaveBeenCalledWith(stream);
    expect(sonioxTransportCtor).not.toHaveBeenCalled();
  });

  it("cancelled share picker (NotAllowedError): zh cancellation hint, no transport constructed", async () => {
    installFakeDisplayMedia(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    const engine = new TabAudioCloudEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

    await engine.start(events, { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud" as const, sonioxKey: "sk-key" });

    expect(onStatus).toHaveBeenCalledWith(
      "error",
      "已取消共享。提示：选择会议所在的浏览器标签页并勾选「分享标签页音频」",
    );
    expect(sonioxTransportCtor).not.toHaveBeenCalled();
  });

  it("any other getDisplayMedia failure: generic zh capture error", async () => {
    installFakeDisplayMedia(() => Promise.reject(new Error("boom")));
    const engine = new TabAudioCloudEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

    await engine.start(events, { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud" as const, sonioxKey: "sk-key" });

    expect(onStatus).toHaveBeenCalledWith("error", "无法捕获标签页音频，请重试或选择其他引擎");
  });

  it("no audio track in the granted capture: zh hint, stops every track, no transport constructed", async () => {
    const stream = new FakeDisplayStream(0);
    installFakeDisplayMedia(() => Promise.resolve(stream));
    const engine = new TabAudioCloudEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

    await engine.start(events, { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud" as const, sonioxKey: "sk-key" });

    expect(onStatus).toHaveBeenCalledWith(
      "error",
      "没有检测到音频，请选择「Chrome 标签页」并勾选左下角「分享标签页音频」",
    );
    expect(sonioxTransportCtor).not.toHaveBeenCalled();
  });

  it("stop() landing while the share picker is open stops the late-granted capture and never constructs a transport", async () => {
    let resolveGdm!: (s: FakeDisplayStream) => void;
    installFakeDisplayMedia(() => new Promise((resolve) => (resolveGdm = resolve)));
    const engine = new TabAudioCloudEngine();

    const startP = engine.start(noopEvents(), {
      ...DEFAULT_SETTINGS,
      engine: "tabaudio-cloud" as const,
      sonioxKey: "sk-key",
    });
    await engine.stop();

    const stream = new FakeDisplayStream();
    resolveGdm(stream);
    await startP.catch(() => {});

    expect(stream.getTracks().length).toBeGreaterThan(0);
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
    expect(sonioxTransportCtor).not.toHaveBeenCalled();
  });

  it("surfaces a zh audio-init error and tears down the capture when attachStream throws", async () => {
    sonioxAttachStreamMock.mockImplementationOnce(() => Promise.reject(new Error("no worklet")));
    const stream = new FakeDisplayStream();
    installFakeDisplayMedia(() => Promise.resolve(stream));
    const engine = new TabAudioCloudEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

    await engine.start(events, { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud" as const, sonioxKey: "sk-key" });

    expect(onStatus).toHaveBeenCalledWith("error", "无法初始化音频处理，请刷新页面重试");
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
  });
});

describe("TabAudioCloudEngine.stop()", () => {
  it("tears down the transport and stops every captured track, including the unused video track", async () => {
    const stream = new FakeDisplayStream(2); // audio + the required-but-unused video track
    installFakeDisplayMedia(() => Promise.resolve(stream));
    const engine = new TabAudioCloudEngine();

    await engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud" as const, sonioxKey: "sk-key" });
    await engine.stop();

    expect(sonioxStopMock).toHaveBeenCalledTimes(1);
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
  });

  it("is idempotent — a second stop() call is a no-op", async () => {
    const stream = new FakeDisplayStream();
    installFakeDisplayMedia(() => Promise.resolve(stream));
    const engine = new TabAudioCloudEngine();

    await engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud" as const, sonioxKey: "sk-key" });

    await engine.stop();
    await engine.stop();

    expect(sonioxStopMock).toHaveBeenCalledTimes(1);
  });

  it("the browser's native 停止共享 control (track 'ended') reports onStatus('idle', 'capture_ended') while not already stopping", async () => {
    const stream = new FakeDisplayStream();
    installFakeDisplayMedia(() => Promise.resolve(stream));
    const engine = new TabAudioCloudEngine();
    const onStatus = vi.fn();
    const events = { ...noopEvents(), onStatus } as unknown as STTEvents;

    await engine.start(events, { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud" as const, sonioxKey: "sk-key" });
    onStatus.mockClear();
    stream.getTracks()[0].simulateEnded();

    expect(onStatus).toHaveBeenCalledWith("idle", "capture_ended");
  });
});
