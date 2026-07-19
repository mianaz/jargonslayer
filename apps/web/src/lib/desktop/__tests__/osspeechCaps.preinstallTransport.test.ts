// osspeechCaps.ts's preinstallOsSpeech() — proves it subscribes via
// osSpeechTransport.ts's listenOsSpeechStatus (S13 blueprint §6 Sol F2,
// BLOCKER), not a direct tauriApi.getListen() call. osspeechCaps.test.ts
// covers the end-to-end BEHAVIOR (tracker forwarding, resolve/reject)
// against a mocked tauriApi with the REAL shim in between; this file
// isolates the ONE thing that suite can't cleanly assert — that the
// shim itself, not getListen(), is the thing being called — by mocking
// "../../stt/osSpeechTransport" directly. vi.mock is file-scoped, so
// this needs its own file rather than a describe block alongside
// osspeechCaps.test.ts's own tauriApi-level mocking.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { OsSpeechStatusPayload } from "../../stt/osSpeech";

const mockGetInvoke = vi.fn();
vi.mock("../tauriApi", () => ({
  getInvoke: () => mockGetInvoke(),
}));

let capturedCb: ((e: { payload: OsSpeechStatusPayload }) => void) | null = null;
const unlistenSpy = vi.fn();
const mockListenOsSpeechStatus = vi.fn((cb: (e: { payload: OsSpeechStatusPayload }) => void) => {
  capturedCb = cb;
  return Promise.resolve(unlistenSpy);
});
vi.mock("../../stt/osSpeechTransport", () => ({
  listenOsSpeechStatus: (cb: (e: { payload: OsSpeechStatusPayload }) => void) => mockListenOsSpeechStatus(cb),
}));

vi.mock("../../stt/osSpeech", () => ({
  OSSPEECH_TERMINAL_STATUS_KINDS: new Set([
    "ended",
    "crashed",
    "permission-denied",
    "unsupported",
    "unsupported-locale",
    "device-changed",
    "asset-failed",
  ]),
}));

vi.mock("../jobsBridge", () => ({
  trackOsSpeechAsset: () => ({ handle: vi.fn() }),
}));

import { preinstallOsSpeech } from "../osspeechCaps";

describe("preinstallOsSpeech — routed through the osSpeechTransport shim (S13 §6 Sol F2)", () => {
  afterEach(() => {
    capturedCb = null;
    mockListenOsSpeechStatus.mockClear();
    unlistenSpy.mockClear();
    mockGetInvoke.mockReset();
  });

  it("subscribes via listenOsSpeechStatus (the shim) exactly once — never a direct tauriApi.getListen() call", async () => {
    mockGetInvoke.mockResolvedValue(async () => undefined);

    const p = preinstallOsSpeech("zh-CN");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockListenOsSpeechStatus).toHaveBeenCalledTimes(1);
    expect(capturedCb).not.toBeNull();

    capturedCb!({ payload: { kind: "asset-installed", source: "session" } });
    await p;

    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });
});
