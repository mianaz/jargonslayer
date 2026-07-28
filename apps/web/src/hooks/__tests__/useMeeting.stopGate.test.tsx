// @vitest-environment jsdom
//
// v0.7 stop gate (bilingual-pending End confirm): useMeeting.ts's
// stop() checks useApp.getState().translateStatus + settings.
// bilingualTranscript before tearing the meeting down — when bilingual
// is on, a translation batch is still pending, and the queue is busy
// or stalled, it parks the End behind a confirm sheet (`stopConfirm`,
// returned by the hook) instead of stopping and losing the tail.
// confirmStop("wait"/"now") both re-enter stop() with the confirm gate
// bypassed; "now" additionally skips doStop's bounded translate-queue
// drain. Same harness shape as useMeeting.lifecycle.test.tsx (real
// hook mounted via createRoot/act against a mocked createEngine — see
// that file's own header comment for the "no @testing-library"
// convention this repo follows); the TranslateQueue itself is NOT
// mocked (it's constructed for real inside start(), same as
// useMeeting.translateProvider.test.tsx) — the seam used to observe
// the stop-drain is a `vi.spyOn` on TranslateQueue.prototype.drain,
// which reaches whichever instance start() constructs since spyOn
// patches the shared prototype, not any one instance.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

type AnyEvents = { onStatus: (status: string, detail?: string) => void; [k: string]: unknown };

class FakeEngine {
  kind = "demo";
  events: AnyEvents | null = null;
  startResolve: (() => void) | null = null;
  private startP = new Promise<void>((r) => (this.startResolve = r));
  async start(events: AnyEvents): Promise<void> {
    this.events = events;
    await this.startP;
  }
  async stop(): Promise<void> {}
}

const engines: FakeEngine[] = [];
vi.mock("../../lib/stt", () => ({
  createEngine: vi.fn(() => {
    const e = new FakeEngine();
    engines.push(e);
    return e as unknown as import("@jargonslayer/core/types").STTEngine;
  }),
}));

import { useMeeting, type UseMeetingResult } from "../useMeeting";
import { useApp } from "../../lib/store";
import { TranslateQueue } from "../../lib/translate/queue";

let api: UseMeetingResult | null = null;
function Probe() {
  api = useMeeting();
  return null;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useMeeting — v0.7 stop gate (bilingual-pending End confirm)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let drainSpy: ReturnType<typeof vi.spyOn>;
  let stopSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    engines.length = 0;
    drainSpy = vi.spyOn(TranslateQueue.prototype, "drain");
    // Fix round (HIGH): doStop must call the queue's own stop() right
    // after the drain window (both the drained and skip-drain paths) —
    // spyOn the shared prototype, same reach-whichever-instance
    // rationale as drainSpy above.
    stopSpy = vi.spyOn(TranslateQueue.prototype, "stop");
    useApp.setState({
      status: "idle",
      segments: [],
      interim: null,
      pausedAccumMs: 0,
      pauseStartedAt: null,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
  });

  afterEach(() => {
    drainSpy.mockRestore();
    stopSpy.mockRestore();
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
    api = null;
  });

  /** start → engine live → listening — same shape as
   *  useMeeting.lifecycle.test.tsx's own startListening() helper. */
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

  function setBilingualPending(state: "busy" | "stalled", pending: number, reason?: string): void {
    useApp.setState((s) => ({
      settings: { ...s.settings, bilingualTranscript: true },
      translateStatus: { state, pending, reason },
    }));
  }

  it("bilingual on + busy pending>0 — stop() parks behind stopConfirm instead of stopping; cancelStop() clears it without stopping", async () => {
    await startListening();
    setBilingualPending("busy", 3);

    await act(async () => {
      await api!.stop();
    });

    expect(api!.stopConfirm).toEqual({ pending: 3, stalled: false });
    expect(useApp.getState().status).toBe("listening");

    await act(async () => {
      api!.cancelStop();
    });

    expect(api!.stopConfirm).toBeNull();
    expect(useApp.getState().status).toBe("listening");
  });

  it('confirmStop("wait") re-enters stop with the gate bypassed, actually stops, and drains the translate queue on the way', async () => {
    await startListening();
    setBilingualPending("busy", 3);

    await act(async () => {
      await api!.stop();
    });
    expect(api!.stopConfirm).not.toBeNull();

    await act(async () => {
      api!.confirmStop("wait");
      await flush();
      await flush();
    });

    expect(useApp.getState().status).toBe("stopped");
    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(api!.stopConfirm).toBeNull();
    // Fix round (HIGH): the queue must actually stop on End — a pending
    // debounced/paused batch must never fire after the meeting stops.
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('confirmStop("now") stops WITHOUT draining the translate queue', async () => {
    await startListening();
    setBilingualPending("stalled", 2);

    await act(async () => {
      await api!.stop();
    });
    expect(api!.stopConfirm).not.toBeNull();

    await act(async () => {
      api!.confirmStop("now");
      await flush();
      await flush();
    });

    expect(useApp.getState().status).toBe("stopped");
    expect(drainSpy).not.toHaveBeenCalled();
    // Fix round (HIGH): the skip-drain path must still stop the queue.
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("bilingual OFF — stop() goes straight through, no stopConfirm even with translations pending", async () => {
    await startListening();
    useApp.setState((s) => ({
      settings: { ...s.settings, bilingualTranscript: false },
      translateStatus: { state: "busy", pending: 5 },
    }));

    await act(async () => {
      await api!.stop();
      await flush();
      await flush();
    });

    expect(api!.stopConfirm).toBeNull();
    expect(useApp.getState().status).toBe("stopped");
  });

  it("pending 0 — stop() goes straight through even with bilingual on and the queue busy", async () => {
    await startListening();
    useApp.setState((s) => ({
      settings: { ...s.settings, bilingualTranscript: true },
      translateStatus: { state: "busy", pending: 0 },
    }));

    await act(async () => {
      await api!.stop();
      await flush();
      await flush();
    });

    expect(api!.stopConfirm).toBeNull();
    expect(useApp.getState().status).toBe("stopped");
  });

  it("stalled state — stopConfirm.stalled is true and threads the queue's own reason string", async () => {
    await startListening();
    setBilingualPending(
      "stalled",
      2,
      "未配置 API Key，双语转录已暂停。前往设置填入 Key 即可自动恢复",
    );

    await act(async () => {
      await api!.stop();
    });

    expect(api!.stopConfirm).toEqual({
      pending: 2,
      stalled: true,
      reason: "未配置 API Key，双语转录已暂停。前往设置填入 Key 即可自动恢复",
    });
    expect(useApp.getState().status).toBe("listening");
  });
});
