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
