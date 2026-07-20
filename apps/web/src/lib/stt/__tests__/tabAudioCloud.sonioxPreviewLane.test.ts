// tabAudioCloud — Soniox preview lane (SONIOX_PREVIEW_LANE): the
// minted-path INVARIANT (v0.5 closeout, lead-pinned) — on this lane,
// start() ALWAYS routes through Soniox regardless of the persisted
// tabAudioCloudProvider, and passes mintPreviewToken exactly like
// soniox.ts's own SonioxEngine.start() does. PREVIEW_TIER/
// SONIOX_PREVIEW_LANE are both import-time consts (deployTier.ts) —
// same "needs its own vi.mock'd file" constraint as engineOptions.
// sonioxPreviewLane.test.ts/soniox.sonioxPreview.test.ts (see either
// file's own header) — tabAudioCloud.test.ts's own ambient env (both
// false) stays untouched for its existing non-preview coverage.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/deployTier", () => ({ PREVIEW_TIER: true, SONIOX_PREVIEW_LANE: true }));

const sonioxTransportCtor = vi.fn();
vi.mock("../sonioxTransport", () => ({
  SonioxTransport: class {
    constructor(...args: unknown[]) {
      sonioxTransportCtor(...args);
    }
    attachStream() {
      return Promise.resolve();
    }
    stop() {
      return Promise.resolve();
    }
  },
}));

const deepgramTransportCtor = vi.fn();
vi.mock("../deepgramTransport", () => ({
  DeepgramTransport: class {
    constructor(...args: unknown[]) {
      deepgramTransportCtor(...args);
    }
    attachStream() {
      return Promise.resolve();
    }
    stop() {
      return Promise.resolve();
    }
  },
}));

import {
  FakeMediaStream,
  installFakeMediaDevices,
  uninstallFakeMediaDevices,
} from "./fakeMedia";
import { TabAudioCloudEngine } from "../tabAudioCloud";
import { mintPreviewToken } from "../soniox";
import { DEFAULT_SETTINGS, type STTEvents } from "@jargonslayer/core/types";

function noopEvents(): STTEvents {
  return { onInterim: () => {}, onFinal: () => {}, onStatus: () => {} } as unknown as STTEvents;
}

// tabAudioCloud reads getAudioTracks(); fakeMedia's stream only exposes
// getTracks() — same shape fix tabAudioCloud.test.ts's own
// FakeDisplayStream already established.
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
  deepgramTransportCtor.mockClear();
  vi.unstubAllGlobals();
});

describe("TabAudioCloudEngine.start() — soniox preview lane minted path", () => {
  it("keyless lane: constructs SonioxTransport with mintPreviewToken as mintToken", async () => {
    installFakeDisplayMedia(() => Promise.resolve(new FakeDisplayStream()));
    const engine = new TabAudioCloudEngine();

    await engine.start(noopEvents(), { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud" as const, sonioxKey: "" });

    expect(sonioxTransportCtor).toHaveBeenCalledTimes(1);
    const ctorArgs = sonioxTransportCtor.mock.calls[0][0] as { mintToken?: unknown };
    expect(ctorArgs.mintToken).toBe(mintPreviewToken);
    expect(deepgramTransportCtor).not.toHaveBeenCalled();
  });

  it("a BYOK sonioxKey still wins — mintToken stays undefined even though the lane is on", async () => {
    installFakeDisplayMedia(() => Promise.resolve(new FakeDisplayStream()));
    const engine = new TabAudioCloudEngine();

    await engine.start(noopEvents(), {
      ...DEFAULT_SETTINGS,
      engine: "tabaudio-cloud" as const,
      sonioxKey: "sk-own-key",
    });

    expect(sonioxTransportCtor).toHaveBeenCalledTimes(1);
    const ctorArgs = sonioxTransportCtor.mock.calls[0][0] as { mintToken?: unknown };
    expect(ctorArgs.mintToken).toBeUndefined();
  });

  it("a persisted tabAudioCloudProvider:'deepgram' is FORCED to soniox on the lane — no dead tab tile, DeepgramTransport never constructed", async () => {
    installFakeDisplayMedia(() => Promise.resolve(new FakeDisplayStream()));
    const engine = new TabAudioCloudEngine();

    await engine.start(noopEvents(), {
      ...DEFAULT_SETTINGS,
      engine: "tabaudio-cloud" as const,
      tabAudioCloudProvider: "deepgram",
      sonioxKey: "",
      deepgramKey: "",
    });

    expect(sonioxTransportCtor).toHaveBeenCalledTimes(1);
    expect(deepgramTransportCtor).not.toHaveBeenCalled();
  });
});
