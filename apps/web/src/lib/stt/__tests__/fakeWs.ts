// Shared WebSocket + minimal AudioWorklet-graph fakes for testing
// wsTransport.ts directly (wsTransport.test.ts). Not itself a test
// file (no .test.ts suffix), same convention as fakeMedia.ts/
// fakeSpeechRecognition.ts in this directory. wsTransport.ts's source
// references `WebSocket`/`AudioContext`/`AudioWorkletNode` as BARE
// globals (not `window.*`, unlike vad.ts — see fakeMedia.ts's own
// AudioContext polyfill, which patches `window.AudioContext` and
// relies on `window === globalThis` in a real browser), so these
// install straight onto `globalThis`.

import { vi } from "vitest";

// ---------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------

type MessageLike = { data: unknown };

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every constructed instance, in construction order — reset by
   *  installFakeWebSocket() each call. */
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  sent: (string | ArrayBuffer)[] = [];
  closeCalls = 0;

  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageLike) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  // v0.4.7 Lane D: deepgramTransport.ts authenticates via the WS
  // handshake's Sec-WebSocket-Protocol (`new WebSocket(url, ["token",
  // apiKey])`), unlike Soniox/whisper's 1-arg `new WebSocket(url)` — this
  // optional 2nd param is purely additive (defaults to []), so every
  // existing 1-arg call site (wsTransport.ts/sonioxTransport.ts and their
  // own tests) keeps constructing/asserting identically.
  constructor(
    public url: string,
    public protocols: string | string[] = [],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    // Real WebSocket.close() dispatches "close" asynchronously; this
    // fake fires onclose synchronously (deterministic tests > exact
    // async fidelity here), which every test in this suite accounts
    // for by reading state right after calling stop()/close().
    this.onclose?.();
  }

  // ---- test-only helpers, never called by wsTransport.ts itself ----

  /** Simulate the server accepting the connection. */
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Simulate one JSON text frame arriving from the server. */
  simulateMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** Simulate the connection dropping on its own (server crash,
   *  network loss) — NOT a client-initiated close(). */
  simulateServerClose(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

/** Installs `globalThis.WebSocket = FakeWebSocket` and resets the
 *  instance-tracking array. Call uninstallFakeWebSocket() in
 *  afterEach. */
export function installFakeWebSocket(): { instances: FakeWebSocket[] } {
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", {
    value: FakeWebSocket,
    configurable: true,
    writable: true,
  });
  return { instances: FakeWebSocket.instances };
}

export function uninstallFakeWebSocket(): void {
  Object.defineProperty(globalThis, "WebSocket", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

// ---------------------------------------------------------------
// Minimal AudioContext / AudioWorkletNode graph — just enough for
// WsTransport.attachStream()'s exact call sequence (see wsTransport.
// ts): new AudioContext() -> ctx.audioWorklet.addModule() ->
// ctx.createMediaStreamSource() -> new AudioWorkletNode(ctx, name) ->
// (worklet).connect()/ctx.createGain()/.connect() chain -> ctx.close().
// ---------------------------------------------------------------

export class FakeAudioWorkletPort {
  onmessage: ((ev: MessageLike) => void) | null = null;
  postMessage(): void {}
}

export class FakeAudioWorkletNode {
  port = new FakeAudioWorkletPort();
  connect(): void {}
  disconnect(): void {}
  constructor(
    public ctx: unknown,
    public name: string,
  ) {}
}

class FakeGainNode {
  gain = { value: 1 };
  connect(): void {}
  disconnect(): void {}
}

class FakeMediaStreamAudioSourceNode {
  connect(): void {}
  disconnect(): void {}
}

export class FakeAudioContext {
  destination = {};
  audioWorklet = { addModule: vi.fn(() => Promise.resolve()) };
  closeCalls = 0;

  createMediaStreamSource(_stream: unknown): FakeMediaStreamAudioSourceNode {
    return new FakeMediaStreamAudioSourceNode();
  }
  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

/** Installs `globalThis.AudioContext` + `globalThis.AudioWorkletNode`
 *  and returns the live tracking arrays of every instance constructed
 *  (so a test can reach into `workletNodes[N].port.onmessage(...)` to
 *  simulate a delivered PCM chunk, or assert `contexts.length === 0` to
 *  prove a codepath built no audio graph at all — see wsTransport.ts's
 *  attachPcmFeed()/appAudio.test.ts's own "no AudioContext" coverage).
 *  Call uninstallFakeAudioGraph() in afterEach. */
export function installFakeAudioGraph(): {
  workletNodes: FakeAudioWorkletNode[];
  contexts: FakeAudioContext[];
} {
  const workletNodes: FakeAudioWorkletNode[] = [];
  const contexts: FakeAudioContext[] = [];

  Object.defineProperty(globalThis, "AudioContext", {
    value: class extends FakeAudioContext {
      constructor() {
        super();
        contexts.push(this);
      }
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    value: class extends FakeAudioWorkletNode {
      constructor(ctx: unknown, name: string) {
        super(ctx, name);
        workletNodes.push(this);
      }
    },
    configurable: true,
    writable: true,
  });

  return { workletNodes, contexts };
}

export function uninstallFakeAudioGraph(): void {
  Object.defineProperty(globalThis, "AudioContext", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

/** A MediaStream stand-in — WsTransport.attachStream() only ever
 *  passes it straight into createMediaStreamSource(), which this
 *  fake's FakeAudioContext ignores entirely. */
export function fakeMediaStream(): MediaStream {
  return {} as MediaStream;
}
