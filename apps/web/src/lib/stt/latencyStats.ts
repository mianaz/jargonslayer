// S10 field-fix #5 — smoothed local-Whisper transcribe latency. wsTransport.
// ts pushes one raw lag_ms sample per partial/final message that carries
// one (additive/optional field, see that file's own parse); StatusLine
// reads the smoothed value and shows a 延迟 chip once it stays above its
// own threshold. Own tiny zustand store, mirroring registry.ts's plain
// `create(() => ({...}))` shape — session-scoped, no persistence.

import { create } from "zustand";

export interface LatencyStatsState {
  lagMs: number | null;
  /** S10 field-fix #8 (LOW, adversarial review): hysteresis-gated
   *  "show the 延迟 chip" signal — StatusLine reads this directly
   *  instead of re-deriving its own `lagMs > threshold` check, so the
   *  ON/OFF thresholds and anti-flap consecutive-sample counting live
   *  in exactly one place. ON only once the SMOOTHED lagMs has read
   *  above SUSTAINED_ON_MS for SUSTAINED_ON_SAMPLES consecutive pushes;
   *  OFF as soon as it dips below SUSTAINED_OFF_MS (a single sample —
   *  the concern is a flash-ON false alarm, not a flash-OFF one).
   *  Between the two thresholds, holds whatever it last was (the
   *  hysteresis dead zone) — this is what stops a reading hovering near
   *  2000ms from flipping the chip on every single sample. */
  sustained: boolean;
}

export const useLatencyStats = create<LatencyStatsState>(() => ({ lagMs: null, sustained: false }));

// EMA smoothing (picked over a rolling window: O(1) state, no buffer to
// size/prune). Alpha tuned for "reacts within a few samples, doesn't
// flash on one slow inference" — a sustained slowdown crosses the
// SUSTAINED_ON_MS threshold within 2-3 partials (~PARTIAL_INTERVAL_S
// apart, see whisper_server.py) rather than being averaged away over a
// long tail.
const EMA_ALPHA = 0.3;

// S10 field-fix #8 hysteresis thresholds — see LatencyStatsState.sustained's
// own doc comment for the ON/OFF/dead-zone contract.
const SUSTAINED_ON_MS = 2000;
const SUSTAINED_OFF_MS = 1200;
const SUSTAINED_ON_SAMPLES = 3;

// Consecutive-above-SUSTAINED_ON_MS push count — private to this module
// (StatusLine only ever needs the derived `sustained` boolean, not the
// raw streak), reset by any push that doesn't extend it and by
// resetLagStats(). Session-scoped like the store itself.
let aboveOnThresholdStreak = 0;

/** Feeds one fresh lag_ms sample into the smoothed value (+ the
 *  `sustained` hysteresis gate above it). The first sample after a
 *  null/reset state seeds the average directly (no artificial ramp-up
 *  from 0, which would otherwise read as "instant" right after a fresh
 *  connection). */
export function pushLagSample(sampleMs: number): void {
  useLatencyStats.setState((s) => {
    const lagMs = s.lagMs === null ? sampleMs : s.lagMs + EMA_ALPHA * (sampleMs - s.lagMs);
    aboveOnThresholdStreak = lagMs > SUSTAINED_ON_MS ? aboveOnThresholdStreak + 1 : 0;
    const sustained =
      lagMs < SUSTAINED_OFF_MS
        ? false
        : aboveOnThresholdStreak >= SUSTAINED_ON_SAMPLES
          ? true
          : s.sustained; // dead zone (or not-yet-3-consecutive) — hold the previous reading
    return { lagMs, sustained };
  });
}

/** Resets the smoothed value (+ the sustained streak/flag) — a fresh
 *  meeting/engine session must never show a stale reading carried over
 *  from a previous one. Wired from useMeeting.ts's own per-session
 *  reset (see that file's beginMeeting/newMeeting handling). */
export function resetLagStats(): void {
  aboveOnThresholdStreak = 0;
  useLatencyStats.setState({ lagMs: null, sustained: false });
}
