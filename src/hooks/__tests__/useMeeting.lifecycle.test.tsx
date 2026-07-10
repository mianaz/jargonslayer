// @vitest-environment jsdom
//
// Hook-level lifecycle races (codex review 2026-07-10, rounds 1+2):
// the engine-only cancellation tests can't see integration races, so
// these drive the REAL useMeeting hook (mounted via createRoot, per
// this repo's no-@testing-library pattern) against a mocked
// createEngine whose start()/stop() resolve under test control.
//
// Round-2 HIGHs locked down here:
//   1. End clicked while resume holds the lifecycle gate (permission
//      prompt pending) must NEVER be dropped — the pending-End intent
//      drains into a real stop, and the meeting must not flip to
//      "listening" on the way.
//   2. A FAILED resume on a zero-segment meeting lands on "idle" (the
//      engine error path) — resume must not resurrect it to
//      "listening" with no engine attached.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

type AnyEvents = {
  onStatus: (status: string, detail?: string) => void;
  [k: string]: unknown;
};

class FakeEngine {
  events: AnyEvents | null = null;
  startResolve: (() => void) | null = null;
  stopResolve: (() => void) | null = null;
  stopCalls = 0;
  private startP = new Promise<void>((r) => (this.startResolve = r));
  private stopP: Promise<void> | null = null;

  deferStop(): void {
    this.stopP = new Promise((r) => (this.stopResolve = r));
  }
  async start(events: AnyEvents): Promise<void> {
    this.events = events;
    await this.startP;
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopP) await this.stopP;
  }
}

const engines: FakeEngine[] = [];
vi.mock("../../lib/stt", () => ({
  createEngine: vi.fn(() => {
    const e = new FakeEngine();
    engines.push(e);
    return e as unknown as import("../../lib/types").STTEngine;
  }),
}));

import { useMeeting, type UseMeetingResult } from "../useMeeting";
import { useApp } from "../../lib/store";

let api: UseMeetingResult | null = null;
function Probe() {
  api = useMeeting();
  return null;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useMeeting — lifecycle races", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let statuses: string[] = [];
  let unsub: (() => void) | null = null;

  beforeEach(async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    engines.length = 0;
    statuses = [];
    useApp.setState({
      status: "idle",
      segments: [],
      interim: null,
      pausedAccumMs: 0,
      pauseStartedAt: null,
    });
    unsub = useApp.subscribe((s) => {
      if (statuses[statuses.length - 1] !== s.status) statuses.push(s.status);
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
  });

  afterEach(() => {
    unsub?.();
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
    api = null;
  });

  /** start → engine live → listening (drives the fake through the same
   *  events contract the real engines use). */
  async function startListening(): Promise<FakeEngine> {
    let p: Promise<void>;
    await act(async () => {
      p = api!.start();
      await flush();
      engines[0].startResolve!();
      await p;
      engines[0].events!.onStatus("listening");
    });
    expect(useApp.getState().status).toBe("listening");
    return engines[0];
  }

  it("End during resume's pending acquisition is never dropped, and never flips to listening", async () => {
    await startListening();
    await act(async () => {
      await api!.pause();
    });
    expect(useApp.getState().status).toBe("paused");

    let resumeP: Promise<void>;
    await act(async () => {
      resumeP = api!.resume();
      await flush();
      // Gate is held by resume (engine #2's start is pending — the
      // "permission prompt is open" moment). End lands NOW.
      await api!.stop();
      // Grant arrives after the user already ended.
      engines[1].startResolve!();
      await resumeP;
      await flush();
      await flush();
    });

    expect(useApp.getState().status).toBe("stopped");
    // The drained End must have stopped the just-attached engine.
    expect(engines[1].stopCalls).toBeGreaterThan(0);
    // The meeting never resurfaced as listening after the pause.
    expect(statuses.slice(statuses.indexOf("paused"))).not.toContain("listening");
  });

  it("a FAILED resume on an empty meeting stays idle — no engineless 'listening'", async () => {
    await startListening();
    await act(async () => {
      await api!.pause();
    });

    await act(async () => {
      const resumeP = api!.resume();
      await flush();
      // Engine errors while attaching (e.g. permission denied); the
      // engine error path runs runStopFlow → zero segments → "idle".
      engines[1].events!.onStatus("error", "denied");
      await flush();
      engines[1].startResolve!();
      await resumeP;
      await flush();
    });

    expect(useApp.getState().status).toBe("idle");
    expect(statuses.slice(statuses.indexOf("paused"))).not.toContain("listening");
  });

  it("double-pause is a no-op — one accounting stamp, engine stopped once", async () => {
    const engine = await startListening();
    engine.deferStop();

    await act(async () => {
      const p1 = api!.pause();
      await flush();
      const stampAfterFirst = useApp.getState().pauseStartedAt;
      const p2 = api!.pause(); // gate-held → no-op
      await flush();
      expect(useApp.getState().pauseStartedAt).toBe(stampAfterFirst);
      engine.stopResolve!();
      await p1;
      await p2;
    });

    expect(useApp.getState().status).toBe("paused");
    expect(engine.stopCalls).toBe(1);
    expect(useApp.getState().pausedAccumMs).toBe(0);
  });

  it("End during pause's teardown drains into a real stop (not a paused zombie)", async () => {
    const engine = await startListening();
    engine.deferStop();

    await act(async () => {
      const p1 = api!.pause();
      await flush();
      await api!.stop(); // gate-held → records the End intent
      engine.stopResolve!();
      await p1;
      await flush();
      await flush();
    });

    expect(useApp.getState().status).toBe("stopped");
  });
});
