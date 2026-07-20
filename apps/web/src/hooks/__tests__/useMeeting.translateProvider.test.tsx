// @vitest-environment jsdom
//
// v0.5 Wave-1 Feature 6 / A6 (docs/design-explorations/
// v05-wave1-blueprint.md §1 Feature 6 + §5 A6) — end-to-end proof that
// useMeeting.ts's start() calls the resolved TranslationProvider's
// prepare() SYNCHRONOUSLY, inside the SAME call stack a real Start
// click produces (Header.tsx:596 `onClick={onStart}` -> onStart =
// `() => void start()` in page.tsx — a plain synchronous handler, no
// intervening await), before attachEngine's own engine.start() call.
// Drives the REAL useMeeting hook (mounted via createRoot, per this
// repo's no-@testing-library pattern), same harness shape as
// useMeeting.lifecycle.test.tsx.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

type AnyEvents = { onStatus: (status: string, detail?: string) => void; [k: string]: unknown };

const callOrder: string[] = [];

class FakeEngine {
  kind = "demo";
  events: AnyEvents | null = null;
  startResolve: (() => void) | null = null;
  private startP = new Promise<void>((r) => (this.startResolve = r));
  async start(events: AnyEvents): Promise<void> {
    // Pushed as the FIRST line of the fake's own start() — mirrors
    // every real STTEngine.start() implementation's own first
    // synchronous statements, so "this fired after prepare()" is a
    // faithful proxy for "prepare() ran before attachEngine's own
    // engine.start() call".
    callOrder.push("engine.start() called");
    this.events = events;
    await this.startP;
  }
  async stop(): Promise<void> {}
}

let engine: FakeEngine | null = null;
vi.mock("../../lib/stt", () => ({
  createEngine: vi.fn(() => {
    engine = new FakeEngine();
    return engine as unknown as import("@jargonslayer/core/types").STTEngine;
  }),
}));

import { useMeeting, type UseMeetingResult } from "../useMeeting";
import { useApp } from "../../lib/store";

let api: UseMeetingResult | null = null;
function Probe() {
  api = useMeeting();
  return null;
}

interface FakeTranslatorApi {
  availability: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
}

function installFakeTranslator(): FakeTranslatorApi {
  const fake: FakeTranslatorApi = {
    availability: vi.fn().mockResolvedValue("available"),
    create: vi.fn(() => {
      callOrder.push("Translator.create() called");
      return new Promise(() => {}); // never settles — irrelevant to ordering
    }),
  };
  (window as unknown as { Translator?: unknown }).Translator = fake;
  return fake;
}

describe("useMeeting start() — TranslationProvider.prepare() ordering (A6)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    callOrder.length = 0;
    engine = null;
    useApp.setState({ status: "idle", segments: [], interim: null, pausedAccumMs: 0, pauseStartedAt: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
    api = null;
    delete (window as unknown as { Translator?: unknown }).Translator;
  });

  it("translateEngine:'system' — Translator.create() fires BEFORE engine.start(), within start()'s own synchronous call (no await needed to observe it)", () => {
    installFakeTranslator();
    useApp.setState((s) => ({ settings: { ...s.settings, translateEngine: "system" } }));

    act(() => {
      // Exactly what a real click does: a synchronous call, result
      // voided (Header.tsx's own onClick={() => void start()}).
      void api!.start();
    });

    expect(callOrder).toEqual(["Translator.create() called", "engine.start() called"]);
  });

  it("translateEngine:'llm' (default) — prepare() is a no-op: no Translator.create() call, start() still reaches engine.start() normally", () => {
    const fake = installFakeTranslator();

    act(() => {
      void api!.start();
    });

    expect(fake.create).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["engine.start() called"]);
  });
});
