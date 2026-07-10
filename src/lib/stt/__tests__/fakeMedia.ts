// Shared getUserMedia/AudioContext fakes for testing vad.ts's
// SpeechActivityDetector directly (vad.test.ts) and the engine-level
// mic-leak races webSpeech.ts wires it into (webSpeech.test.ts) — see
// the 2026-07 VAD-supervisor review's findings #1/#2/#7. Not itself a
// test file (no .test.ts suffix), same convention as
// fakeSpeechRecognition.ts in this directory.

import { vi } from "vitest";

/** A fake MediaStreamTrack: real enough to exercise "ended" listeners
 *  and stop() bookkeeping without a real getUserMedia stream. */
export class FakeTrack extends EventTarget {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
  /** Test helper: simulate the OS/device revoking this track. */
  simulateEnded(): void {
    this.dispatchEvent(new Event("ended"));
  }
}

export class FakeMediaStream {
  private tracks: FakeTrack[];
  constructor(trackCount = 1) {
    this.tracks = Array.from({ length: trackCount }, () => new FakeTrack());
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

export class FakeAnalyserNode {
  fftSize = 1024;
  /** Constant amplitude fed into getFloatTimeDomainData — tests set
   *  this directly to simulate loud/quiet audio. 0 = digital silence
   *  (rms=0, the -Infinity-dB edge case findings #1 targets). */
  level = 0;
  getFloatTimeDomainData(buffer: Float32Array): void {
    buffer.fill(this.level);
  }
}

export class FakeAudioContext extends EventTarget {
  state: "running" | "suspended" | "closed" = "running";
  closeCalls = 0;
  analysers: FakeAnalyserNode[] = [];

  createMediaStreamSource(_stream: unknown): { connect: () => void } {
    return { connect: () => undefined };
  }
  createAnalyser(): AnalyserNode {
    const analyser = new FakeAnalyserNode();
    this.analysers.push(analyser);
    return analyser as unknown as AnalyserNode;
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = "closed";
    this.dispatchEvent(new Event("statechange"));
  }
  /** Test helper: simulate the context dying for a reason OTHER than
   *  our own close() (e.g. the OS suspending capture). */
  simulateClosedExternally(): void {
    this.state = "closed";
    this.dispatchEvent(new Event("statechange"));
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Installs a controllable navigator.mediaDevices.getUserMedia (one
 *  Deferred PER CALL, so a test can resolve call N independently of
 *  call N+1 — needed to drive stop/start races) and a window.
 *  AudioContext that records every FakeAudioContext instance it
 *  constructs. Call uninstallFakeMediaDevices() in afterEach. */
export function installFakeMediaDevices(): {
  gumCalls: Deferred<FakeMediaStream>[];
  audioContexts: FakeAudioContext[];
} {
  const gumCalls: Deferred<FakeMediaStream>[] = [];
  const audioContexts: FakeAudioContext[] = [];

  // Same defineProperty idiom as fakeSpeechRecognition.ts's
  // installFakeSpeechRecognition — vitest's "node" environment has no
  // real `window`/`navigator`, and Node's own built-in `navigator`
  // global (present since Node 21) is getter-only, so a plain
  // assignment would throw; defineProperty overrides it.
  if (typeof window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
      writable: true,
    });
  }
  const fakeWindow = window as unknown as Window & Record<string, unknown>;
  fakeWindow.AudioContext = class {
    constructor() {
      const ctx = new FakeAudioContext();
      audioContexts.push(ctx);
      return ctx as unknown as AudioContext;
    }
  };

  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        getUserMedia: vi.fn(() => {
          const d = deferred<FakeMediaStream>();
          gumCalls.push(d);
          return d.promise;
        }),
      },
    },
    configurable: true,
    writable: true,
  });

  return { gumCalls, audioContexts };
}

export function uninstallFakeMediaDevices(): void {
  const target = globalThis as typeof globalThis & {
    window?: Record<string, unknown>;
  };
  if (target.window) {
    // `AudioContext` (unlike SpeechRecognition/webkitSpeechRecognition
    // in fakeSpeechRecognition.ts's equivalent cleanup) is ALSO a real
    // ambient global lib.dom.d.ts declares — narrowing to a plain
    // Record here keeps `delete` valid regardless of that.
    const win = target.window as Record<string, unknown>;
    delete win.AudioContext;
  }
}
