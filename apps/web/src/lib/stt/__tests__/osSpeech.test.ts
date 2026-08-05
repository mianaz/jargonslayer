// OsSpeechEngine (S11, docs/design-explorations/s11-osspeech-blueprint.md)
// — mirrors appAudio.test.ts's own testing posture: invoke/listen are
// faked via fakeTauri.ts with the whole tauriApi.ts module mocked out
// (osSpeech.ts imports zero `@tauri-apps/*` itself, same "ONLY module"
// contract). v0.4.7 Lane B (glossary -> recognizer bias, D8): start()'s
// contextual-gathering source is now the `lexicon` param tests pass
// directly (no store mock needed at all anymore — osSpeech.ts no
// longer touches useApp/the store for this, see lexicon.test.ts for
// the shared builder/projection's own coverage). Also mocks
// "../../desktop/jobsBridge" (trackOsSpeechAsset — its OWN task-row
// bookkeeping is jobsBridge.ts's own test responsibility; this file
// only asserts that the ENGINE forwards the right kind/progress/message
// to whatever tracker trackOsSpeechAsset() hands back).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type MeetingLexicon, type STTEvents } from "@jargonslayer/core/types";
import { makeFakeInvoke, makeFakeListen, type FakeInvokeCall } from "./fakeTauri";
import { deferred } from "./fakeMedia";
import type { InvokeFn, ListenFn, UnlistenFn } from "../../desktop/tauriApi";
import { clearDiag, getDiagEntries } from "../../diag/log";

// Mirrors appAudio.test.ts's own "reference, don't eagerly read" shape —
// vi.mock is hoisted above these `let`s, but the factory only reads them
// from inside closures invoked much later, once a test has assigned them.
let currentInvoke!: InvokeFn;
let currentListen!: ListenFn;

vi.mock("../../desktop/tauriApi", () => ({
  getInvoke: () => Promise.resolve(currentInvoke),
  getListen: () => Promise.resolve(currentListen),
}));

// Dual capture v1 (docs/design-explorations/dual-capture-2026-08.md):
// this ambient file is osSpeech.ts's DESKTOP-flavored default coverage —
// osSpeech.ios.test.ts is the dedicated IS_IOS:true sibling (see that
// file's own header comment) — so IS_DESKTOP is pinned true here too,
// same "ambient = desktop, dedicated .ios file = iOS" split. Needed for
// start()'s own `source` gate (osSpeech.ts), which is desktop-only
// (iOS's start_os_speech Rust command has no `source` param at all);
// nothing else in this file's ~56 pre-existing tests reads IS_DESKTOP.
vi.mock("../../platform/desktop", () => ({ IS_DESKTOP: true }));

interface FakeAssetTracker {
  handle: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
}
let assetTrackers: FakeAssetTracker[] = [];
vi.mock("../../desktop/jobsBridge", () => ({
  trackOsSpeechAsset: () => {
    const tracker: FakeAssetTracker = { handle: vi.fn(), settle: vi.fn() };
    assetTrackers.push(tracker);
    return tracker;
  },
}));

// Lane W (mid-session STT liveness watchdog): this engine is a dumb
// forwarder onto audioLiveness.ts's own store (see handleAudioStats's own
// doc comment) — mocked here so "osspeech://audio-stats mapping" below
// can assert the forwarding call directly, same posture as jobsBridge's
// mock above (that module's OWN behavior is somebody else's test file).
const pushAudioWindow = vi.fn();
vi.mock("../audioLiveness", () => ({ pushAudioWindow: (...args: unknown[]) => pushAudioWindow(...args) }));

import { OsSpeechEngine } from "../osSpeech";
import { createEngine } from "../index";
import { CH_MIC_SPEAKER, CH_SYS_SPEAKER } from "../../store";

// Mirrors osSpeech.ts's own (unexported) STOP_ENDED_TIMEOUT_MS.
const STOP_ENDED_TIMEOUT_MS = 4000;

// mode:"system-audio" (dual capture v1's own default, docs/design-
// explorations/dual-capture-2026-08.md) — NOT DEFAULT_SETTINGS.mode's
// own "mic" default, which would now spuriously add a `source: "mic"`
// arg to every start_os_speech call in this file (see the "source
// pass-through on start" describe block below for the dedicated
// mic/dual/system-audio coverage).
const OSSPEECH_SETTINGS = {
  ...DEFAULT_SETTINGS,
  engine: "osspeech" as const,
  mode: "system-audio" as const,
};

function noopEvents(): STTEvents {
  return {
    onInterim: () => {},
    onFinal: () => {},
    onStatus: () => {},
    onNotice: () => {},
    onSpeakerUpdate: () => {},
    onDiarStatus: () => {},
  } as unknown as STTEvents;
}

/** Polls a microtask at a time until `check()` is true — mirrors
 *  appAudio.test.ts's own flushUntil exactly (see that file's doc). */
async function flushUntil(check: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (check()) return;
    await Promise.resolve();
  }
  if (!check()) throw new Error("flushUntil: condition never became true");
}

async function settle(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** Wires the default fakes (start/stop/pause/resume: succeed) into the
 *  mocked tauriApi module, with per-command overrides. Mirrors
 *  appAudio.test.ts's own wireFakes. */
function wireFakes(invokeOverrides: Record<string, (args?: Record<string, unknown>) => unknown> = {}): {
  calls: FakeInvokeCall[];
  emit: (event: string, payload: unknown) => void;
  activeCount: (event: string) => number;
} {
  const { invoke, calls } = makeFakeInvoke({
    start_os_speech: () => undefined,
    stop_os_speech: () => undefined,
    pause_os_speech: () => undefined,
    resume_os_speech: () => undefined,
    ...invokeOverrides,
  });
  currentInvoke = invoke;
  const { listen, emit, activeCount } = makeFakeListen();
  currentListen = listen;
  return { calls, emit, activeCount };
}

/** Drives a full stop() to completion via the real "ended" status (not
 *  the timeout fallback). Mirrors appAudio.test.ts's own stopViaEnded. */
async function stopViaEnded(engine: OsSpeechEngine, emit: (event: string, payload: unknown) => void): Promise<void> {
  const stopP = engine.stop();
  await settle(); // let invoke("stop_os_speech") resolve, reaching waitForEndedOrTimeout()
  emit("osspeech://status", { kind: "ended", source: "session" });
  await stopP;
}

describe("OsSpeechEngine", () => {
  beforeEach(() => {
    assetTrackers = [];
    clearDiag();
    pushAudioWindow.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports kind: osspeech", () => {
    expect(new OsSpeechEngine().kind).toBe("osspeech");
  });

  it("createEngine('osspeech') builds an OsSpeechEngine (factory wiring)", () => {
    expect(createEngine("osspeech")).toBeInstanceOf(OsSpeechEngine);
  });

  it("pause()/resume() are no-ops before start() ever invokes start_os_speech", async () => {
    const engine = new OsSpeechEngine();
    await expect(engine.pause()).resolves.toBeUndefined();
    await expect(engine.resume()).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------
  // full happy path
  // ---------------------------------------------------------------

  it("full happy path: start -> both lanes listened -> capturing -> transcript -> stop -> ended", async () => {
    const { calls, emit, activeCount } = wireFakes();
    const engine = new OsSpeechEngine();
    const onStatus = vi.fn();
    const onInterim = vi.fn();
    const onFinal = vi.fn();
    const events = { ...noopEvents(), onStatus, onInterim, onFinal } as unknown as STTEvents;

    await engine.start(events, OSSPEECH_SETTINGS);

    expect(calls.some((c) => c.cmd === "start_os_speech")).toBe(true);
    expect(activeCount("osspeech://transcript")).toBe(1);
    expect(activeCount("osspeech://status")).toBe(1);

    emit("osspeech://status", { kind: "capturing", source: "session" });
    expect(onStatus).toHaveBeenCalledWith("listening");

    emit("osspeech://transcript", { final: false, seq: 1, startMs: 0, endMs: 500, text: "jargon" });
    // Fix B (pre-tag fix round): onInterim's third argument now carries
    // the channel-mapped sttSpeaker — undefined here, a channel-less
    // (legacy/single-source) transcript event.
    expect(onInterim).toHaveBeenCalledWith("jargon", undefined, undefined);

    emit("osspeech://transcript", { final: true, seq: 2, startMs: 0, endMs: 900, text: "jargon slayer" });
    expect(onFinal).toHaveBeenCalledWith("jargon slayer");

    let resolved = false;
    const stopP = engine.stop().then(() => {
      resolved = true;
    });
    await flushUntil(() => calls.some((c) => c.cmd === "stop_os_speech"));
    expect(resolved).toBe(false);

    emit("osspeech://status", { kind: "ended", source: "session" });
    await stopP;
    expect(resolved).toBe(true);
    expect(activeCount("osspeech://transcript")).toBe(0);
    expect(activeCount("osspeech://status")).toBe(0);
  });

  // ---------------------------------------------------------------
  // contextual gathering wired into start_os_speech (Q11, generalized
  // v0.4.7 Lane B onto the shared lexicon.ts builder — D8: start()
  // takes the ALREADY-BUILT lexicon directly, no store read of any
  // kind. Tier/cap coverage for the projection itself lives in
  // lexicon.test.ts; these tests only pin that osSpeech.ts's start()
  // actually threads its `lexicon` param into contextualJson.)
  // ---------------------------------------------------------------

  describe("contextual gathering wiring", () => {
    it("forwards settings.language as locale and the lexicon as contextualJson", async () => {
      const { calls } = wireFakes();
      const engine = new OsSpeechEngine();
      const lexicon: MeetingLexicon = { terms: ["木桶效应", "barrel effect"] };

      await engine.start(noopEvents(), { ...OSSPEECH_SETTINGS, language: "zh-CN" }, lexicon);

      const startCall = calls.find((c) => c.cmd === "start_os_speech");
      expect(startCall?.args).toEqual({
        locale: "zh-CN",
        contextualJson: JSON.stringify(["木桶效应", "barrel effect"]),
      });
    });

    it("passes contextualJson: null when the lexicon is empty", async () => {
      const { calls } = wireFakes();
      const engine = new OsSpeechEngine();

      await engine.start(noopEvents(), OSSPEECH_SETTINGS, { terms: [] });

      const startCall = calls.find((c) => c.cmd === "start_os_speech");
      expect(startCall?.args?.contextualJson).toBeNull();
    });

    it("passes contextualJson: null when start() is called with no lexicon arg at all (defensive default)", async () => {
      const { calls } = wireFakes();
      const engine = new OsSpeechEngine();

      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      const startCall = calls.find((c) => c.cmd === "start_os_speech");
      expect(startCall?.args?.contextualJson).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // transcript mapping
  // ---------------------------------------------------------------

  describe("osspeech://transcript mapping", () => {
    it("final:false maps to onInterim(text)", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onInterim = vi.fn();
      await engine.start({ ...noopEvents(), onInterim } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://transcript", { final: false, seq: 1, startMs: 100, endMs: 400, text: "hi" });

      // Fix B (pre-tag fix round): third argument (sttSpeaker) is
      // undefined for a channel-less transcript event.
      expect(onInterim).toHaveBeenCalledWith("hi", undefined, undefined);
    });

    // A3 verify-from-source: wsTransport.ts's own onFinal call
    // (apps/web/src/lib/stt/wsTransport.ts:332,
    // `events.onFinal(final.text, { sttSeg: ... })`) passes NO
    // `startedAt` field at all — this pins that OsSpeechEngine matches
    // that exact semantic by passing onFinal with NO second argument at
    // all (not even an empty options object), rather than inventing a
    // startedAt value nothing downstream of the appaudio/wsTransport
    // family actually reads.
    it("final:true maps to onFinal(text) with NO second (opts) argument at all", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onFinal = vi.fn();
      await engine.start({ ...noopEvents(), onFinal } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://transcript", { final: true, seq: 2, startMs: 100, endMs: 900, text: "jargon slayer" });

      expect(onFinal).toHaveBeenCalledWith("jargon slayer");
      expect(onFinal.mock.calls[0]).toEqual(["jargon slayer"]);
    });

    it("final transcripts still flow DURING the stop-wait window (drain tail), not gated on `stopping`", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onFinal = vi.fn();
      await engine.start({ ...noopEvents(), onFinal } as unknown as STTEvents, OSSPEECH_SETTINGS);

      const stopP = engine.stop();
      await settle(); // stop_os_speech invoked, now awaiting waitForEndedOrTimeout()

      emit("osspeech://transcript", { final: true, seq: 3, startMs: 0, endMs: 100, text: "drain tail" });
      expect(onFinal).toHaveBeenCalledWith("drain tail");

      emit("osspeech://status", { kind: "ended", source: "session" });
      await stopP;
    });

    it("drops a transcript event that arrives after stop() has already settled (listener unregistered)", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onInterim = vi.fn();
      const onFinal = vi.fn();
      await engine.start({ ...noopEvents(), onInterim, onFinal } as unknown as STTEvents, OSSPEECH_SETTINGS);
      await stopViaEnded(engine, emit);

      emit("osspeech://transcript", { final: false, seq: 4, startMs: 0, endMs: 100, text: "late interim" });
      emit("osspeech://transcript", { final: true, seq: 5, startMs: 0, endMs: 100, text: "late final" });

      expect(onInterim).not.toHaveBeenCalled();
      expect(onFinal).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // Dual capture v1 (docs/design-explorations/dual-capture-2026-08.md)
  // ---------------------------------------------------------------

  describe("dual capture v1: source pass-through on start", () => {
    it("mode:mic -> start_os_speech args include source:\"mic\"", async () => {
      const { calls } = wireFakes();
      const engine = new OsSpeechEngine();

      await engine.start(noopEvents(), { ...OSSPEECH_SETTINGS, mode: "mic" });

      const startCall = calls.find((c) => c.cmd === "start_os_speech");
      expect(startCall?.args?.source).toBe("mic");
    });

    it("mode:dual -> start_os_speech args include source:\"dual\"", async () => {
      const { calls } = wireFakes();
      const engine = new OsSpeechEngine();

      await engine.start(noopEvents(), { ...OSSPEECH_SETTINGS, mode: "dual" });

      const startCall = calls.find((c) => c.cmd === "start_os_speech");
      expect(startCall?.args?.source).toBe("dual");
    });

    it("mode:system-audio -> `source` key is OMITTED entirely (byte-identical argv to every pre-dual-capture caller)", async () => {
      const { calls } = wireFakes();
      const engine = new OsSpeechEngine();

      await engine.start(noopEvents(), { ...OSSPEECH_SETTINGS, mode: "system-audio" });

      const startCall = calls.find((c) => c.cmd === "start_os_speech");
      expect(startCall?.args).not.toHaveProperty("source");
    });
  });

  describe("dual capture v1: channel -> sttSpeaker mapping", () => {
    it("channel:\"mic\" maps to onFinal(text, { sttSpeaker: CH_MIC_SPEAKER })", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onFinal = vi.fn();
      await engine.start({ ...noopEvents(), onFinal } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://transcript", {
        final: true,
        seq: 1,
        startMs: 0,
        endMs: 500,
        text: "my side",
        channel: "mic",
      });

      expect(onFinal).toHaveBeenCalledWith("my side", { sttSpeaker: CH_MIC_SPEAKER });
    });

    it("channel:\"system\" maps to onFinal(text, { sttSpeaker: CH_SYS_SPEAKER })", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onFinal = vi.fn();
      await engine.start({ ...noopEvents(), onFinal } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://transcript", {
        final: true,
        seq: 2,
        startMs: 0,
        endMs: 500,
        text: "their side",
        channel: "system",
      });

      expect(onFinal).toHaveBeenCalledWith("their side", { sttSpeaker: CH_SYS_SPEAKER });
    });

    // Legacy/single-source no-channel case (`channel` absent) already
    // pinned above: "final:true maps to onFinal(text) with NO second
    // (opts) argument at all" — a channel-tagged event must never
    // regress that byte-identical call shape.

    // Fix B (pre-tag fix round, HIGH): the interim branch used to drop
    // the channel entirely (noteResult(undefined) cleared EVERY channel
    // regardless of which lane actually produced the interim) — now
    // mapped through the SAME sttSpeakerForChannel onFinal uses, carried
    // as onInterim's THIRD argument. The SECOND argument (`speaker`,
    // InterimLine's own display value) is untouched by this fix — still
    // always `undefined` for osspeech's interim branch.
    it("interim (final:false) events carry the channel via the THIRD argument, but no speaker display value (second argument stays undefined)", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onInterim = vi.fn();
      await engine.start({ ...noopEvents(), onInterim } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://transcript", {
        final: false,
        seq: 3,
        startMs: 0,
        endMs: 100,
        text: "partial",
        channel: "mic",
      });

      expect(onInterim).toHaveBeenCalledWith("partial", undefined, CH_MIC_SPEAKER);
    });

    it("interim events on the 'system' channel map to CH_SYS_SPEAKER via the third argument", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onInterim = vi.fn();
      await engine.start({ ...noopEvents(), onInterim } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://transcript", {
        final: false,
        seq: 4,
        startMs: 0,
        endMs: 100,
        text: "their partial",
        channel: "system",
      });

      expect(onInterim).toHaveBeenCalledWith("their partial", undefined, CH_SYS_SPEAKER);
    });
  });

  // ---------------------------------------------------------------
  // Lane W (mid-session STT liveness watchdog): "osspeech://audio-stats"
  // -> pushAudioWindow mapping. This engine is a dumb forwarder — the
  // verdict/threshold logic itself is audioLiveness.test.ts's own job.
  // ---------------------------------------------------------------

  describe("osspeech://audio-stats mapping (Lane W)", () => {
    it("forwards channel + windowPeak verbatim", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      emit("osspeech://audio-stats", { channel: "mic", windowPeak: 0.05 });

      // Fix C (pre-tag fix round): third argument (windowLoudMs) is
      // undefined when the payload doesn't carry one (an older/foreign
      // helper build).
      expect(pushAudioWindow).toHaveBeenCalledWith("mic", 0.05, undefined);
    });

    it("an absent channel (legacy/single-source session) maps to 'default'", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      emit("osspeech://audio-stats", { windowPeak: 0.02 });

      expect(pushAudioWindow).toHaveBeenCalledWith("default", 0.02, undefined);
    });

    it("forwards windowLoudMs verbatim when the payload carries one (Fix C)", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      emit("osspeech://audio-stats", { channel: "system", windowPeak: 0.02, windowLoudMs: 1500 });

      expect(pushAudioWindow).toHaveBeenCalledWith("system", 0.02, 1500);
    });

    it("drops an audio-stats event that arrives after stop() has already settled (listener unregistered)", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);
      await stopViaEnded(engine, emit);

      emit("osspeech://audio-stats", { channel: "mic", windowPeak: 0.05 });

      expect(pushAudioWindow).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // status mapping (§2.6)
  // ---------------------------------------------------------------

  describe("osspeech://status mapping", () => {
    it("starting maps to onStatus(connecting)", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();
      await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "starting", source: "session" });

      expect(onStatus).toHaveBeenCalledWith("connecting");
    });

    it("asset-checking maps to onStatus(connecting) + a ONE-SHOT onNotice, and forwards to the asset tracker", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();
      const onNotice = vi.fn();
      await engine.start({ ...noopEvents(), onStatus, onNotice } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "asset-checking", source: "session" });
      emit("osspeech://status", { kind: "asset-checking", source: "session" }); // second arrival — notice must not repeat

      expect(onStatus).toHaveBeenCalledWith("connecting");
      expect(onNotice).toHaveBeenCalledTimes(1);
      expect(assetTrackers[0].handle).toHaveBeenCalledWith("asset-checking");
    });

    it("asset-downloading maps to onStatus(connecting) + a ONE-SHOT onNotice + tracker progress on EVERY tick", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();
      const onNotice = vi.fn();
      await engine.start({ ...noopEvents(), onStatus, onNotice } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "asset-downloading", progress: 0.2, source: "session" });
      emit("osspeech://status", { kind: "asset-downloading", progress: 0.8, source: "session" });

      expect(onStatus).toHaveBeenCalledWith("connecting");
      expect(onNotice).toHaveBeenCalledTimes(1);
      expect(assetTrackers[0].handle).toHaveBeenNthCalledWith(1, "asset-downloading", 0.2);
      expect(assetTrackers[0].handle).toHaveBeenNthCalledWith(2, "asset-downloading", 0.8);
    });

    it("asset-installed forwards to the tracker with NO status transition of its own", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();
      await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "asset-installed", source: "session" });

      expect(assetTrackers[0].handle).toHaveBeenCalledWith("asset-installed");
      expect(onStatus).not.toHaveBeenCalled();
    });

    it("asset-failed maps to onStatus(error, 下载失败 copy), forwards to the tracker, and is TERMINAL", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();
      await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "asset-failed", message: "network unreachable", source: "session" });

      expect(onStatus).toHaveBeenCalledWith("error", "系统语音资源下载失败，请检查网络后重试");
      expect(assetTrackers[0].handle).toHaveBeenCalledWith("asset-failed", undefined, "network unreachable");
    });

    it("locale-resolved surfaces an onNotice naming the resolved locale", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onNotice = vi.fn();
      await engine.start({ ...noopEvents(), onNotice } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "locale-resolved", resolvedLocale: "zh_CN", source: "session" });

      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("zh_CN"));
    });

    it("locale-resolved with no resolvedLocale field never calls onNotice", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onNotice = vi.fn();
      await engine.start({ ...noopEvents(), onNotice } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "locale-resolved", source: "session" });

      expect(onNotice).not.toHaveBeenCalled();
    });

    it("capturing maps to onStatus(listening)", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();
      await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "capturing", source: "session" });

      expect(onStatus).toHaveBeenCalledWith("listening");
    });

    it("permission-denied maps to onStatus(error, zh guidance mentioning 系统设置/隐私与安全性/屏幕与系统音频录制)", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();
      await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "permission-denied", source: "session" });

      expect(onStatus).toHaveBeenCalledWith(
        "error",
        expect.stringMatching(/系统设置.*隐私与安全性.*屏幕与系统音频录制/),
      );
    });

    it("device-changed maps to onStatus(error, zh)", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();
      await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "device-changed", source: "session" });

      expect(onStatus).toHaveBeenCalledWith("error", expect.any(String));
    });

    it('unsupported maps EXACTLY to onStatus("error","系统识别需要 macOS 26 或更高版本") (blueprint-pinned copy)', async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();
      await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "unsupported", source: "session" });

      expect(onStatus).toHaveBeenCalledWith("error", "系统识别需要 macOS 26 或更高版本");
    });

    it("unsupported-locale maps to onStatus(error, copy naming the requested locale + supported list)", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();
      await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", {
        kind: "unsupported-locale",
        source: "session",
        message: "zh-Yue",
        supportedLocales: ["zh_CN", "en_US"],
      });

      const [, msg] = onStatus.mock.calls.find((c) => c[0] === "error")!;
      expect(msg).toContain("zh-Yue");
      expect(msg).toContain("zh_CN");
      expect(msg).toContain("en_US");
    });

    it('crashed maps EXACTLY to onStatus("error","系统识别意外退出，请重试") (blueprint-pinned copy)', async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();
      await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "crashed", source: "session" });

      expect(onStatus).toHaveBeenCalledWith("error", "系统识别意外退出，请重试");
    });

    it("an unexpected ended (no stop() called) surfaces onStatus(idle, capture_ended)", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();
      await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "ended", source: "session" });

      expect(onStatus).toHaveBeenCalledWith("idle", "capture_ended");
    });

    it("a captured-but-silent session (finals=0, sawAudio=false) notices the mic/system-audio confusion at session end — even when 'ended' arrives mid-stop", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onNotice = vi.fn();
      await engine.start({ ...noopEvents(), onNotice } as unknown as STTEvents, OSSPEECH_SETTINGS);
      emit("osspeech://status", { kind: "capturing", source: "session" });

      // The observed shape of this failure (2026-08-02 field report): the
      // user watches nothing transcribe and presses stop — the final
      // "ended" (Rust attaches sawAudio only there) lands during stop()'s
      // wait window, where every non-"ended" branch is skipped.
      const stopP = engine.stop();
      await settle(); // stop_os_speech invoked, now awaiting waitForEndedOrTimeout()
      emit("osspeech://status", { kind: "ended", source: "session", sawAudio: false });
      await stopP;

      expect(onNotice).toHaveBeenCalledTimes(1);
      expect(onNotice).toHaveBeenCalledWith(
        "未检测到系统声音——系统引擎只采集系统播放的音频，不采集麦克风；要转写麦克风请切换到本地模型或云端引擎",
      );
    });

    it.each(["mic", "dual"] as const)(
      "a silent %s session does NOT get the system-audio steer — that copy's premise is false when the mic IS being captured",
      async (mode) => {
        const { emit } = wireFakes();
        const engine = new OsSpeechEngine();
        const onNotice = vi.fn();
        await engine.start(
          { ...noopEvents(), onNotice } as unknown as STTEvents,
          { ...OSSPEECH_SETTINGS, mode } as unknown as typeof OSSPEECH_SETTINGS,
        );
        emit("osspeech://status", { kind: "capturing", source: "session" });

        // Identical wire shape to the system-audio case above — same
        // zero finals, same explicitly-false sawAudio. Only the session's
        // own source differs, and that alone must suppress the steer.
        emit("osspeech://status", { kind: "ended", source: "session", sawAudio: false });

        expect(onNotice).not.toHaveBeenCalledWith(
          "未检测到系统声音——系统引擎只采集系统播放的音频，不采集麦克风；要转写麦克风请切换到本地模型或云端引擎",
        );
      },
    );

    it("a system-audio session AFTER a dual one still gets the steer — the latch never survives into the next session", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onNotice = vi.fn();

      await engine.start(
        { ...noopEvents(), onNotice } as unknown as STTEvents,
        { ...OSSPEECH_SETTINGS, mode: "dual" } as unknown as typeof OSSPEECH_SETTINGS,
      );
      emit("osspeech://status", { kind: "capturing", source: "session" });
      emit("osspeech://status", { kind: "ended", source: "session", sawAudio: false });
      expect(onNotice).not.toHaveBeenCalled();

      await engine.start({ ...noopEvents(), onNotice } as unknown as STTEvents, OSSPEECH_SETTINGS);
      emit("osspeech://status", { kind: "capturing", source: "session" });
      emit("osspeech://status", { kind: "ended", source: "session", sawAudio: false });

      expect(onNotice).toHaveBeenCalledWith(
        "未检测到系统声音——系统引擎只采集系统播放的音频，不采集麦克风；要转写麦克风请切换到本地模型或云端引擎",
      );
    });
  });

  // ---------------------------------------------------------------
  // terminal latch (§2.5 TERMINAL kinds) — incl. asset-failed
  // ---------------------------------------------------------------

  describe("terminal latch", () => {
    it("permission-denied arriving pre-stop lets stop() resolve immediately, without consuming the 4s wait", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "permission-denied", source: "session" });

      vi.useFakeTimers();
      let resolved = false;
      const stopP = engine.stop().then(() => {
        resolved = true;
      });
      await settle(); // deliberately no vi.advanceTimersByTimeAsync — fails loudly on pre-fix code

      expect(resolved).toBe(true);
      await stopP;
    });

    it("asset-failed arriving pre-stop ALSO lets stop() resolve immediately (S11: asset-failed joins the terminal set)", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "asset-failed", message: "network unreachable", source: "session" });

      vi.useFakeTimers();
      let resolved = false;
      const stopP = engine.stop().then(() => {
        resolved = true;
      });
      await settle();

      expect(resolved).toBe(true);
      await stopP;
    });
  });

  // ---------------------------------------------------------------
  // S11 fix-round J1 — osspeech://status `source` filtering (cross-lane
  // contract, PINNED): a background preinstall's own events must never
  // false-latch a session that never asked for them. Every OTHER test
  // in this file already exercises the "source: session" happy path
  // implicitly (every emit above now carries it) — this block covers
  // the NEGATIVE case, source !== "session".
  // ---------------------------------------------------------------

  describe("osspeech://status source filtering (J1 cross-lane contract)", () => {
    it("a preinstall-sourced asset-failed arriving WHILE start_os_speech is still in flight (the true race window) never latches this brand-new session", async () => {
      const startOsSpeech = deferred<undefined>();
      const { calls, emit } = wireFakes({
        start_os_speech: () => startOsSpeech.promise,
      });
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();

      const startP = engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);
      await flushUntil(() => calls.some((c) => c.cmd === "start_os_speech"));

      // The race: a DIFFERENT, background preinstall attempt's own
      // terminal event lands on the SAME "osspeech://status" lane before
      // THIS session's own start_os_speech has even resolved.
      emit("osspeech://status", {
        kind: "asset-failed",
        source: "preinstall",
        message: "unrelated preinstall failure",
      });

      startOsSpeech.resolve(undefined);
      await startP;

      emit("osspeech://status", { kind: "capturing", source: "session" });

      expect(onStatus).toHaveBeenCalledWith("listening");
      expect(onStatus).not.toHaveBeenCalledWith("error", expect.any(String));
    });

    it("a preinstall-sourced ended never latches an already-running session — stop() still waits the FULL timeout rather than resolving as if the helper had already terminated", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();
      await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "ended", source: "preinstall" });

      // Pre-fix: this WOULD reach the (un-gated) "ended" branch below and
      // surface onStatus("idle", "capture_ended") despite nobody ever
      // stopping this session.
      expect(onStatus).not.toHaveBeenCalledWith("idle", "capture_ended");

      vi.useFakeTimers();
      let resolved = false;
      const stopP = engine.stop().then(() => {
        resolved = true;
      });
      await settle();
      // Pre-fix: the preinstall-sourced "ended" above would have latched
      // helperTerminated, so stop() would already have resolved here,
      // WITHOUT needing to advance the timer at all.
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(STOP_ENDED_TIMEOUT_MS);
      await stopP;
      expect(resolved).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // S11 fix-round J2(c) — assetTracker.settle() forwarding: a still-
  // running "os-speech-asset" row (this session's own, or one ADOPTED
  // from a preempted preinstall — see jobsBridge.test.ts's own single-
  // flight coverage) must not be orphaned when the session ends some
  // way OTHER than asset-installed/asset-failed.
  // ---------------------------------------------------------------

  describe("assetTracker.settle() forwarding on terminal status (J2c)", () => {
    it.each([
      { kind: "device-changed" },
      { kind: "unsupported" },
      { kind: "unsupported-locale", message: "zh-Yue" },
      { kind: "crashed" },
      { kind: "ended" },
      { kind: "permission-denied" },
    ])("$kind calls assetTracker.settle() once", async ({ kind, message }) => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind, message, source: "session" });

      expect(assetTrackers[0].settle).toHaveBeenCalledTimes(1);
    });

    it("asset-failed does NOT also call settle() — its own handle('asset-failed', ...) already settles the row with the real message", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "asset-failed", message: "network unreachable", source: "session" });

      expect(assetTrackers[0].handle).toHaveBeenCalledWith("asset-failed", undefined, "network unreachable");
      expect(assetTrackers[0].settle).not.toHaveBeenCalled();
    });

    it("a non-terminal status (e.g. capturing) never calls settle()", async () => {
      const { emit } = wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      emit("osspeech://status", { kind: "capturing", source: "session" });

      expect(assetTrackers[0].settle).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // stop()
  // ---------------------------------------------------------------

  describe("stop()", () => {
    it("falls back to the STOP_ENDED_TIMEOUT_MS timeout when no ended ever arrives", async () => {
      wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      vi.useFakeTimers();
      let resolved = false;
      const stopP = engine.stop().then(() => {
        resolved = true;
      });
      await settle();
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(STOP_ENDED_TIMEOUT_MS);
      await stopP;
      expect(resolved).toBe(true);
    });

    it("is idempotent — a second call is a no-op", async () => {
      const { calls, emit } = wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);
      await stopViaEnded(engine, emit);

      await engine.stop();

      expect(calls.filter((c) => c.cmd === "stop_os_speech").length).toBe(1);
    });

    // S11 fix-round J4: a REJECTED start_os_speech invoke() (macOS-26
    // recheck failing, a single-flight busy rejection, ...) routes
    // through stop() to unwind (see start()'s own catch block) — but
    // `this.running` never went true for it, so stop()'s ended-wait must
    // be skipped entirely rather than burning the full
    // STOP_ENDED_TIMEOUT_MS waiting for an "ended" no helper process was
    // ever going to send (there IS no helper process here). Uses
    // flushUntil (microtask-only, no timer advance at all) rather than
    // vi.advanceTimersByTimeAsync — pre-fix, this never resolves within
    // flushUntil's own bounded tick budget (the pending real setTimeout
    // stays un-advanced forever), which is exactly the red failure mode.
    it("a start_os_speech invoke() rejection surfaces a zh error and resolves stop()'s unwind PROMPTLY — no unnecessary ended-wait since this.running never went true", async () => {
      const { calls } = wireFakes({
        start_os_speech: () => {
          throw new Error("ipc failure");
        },
      });
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();

      vi.useFakeTimers();
      let resolved = false;
      const startP = engine
        .start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS)
        .then(() => {
          resolved = true;
        });

      await flushUntil(() => resolved); // deliberately no vi.advanceTimersByTimeAsync

      expect(onStatus).toHaveBeenCalledWith("error", expect.any(String));
      expect(calls.some((c) => c.cmd === "stop_os_speech")).toBe(true);
      await startP;
    });
  });

  // ---------------------------------------------------------------
  // generation staleness / listener cleanup (mirrors appAudio.ts's F2)
  // ---------------------------------------------------------------

  describe("generation staleness / unlisten cleanup", () => {
    it("stop() landing WHILE the transcript listen() itself is still in flight leaves zero listeners", async () => {
      const listenGate = deferred<UnlistenFn>();
      const unlistenSpy = vi.fn();
      wireFakes();
      currentListen = (async () => {
        await listenGate.promise;
        return unlistenSpy;
      }) as ListenFn;

      const engine = new OsSpeechEngine();
      const startP = engine.start(noopEvents(), OSSPEECH_SETTINGS);
      await settle();

      await engine.stop();

      listenGate.resolve(unlistenSpy);
      await startP;

      expect(unlistenSpy).toHaveBeenCalledTimes(1);
    });

    // stop() can land in the GAP between the transcript and status
    // listen() calls — by the time the (still in-flight) status listen()
    // finally resolves, stop() has ALREADY torn down `this.
    // unlistenTranscript` itself (since it was already assigned) AND
    // abandonStart() independently tears down its OWN local holders —
    // the SAME transcript unlisten can therefore fire twice. That's
    // exactly as harmless here as appAudio.ts's own precedent (stop()
    // and abandonStart() can likewise both call the SAME WsTransport.
    // stop(), which tolerates it via its own `if (this.stopping) return`
    // guard) — real Tauri unlisten()s (and this suite's own fakes) are
    // equally idempotent to call more than once. What actually matters
    // is the OUTCOME: zero listeners left active either way, so this
    // asserts that invariant directly rather than an exact call count.
    it("stop() landing in the GAP between the two listen() calls still leaves ZERO active listeners once everything settles", async () => {
      const listenGate = deferred<void>();
      let transcriptRegistered = false;
      const { activeCount } = wireFakes();
      const realListen = currentListen;
      currentListen = (async (event: string, handler: (event: { event: string; payload: unknown }) => void) => {
        if (event === "osspeech://transcript") {
          transcriptRegistered = true;
          return realListen(event, handler);
        }
        await listenGate.promise;
        return realListen(event, handler);
      }) as ListenFn;

      const engine = new OsSpeechEngine();
      const startP = engine.start(noopEvents(), OSSPEECH_SETTINGS);
      await flushUntil(() => transcriptRegistered);
      await settle();

      await engine.stop();

      listenGate.resolve();
      await startP;

      expect(activeCount("osspeech://transcript")).toBe(0);
      expect(activeCount("osspeech://status")).toBe(0);
    });

    it("stop() landing while start_os_speech is still in flight tears down cleanly — a later capturing never reaches onStatus", async () => {
      const startOsSpeech = deferred<undefined>();
      const { calls, emit } = wireFakes({
        start_os_speech: () => startOsSpeech.promise,
      });
      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();

      const startP = engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);
      await flushUntil(() => calls.some((c) => c.cmd === "start_os_speech"));

      vi.useFakeTimers();
      const stopP = engine.stop();
      await flushUntil(() => calls.some((c) => c.cmd === "stop_os_speech"));

      startOsSpeech.resolve(undefined);
      await startP;

      onStatus.mockClear();
      emit("osspeech://status", { kind: "capturing", source: "session" });
      expect(onStatus).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(STOP_ENDED_TIMEOUT_MS);
      await stopP;

      expect(calls.filter((c) => c.cmd === "stop_os_speech").length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------
  // fix-round F6 (Sol, MEDIUM) — a rejected SECOND (status) subscription
  // must still run the abandon/cleanup path, not skip it and leak the
  // FIRST (transcript) listener that already registered.
  // ---------------------------------------------------------------

  describe("start() subscription-failure cleanup (fix-round F6)", () => {
    it("the status listen() rejecting tears down the already-registered transcript listener and settles in error state", async () => {
      const unlistenTranscriptSpy = vi.fn();
      const { calls } = wireFakes();
      currentListen = (async (event: string) => {
        if (event === "osspeech://transcript") return unlistenTranscriptSpy;
        throw new Error("register_listener denied");
      }) as ListenFn;

      const engine = new OsSpeechEngine();
      const onStatus = vi.fn();

      await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

      // Pre-fix: the rejected listenOsSpeechStatus() await sat outside
      // the try, so this never ran — the transcript PluginListener would
      // stay registered forever.
      expect(unlistenTranscriptSpy).toHaveBeenCalledTimes(1);
      expect(onStatus).toHaveBeenCalledWith("error", "无法启动系统识别，请重试");
      expect(calls.some((c) => c.cmd === "start_os_speech")).toBe(false);
      expect(calls.some((c) => c.cmd === "stop_os_speech")).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // pause() / resume()
  // ---------------------------------------------------------------

  describe("pause() / resume()", () => {
    it("pause() invokes pause_os_speech once running", async () => {
      const { calls } = wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      await engine.pause();

      expect(calls.some((c) => c.cmd === "pause_os_speech")).toBe(true);
    });

    it("resume() invokes resume_os_speech once running", async () => {
      const { calls } = wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      await engine.resume();

      expect(calls.some((c) => c.cmd === "resume_os_speech")).toBe(true);
    });

    it("a pause_os_speech invoke() rejection is logged-not-fatal", async () => {
      wireFakes({
        pause_os_speech: () => {
          throw new Error("ipc failure");
        },
      });
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      await expect(engine.pause()).resolves.toBeUndefined();
    });

    it("a resume_os_speech invoke() rejection is logged-not-fatal", async () => {
      wireFakes({
        resume_os_speech: () => {
          throw new Error("ipc failure");
        },
      });
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);

      await expect(engine.resume()).resolves.toBeUndefined();
    });

    it("pause()/resume() are no-ops once stopping", async () => {
      const { calls, emit } = wireFakes();
      const engine = new OsSpeechEngine();
      await engine.start(noopEvents(), OSSPEECH_SETTINGS);
      await stopViaEnded(engine, emit);
      calls.length = 0;

      await engine.pause();
      await engine.resume();

      expect(calls.some((c) => c.cmd === "pause_os_speech" || c.cmd === "resume_os_speech")).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // diag markers (light-touch, mirrors appAudio.ts's own convention)
  // ---------------------------------------------------------------

  it("logs an 'engine start requested' marker and a status marker for every osspeech://status kind received", async () => {
    const { emit } = wireFakes();
    const engine = new OsSpeechEngine();
    const startP = engine.start(noopEvents(), OSSPEECH_SETTINGS);

    expect(getDiagEntries().some((e) => e.tag === "stt-osspeech" && e.message.includes("启动请求"))).toBe(true);
    await startP;

    emit("osspeech://status", { kind: "starting", source: "session" });
    emit("osspeech://status", { kind: "capturing", source: "session" });

    const statusEntries = getDiagEntries().filter(
      (e) => e.tag === "stt-osspeech" && e.message.includes("osspeech://status"),
    );
    expect(statusEntries.map((e) => e.message)).toEqual([
      expect.stringContaining("starting"),
      expect.stringContaining("capturing"),
    ]);
  });
});
