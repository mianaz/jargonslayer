// captureController.ts's whole point is to be testable without a real
// browser (blueprint Decision A's event-source seam): every test here
// drives a hand-scripted fake STTEngine (captures the STTEvents object
// passed to start() so the test can fire onFinal/onInterim/onStatus
// itself) plus injected permission fns and an injected saveSession —
// no jsdom, no real Chrome/Web Speech/IndexedDB globals, matching
// vitest.config.ts's plain node-env posture.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type STTEngine, type STTEvents, type Settings } from "@jargonslayer/core/types";

import type { AccumulatorSnapshot } from "../../detect/accumulator";
import type { LiteSession } from "../../storage/history";
import { CaptureController, SAVE_FAILED_NOTICE, UNSUPPORTED_NOTICE } from "../captureController";

// ---- scripted fake engine ----------------------------------------

interface FakeEngineHandle {
  engine: STTEngine;
  getEvents: () => STTEvents;
  getSettings: () => Settings;
  startCalls: number;
  stopCalls: number;
}

function createFakeEngine(): FakeEngineHandle {
  let capturedEvents: STTEvents | null = null;
  let capturedSettings: Settings | null = null;
  const handle: FakeEngineHandle = {
    engine: {
      kind: "webspeech",
      async start(events, settings) {
        handle.startCalls += 1;
        capturedEvents = events;
        capturedSettings = settings;
      },
      async stop() {
        handle.stopCalls += 1;
      },
    },
    getEvents: () => {
      if (!capturedEvents) throw new Error("engine.start() was never called");
      return capturedEvents;
    },
    getSettings: () => {
      if (!capturedSettings) throw new Error("engine.start() was never called");
      return capturedSettings;
    },
    startCalls: 0,
    stopCalls: 0,
  };
  return handle;
}

function createCallbackSpies() {
  return {
    onStatusChange: vi.fn(),
    onTranscriptChange: vi.fn(),
    onCardsChange: vi.fn(),
    onPrivacyMode: vi.fn(),
    onGrantNeeded: vi.fn(),
    onNotice: vi.fn(),
    onSaved: vi.fn(),
  };
}

interface ControllerHarnessOptions {
  permissionState?: PermissionState | "unknown";
  detectSupport?: () => boolean;
  fakeEngine?: FakeEngineHandle;
  /** Defaults to an always-resolving no-op — F2's save-failure tests
   *  inject a rejecting implementation instead. */
  saveSession?: (session: LiteSession) => Promise<void>;
}

function createHarness(opts: ControllerHarnessOptions = {}) {
  const callbacks = createCallbackSpies();
  const fakeEngine = opts.fakeEngine ?? createFakeEngine();
  const engineFactory = vi.fn(() => fakeEngine.engine);
  const saveSessionSpy = vi.fn(opts.saveSession ?? (async (_session: LiteSession) => {}));
  const permissionState: PermissionState | "unknown" = opts.permissionState ?? "granted";
  // Plain function, not vi.fn() — nothing here asserts on its call
  // history, and this file's OWN "granted" literal (below) has no
  // contextual type without a target annotation, so leaving it a
  // bare `permissionState`-typed const + function keeps it correct
  // without one.
  const queryMicPermissionImpl = (): Promise<PermissionState | "unknown"> =>
    Promise.resolve(permissionState);
  const controller = new CaptureController({
    callbacks,
    createEngine: engineFactory,
    saveSession: saveSessionSpy,
    queryMicPermission: queryMicPermissionImpl,
    detectSpeechRecognitionSupport: opts.detectSupport ?? (() => true),
  });
  return { controller, callbacks, fakeEngine, engineFactory, saveSessionSpy };
}

/** handleStatus's terminal-error teardown (F1) is deliberately
 *  fire-and-forget — STTEvents.onStatus is a synchronous callback, so
 *  the async engine.stop()/saveSession work it kicks off runs on its
 *  own microtask chain. Tests that assert on its effects yield back to
 *  the event loop once (a macrotask boundary, so ALL pending
 *  microtasks — however many awaits deep — have already settled) before
 *  asserting. */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("CaptureController", () => {
  describe("unsupported browser (feature-detection gate)", () => {
    it("degrades to the 浏览器不支持 notice using the REAL default detector (no window in node)", async () => {
      const callbacks = createCallbackSpies();
      const engineFactory = vi.fn(() => createFakeEngine().engine);
      const controller = new CaptureController({
        callbacks,
        createEngine: engineFactory,
        queryMicPermission: vi.fn(async (): Promise<PermissionState | "unknown"> => "granted"),
        // detectSpeechRecognitionSupport deliberately NOT overridden —
        // proves the real default correctly treats "no window" as
        // unsupported.
      });

      await controller.start();

      expect(engineFactory).not.toHaveBeenCalled();
      expect(callbacks.onStatusChange).toHaveBeenCalledWith("unsupported", UNSUPPORTED_NOTICE);
      expect(callbacks.onGrantNeeded).not.toHaveBeenCalled();
    });

    it("also honors an explicitly injected unsupported detector", async () => {
      const { controller, callbacks, engineFactory } = createHarness({ detectSupport: () => false });

      await controller.start();

      expect(engineFactory).not.toHaveBeenCalled();
      expect(callbacks.onStatusChange).toHaveBeenCalledWith("unsupported", UNSUPPORTED_NOTICE);
    });
  });

  describe("mic permission gating", () => {
    it('"prompt" shows the grant affordance and does NOT start the engine', async () => {
      const { controller, callbacks, fakeEngine, engineFactory } = createHarness({
        permissionState: "prompt",
      });

      await controller.start();

      expect(callbacks.onGrantNeeded).toHaveBeenCalledTimes(1);
      expect(engineFactory).not.toHaveBeenCalled();
      expect(fakeEngine.startCalls).toBe(0);
      expect(callbacks.onStatusChange).not.toHaveBeenCalledWith("listening", undefined);
    });

    it('"denied" also funnels into the grant affordance (blueprint §7 has no separate panel copy for it)', async () => {
      const { controller, callbacks, engineFactory } = createHarness({ permissionState: "denied" });

      await controller.start();

      expect(callbacks.onGrantNeeded).toHaveBeenCalledTimes(1);
      expect(engineFactory).not.toHaveBeenCalled();
    });

    it('"granted" starts the engine with {...DEFAULT_SETTINGS, language: "en-US", preferOnDeviceSpeech: true}', async () => {
      const { controller, callbacks, fakeEngine } = createHarness({ permissionState: "granted" });

      await controller.start();

      expect(fakeEngine.startCalls).toBe(1);
      expect(callbacks.onGrantNeeded).not.toHaveBeenCalled();
      expect(fakeEngine.getSettings()).toEqual({
        ...DEFAULT_SETTINGS,
        language: "en-US",
        preferOnDeviceSpeech: true,
      });
    });

    it('"unknown" optimistically starts (try-then-catch fallback)', async () => {
      const { controller, fakeEngine } = createHarness({ permissionState: "unknown" });

      await controller.start();

      expect(fakeEngine.startCalls).toBe(1);
    });

    it("resets to an empty transcript/cards state right as a new session starts", async () => {
      const { controller, callbacks } = createHarness();

      await controller.start();

      expect(callbacks.onTranscriptChange).toHaveBeenCalledWith([], "");
      expect(callbacks.onCardsChange).toHaveBeenCalledWith({ cards: [], terms: [] });
    });

    it("propagates engine onStatus('listening')", async () => {
      const { controller, callbacks, fakeEngine } = createHarness();

      await controller.start();
      fakeEngine.getEvents().onStatus("listening");

      expect(callbacks.onStatusChange).toHaveBeenCalledWith("listening", undefined);
    });

    it("propagates engine onEngineMode to onPrivacyMode", async () => {
      const { controller, callbacks, fakeEngine } = createHarness();

      await controller.start();
      fakeEngine.getEvents().onEngineMode?.("on-device");

      expect(callbacks.onPrivacyMode).toHaveBeenCalledWith("on-device");
    });
  });

  describe("finalized segments -> transcript + accumulator", () => {
    it("accumulates segments and dictionary cards/terms across multiple finals", async () => {
      const { controller, callbacks, fakeEngine } = createHarness();
      await controller.start();
      const events = fakeEngine.getEvents();

      events.onFinal("Let's circle back on this next week.");
      const firstCall = callbacks.onTranscriptChange.mock.calls.at(-1)!;
      expect(firstCall[0]).toEqual([
        { text: "Let's circle back on this next week.", startedAt: expect.any(Number) },
      ]);
      expect(firstCall[1]).toBe("");

      const firstSnapshot = callbacks.onCardsChange.mock.calls.at(-1)![0] as AccumulatorSnapshot;
      expect(firstSnapshot.cards.some((c) => c.expression === "circle back")).toBe(true);
      expect(firstSnapshot.cards.find((c) => c.expression === "circle back")?.count).toBe(1);

      events.onFinal("The ARR grew nicely this quarter.");
      const secondCall = callbacks.onTranscriptChange.mock.calls.at(-1)!;
      expect(secondCall[0]).toHaveLength(2);

      const secondSnapshot = callbacks.onCardsChange.mock.calls.at(-1)![0] as AccumulatorSnapshot;
      expect(secondSnapshot.terms.some((t) => t.term === "ARR")).toBe(true);

      events.onFinal("We should circle back again tomorrow.");
      const thirdSnapshot = callbacks.onCardsChange.mock.calls.at(-1)![0] as AccumulatorSnapshot;
      expect(thirdSnapshot.cards.find((c) => c.expression === "circle back")?.count).toBe(2);
    });

    it("a final retires whatever interim line preceded it", async () => {
      const { controller, callbacks, fakeEngine } = createHarness();
      await controller.start();
      const events = fakeEngine.getEvents();

      events.onInterim("Let's circle");
      expect(callbacks.onTranscriptChange.mock.calls.at(-1)![1]).toBe("Let's circle");

      events.onFinal("Let's circle back.");
      expect(callbacks.onTranscriptChange.mock.calls.at(-1)![1]).toBe("");
    });

    it("onNotice passes the steer message through unchanged", async () => {
      const { controller, callbacks, fakeEngine } = createHarness();
      await controller.start();

      fakeEngine.getEvents().onNotice?.("一直在说话但识别不出，可能语言不匹配，试试本地 Whisper 或标签页音频模式");

      expect(callbacks.onNotice).toHaveBeenCalledWith(
        "一直在说话但识别不出，可能语言不匹配，试试本地 Whisper 或标签页音频模式",
      );
    });
  });

  describe("mic permission revoked mid-session", () => {
    const MIC_DENIED_DETAIL = "麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问";

    it("not-allowed/service-not-allowed's onStatus('error', …) triggers the grant affordance", async () => {
      const { controller, callbacks, fakeEngine } = createHarness();
      await controller.start();

      fakeEngine.getEvents().onStatus("error", MIC_DENIED_DETAIL);

      expect(callbacks.onStatusChange).toHaveBeenCalledWith("error", MIC_DENIED_DETAIL);
      expect(callbacks.onGrantNeeded).toHaveBeenCalledTimes(1);
    });

    it("other error details do not trigger the grant affordance", async () => {
      const { controller, callbacks, fakeEngine } = createHarness();
      await controller.start();

      fakeEngine
        .getEvents()
        .onStatus("error", "语音识别网络错误，Web Speech 需要联网，可切换到本地 Whisper 引擎");

      expect(callbacks.onGrantNeeded).not.toHaveBeenCalled();
    });
  });

  // F1 (blocker): pre-fix, a terminal engine error left isActive=true and
  // the engine (mic/VAD/AudioContext/watchdog) alive forever — every
  // subsequent start() silently no-op'd. This is the regression test:
  // verified to fail on pre-fix code (git stash captureController.ts's
  // fix and re-run — engineFactory's second call count stays 1, not 2).
  describe("terminal engine error tears down + restores retry (F1)", () => {
    const MIC_DENIED_DETAIL = "麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问";

    it("stops the engine, auto-saves captured segments, and a SUBSEQUENT start() succeeds", async () => {
      const { controller, callbacks, fakeEngine, saveSessionSpy, engineFactory } = createHarness();
      await controller.start();
      fakeEngine.getEvents().onFinal("Let's circle back on this.");

      fakeEngine.getEvents().onStatus("error", MIC_DENIED_DETAIL);
      await flushAsync();

      expect(fakeEngine.stopCalls).toBe(1);
      expect(saveSessionSpy).toHaveBeenCalledTimes(1);
      expect(saveSessionSpy.mock.calls[0][0].segments).toEqual([
        { text: "Let's circle back on this.", startedAt: expect.any(Number) },
      ]);
      expect(callbacks.onSaved).toHaveBeenCalledTimes(1);
      expect(callbacks.onGrantNeeded).toHaveBeenCalledTimes(1);

      const secondEngine = createFakeEngine();
      engineFactory.mockReturnValue(secondEngine.engine);
      await controller.start();

      expect(engineFactory).toHaveBeenCalledTimes(2);
      expect(secondEngine.startCalls).toBe(1);
    });

    it("a non mic-denial terminal error (e.g. network) also tears down without the grant affordance", async () => {
      const { controller, callbacks, fakeEngine, engineFactory } = createHarness();
      await controller.start();

      fakeEngine
        .getEvents()
        .onStatus("error", "语音识别网络错误，Web Speech 需要联网，可切换到本地 Whisper 引擎");
      await flushAsync();

      expect(fakeEngine.stopCalls).toBe(1);
      expect(callbacks.onGrantNeeded).not.toHaveBeenCalled();

      const secondEngine = createFakeEngine();
      engineFactory.mockReturnValue(secondEngine.engine);
      await controller.start();

      expect(secondEngine.startCalls).toBe(1);
    });

    // Lead adjudication on F1(c)'s "if any segments were captured":
    // an error BEFORE any speech saves NOTHING — otherwise every failed
    // start (mic denied, network) deposits a junk empty entry in
    // history. Contrast with stop()'s pre-existing save-even-when-empty
    // behavior (time-string title test below), which is user-initiated
    // and stays.
    it("a terminal error before any speech saves nothing, and retry still works", async () => {
      const { controller, callbacks, fakeEngine, saveSessionSpy, engineFactory } = createHarness();
      await controller.start();

      fakeEngine.getEvents().onStatus("error", MIC_DENIED_DETAIL);
      await flushAsync();

      expect(fakeEngine.stopCalls).toBe(1);
      expect(saveSessionSpy).not.toHaveBeenCalled();
      expect(callbacks.onSaved).not.toHaveBeenCalled();
      expect(callbacks.onGrantNeeded).toHaveBeenCalledTimes(1);

      const secondEngine = createFakeEngine();
      engineFactory.mockReturnValue(secondEngine.engine);
      await controller.start();

      expect(secondEngine.startCalls).toBe(1);
    });
  });

  describe("stop() builds and saves a LiteSession", () => {
    const FIXED_NOW = new Date(2026, 6, 12, 9, 0, 0).getTime();

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("carries id/title/engine/segments/cards/terms and saves exactly once", async () => {
      const { controller, callbacks, fakeEngine, saveSessionSpy } = createHarness();
      await controller.start();
      const events = fakeEngine.getEvents();
      events.onFinal("Let's circle back on this.");
      vi.advanceTimersByTime(5_000);
      events.onFinal("The ARR grew nicely this quarter.");

      await controller.stop();

      expect(fakeEngine.stopCalls).toBe(1);
      expect(saveSessionSpy).toHaveBeenCalledTimes(1);
      const saved = saveSessionSpy.mock.calls[0][0];

      expect(saved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(saved.title).toBe("Let's circle back on this.");
      expect(saved.engine).toBe("webspeech");
      expect(saved.segments).toEqual([
        { text: "Let's circle back on this.", startedAt: FIXED_NOW },
        { text: "The ARR grew nicely this quarter.", startedAt: FIXED_NOW + 5_000 },
      ]);
      expect(saved.cards.some((c) => c.expression === "circle back")).toBe(true);
      expect(saved.terms.some((t) => t.term === "ARR")).toBe(true);
      expect(saved.startedAt).toBe(FIXED_NOW);
      expect(saved.endedAt).toBe(FIXED_NOW + 5_000);

      expect(callbacks.onSaved).toHaveBeenCalledTimes(1);
      expect(callbacks.onSaved).toHaveBeenCalledWith(saved);
      expect(callbacks.onStatusChange).toHaveBeenCalledWith("stopped");
    });

    it("truncates a long first segment to 40 chars + an ellipsis", async () => {
      const { controller, fakeEngine, saveSessionSpy } = createHarness();
      await controller.start();
      fakeEngine.getEvents().onFinal("a".repeat(50));

      await controller.stop();

      expect(saveSessionSpy.mock.calls[0][0].title).toBe(`${"a".repeat(40)}…`);
    });

    it("falls back to a locale time-string title when the session has no segments", async () => {
      const { controller, saveSessionSpy } = createHarness();
      await controller.start();

      await controller.stop();

      expect(saveSessionSpy.mock.calls[0][0].title).toBe(new Date(FIXED_NOW).toLocaleTimeString());
    });
  });

  // F2 (high): pre-fix, stop() awaited saveSession directly — a
  // rejection propagated straight out of stop(), skipping
  // onStatusChange("stopped") entirely and leaving 停止聆听 a dead
  // button. Verified to fail on pre-fix code (git stash the fix —
  // controller.stop() rejects and onStatusChange("stopped") is never
  // observed).
  describe("stop() never leaves a dead button on save failure (F2)", () => {
    it("onStatusChange('stopped') still fires, onNotice carries the zh failure string, onSaved is NOT fired, and stop() itself never rejects", async () => {
      const { controller, callbacks, fakeEngine, saveSessionSpy } = createHarness({
        saveSession: async () => {
          throw new Error("simulated saveSession failure");
        },
      });
      await controller.start();
      fakeEngine.getEvents().onFinal("Let's circle back on this.");

      await expect(controller.stop()).resolves.toBeUndefined();

      expect(saveSessionSpy).toHaveBeenCalledTimes(1);
      expect(callbacks.onStatusChange).toHaveBeenCalledWith("stopped");
      expect(callbacks.onNotice).toHaveBeenCalledWith(SAVE_FAILED_NOTICE);
      expect(callbacks.onSaved).not.toHaveBeenCalled();
    });
  });

  describe("re-entrancy", () => {
    it("start() while already listening is a no-op", async () => {
      const { controller, fakeEngine } = createHarness();

      await controller.start();
      await controller.start();

      expect(fakeEngine.startCalls).toBe(1);
    });

    it("concurrent start() calls (before the first resolves) still start the engine once", async () => {
      const { controller, fakeEngine } = createHarness();

      const first = controller.start();
      const second = controller.start();
      await Promise.all([first, second]);

      expect(fakeEngine.startCalls).toBe(1);
    });

    it("stop() before ever starting is a no-op — no save, no callbacks", async () => {
      const { controller, callbacks, saveSessionSpy } = createHarness();

      await controller.stop();

      expect(saveSessionSpy).not.toHaveBeenCalled();
      expect(callbacks.onSaved).not.toHaveBeenCalled();
      expect(callbacks.onStatusChange).not.toHaveBeenCalledWith("stopped");
    });

    it("a second stop() after the first is a no-op — session is saved exactly once", async () => {
      const { controller, saveSessionSpy } = createHarness();
      await controller.start();

      await controller.stop();
      await controller.stop();

      expect(saveSessionSpy).toHaveBeenCalledTimes(1);
    });

    it("start() after a completed stop() runs a fresh session (re-clears transcript/cards)", async () => {
      const { controller, callbacks, fakeEngine } = createHarness();
      await controller.start();
      fakeEngine.getEvents().onFinal("Let's circle back on this.");
      await controller.stop();

      callbacks.onTranscriptChange.mockClear();
      callbacks.onCardsChange.mockClear();
      await controller.start();

      expect(fakeEngine.startCalls).toBe(2);
      expect(callbacks.onTranscriptChange).toHaveBeenCalledWith([], "");
      expect(callbacks.onCardsChange).toHaveBeenCalledWith({ cards: [], terms: [] });
    });

    // F3 (generation guard): pre-fix, a stop() landing while start() was
    // still awaiting queryMicPermission() would fall through to
    // stop()'s save logic with whatever was left on `this.segments` and
    // the class field default `sessionStartedAt = 0` — a bogus
    // startedAt:0 session (codex finding). Verified to fail on pre-fix
    // code (git stash the fix — saveSessionSpy IS called here, with
    // segments: [] and startedAt: 0).
    it("stop() racing a pending queryMicPermission: no engine ever starts, no session saved, and a later start() works", async () => {
      const callbacks = createCallbackSpies();
      const fakeEngine = createFakeEngine();
      const engineFactory = vi.fn(() => fakeEngine.engine);
      const saveSessionSpy = vi.fn(async (_session: LiteSession) => {});
      let resolvePermission!: (state: PermissionState | "unknown") => void;
      const permissionPromise = new Promise<PermissionState | "unknown">((resolve) => {
        resolvePermission = resolve;
      });
      const controller = new CaptureController({
        callbacks,
        createEngine: engineFactory,
        saveSession: saveSessionSpy,
        queryMicPermission: () => permissionPromise,
        detectSpeechRecognitionSupport: () => true,
      });

      const startPromise = controller.start();
      await controller.stop(); // races in while queryMicPermission() is still pending

      resolvePermission("granted");
      await startPromise;

      expect(engineFactory).not.toHaveBeenCalled();
      expect(saveSessionSpy).not.toHaveBeenCalled();
      expect(callbacks.onSaved).not.toHaveBeenCalled();
      expect(callbacks.onStatusChange).toHaveBeenCalledWith("stopped");

      // a later start() must still work — the generation guard must not
      // permanently wedge isActive/generation against each other.
      await controller.start();
      expect(engineFactory).toHaveBeenCalledTimes(1);
      expect(fakeEngine.startCalls).toBe(1);
    });
  });
});
