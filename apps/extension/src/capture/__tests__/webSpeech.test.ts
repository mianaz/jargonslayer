// Direct, engine-level behavioral tests for WebSpeechEngine
// (webSpeech.ts) — as opposed to webSpeechLoss.test.ts's scripted
// word-timeline scenarios, these drive a hand-controlled fake
// SpeechRecognition (ManualSpeechRecognition below) so each test can
// assert PRECISE timing/ordering guarantees for the 2026-07
// VAD-supervisor review's findings:
//  - #2: hot-mic leak on stop/start races (engine-level half; vad.
//    test.ts covers the SpeechActivityDetector-level half directly).
//  - #3: end-cycle generation discipline (slow onend, zombie sessions,
//    overlapping watchdog ticks during a pending end).
//  - #4: the dying-session tail rescue on relaunch.
//  - #11: endSession() still escalates even if stop() itself throws.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, STTEvents } from "@jargonslayer/core/types";
import { WebSpeechEngine, resetOnDeviceSpeechState } from "../webSpeech";
import { SpeechActivityDetector } from "../vad";
import type { VadHandle } from "../vad";
import type { VadState } from "../vadCore";
import { STALL_SPEECH_MS } from "../sttSupervisor";
import type { OnDeviceAvailability, OnDeviceMode } from "../onDeviceSpeech";
import { clearDiag, getDiagEntries } from "../../lib/diag";
import {
  FakeMediaStream,
  installFakeMediaDevices,
  uninstallFakeMediaDevices,
} from "./fakeMedia";

// ---- ManualSpeechRecognition: full manual control over onresult/
// onend, no scripted timeline. ----

interface ManualResultEntry {
  transcript: string;
  isFinal: boolean;
}

class ManualSpeechRecognition extends EventTarget {
  static instances: ManualSpeechRecognition[] = [];

  // On-device (Chrome 139+) static feature surface — configurable per
  // test. Defaults keep every test that predates this feature on the
  // exact same cloud path as before: none of them set
  // preferOnDeviceSpeech, and decideOnDeviceMode's pref-off branch
  // wins regardless of what these resolve to. NOT reset by
  // installManualSpeechRecognition() (called possibly MULTIPLE times
  // within one test, e.g. the restart-race tests below) — see
  // resetManualSpeechRecognitionOnDeviceStatics, called once per test
  // from the top-level afterEach instead.
  static availableResult: OnDeviceAvailability = "unavailable";
  static availableCalls: { langs: string[]; processLocally?: boolean }[] = [];
  static installResult = true;
  static installCalls: { langs: string[]; processLocally?: boolean }[] = [];
  /** Makes the NEXT start() call (on ANY instance) throw once — the
   *  "starting an on-device session throws where cloud wouldn't"
   *  defensive-fallback case. */
  static failNextStart = false;

  static async available(options: {
    langs: string[];
    processLocally?: boolean;
  }): Promise<OnDeviceAvailability> {
    ManualSpeechRecognition.availableCalls.push(options);
    return ManualSpeechRecognition.availableResult;
  }

  static async install(options: {
    langs: string[];
    processLocally?: boolean;
  }): Promise<boolean> {
    ManualSpeechRecognition.installCalls.push(options);
    return ManualSpeechRecognition.installResult;
  }

  continuous = false;
  interimResults = false;
  lang = "";
  processLocally = false;
  onresult: ((ev: { resultIndex: number; results: unknown }) => void) | null =
    null;
  onerror: ((ev: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  // True from start() until onend() actually fires — NOT flipped by
  // stop()/abort() themselves. This mirrors real Web Speech API
  // semantics: stop()/abort() only REQUEST termination, the session
  // stays "active" until onend is actually delivered — which is
  // exactly the window a zombie session (onend never arrives) never
  // leaves, and where a SECOND request (the escalation's abort() after
  // a stop() that got no onend) must still be a valid call, not an
  // "already stopped" throw.
  running = false;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;
  /** When true, stop() throws instead of succeeding (finding #11's
   *  "stop() throws with no pending onend" case). */
  stopThrows = false;

  constructor() {
    super();
    ManualSpeechRecognition.instances.push(this);
  }

  start(): void {
    if (ManualSpeechRecognition.failNextStart) {
      ManualSpeechRecognition.failNextStart = false;
      throw new Error("start() failed (scripted)");
    }
    if (this.running) throw new Error("already started");
    this.running = true;
    this.startCalls += 1;
  }

  stop(): void {
    if (this.stopThrows) throw new Error("stop() failed");
    if (!this.running) throw new Error("not running");
    this.stopCalls += 1;
    // Deliberately does NOT flip `running` false — stop() only
    // REQUESTS graceful termination; the session stays "active" until
    // onend is actually delivered (that's what leaves room for a
    // still-pending stop() to legitimately receive a FOLLOW-UP abort()
    // call, exactly the escalation's zombie-session path).
  }

  abort(): void {
    if (!this.running) throw new Error("not running");
    this.abortCalls += 1;
    // Unlike stop(), abort() is specified as an immediate hard stop —
    // the underlying session DOES terminate right away even in the
    // pathological case this fixture models: the onend EVENT never
    // gets dispatched (simulating a lost/dropped callback), but a
    // fresh start() call afterward must still be able to succeed, or
    // the "zombie" case could never recover even in principle.
    this.running = false;
  }

  /** Emit ONE result event with a single changed entry at `index`. */
  emitResult(index: number, transcript: string, isFinal: boolean): void {
    const entry: ManualResultEntry = { transcript, isFinal };
    const results: Record<number, unknown> & { length: number } = {
      length: index + 1,
    };
    results[index] = { length: 1, isFinal: entry.isFinal, 0: { transcript: entry.transcript } };
    this.onresult?.({ resultIndex: index, results });
  }

  emitEnd(): void {
    this.running = false;
    this.onend?.();
  }
}

function installManualSpeechRecognition(): void {
  ManualSpeechRecognition.instances = [];
  const target = globalThis as typeof globalThis & {
    window?: Record<string, unknown>;
  };
  if (typeof target.window === "undefined") {
    Object.defineProperty(target, "window", {
      value: {},
      configurable: true,
      writable: true,
    });
  }
  const win = target.window as Record<string, unknown>;
  win.SpeechRecognition = ManualSpeechRecognition;
  win.webkitSpeechRecognition = ManualSpeechRecognition;
}

function uninstallManualSpeechRecognition(): void {
  const target = globalThis as typeof globalThis & {
    window?: Record<string, unknown>;
  };
  if (target.window) {
    delete target.window.SpeechRecognition;
    delete target.window.webkitSpeechRecognition;
  }
}

/** Test helper — resets the on-device static config/counters. Once
 *  per TEST (top-level afterEach), not once per makeEngineHarness()
 *  call: several tests below (and the pre-existing restart-race tests
 *  above) call makeEngineHarness() more than once per test to model
 *  multiple engine instances, and availableCalls/installCalls need to
 *  accumulate ACROSS those to be assertable at all. */
function resetManualSpeechRecognitionOnDeviceStatics(): void {
  ManualSpeechRecognition.availableResult = "unavailable";
  ManualSpeechRecognition.availableCalls = [];
  ManualSpeechRecognition.installResult = true;
  ManualSpeechRecognition.installCalls = [];
  ManualSpeechRecognition.failNextStart = false;
}

/** A VadHandle stub always reporting `speaking` (once available), used
 *  to make a RECOVER decision (idle >= STALL_SPEECH_MS while speaking)
 *  deterministic and independent of the HARD rotation ceiling. */
class AlwaysSpeakingVad implements VadHandle {
  available = true;
  async start(): Promise<boolean> {
    this.available = true;
    return true;
  }
  stop(): void {
    this.available = false;
  }
  get state(): VadState {
    return { speaking: true, lastSpeechAt: Date.now() };
  }
}

const T0 = 0;

function makeEngineHarness(vadFactory?: () => VadHandle) {
  installManualSpeechRecognition();
  const finals: { text: string; startedAt?: number }[] = [];
  const notices: string[] = [];
  const engineModes: OnDeviceMode[] = [];
  const events: STTEvents = {
    onInterim: () => undefined,
    onFinal: (text, opts) => finals.push({ text, startedAt: opts?.startedAt }),
    onStatus: () => undefined,
    onNotice: (msg) => notices.push(msg),
    onEngineMode: (mode) => engineModes.push(mode),
  };
  const engine = new WebSpeechEngine(vadFactory);
  return { engine, events, finals, notices, engineModes };
}

describe("WebSpeechEngine — engine-level", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    resetManualSpeechRecognitionOnDeviceStatics();
    resetOnDeviceSpeechState();
    clearDiag();
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallManualSpeechRecognition();
    resetManualSpeechRecognitionOnDeviceStatics();
    resetOnDeviceSpeechState();
    uninstallFakeMediaDevices();
  });

  // ---- finding #2: hot-mic leak on stop/start races (engine wiring half) ----

  describe("VAD stop/start races", () => {
    it("stop() during a pending VAD acquisition stops the RIGHT (real) detector — zero live tracks once it resolves", async () => {
      const media = installFakeMediaDevices();
      const { engine, events } = makeEngineHarness(() => new SpeechActivityDetector());

      await engine.start(events, { language: "zh-CN" } as Settings);
      expect(media.gumCalls).toHaveLength(1);

      await engine.stop(); // races the pending getUserMedia()

      const stream = new FakeMediaStream(1);
      media.gumCalls[0].resolve(stream);
      await vi.advanceTimersByTimeAsync(0); // let the VAD's start().then() run

      expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
      expect(media.audioContexts).toHaveLength(0);
    });

    it("restart race: a start->stop->start sequence stops the FIRST (stale) detector once its late getUserMedia resolves, without disturbing the second", async () => {
      const media = installFakeMediaDevices();
      const { engine, events } = makeEngineHarness(() => new SpeechActivityDetector());

      await engine.start(events, { language: "zh-CN" } as Settings);
      expect(media.gumCalls).toHaveLength(1);
      await engine.stop();

      const { engine: engine2, events: events2 } = makeEngineHarness(
        () => new SpeechActivityDetector(),
      );
      await engine2.start(events2, { language: "zh-CN" } as Settings);
      expect(media.gumCalls).toHaveLength(2);
      const secondStream = new FakeMediaStream(1);
      media.gumCalls[1].resolve(secondStream);
      await vi.advanceTimersByTimeAsync(0);
      expect(secondStream.getTracks().every((t) => t.stopped)).toBe(false);

      // NOW the first (stale) detector's getUserMedia call resolves —
      // engine.stop() already ran while it was still pending, and
      // `this.userStopped` on the FIRST engine is what its own
      // `.then()` guard checks (independent instances/state — see
      // vad.test.ts's restart-race test for the matching same-engine
      // `this.vad !== vad` case).
      const firstStream = new FakeMediaStream(1);
      media.gumCalls[0].resolve(firstStream);
      await vi.advanceTimersByTimeAsync(0);

      expect(firstStream.getTracks().every((t) => t.stopped)).toBe(true);
      await engine2.stop();
    });
  });

  // ---- finding #3: end-cycle generation discipline ----

  describe("end-cycle generation discipline", () => {
    it("slow onend (1.5s, within CLOUD_FINALIZE_GRACE_MS): no abort, no re-entrant stop, exactly one relaunch", async () => {
      const { engine, events } = makeEngineHarness(() => new AlwaysSpeakingVad());
      await engine.start(events, { language: "zh-CN" } as Settings);
      const rec = ManualSpeechRecognition.instances[0];
      expect(rec.startCalls).toBe(1);

      // Idle (no events) for exactly STALL_SPEECH_MS while VAD reports
      // speaking — the watchdog tick landing EXACTLY on this boundary
      // (500ms-granular, and STALL_SPEECH_MS is itself a multiple of
      // 500) is the first to decide "recover", so stop() fires at
      // precisely t=STALL_SPEECH_MS — every later advance below is
      // relative to that known instant.
      await vi.advanceTimersByTimeAsync(STALL_SPEECH_MS);
      expect(rec.stopCalls).toBe(1); // endSession() fired exactly once

      // 1.5s further (t=STALL_SPEECH_MS+1500) — still short of the
      // 2s escalation deadline. Many watchdog ticks elapse in this
      // window while the end is still in flight; none may call
      // stop()/start() again re-entrantly.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(rec.stopCalls).toBe(1);
      expect(rec.startCalls).toBe(1);
      expect(rec.abortCalls).toBe(0); // well inside the 2s grace

      // The slow onend finally arrives.
      rec.emitEnd();
      await vi.advanceTimersByTimeAsync(500); // RESTART_DELAY_MS

      expect(rec.startCalls).toBe(2); // exactly one relaunch
      expect(rec.abortCalls).toBe(0);
      expect(rec.stopCalls).toBe(1);
      await engine.stop();
    });

    it("zombie session (onend never arrives): abort() fires exactly once at the widened (~2s) deadline, then a forced relaunch", async () => {
      const { engine, events } = makeEngineHarness(() => new AlwaysSpeakingVad());
      await engine.start(events, { language: "zh-CN" } as Settings);
      const rec = ManualSpeechRecognition.instances[0];

      // stop() fires at precisely t=STALL_SPEECH_MS (see the slow-onend
      // test above for why this is exact, not approximate).
      await vi.advanceTimersByTimeAsync(STALL_SPEECH_MS);
      expect(rec.stopCalls).toBe(1);

      // Not yet at the escalation deadline (t=STALL_SPEECH_MS+1900).
      await vi.advanceTimersByTimeAsync(1_900);
      expect(rec.abortCalls).toBe(0);

      // Cross it (t=STALL_SPEECH_MS+2000) — abort() fires exactly once.
      await vi.advanceTimersByTimeAsync(100);
      expect(rec.abortCalls).toBe(1);

      // abort() also produces no onend (truly zombied) — after ANOTHER
      // full grace window, the engine force-relaunches without ever
      // firing a second abort().
      await vi.advanceTimersByTimeAsync(2_000);
      expect(rec.abortCalls).toBe(1);
      expect(rec.startCalls).toBe(2);
      await engine.stop();
    });

    it("overlapping tick storm during a pending end never calls stop()/launch() re-entrantly", async () => {
      const { engine, events } = makeEngineHarness(() => new AlwaysSpeakingVad());
      await engine.start(events, { language: "zh-CN" } as Settings);
      const rec = ManualSpeechRecognition.instances[0];

      await vi.advanceTimersByTimeAsync(STALL_SPEECH_MS);
      expect(rec.stopCalls).toBe(1);

      // 1.8s of tick storm (500ms watchdog ticks) while the end is
      // still in flight and VAD keeps reporting "speaking, idle" —
      // the exact conditions that would re-trigger "recover" on every
      // tick without the awaitingOnendForGen guard.
      await vi.advanceTimersByTimeAsync(1_800);
      expect(rec.stopCalls).toBe(1);
      expect(rec.startCalls).toBe(1);
      expect(rec.abortCalls).toBe(0);

      rec.emitEnd();
      await vi.advanceTimersByTimeAsync(500);
      expect(rec.startCalls).toBe(2);
      await engine.stop();
    });
  });

  // ---- finding #4: dying-session tail rescue on relaunch ----

  describe("dying-session tail rescue (launch()'s flushAll)", () => {
    it("stop-with-no-final: the held-back tail is rescued as a final before the next session launches", async () => {
      // No vadFactory -> the default real SpeechActivityDetector fails
      // safely in this test environment (no navigator.mediaDevices),
      // so vadAvailable stays false throughout. A pending interim
      // (below) then puts the LEGACY branch's shorter limit
      // (STALL_SPEECH_MS, not STALL_SILENCE_MS_LEGACY) in play — the
      // same recover()-then-endSession() path as the VAD-available
      // case, deterministic and independent of the 55s HARD ceiling.
      const { engine, events, finals } = makeEngineHarness();
      await engine.start(events, { language: "zh-CN" } as Settings);
      const rec = ManualSpeechRecognition.instances[0];

      // Short enough that flushStable's rotation-time flush can't
      // safely cut anything (holds back the WHOLE thing) — the exact
      // "flushStable withholds everything" case finding #4 targets.
      const words = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
      rec.emitResult(0, words, false);

      await vi.advanceTimersByTimeAsync(STALL_SPEECH_MS);
      expect(rec.stopCalls).toBe(1);

      // No trailing final ever arrives — just onend.
      rec.emitEnd();
      await vi.advanceTimersByTimeAsync(500);

      expect(rec.startCalls).toBe(2); // relaunched
      const reconstructed = finals
        .map((f) => f.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      expect(reconstructed).toBe(words);
      await engine.stop();
    });

    it("stop-with-final: the dying session's own trailing final is not duplicated by the rescue", async () => {
      const { engine, events, finals } = makeEngineHarness();
      await engine.start(events, { language: "zh-CN" } as Settings);
      const rec = ManualSpeechRecognition.instances[0];

      const words = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
      rec.emitResult(0, words, false);

      await vi.advanceTimersByTimeAsync(STALL_SPEECH_MS);
      expect(rec.stopCalls).toBe(1);

      // The dying session DOES produce its trailing real final before
      // onend (the common/expected MDN case).
      rec.emitResult(0, words, true);
      rec.emitEnd();
      await vi.advanceTimersByTimeAsync(500);

      expect(rec.startCalls).toBe(2);
      const reconstructed = finals
        .map((f) => f.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      expect(reconstructed).toBe(words); // no dup
      await engine.stop();
    });
  });

  // ---- finding #11: endSession() catch hole ----

  describe("endSession() when recognition.stop() itself throws", () => {
    it("still schedules the escalation path: abort() then a forced relaunch, instead of stranding the engine", async () => {
      const { engine, events } = makeEngineHarness(() => new AlwaysSpeakingVad());
      await engine.start(events, { language: "zh-CN" } as Settings);
      const rec = ManualSpeechRecognition.instances[0];
      rec.stopThrows = true;

      await vi.advanceTimersByTimeAsync(STALL_SPEECH_MS);
      // stop() threw — `running` never flipped false, so recognition
      // is technically still "running" from the fake's point of view,
      // but the engine must still be trying to recover it.
      expect(rec.running).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(rec.abortCalls).toBe(1); // escalation's abort() succeeds (running was still true)

      await vi.advanceTimersByTimeAsync(2_000);
      expect(rec.startCalls).toBe(2); // forced relaunch — engine is NOT stranded
      await engine.stop();
    });
  });

  // ---- on-device Web Speech (processLocally, Chrome 139+ —
  // docs/research/stt-live-engines-2026-07.md item #1) ----

  describe("on-device Web Speech (processLocally)", () => {
    it("applies processLocally and announces mode 'on-device' when availability is 'available' and the pref is on", async () => {
      ManualSpeechRecognition.availableResult = "available";
      const { engine, events, engineModes } = makeEngineHarness();
      await engine.start(events, {
        language: "en-US",
        preferOnDeviceSpeech: true,
      } as Settings);
      const rec = ManualSpeechRecognition.instances[0];

      expect(rec.processLocally).toBe(true);
      expect(ManualSpeechRecognition.availableCalls).toEqual([
        { langs: ["en-US"], processLocally: true },
      ]);
      expect(engineModes).toEqual(["on-device"]);
      await engine.stop();
    });

    it("does not apply processLocally when the pref is off, even if available", async () => {
      ManualSpeechRecognition.availableResult = "available";
      const { engine, events, engineModes } = makeEngineHarness();
      await engine.start(events, {
        language: "en-US",
        preferOnDeviceSpeech: false,
      } as Settings);
      const rec = ManualSpeechRecognition.instances[0];

      expect(rec.processLocally).toBe(false);
      expect(engineModes).toEqual(["cloud"]);
      await engine.stop();
    });

    it("does not apply processLocally when unavailable, even with the pref on", async () => {
      ManualSpeechRecognition.availableResult = "unavailable";
      const { engine, events, engineModes } = makeEngineHarness();
      await engine.start(events, {
        language: "en-US",
        preferOnDeviceSpeech: true,
      } as Settings);
      const rec = ManualSpeechRecognition.instances[0];

      expect(rec.processLocally).toBe(false);
      expect(engineModes).toEqual(["cloud"]);
      await engine.stop();
    });

    it("downloadable + pref on: stays cloud THIS session, but triggers install() once for the language", async () => {
      ManualSpeechRecognition.availableResult = "downloadable";
      const { engine, events, engineModes } = makeEngineHarness();
      await engine.start(events, {
        language: "en-US",
        preferOnDeviceSpeech: true,
      } as Settings);
      const rec = ManualSpeechRecognition.instances[0];

      expect(rec.processLocally).toBe(false);
      expect(engineModes).toEqual(["cloud"]);
      await vi.advanceTimersByTimeAsync(0); // let the fire-and-forget install() settle
      expect(ManualSpeechRecognition.installCalls).toEqual([
        { langs: ["en-US"], processLocally: true },
      ]);
      await engine.stop();
    });

    it("starting an on-device session throws once -> falls back to cloud and retries successfully", async () => {
      ManualSpeechRecognition.availableResult = "available";
      ManualSpeechRecognition.failNextStart = true;
      const { engine, events, engineModes } = makeEngineHarness();
      await engine.start(events, {
        language: "en-US",
        preferOnDeviceSpeech: true,
      } as Settings);
      const rec = ManualSpeechRecognition.instances[0];

      // Fell back BEFORE the successful retry — processLocally ends up
      // false, and exactly one SUCCESSFUL start (the retry) happened.
      expect(rec.processLocally).toBe(false);
      expect(rec.startCalls).toBe(1);
      expect(engineModes).toEqual(["cloud"]); // announces the ACTUAL (post-fallback) mode
      expect(
        getDiagEntries().some(
          (e) => e.tag === "stt-ondevice" && e.message.includes("回退云端"),
        ),
      ).toBe(true);
      await engine.stop();
    });
  });

  describe("on-device availability cache", () => {
    it("queries availability once per language per page-load, even across multiple engine starts", async () => {
      ManualSpeechRecognition.availableResult = "available";

      const { engine: engine1, events: events1 } = makeEngineHarness();
      await engine1.start(events1, {
        language: "en-US",
        preferOnDeviceSpeech: true,
      } as Settings);
      await engine1.stop();

      const { engine: engine2, events: events2 } = makeEngineHarness();
      await engine2.start(events2, {
        language: "en-US",
        preferOnDeviceSpeech: true,
      } as Settings);
      await engine2.stop();

      expect(ManualSpeechRecognition.availableCalls).toHaveLength(1);

      const { engine: engine3, events: events3 } = makeEngineHarness();
      await engine3.start(events3, {
        language: "zh-CN",
        preferOnDeviceSpeech: true,
      } as Settings);
      await engine3.stop();

      // A DIFFERENT language is a fresh cache entry.
      expect(ManualSpeechRecognition.availableCalls).toHaveLength(2);
    });
  });
});
