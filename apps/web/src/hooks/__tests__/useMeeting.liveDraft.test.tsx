// @vitest-environment jsdom
//
// useMeeting — live draft persistence interval (M1 field fix, Sol
// adversarial-review): the routine write path is an INTERVAL loop, not
// a segments/cards-count-reactive effect, so a translation-only change
// (no new segment, no new card) inside one interval still gets
// persisted — see liveDraft.ts's own computeDraftSignature doc for what
// counts as "dirty". Drives the REAL useMeeting hook (createRoot, per
// this repo's no-@testing-library pattern), mirroring useMeeting.
// lifecycle.test.tsx/sonioxPreviewLane.test.tsx's own harness shape,
// trimmed to just this one seam — liveDraft.writeDraft itself is
// spied (not the whole module) so the interval's OWN dirty-check logic
// is what's under test, independent of real IndexedDB.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import * as liveDraftModule from "../../lib/history/liveDraft";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";

type AnyEvents = {
  onStatus: (status: string, detail?: string) => void;
  onInterim: (text: string, speaker?: string) => void;
  [k: string]: unknown;
};

class FakeEngine {
  kind = "webspeech";
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

let api: UseMeetingResult | null = null;
function Probe() {
  api = useMeeting();
  return null;
}

// A real setTimeout-based flush (lifecycle.test.tsx's own helper) never
// resolves once vi.useFakeTimers() is active (below) — advancing the
// fake clock by 0 both flushes pending microtasks AND lets any
// already-queued fake timers fire, which is what actually lets the
// FakeEngine's start()/stop() promise chains settle here.
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("useMeeting — live draft persistence interval (M1 field fix)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let writeDraftSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    engines.length = 0;
    vi.useFakeTimers();
    useApp.setState({
      status: "idle",
      segments: [],
      interim: null,
      translations: {},
      cards: [],
      terms: [],
      settings: { ...DEFAULT_SETTINGS, engine: "webspeech" },
    });
    writeDraftSpy = vi.spyOn(liveDraftModule, "writeDraft").mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    container?.remove();
    container = null;
    api = null;
    writeDraftSpy.mockRestore();
    vi.useRealTimers();
  });

  async function startListening(): Promise<void> {
    let p: Promise<void>;
    await act(async () => {
      p = api!.start();
      await flush();
      engines[0].startResolve!();
      await p;
      engines[0].events!.onStatus("listening");
    });
  }

  it("persists on the first interval tick once a segment exists, then persists a translation-only change on the NEXT tick even though segment/card counts never moved", async () => {
    await startListening();

    act(() => {
      useApp.setState({
        segments: [
          { id: "seg-1", index: 0, startedAt: Date.now(), endedAt: Date.now(), text: "hello there", engine: "webspeech" },
        ],
      });
    });
    expect(writeDraftSpy).not.toHaveBeenCalled(); // interval hasn't ticked yet

    await act(async () => {
      await vi.advanceTimersByTimeAsync(liveDraftModule.DRAFT_WRITE_INTERVAL_MS);
    });
    expect(writeDraftSpy).toHaveBeenCalledTimes(1);

    writeDraftSpy.mockClear();

    // Translation-only mutation — no new segment, no new card — is
    // exactly the gap the OLD segments/cards-count-reactive effect
    // missed within one write window.
    act(() => {
      useApp.getState().applyTranslations({ "seg-1": "你好" }, useApp.getState().meetingGen);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(liveDraftModule.DRAFT_WRITE_INTERVAL_MS);
    });

    expect(writeDraftSpy).toHaveBeenCalledTimes(1);
    const [, snapshot] = writeDraftSpy.mock.calls[0];
    expect((snapshot as { translations?: Record<string, string> }).translations).toEqual({
      "seg-1": "你好",
    });
  });

  it("does NOT write again on the next tick when nothing changed (the dirty signature is unchanged)", async () => {
    await startListening();
    act(() => {
      useApp.setState({
        segments: [
          { id: "seg-1", index: 0, startedAt: Date.now(), endedAt: Date.now(), text: "hello", engine: "webspeech" },
        ],
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(liveDraftModule.DRAFT_WRITE_INTERVAL_MS);
    });
    expect(writeDraftSpy).toHaveBeenCalledTimes(1);

    writeDraftSpy.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(liveDraftModule.DRAFT_WRITE_INTERVAL_MS);
    });
    expect(writeDraftSpy).not.toHaveBeenCalled();
  });

  it("stops ticking once the meeting is no longer draftable (status leaves listening/paused/connecting)", async () => {
    await startListening();
    act(() => {
      useApp.setState({
        segments: [
          { id: "seg-1", index: 0, startedAt: Date.now(), endedAt: Date.now(), text: "hello", engine: "webspeech" },
        ],
        status: "stopped",
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(liveDraftModule.DRAFT_WRITE_INTERVAL_MS * 2);
    });

    expect(writeDraftSpy).not.toHaveBeenCalled();
  });
});
