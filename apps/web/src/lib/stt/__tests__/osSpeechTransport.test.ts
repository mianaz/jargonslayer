// osSpeechTransport.ts (S13 blueprint §2/§6 D2, Lane D) — desktop-branch
// coverage (ambient test env: NEXT_PUBLIC_IOS unset, so the REAL IS_IOS
// resolves false, same as every other build-flag suite's "false by
// default" convention). See osSpeechTransport.ios.test.ts for the iOS
// branch — IS_IOS is a module-scope import-time const, so that half
// needs its own file/vi.mock, mirroring engineOptions.desktop.test.ts's
// own split for the identical constraint.

import { describe, expect, it, vi } from "vitest";
import type { ListenFn, TauriEvent, UnlistenFn } from "../../desktop/tauriApi";

let currentListen!: ListenFn;
vi.mock("../../desktop/tauriApi", () => ({
  getListen: () => Promise.resolve(currentListen),
}));

import { listenOsSpeechAudioStats, listenOsSpeechStatus, listenOsSpeechTranscript } from "../osSpeechTransport";

function makeFakeListen(): {
  listen: ListenFn;
  emit: (event: string, payload: unknown) => void;
  activeCount: (event: string) => number;
} {
  const active = new Map<string, Array<(event: TauriEvent<unknown>) => void>>();
  const listen: ListenFn = (async <T>(event: string, handler: (event: TauriEvent<T>) => void) => {
    const list = active.get(event) ?? [];
    list.push(handler as (event: TauriEvent<unknown>) => void);
    active.set(event, list);
    const unlisten: UnlistenFn = () => {
      active.set(event, (active.get(event) ?? []).filter((h) => h !== handler));
    };
    return unlisten;
  }) as ListenFn;
  function emit(event: string, payload: unknown): void {
    for (const handler of active.get(event) ?? []) handler({ event, payload });
  }
  function activeCount(event: string): number {
    return (active.get(event) ?? []).length;
  }
  return { listen, emit, activeCount };
}

describe("listenOsSpeechTranscript/listenOsSpeechStatus — desktop branch (IS_IOS false)", () => {
  it('listenOsSpeechTranscript subscribes to the macOS global "osspeech://transcript" event via getListen()', async () => {
    const { listen, emit } = makeFakeListen();
    currentListen = listen;
    const cb = vi.fn();

    await listenOsSpeechTranscript(cb);
    emit("osspeech://transcript", { final: true, seq: 1, startMs: 0, endMs: 100, text: "hi" });

    // Desktop's listen() delivers the native TauriEvent<T> shape
    // ({event, payload}) straight through — every real consumer only
    // ever reads `.payload` off it (same as before this shim existed),
    // so this checks that field specifically rather than the whole
    // call-argument object.
    expect(cb.mock.calls[0][0].payload).toEqual({ final: true, seq: 1, startMs: 0, endMs: 100, text: "hi" });
  });

  it('listenOsSpeechStatus subscribes to the macOS global "osspeech://status" event via getListen()', async () => {
    const { listen, emit } = makeFakeListen();
    currentListen = listen;
    const cb = vi.fn();

    await listenOsSpeechStatus(cb);
    emit("osspeech://status", { kind: "capturing", source: "session" });

    expect(cb.mock.calls[0][0].payload).toEqual({ kind: "capturing", source: "session" });
  });

  it("the returned UnlistenFn tears down the underlying getListen() subscription", async () => {
    const { listen, emit, activeCount } = makeFakeListen();
    currentListen = listen;
    const cb = vi.fn();

    const unlisten = await listenOsSpeechTranscript(cb);
    expect(activeCount("osspeech://transcript")).toBe(1);

    unlisten();
    expect(activeCount("osspeech://transcript")).toBe(0);

    emit("osspeech://transcript", { final: false, seq: 2, startMs: 0, endMs: 50, text: "late" });
    expect(cb).not.toHaveBeenCalled();
  });
});

// Lane W (mid-session STT liveness watchdog, audioLiveness.ts) —
// "osspeech://audio-stats" rides the SAME desktop global-event path as
// the other two, just a dedicated event name (never plugin-scoped on
// iOS at all — see osSpeechTransport.ios.test.ts for that branch).
describe("listenOsSpeechAudioStats — desktop branch (IS_IOS false)", () => {
  it('subscribes to the macOS global "osspeech://audio-stats" event via getListen()', async () => {
    const { listen, emit } = makeFakeListen();
    currentListen = listen;
    const cb = vi.fn();

    await listenOsSpeechAudioStats(cb);
    emit("osspeech://audio-stats", { channel: "mic", windowPeak: 0.05 });

    expect(cb.mock.calls[0][0].payload).toEqual({ channel: "mic", windowPeak: 0.05 });
  });

  it("the returned UnlistenFn tears down the underlying getListen() subscription", async () => {
    const { listen, emit, activeCount } = makeFakeListen();
    currentListen = listen;
    const cb = vi.fn();

    const unlisten = await listenOsSpeechAudioStats(cb);
    expect(activeCount("osspeech://audio-stats")).toBe(1);

    unlisten();
    expect(activeCount("osspeech://audio-stats")).toBe(0);

    emit("osspeech://audio-stats", { windowPeak: 0.1 });
    expect(cb).not.toHaveBeenCalled();
  });
});
