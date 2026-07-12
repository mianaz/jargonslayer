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

// Soft-pause capable fake (STT protocol v2, e.g. tabaudio): adds
// pause()/resume(). useMeeting.ts branches on `engineRef.current?.
// pause`/`?.resume` PURELY by property presence at call time — a
// plain FakeEngine (no pause/resume at all) always takes the teardown
// branch, so every existing test below is untouched by this addition.
class FakeSoftPauseEngine extends FakeEngine {
  pauseCalls = 0;
  resumeCalls = 0;
  pauseResolve: (() => void) | null = null;
  resumeResolve: (() => void) | null = null;
  private pauseP: Promise<void> | null = null;
  private resumeP: Promise<void> | null = null;

  deferPause(): void {
    this.pauseP = new Promise((r) => (this.pauseResolve = r));
  }
  deferResume(): void {
    this.resumeP = new Promise((r) => (this.resumeResolve = r));
  }
  async pause(): Promise<void> {
    this.pauseCalls += 1;
    if (this.pauseP) await this.pauseP;
  }
  async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.resumeP) await this.resumeP;
  }
}

const engines: FakeEngine[] = [];
// Which class createEngine() constructs next — FakeEngine (teardown-
// only) by default; startListeningSoft() below points this at
// FakeSoftPauseEngine for exactly one call, then restores it
// immediately (createEngine() runs synchronously within that same
// call — see startListeningSoft's own comment).
let nextEngineClass: new () => FakeEngine = FakeEngine;
vi.mock("../../lib/stt", () => ({
  createEngine: vi.fn(() => {
    const e = new nextEngineClass();
    engines.push(e);
    return e as unknown as import("@jargonslayer/core/types").STTEngine;
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

  /** Same as startListening(), but the engine createEngine() builds
   *  supports soft pause/resume (STT protocol v2) — i.e. useMeeting's
   *  pause()/resume() take the SOFT branch instead of teardown. */
  async function startListeningSoft(): Promise<FakeSoftPauseEngine> {
    let p: Promise<void>;
    await act(async () => {
      nextEngineClass = FakeSoftPauseEngine;
      p = api!.start();
      // createEngine() has already run synchronously as part of the
      // call above (before start()'s first await) — safe to restore
      // immediately so this override never leaks into a later start().
      nextEngineClass = FakeEngine;
      await flush();
      engines[0].startResolve!();
      await p;
      engines[0].events!.onStatus("listening");
    });
    expect(useApp.getState().status).toBe("listening");
    return engines[0] as FakeSoftPauseEngine;
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

  it("a pending End suppresses the resumed engine's own 'listening' emission", async () => {
    await startListening();
    await act(async () => {
      await api!.pause();
    });

    await act(async () => {
      const resumeP = api!.resume();
      await flush();
      await api!.stop(); // End intent recorded while resume holds the gate
      // The engine warms up and reports listening BEFORE start()
      // resolves — after an End this must be ignored, not stored.
      engines[1].events!.onStatus("listening");
      engines[1].startResolve!();
      await resumeP;
      await flush();
      await flush();
    });

    expect(useApp.getState().status).toBe("stopped");
    expect(statuses.slice(statuses.indexOf("paused"))).not.toContain("listening");
  });

  it("failed resume with SLOW error teardown never folds — attach success is explicit", async () => {
    await startListening();
    await act(async () => {
      await api!.pause();
    });

    await act(async () => {
      const resumeP = api!.resume();
      await flush();
      // Error teardown hangs on engine.stop() while start() resolves
      // first — global status still reads "paused" at that moment, so
      // only the explicit attach-failure signal can prevent the fold.
      engines[1].deferStop();
      engines[1].events!.onStatus("error", "denied");
      engines[1].startResolve!();
      await resumeP;
      await flush();
      expect(useApp.getState().status).not.toBe("listening");
      engines[1].stopResolve!();
      await flush();
      await flush();
    });

    expect(useApp.getState().status).toBe("idle");
    expect(statuses.slice(statuses.indexOf("paused"))).not.toContain("listening");
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

  // ---------------------------------------------------------------
  // Soft pause/resume (STT protocol v2, B4): an engine exposing
  // pause()/resume() (tabaudio) is KEPT alive across a pause instead
  // of torn down + reattached — see useMeeting.ts's pause()/resume()
  // and Header.tsx's canPause matrix.
  // ---------------------------------------------------------------

  it("soft-pause keeps the SAME engine instance alive and flips status to paused", async () => {
    const engine = await startListeningSoft();

    await act(async () => {
      await api!.pause();
    });

    expect(useApp.getState().status).toBe("paused");
    expect(engine.pauseCalls).toBe(1);
    expect(engine.stopCalls).toBe(0); // NOT torn down — the soft branch
    expect(engines.length).toBe(1); // no new engine constructed by pause()
  });

  it("an engine 'listening'/'connecting' event while soft-paused does NOT un-pause the UI", async () => {
    const engine = await startListeningSoft();
    await act(async () => {
      await api!.pause();
    });
    expect(useApp.getState().status).toBe("paused");

    // e.g. a transient ws reconnect on the still-alive tabaudio
    // transport — must be ignored while soft-paused, not un-pause it.
    await act(async () => {
      engine.events!.onStatus("listening");
    });
    expect(useApp.getState().status).toBe("paused");

    await act(async () => {
      engine.events!.onStatus("connecting");
    });
    expect(useApp.getState().status).toBe("paused");
  });

  it("End while soft-paused stops the SAME engine and lands on stopped", async () => {
    const engine = await startListeningSoft();
    await act(async () => {
      await api!.pause();
    });

    await act(async () => {
      await api!.stop();
    });

    expect(useApp.getState().status).toBe("stopped");
    expect(engine.stopCalls).toBe(1);
  });

  it("resume() calls engine.resume() in place (no reattach) and folds accounting via resumeMeeting", async () => {
    const engine = await startListeningSoft();
    await act(async () => {
      await api!.pause();
    });

    await act(async () => {
      await api!.resume();
    });

    expect(engine.resumeCalls).toBe(1);
    expect(useApp.getState().status).toBe("listening");
    expect(engines.length).toBe(1); // still the SAME engine — no reattach
  });

  it("End during soft-pause's own await drains into a real stop (not a paused zombie)", async () => {
    const engine = await startListeningSoft();
    engine.deferPause();

    await act(async () => {
      const p1 = api!.pause();
      await flush();
      await api!.stop(); // gate-held → records the End intent
      engine.pauseResolve!();
      await p1;
      await flush();
      await flush();
    });

    expect(useApp.getState().status).toBe("stopped");
    expect(engine.stopCalls).toBe(1);
  });

  it("End during soft-resume's own await drains into a real stop afterward", async () => {
    const engine = await startListeningSoft();
    await act(async () => {
      await api!.pause();
    });
    engine.deferResume();

    await act(async () => {
      const p1 = api!.resume();
      await flush();
      await api!.stop(); // gate-held → pendingEnd, mirrors the teardown-branch guard
      engine.resumeResolve!();
      await p1;
      await flush();
      await flush();
    });

    expect(useApp.getState().status).toBe("stopped");
    expect(engine.stopCalls).toBe(1);
    // resumeMeeting() must NOT have folded accounting on the way — the
    // pendingEnd guard should have suppressed it.
    expect(statuses.slice(statuses.indexOf("paused"))).not.toContain("listening");
  });
});
