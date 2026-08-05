// Lane W: mid-session STT liveness watchdog + per-channel silence hint.
// Fake timers throughout (vitest's default fake-timer set includes Date,
// same house pattern queue.test.ts/latencyStats.test.ts already use) —
// every verdict formula is wall-clock-gated, so real timers would make
// this suite flaky/slow for no reason.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../../store";
import {
  AUDIO_FLOOR,
  SPEECH_SAMPLE_FLOOR,
  STATS_STALE_MS,
  SILENT_CHANNEL_HINT_MS,
  WATCHDOG_MIN_AUDIO_WINDOWS,
  WATCHDOG_WALL_FLOOR_MS,
  WINDOW_LOUD_MS_MIN,
  armLiveness,
  disarmLiveness,
  noteResult,
  pushAudioWindow,
  resetLiveness,
  resumeLiveness,
  useAudioLiveness,
} from "../audioLiveness";

/** Baseline live-meeting store state every test starts from — a fresh
 *  listening meeting with no pause history. Individual tests override
 *  `status`/`pauseStartedAt` for their own pause/silentChannel scenarios. */
function primeAppStore(startedAt: number): void {
  useApp.setState({ status: "listening", startedAt, pausedAccumMs: 0, pauseStartedAt: null });
}

/** Pushes `count` audio-present windows on `channel`, advancing the fake
 *  clock by 1ms between each (so lastAudioAt/lastResultAt timestamps
 *  never collide) without pulling in the ~5s real cadence — the
 *  formulas only care about accumulated count + elapsed wall time, not
 *  the cadence between pushes. */
function pushLoudWindows(channel: Parameters<typeof pushAudioWindow>[0], count: number): void {
  for (let i = 0; i < count; i++) {
    pushAudioWindow(channel, AUDIO_FLOOR + 0.01);
    vi.advanceTimersByTime(1);
  }
}

describe("audioLiveness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetLiveness();
  });

  afterEach(() => {
    disarmLiveness();
    vi.useRealTimers();
  });

  describe("arming", () => {
    it("armLiveness no-ops for a non-qualifying engine (webspeech) — armed stays false", () => {
      armLiveness("webspeech");
      expect(useAudioLiveness.getState().armed).toBe(false);
    });

    it("armLiveness no-ops for a cloud engine (soniox)", () => {
      armLiveness("soniox");
      expect(useAudioLiveness.getState().armed).toBe(false);
    });

    it("armLiveness arms for every whisper-family kind + osspeech", () => {
      for (const engine of ["whisper", "tabaudio", "appaudio", "osspeech"] as const) {
        armLiveness(engine);
        expect(useAudioLiveness.getState().armed).toBe(true);
        disarmLiveness();
      }
    });

    it("pushAudioWindow/noteResult are no-ops while unarmed", () => {
      primeAppStore(Date.now());
      pushAudioWindow("default", 1);
      noteResult(undefined);
      expect(useAudioLiveness.getState().verdicts.watchdogChannels).toEqual([]);
    });
  });

  describe("floor gating + window accumulation", () => {
    beforeEach(() => {
      primeAppStore(Date.now());
      armLiveness("whisper");
    });

    it("a window at/below AUDIO_FLOOR never bumps everAudio/audioWindowsSinceResult (lull no-fire)", () => {
      pushAudioWindow("default", AUDIO_FLOOR);
      pushAudioWindow("default", AUDIO_FLOOR - 0.001);
      pushAudioWindow("default", 0);
      const c = useAudioLiveness.getState().channels.default;
      expect(c.everAudio).toBe(false);
      expect(c.audioWindowsSinceResult).toBe(0);
      expect(c.lastAudioAt).toBeNull();
    });

    it("a window above AUDIO_FLOOR bumps everAudio/lastAudioAt/audioWindowsSinceResult", () => {
      pushAudioWindow("default", AUDIO_FLOOR + 0.01);
      const c = useAudioLiveness.getState().channels.default;
      expect(c.everAudio).toBe(true);
      expect(c.lastAudioAt).not.toBeNull();
      expect(c.audioWindowsSinceResult).toBe(1);
    });

    it("audioWindowsSinceResult accumulates across repeated loud windows", () => {
      pushLoudWindows("default", 5);
      expect(useAudioLiveness.getState().channels.default.audioWindowsSinceResult).toBe(5);
    });

    it("every push updates lastStatsAt regardless of level", () => {
      const before = useAudioLiveness.getState().channels.default.lastStatsAt;
      vi.advanceTimersByTime(10);
      pushAudioWindow("default", 0); // below floor — still a stats tick
      expect(useAudioLiveness.getState().channels.default.lastStatsAt).toBeGreaterThan(before);
    });
  });

  // Fix C (pre-tag fix round, sustained-audio predicate): when a producer
  // carries `windowLoudMs`, it ALONE decides audio-presence — a single
  // loud sample (windowPeak comfortably above AUDIO_FLOOR) must not count
  // as "audio-present" if the DURATION of loud samples in that window
  // never reached WINDOW_LOUD_MS_MIN, and vice versa. Falls back to the
  // old windowPeak > AUDIO_FLOOR predicate only when windowLoudMs is
  // omitted entirely (an older/foreign producer).
  describe("windowLoudMs sustained-audio predicate (Fix C)", () => {
    beforeEach(() => {
      primeAppStore(Date.now());
      armLiveness("whisper");
    });

    it("a loud single-sample peak with windowLoudMs below WINDOW_LOUD_MS_MIN does NOT count as audio-present", () => {
      pushAudioWindow("default", AUDIO_FLOOR + 0.5, WINDOW_LOUD_MS_MIN - 1);
      const c = useAudioLiveness.getState().channels.default;
      expect(c.everAudio).toBe(false);
      expect(c.audioWindowsSinceResult).toBe(0);
    });

    it("windowLoudMs at/above WINDOW_LOUD_MS_MIN counts as audio-present even with a modest peak", () => {
      pushAudioWindow("default", AUDIO_FLOOR - 0.01, WINDOW_LOUD_MS_MIN);
      const c = useAudioLiveness.getState().channels.default;
      expect(c.everAudio).toBe(true);
      expect(c.audioWindowsSinceResult).toBe(1);
    });

    it("omitting windowLoudMs entirely falls back to the windowPeak > AUDIO_FLOOR predicate", () => {
      pushAudioWindow("default", AUDIO_FLOOR + 0.01);
      expect(useAudioLiveness.getState().channels.default.everAudio).toBe(true);

      pushAudioWindow("default", AUDIO_FLOOR);
      expect(useAudioLiveness.getState().channels.default.audioWindowsSinceResult).toBe(1); // unchanged — at-floor never bumps
    });
  });

  describe("watchdog verdict (1): loud audio, zero results", () => {
    beforeEach(() => {
      primeAppStore(Date.now());
      armLiveness("whisper");
    });

    it("does not fire below WATCHDOG_MIN_AUDIO_WINDOWS, however much wall clock passes", () => {
      pushLoudWindows("default", WATCHDOG_MIN_AUDIO_WINDOWS - 1);
      vi.advanceTimersByTime(WATCHDOG_WALL_FLOOR_MS + 1000);
      expect(useAudioLiveness.getState().verdicts.watchdogChannels).toEqual([]);
    });

    it("does not fire at the window threshold before WATCHDOG_WALL_FLOOR_MS has elapsed", () => {
      pushLoudWindows("default", WATCHDOG_MIN_AUDIO_WINDOWS);
      expect(useAudioLiveness.getState().verdicts.watchdogChannels).toEqual([]);
    });

    it("fires once BOTH the window count and wall-clock floor are satisfied", () => {
      pushLoudWindows("default", WATCHDOG_MIN_AUDIO_WINDOWS);
      vi.advanceTimersByTime(WATCHDOG_WALL_FLOOR_MS);
      // One more push re-evaluates verdicts against the now-elapsed clock
      // (verdicts are lazily recomputed at push time — see the module's
      // own doc comment).
      pushAudioWindow("default", AUDIO_FLOOR + 0.01);
      expect(useAudioLiveness.getState().verdicts.watchdogChannels).toEqual(["default"]);
    });
  });

  describe("noteResult", () => {
    beforeEach(() => {
      primeAppStore(Date.now());
      armLiveness("osspeech");
    });

    it("a final clears ONLY its own channel's count/lastResultAt", () => {
      pushLoudWindows("mic", 5);
      pushLoudWindows("system", 5);
      noteResult("mic");
      const s = useAudioLiveness.getState();
      expect(s.channels.mic.audioWindowsSinceResult).toBe(0);
      expect(s.channels.system.audioWindowsSinceResult).toBe(5);
    });

    it("an unknown/undefined channel (every interim) clears EVERY channel — conservative, false-negative-safe", () => {
      pushLoudWindows("mic", 5);
      pushLoudWindows("system", 5);
      noteResult(undefined);
      const s = useAudioLiveness.getState();
      expect(s.channels.mic.audioWindowsSinceResult).toBe(0);
      expect(s.channels.system.audioWindowsSinceResult).toBe(0);
    });

    it("clearing a channel resolves an already-active watchdog verdict for it", () => {
      pushLoudWindows("mic", WATCHDOG_MIN_AUDIO_WINDOWS);
      vi.advanceTimersByTime(WATCHDOG_WALL_FLOOR_MS);
      pushAudioWindow("mic", AUDIO_FLOOR + 0.01);
      expect(useAudioLiveness.getState().verdicts.watchdogChannels).toEqual(["mic"]);

      noteResult("mic");
      expect(useAudioLiveness.getState().verdicts.watchdogChannels).toEqual([]);
    });

    it("recovery then re-arm: a watchdog that clears can fire again on a LATER streak", () => {
      disarmLiveness();
      armLiveness("whisper");

      pushLoudWindows("default", WATCHDOG_MIN_AUDIO_WINDOWS);
      vi.advanceTimersByTime(WATCHDOG_WALL_FLOOR_MS);
      pushAudioWindow("default", AUDIO_FLOOR + 0.01);
      expect(useAudioLiveness.getState().verdicts.watchdogChannels).toEqual(["default"]);

      noteResult(undefined); // a result finally lands — clears the streak
      expect(useAudioLiveness.getState().verdicts.watchdogChannels).toEqual([]);

      // A second, independent streak of loud-audio-with-no-result.
      pushLoudWindows("default", WATCHDOG_MIN_AUDIO_WINDOWS);
      vi.advanceTimersByTime(WATCHDOG_WALL_FLOOR_MS);
      pushAudioWindow("default", AUDIO_FLOOR + 0.01);
      expect(useAudioLiveness.getState().verdicts.watchdogChannels).toEqual(["default"]);
    });

    // Fix B (pre-tag fix round, HIGH): before that fix, EVERY interim
    // (regardless of which channel actually produced it) called
    // noteResult(undefined) — the surviving channel's own interims kept
    // perpetually clearing a wedged sibling's count, making its watchdog
    // unreachable in practice. With the channel now threaded through
    // (useMeeting.ts's onInterim -> noteResult(channelFromSttSpeaker(...))),
    // a channel that produced results and then died is catchable: the
    // OTHER channel's continuing interims/finals no longer touch it.
    it("a channel that goes silent stays catchable even while the OTHER channel keeps producing results (Fix B)", () => {
      // "mic" accumulates enough loud-audio-with-no-result evidence to
      // satisfy the watchdog's window-count floor, then goes quiet —
      // representing a wedged/dead lane.
      pushLoudWindows("mic", WATCHDOG_MIN_AUDIO_WINDOWS);

      // "system" keeps right on producing results for the whole
      // WATCHDOG_WALL_FLOOR_MS wait — each one now correctly attributed
      // to ONLY "system" (the post-Fix-B behavior), never clearing mic's
      // count the way an unconditional noteResult(undefined) used to.
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(WATCHDOG_WALL_FLOOR_MS / 5);
        noteResult("system");
      }

      pushAudioWindow("mic", AUDIO_FLOOR + 0.01); // re-evaluate against the now-elapsed clock
      expect(useAudioLiveness.getState().verdicts.watchdogChannels).toEqual(["mic"]);
    });
  });

  // Fix E (pre-tag fix round, MEDIUM): computeVerdicts used to return a
  // fresh object/arrays on EVERY noteResult/pushAudioWindow call, so
  // StatusLine (which reads `verdicts` reactively) re-rendered on every
  // single interim for the whole meeting even when nothing about the
  // verdict actually changed.
  describe("verdict object identity (Fix E)", () => {
    it("two consecutive noteResults with an unchanged verdict return the SAME verdicts object (Object.is)", () => {
      primeAppStore(Date.now());
      armLiveness("whisper");

      noteResult(undefined);
      const first = useAudioLiveness.getState().verdicts;
      noteResult(undefined);
      const second = useAudioLiveness.getState().verdicts;
      expect(Object.is(first, second)).toBe(true);
    });
  });

  describe("pause suppression", () => {
    beforeEach(() => {
      primeAppStore(Date.now());
      armLiveness("whisper");
    });

    it("while paused, a loud window updates lastStatsAt but never bumps everAudio/audioWindowsSinceResult", () => {
      useApp.setState({ status: "paused", pauseStartedAt: Date.now() });
      pushLoudWindows("default", WATCHDOG_MIN_AUDIO_WINDOWS + 5);
      const c = useAudioLiveness.getState().channels.default;
      expect(c.everAudio).toBe(false);
      expect(c.audioWindowsSinceResult).toBe(0);
      expect(c.lastStatsAt).not.toBeNull();
    });

    it("statsStale never fires while paused, however long the pipeline goes quiet", () => {
      useApp.setState({ status: "paused", pauseStartedAt: Date.now() });
      vi.advanceTimersByTime(STATS_STALE_MS * 3);
      expect(useAudioLiveness.getState().verdicts.statsStale).toBe(false);
    });
  });

  describe("statsStale verdict (2): the sentinel's own job", () => {
    beforeEach(() => {
      primeAppStore(Date.now());
      armLiveness("whisper");
    });

    it("stays false before STATS_STALE_MS has elapsed with no activity", () => {
      vi.advanceTimersByTime(STATS_STALE_MS - 1000);
      expect(useAudioLiveness.getState().verdicts.statsStale).toBe(false);
    });

    it("fires via the sentinel tick alone — no push required — once STATS_STALE_MS elapses while listening+unpaused", () => {
      vi.advanceTimersByTime(STATS_STALE_MS + 1000);
      expect(useAudioLiveness.getState().verdicts.statsStale).toBe(true);
    });

    it("a fresh push resets the clock — statsStale clears", () => {
      vi.advanceTimersByTime(STATS_STALE_MS + 1000);
      expect(useAudioLiveness.getState().verdicts.statsStale).toBe(true);

      pushAudioWindow("default", 0);
      expect(useAudioLiveness.getState().verdicts.statsStale).toBe(false);
    });

    it("never fires while not listening (e.g. connecting)", () => {
      useApp.setState({ status: "connecting" });
      vi.advanceTimersByTime(STATS_STALE_MS + 1000);
      expect(useAudioLiveness.getState().verdicts.statsStale).toBe(false);
    });

    it("noticeTick: bumped by the sentinel each tick WHILE a warning persists (StatusLine's re-notice heartbeat), untouched while idle or after recovery", () => {
      const idleTick = useAudioLiveness.getState().noticeTick;
      vi.advanceTimersByTime(30_000); // two sentinel ticks, no verdict yet
      expect(useAudioLiveness.getState().noticeTick).toBe(idleTick);

      vi.advanceTimersByTime(STATS_STALE_MS); // statsStale active from here
      const activeTick = useAudioLiveness.getState().noticeTick;
      expect(activeTick).toBeGreaterThan(idleTick);

      vi.advanceTimersByTime(30_000); // two more ticks, still stale
      expect(useAudioLiveness.getState().noticeTick).toBeGreaterThanOrEqual(activeTick + 2);

      pushAudioWindow("default", 0); // fresh stats line — statsStale clears
      const recoveredTick = useAudioLiveness.getState().noticeTick;
      vi.advanceTimersByTime(30_000); // safely under a fresh STATS_STALE_MS
      expect(useAudioLiveness.getState().noticeTick).toBe(recoveredTick);
    });
  });

  describe("silentChannel hint (3): dual-capture osspeech only", () => {
    beforeEach(() => {
      primeAppStore(Date.now());
      armLiveness("osspeech");
    });

    it("does not fire before SILENT_CHANNEL_HINT_MS of active session time has elapsed", () => {
      pushLoudWindows("mic", 3);
      vi.advanceTimersByTime(SILENT_CHANNEL_HINT_MS - 1000);
      pushAudioWindow("mic", AUDIO_FLOOR + 0.01);
      expect(useAudioLiveness.getState().verdicts.silentChannels).toEqual([]);
    });

    it("fires for the channel that never crossed AUDIO_FLOOR once the OTHER channel has audio and 10 minutes elapse", () => {
      pushLoudWindows("mic", 3);
      vi.advanceTimersByTime(SILENT_CHANNEL_HINT_MS);
      pushAudioWindow("mic", AUDIO_FLOOR + 0.01); // re-evaluate against the now-elapsed clock
      expect(useAudioLiveness.getState().verdicts.silentChannels).toEqual(["system"]);
    });

    it("never fires for the single-lane 'default' channel (no 'other channel' to compare against)", () => {
      disarmLiveness();
      armLiveness("whisper");
      pushLoudWindows("default", 3);
      vi.advanceTimersByTime(SILENT_CHANNEL_HINT_MS);
      pushAudioWindow("default", AUDIO_FLOOR + 0.01);
      expect(useAudioLiveness.getState().verdicts.silentChannels).toEqual([]);
    });

    it("does not fire once BOTH channels have seen audio", () => {
      pushLoudWindows("mic", 3);
      pushLoudWindows("system", 3);
      vi.advanceTimersByTime(SILENT_CHANNEL_HINT_MS);
      pushAudioWindow("mic", AUDIO_FLOOR + 0.01);
      expect(useAudioLiveness.getState().verdicts.silentChannels).toEqual([]);
    });

    it("excludes PAUSED time from the elapsed-active-time floor", () => {
      pushLoudWindows("mic", 3);
      // Most of the wall-clock gap is a pause — active time stays well
      // under SILENT_CHANNEL_HINT_MS even though real time exceeds it.
      useApp.setState({ status: "paused", pauseStartedAt: Date.now() });
      vi.advanceTimersByTime(SILENT_CHANNEL_HINT_MS + 60_000);
      useApp.setState((s) => ({
        status: "listening",
        pausedAccumMs: s.pausedAccumMs + (Date.now() - (s.pauseStartedAt ?? Date.now())),
        pauseStartedAt: null,
      }));
      pushAudioWindow("mic", AUDIO_FLOOR + 0.01);
      expect(useAudioLiveness.getState().verdicts.silentChannels).toEqual([]);
    });
  });

  // Fix A (pre-tag fix round, CRITICAL): a soft pause (tabaudio/appaudio)
  // keeps the SAME watchdog session alive across the pause — resumeLiveness()
  // is what useMeeting.ts's own soft-resume branch calls on the
  // paused->listening transition to re-seed every channel's evidence
  // clocks, closing the false-stall/false-statsStale a long pause would
  // otherwise manufacture (retained pre-pause counts + a frozen
  // lastStatsAt). Both scenario tests below simulate that exact
  // sequence: pushLoudWindows/pause/advance/resume+resumeLiveness().
  describe("resumeLiveness (Fix A: post-resume false-stall/false-statsStale)", () => {
    beforeEach(() => {
      primeAppStore(Date.now());
      armLiveness("tabaudio");
    });

    function simulatePauseThenResume(pauseMs: number): void {
      useApp.setState({ status: "paused", pauseStartedAt: Date.now() });
      vi.advanceTimersByTime(pauseMs);
      useApp.setState((s) => ({
        status: "listening",
        pausedAccumMs: s.pausedAccumMs + (Date.now() - (s.pauseStartedAt ?? Date.now())),
        pauseStartedAt: null,
      }));
      resumeLiveness();
    }

    it("long pause -> resume -> sentinel ticks BEFORE the first post-resume push -> no statsStale", () => {
      simulatePauseThenResume(20 * 60_000); // a 20-minute break

      // The free-running 15s sentinel fires (real setInterval, fake
      // timers) well before any post-resume pushAudioWindow ever lands
      // (up to 5s of audio needed for the first fold flush) — without
      // Fix A, lastStatsAt would still read its frozen pre-pause value
      // here and this tick would false-fire statsStale.
      vi.advanceTimersByTime(15_000);
      expect(useAudioLiveness.getState().verdicts.statsStale).toBe(false);
    });

    it("12 pre-pause windows + long pause -> resume -> no immediate watchdog fire", () => {
      pushLoudWindows("default", WATCHDOG_MIN_AUDIO_WINDOWS);

      // Without Fix A, the wall-clock floor (now - lastResultAt) is
      // pre-satisfied the instant the pause ends — the retained
      // audioWindowsSinceResult count from before the pause already
      // meets WATCHDOG_MIN_AUDIO_WINDOWS.
      simulatePauseThenResume(20 * 60_000);

      expect(useAudioLiveness.getState().verdicts.watchdogChannels).toEqual([]);
    });
  });

  describe("resetLiveness", () => {
    it("clears every channel's counters and verdicts, and disarms", () => {
      primeAppStore(Date.now());
      armLiveness("whisper");
      pushLoudWindows("default", WATCHDOG_MIN_AUDIO_WINDOWS);
      vi.advanceTimersByTime(WATCHDOG_WALL_FLOOR_MS);
      pushAudioWindow("default", AUDIO_FLOOR + 0.01);
      expect(useAudioLiveness.getState().verdicts.watchdogChannels).toEqual(["default"]);

      resetLiveness();
      const s = useAudioLiveness.getState();
      expect(s.armed).toBe(false);
      expect(s.verdicts).toEqual({ watchdogChannels: [], statsStale: false, silentChannels: [] });
      expect(s.channels.default.audioWindowsSinceResult).toBe(0);
    });
  });

  // Fix H (pre-tag fix round, LOW): this suite imports every tunable by
  // name, so silently changing one of these values (e.g.
  // WATCHDOG_MIN_AUDIO_WINDOWS to 2, or AUDIO_FLOOR to 0.003) would keep
  // every test above green — none of them pin the LITERAL value, only the
  // relative behavior around it. Changing any of these is a product
  // decision (how aggressively the watchdog warns), not a refactor —
  // this is the one place a change to any of them must show up as a
  // failing test, forcing a conscious update here.
  describe("tunable contract pins", () => {
    it("pins the exact tunable values", () => {
      expect(AUDIO_FLOOR).toBe(0.06);
      expect(WATCHDOG_MIN_AUDIO_WINDOWS).toBe(12);
      expect(WATCHDOG_WALL_FLOOR_MS).toBe(90_000);
      expect(STATS_STALE_MS).toBe(45_000);
      expect(SILENT_CHANNEL_HINT_MS).toBe(600_000);
      expect(WINDOW_LOUD_MS_MIN).toBe(1000);
      expect(SPEECH_SAMPLE_FLOOR).toBe(0.05);
    });
  });
});
