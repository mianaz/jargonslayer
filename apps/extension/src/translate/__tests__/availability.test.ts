import { describe, expect, it } from "vitest";

import {
  canUseCapabilityNow,
  INITIAL_CAPABILITY_STATE,
  normalizeDownloadProgress,
  reduceCapabilityState,
} from "../availability";

describe("reduceCapabilityState", () => {
  it("starts unsupported and unusable", () => {
    expect(INITIAL_CAPABILITY_STATE.status).toBe("unsupported");
    expect(canUseCapabilityNow(INITIAL_CAPABILITY_STATE)).toBe(false);
  });

  it("an explicit unsupported event resets to the initial state", () => {
    const state = reduceCapabilityState(
      { status: "downloading", progress: 0.5, message: null },
      { type: "unsupported" },
    );
    expect(state).toEqual(INITIAL_CAPABILITY_STATE);
  });

  it("checked(available) marks the capability usable immediately with full progress", () => {
    const state = reduceCapabilityState(INITIAL_CAPABILITY_STATE, {
      type: "checked",
      status: "available",
    });
    expect(state.status).toBe("available");
    expect(state.progress).toBe(1);
    expect(canUseCapabilityNow(state)).toBe(true);
  });

  it.each(["unavailable", "downloadable", "downloading"] as const)(
    "checked(%s) is not usable yet and resets progress",
    (status) => {
      const state = reduceCapabilityState(
        { status: "available", progress: 1, message: null },
        { type: "checked", status },
      );
      expect(state.status).toBe(status);
      expect(state.progress).toBe(0);
      expect(canUseCapabilityNow(state)).toBe(false);
    },
  );

  it("download-progress clamps out-of-range fractions into [0,1]", () => {
    const over = reduceCapabilityState(INITIAL_CAPABILITY_STATE, {
      type: "download-progress",
      progress: 1.4,
    });
    expect(over.status).toBe("downloading");
    expect(over.progress).toBe(1);

    const under = reduceCapabilityState(INITIAL_CAPABILITY_STATE, {
      type: "download-progress",
      progress: -0.2,
    });
    expect(under.progress).toBe(0);

    const nan = reduceCapabilityState(INITIAL_CAPABILITY_STATE, {
      type: "download-progress",
      progress: Number.NaN,
    });
    expect(nan.progress).toBe(0);
  });

  it("ready transitions straight to available regardless of prior status", () => {
    const state = reduceCapabilityState(
      { status: "downloading", progress: 0.7, message: null },
      { type: "ready" },
    );
    expect(state.status).toBe("available");
    expect(state.progress).toBe(1);
    expect(canUseCapabilityNow(state)).toBe(true);
  });

  it("error flips status to error and preserves a message, without touching progress", () => {
    const state = reduceCapabilityState(
      { status: "downloading", progress: 0.3, message: null },
      { type: "error", message: "boom" },
    );
    expect(state.status).toBe("error");
    expect(state.message).toBe("boom");
    expect(state.progress).toBe(0.3);
    expect(canUseCapabilityNow(state)).toBe(false);
  });
});

describe("normalizeDownloadProgress", () => {
  it("treats loaded<=1 as an already-computed fraction (today's real Chrome behavior)", () => {
    expect(normalizeDownloadProgress(0.42, 1)).toBe(0.42);
    expect(normalizeDownloadProgress(1, 1)).toBe(1);
    expect(normalizeDownloadProgress(0, 0)).toBe(0);
  });

  it("derives loaded/total when loaded looks like a byte count (>1)", () => {
    expect(normalizeDownloadProgress(4_500_000, 9_000_000)).toBe(0.5);
  });

  it("falls back to 0 for a non-finite or zero-total byte reading", () => {
    expect(normalizeDownloadProgress(Number.NaN, 100)).toBe(0);
    expect(normalizeDownloadProgress(5, 0)).toBe(0);
  });
});
