// Acquisition-cancellation guard (codex review 2026-07-10 HIGH): a
// stop() landing while getUserMedia/getDisplayMedia is still awaiting
// the permission prompt must NOT let the later-granted stream attach —
// pre-guard, the acquired tracks kept recording on an engine the user
// had already stopped (hot-mic class). Uses fakeMedia's deferred
// getUserMedia so the acquisition can be resolved AFTER stop(), and a
// module-mocked WsTransport so "a transport was constructed at all"
// is the red signal (red-verified against the unguarded engines).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeMediaStream,
  installFakeMediaDevices,
  uninstallFakeMediaDevices,
  deferred,
  type Deferred,
} from "./fakeMedia";

const wsTransportCtor = vi.fn();
vi.mock("../wsTransport", () => ({
  WsTransport: class {
    constructor(...args: unknown[]) {
      wsTransportCtor(...args);
    }
    attachStream() {
      return Promise.resolve();
    }
    stop() {
      return Promise.resolve();
    }
  },
}));

import { WhisperSocketEngine } from "../whisperSocket";
import { TabAudioEngine } from "../tabAudio";
import { DEFAULT_SETTINGS, type STTEvents } from "../../types";

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

// tabAudio reads getAudioTracks(); fakeMedia's stream only has
// getTracks() — treat every fake track as an audio track.
class FakeDisplayStream extends FakeMediaStream {
  getAudioTracks() {
    return this.getTracks();
  }
}

afterEach(() => {
  uninstallFakeMediaDevices();
  wsTransportCtor.mockClear();
  vi.unstubAllGlobals();
});

describe("whisperSocket — stop() during getUserMedia acquisition", () => {
  it("stops the late-granted tracks and never constructs a transport", async () => {
    const { gumCalls } = installFakeMediaDevices();
    const engine = new WhisperSocketEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "whisper" });
    // stop() lands while the (deferred) permission prompt is open.
    await engine.stop();

    const stream = new FakeMediaStream();
    expect(gumCalls.length).toBe(1);
    gumCalls[0].resolve(stream);
    await startP.catch(() => {});

    expect(stream.getTracks().length).toBeGreaterThan(0);
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
    expect(wsTransportCtor).not.toHaveBeenCalled();
  });
});

describe("tabAudio — stop() while the share picker is open", () => {
  it("stops the late-granted capture and never constructs a transport", async () => {
    installFakeMediaDevices();
    const gdm: Deferred<FakeDisplayStream> = deferred<FakeDisplayStream>();
    (navigator.mediaDevices as unknown as Record<string, unknown>).getDisplayMedia = vi.fn(
      () => gdm.promise,
    );
    const engine = new TabAudioEngine();

    const startP = engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "tabaudio" });
    await engine.stop();

    const stream = new FakeDisplayStream();
    gdm.resolve(stream);
    await startP.catch(() => {});

    expect(stream.getTracks().length).toBeGreaterThan(0);
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
    expect(wsTransportCtor).not.toHaveBeenCalled();
  });
});
