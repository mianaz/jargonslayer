// SpeechActivityDetector (vad.ts) — the browser shell around VadCore.
// Covers the shell-level halves of the 2026-07 VAD-supervisor review's
// findings #1 (RMS->dB clamp), #2 (real cancellation / hot-mic leak on
// stop/start races), and #7 (mid-meeting VAD death via track "ended" /
// AudioContext statechange). vadCore.test.ts covers the pure-core half
// of #1 directly; webSpeech.test.ts covers the ENGINE-level wiring
// half of #2 (the `this.vad !== vad` race guard).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechActivityDetector } from "../vad";
import { VAD_ATTACK_MS, VAD_SAMPLE_MS } from "../vadCore";
import {
  FakeMediaStream,
  installFakeMediaDevices,
  uninstallFakeMediaDevices,
} from "./fakeMedia";

describe("SpeechActivityDetector", () => {
  let media: ReturnType<typeof installFakeMediaDevices>;

  beforeEach(() => {
    media = installFakeMediaDevices();
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallFakeMediaDevices();
  });

  // ---- finding #1: RMS->dB clamp (shell level) ----

  it("digital-silence frames (rms=0) stay non-speaking, and real loud audio afterward still correctly promotes to speaking", async () => {
    vi.useFakeTimers();
    const detector = new SpeechActivityDetector();
    const startPromise = detector.start();
    const stream = new FakeMediaStream(1);
    media.gumCalls[0].resolve(stream);
    expect(await startPromise).toBe(true);

    const analyser = media.audioContexts[0].analysers[0];
    analyser.level = 0; // true digital silence

    for (let i = 0; i < 30; i += 1) {
      await vi.advanceTimersByTimeAsync(VAD_SAMPLE_MS);
    }
    expect(detector.state.speaking).toBe(false);

    // Now genuinely loud audio — must still promote (the floor was
    // never poisoned into misreading silence as permanent speech, nor
    // did it get poisoned into misreading NOTHING as loud either).
    analyser.level = 0.9;
    let flippedAt = false;
    for (let i = 0; i < Math.ceil(VAD_ATTACK_MS / VAD_SAMPLE_MS) + 3; i += 1) {
      await vi.advanceTimersByTimeAsync(VAD_SAMPLE_MS);
      if (detector.state.speaking) flippedAt = true;
    }
    expect(flippedAt).toBe(true);

    detector.stop();
  });

  // ---- finding #2: real cancellation on stop/start races ----

  it("stop() during a pending getUserMedia() releases the stream once it resolves — zero live tracks, no AudioContext, no interval", async () => {
    vi.useFakeTimers();
    const detector = new SpeechActivityDetector();
    const startPromise = detector.start();
    expect(media.gumCalls).toHaveLength(1);

    detector.stop(); // races the pending getUserMedia()

    const stream = new FakeMediaStream(2);
    media.gumCalls[0].resolve(stream);
    const ok = await startPromise;

    expect(ok).toBe(false);
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
    expect(media.audioContexts).toHaveLength(0); // never got that far
    expect(detector.available).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // no sample interval was ever installed
  });

  it("restart race: stop()-ing a detector whose getUserMedia() resolves AFTER a second start() on a DIFFERENT instance leaves the first with zero live resources", async () => {
    vi.useFakeTimers();
    // Mirrors webSpeech.ts's start->stop->start race at the vad.ts
    // level directly: two independent SpeechActivityDetector
    // instances, first one's acquisition resolves late.
    const first = new SpeechActivityDetector();
    const firstStart = first.start();
    expect(media.gumCalls).toHaveLength(1);

    first.stop(); // engine "stopped" before the first detector ever came up

    const second = new SpeechActivityDetector();
    const secondStart = second.start();
    expect(media.gumCalls).toHaveLength(2);
    const secondStream = new FakeMediaStream(1);
    media.gumCalls[1].resolve(secondStream);
    expect(await secondStart).toBe(true);

    // Only NOW does the first (stale, stopped-before-ready) call
    // resolve — real getUserMedia() timing is not last-call-wins.
    const firstStream = new FakeMediaStream(1);
    media.gumCalls[0].resolve(firstStream);
    expect(await firstStart).toBe(false);

    expect(firstStream.getTracks().every((t) => t.stopped)).toBe(true);
    expect(first.available).toBe(false);
    // The second (live) detector is unaffected.
    expect(second.available).toBe(true);
    expect(secondStream.getTracks().every((t) => t.stopped)).toBe(false);

    second.stop();
  });

  // ---- finding #7: mid-meeting VAD death ----

  it("a track 'ended' event tears the detector down and flips available false", async () => {
    vi.useFakeTimers();
    const detector = new SpeechActivityDetector();
    const startPromise = detector.start();
    const stream = new FakeMediaStream(1);
    media.gumCalls[0].resolve(stream);
    expect(await startPromise).toBe(true);
    expect(detector.available).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    stream.getTracks()[0].simulateEnded();

    expect(detector.available).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(media.audioContexts[0].closeCalls).toBe(1);
  });

  it("AudioContext closing externally (not via our own stop()) also tears down and flips available false", async () => {
    vi.useFakeTimers();
    const detector = new SpeechActivityDetector();
    const startPromise = detector.start();
    const stream = new FakeMediaStream(1);
    media.gumCalls[0].resolve(stream);
    expect(await startPromise).toBe(true);

    media.audioContexts[0].simulateClosedExternally();

    expect(detector.available).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
  });

  it("our own stop() does not re-trigger the lifecycle-death teardown a second time", async () => {
    vi.useFakeTimers();
    const detector = new SpeechActivityDetector();
    const startPromise = detector.start();
    const stream = new FakeMediaStream(1);
    media.gumCalls[0].resolve(stream);
    await startPromise;

    detector.stop();
    expect(() => stream.getTracks()[0].simulateEnded()).not.toThrow();
    expect(media.audioContexts[0].closeCalls).toBe(1); // not double-closed
  });
});
