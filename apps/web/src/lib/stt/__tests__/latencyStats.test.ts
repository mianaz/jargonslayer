import { beforeEach, describe, expect, it } from "vitest";
import { pushLagSample, resetLagStats, useLatencyStats } from "../latencyStats";

describe("latencyStats — smoothed lag_ms (S10 field-fix #5)", () => {
  beforeEach(() => {
    resetLagStats();
  });

  it("starts null (no sample seen yet)", () => {
    expect(useLatencyStats.getState().lagMs).toBeNull();
  });

  it("the first sample after a null/reset state seeds the average directly — no ramp-up from 0", () => {
    pushLagSample(1000);
    expect(useLatencyStats.getState().lagMs).toBe(1000);
  });

  it("a second sample applies EMA smoothing rather than overwriting", () => {
    pushLagSample(1000);
    pushLagSample(2000);
    // EMA_ALPHA = 0.3: 1000 + 0.3 * (2000 - 1000) = 1300
    expect(useLatencyStats.getState().lagMs).toBeCloseTo(1300);
  });

  it("a sustained higher value pulls the smoothed reading up over several samples without ever jumping straight to it", () => {
    pushLagSample(500);
    const readings: number[] = [];
    for (let i = 0; i < 5; i++) {
      pushLagSample(3000);
      readings.push(useLatencyStats.getState().lagMs as number);
    }
    // Monotonically increasing toward 3000, never overshooting it, never
    // reaching it in one tick.
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i]).toBeGreaterThan(readings[i - 1]);
    }
    expect(readings[0]).toBeLessThan(3000);
    expect(readings[readings.length - 1]).toBeLessThan(3000);
    expect(readings[readings.length - 1]).toBeGreaterThan(2000);
  });

  it("a sustained lower value pulls the smoothed reading down the same way", () => {
    pushLagSample(3000);
    pushLagSample(500);
    const first = useLatencyStats.getState().lagMs as number;
    expect(first).toBeLessThan(3000);
    expect(first).toBeGreaterThan(500);
  });

  it("resetLagStats clears back to null", () => {
    pushLagSample(1500);
    expect(useLatencyStats.getState().lagMs).not.toBeNull();
    resetLagStats();
    expect(useLatencyStats.getState().lagMs).toBeNull();
  });
});

// ---------------------------------------------------------------
// S10 field-fix #8 (LOW, adversarial review): `sustained` — a
// hysteresis-gated ON/OFF signal StatusLine reads directly (stays
// dumb, no threshold of its own). ON only once the SMOOTHED lagMs has
// read above 2000ms for 3 CONSECUTIVE pushes; OFF as soon as it dips
// below 1200ms (one sample, no counting on the way down); holds
// whatever it last was in between (the dead zone) — this is what stops
// a value hovering near 2000ms from flipping the chip on every single
// sample.
// ---------------------------------------------------------------

describe("latencyStats — sustained (S10 field-fix #8: hysteresis, no per-sample flapping)", () => {
  beforeEach(() => {
    resetLagStats();
  });

  it("starts false (no sample seen yet)", () => {
    expect(useLatencyStats.getState().sustained).toBe(false);
  });

  it("stays false below the 2000ms ON threshold, however many samples arrive", () => {
    for (let i = 0; i < 5; i++) pushLagSample(1500);
    expect(useLatencyStats.getState().sustained).toBe(false);
  });

  it("turns true only after 3 consecutive smoothed samples above 2000ms, not sooner", () => {
    pushLagSample(5000);
    expect(useLatencyStats.getState().sustained).toBe(false);
    pushLagSample(5000);
    expect(useLatencyStats.getState().sustained).toBe(false);
    pushLagSample(5000);
    expect(useLatencyStats.getState().sustained).toBe(true);
  });

  it("a streak interrupted by a below-2000 smoothed reading resets the consecutive count", () => {
    pushLagSample(5000);
    pushLagSample(5000); // streak = 2, still not sustained
    expect(useLatencyStats.getState().sustained).toBe(false);

    // A single sharply-low sample so the SMOOTHED result drops below
    // 2000 in exactly one step (a gently-decaying sample, e.g. 0,
    // stays above 2000 for a couple more pushes first under EMA
    // smoothing, which would confound this specific assertion).
    pushLagSample(-6000);
    expect(useLatencyStats.getState().lagMs).toBeLessThan(2000);
    expect(useLatencyStats.getState().sustained).toBe(false); // dead zone/reset streak — holds false

    pushLagSample(5000);
    pushLagSample(5000);
    // Only 2 consecutive-above-2000 samples since the reset — not yet 3.
    expect(useLatencyStats.getState().sustained).toBe(false);
  });

  it("holds true through the 1200-2000ms dead zone during a descent, then flips false exactly once it crosses below 1200ms", () => {
    pushLagSample(5000);
    pushLagSample(5000);
    pushLagSample(5000);
    expect(useLatencyStats.getState().sustained).toBe(true);

    let sawDeadZoneStillSustained = false;
    for (let i = 0; i < 40; i++) {
      pushLagSample(0);
      const s = useLatencyStats.getState();
      if (s.lagMs === null) continue;
      if (s.lagMs >= 1200) {
        // Never flips early, including the whole 1200-2000 dead zone.
        expect(s.sustained).toBe(true);
        if (s.lagMs < 2000) sawDeadZoneStillSustained = true;
      } else {
        expect(s.sustained).toBe(false);
        break;
      }
    }
    // Sanity check the loop actually passed through the dead zone
    // rather than jumping straight past it.
    expect(sawDeadZoneStillSustained).toBe(true);
  });

  it("the flap case: 2100/1900 alternating does not toggle sustained on every sample", () => {
    const samples = [2100, 1900, 2100, 1900, 2100, 1900];
    const trace: boolean[] = [];
    for (const sample of samples) {
      pushLagSample(sample);
      trace.push(useLatencyStats.getState().sustained);
    }
    // The old single-threshold check flipped on every sample (up to 5
    // flips across 6 pushes) — hysteresis must settle into a stable
    // on/off state instead.
    let flips = 0;
    for (let i = 1; i < trace.length; i++) {
      if (trace[i] !== trace[i - 1]) flips++;
    }
    expect(flips).toBeLessThanOrEqual(1);
  });

  it("resetLagStats also resets sustained back to false", () => {
    pushLagSample(5000);
    pushLagSample(5000);
    pushLagSample(5000);
    expect(useLatencyStats.getState().sustained).toBe(true);
    resetLagStats();
    expect(useLatencyStats.getState().sustained).toBe(false);
  });
});
