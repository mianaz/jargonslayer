// Lane W: mid-session STT liveness watchdog + per-channel silence hint.
// Fake timers throughout (vitest's default fake-timer set includes Date,
// same house pattern queue.test.ts/latencyStats.test.ts already use) —
// every verdict formula is wall-clock-gated, so real timers would make
// this suite flaky/slow for no reason.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../../store";
import {
  AUDIO_FLOOR,
  STATS_STALE_MS,
  SILENT_CHANNEL_HINT_MS,
  WATCHDOG_MIN_AUDIO_WINDOWS,
  WATCHDOG_WALL_FLOOR_MS,
  armLiveness,
  disarmLiveness,
  noteResult,
  pushAudioWindow,
  resetLiveness,
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
});
