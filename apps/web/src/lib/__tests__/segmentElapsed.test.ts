import { describe, expect, it } from "vitest";
import {
  formatElapsedClock,
  resolveSessionElapsedBasis,
  segmentElapsedMs,
} from "../segmentElapsed";
import type { MeetingSession, TranscriptSegment } from "@jargonslayer/core/types";

function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "seg-1",
    index: 0,
    startedAt: 1000,
    endedAt: 1100,
    text: "hello",
    engine: "whisper",
    ...overrides,
  };
}

describe("segmentElapsedMs — per-segment paused-interval mapping (transcript-timestamp fix)", () => {
  it("no pauses: elapsed is a plain subtraction from meeting start", () => {
    expect(segmentElapsedMs(0, 5000, [])).toBe(5000);
    expect(segmentElapsedMs(1000, 4000, [])).toBe(3000);
  });

  it("a pause that completed BEFORE the segment is excluded from its elapsed reading", () => {
    // Meeting starts at 0, paused [1000,3000) (2s), segment starts at 5000.
    // Naive wall-clock elapsed would be 5000; excluding the 2s pause -> 3000.
    expect(segmentElapsedMs(0, 5000, [{ start: 1000, end: 3000 }])).toBe(3000);
  });

  it("a pause that happens AFTER the segment does NOT retroactively shrink its elapsed reading", () => {
    // Segment at 2000 (before the pause even starts) must be unaffected by
    // a LATER pause interval [3000,6000) — this is the crux of the fix:
    // earlier segments must not be affected by later pauses.
    expect(segmentElapsedMs(0, 2000, [{ start: 3000, end: 6000 }])).toBe(2000);
  });

  it("only pauses that finished before the segment count — a mix of before/after intervals", () => {
    const pauseIntervals = [
      { start: 1000, end: 2000 }, // 1s, before segment (4000) -> excluded
      { start: 5000, end: 8000 }, // after segment -> not excluded
    ];
    // Elapsed = 4000 - 0 - 1000(excluded pause) = 3000
    expect(segmentElapsedMs(0, 4000, pauseIntervals)).toBe(3000);
  });

  it("multiple completed pauses before the segment all get excluded", () => {
    const pauseIntervals = [
      { start: 1000, end: 2000 }, // 1s
      { start: 4000, end: 4500 }, // 0.5s
    ];
    // meeting start 0, segment at 10_000: 10_000 - 1500(paused) = 8500
    expect(segmentElapsedMs(0, 10_000, pauseIntervals)).toBe(8500);
  });

  it("clamps to 0 rather than going negative on pathological inputs", () => {
    expect(segmentElapsedMs(5000, 5000, [{ start: 0, end: 10_000 }])).toBe(0);
    expect(segmentElapsedMs(10_000, 5000, [])).toBe(0);
  });

  it("defensive: an interval that started before the segment but hasn't 'ended' before it is clamped to its portion before the segment (shouldn't happen live — no segment can arrive mid-pause — but must not corrupt the result)", () => {
    // Pause [1000, 9000) "still open" relative to a segment at 4000 —
    // only the [1000,4000) portion (3000ms) can possibly be "before" it.
    expect(segmentElapsedMs(0, 4000, [{ start: 1000, end: 9000 }])).toBe(1000);
  });
});

describe("resolveSessionElapsedBasis — legacy-session fallback (transcript-timestamp fix)", () => {
  function makeSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
    return {
      id: "s1",
      title: "t",
      startedAt: 500,
      endedAt: 9000,
      engine: "whisper",
      segments: [makeSegment({ startedAt: 1000 }), makeSegment({ id: "seg-2", startedAt: 4000 })],
      cards: [],
      terms: [],
      ...overrides,
    };
  }

  it("a session saved by this fix (pauseIntervals present, even []) keeps session.startedAt as the zero point", () => {
    const session = makeSession({ pauseIntervals: [] });
    const basis = resolveSessionElapsedBasis(session);
    expect(basis.startedAt).toBe(500); // session.startedAt, NOT segments[0].startedAt (1000)
    expect(basis.pauseIntervals).toEqual([]);
  });

  it("a session saved with real pause history keeps it intact", () => {
    const pauseIntervals = [{ start: 1500, end: 2500 }];
    const session = makeSession({ pauseIntervals });
    const basis = resolveSessionElapsedBasis(session);
    expect(basis.startedAt).toBe(500);
    expect(basis.pauseIntervals).toBe(pauseIntervals);
  });

  it("legacy session (pauseIntervals absent, undefined — pre-fix data) falls back to the first segment's own startedAt, with no pause exclusion", () => {
    const session = makeSession(); // no pauseIntervals key at all
    expect(session.pauseIntervals).toBeUndefined();
    const basis = resolveSessionElapsedBasis(session);
    expect(basis.startedAt).toBe(1000); // segments[0].startedAt, NOT session.startedAt (500)
    expect(basis.pauseIntervals).toEqual([]);
  });

  it("legacy session with zero segments falls back to session.startedAt itself — never crashes, never NaN", () => {
    const session = makeSession({ segments: [] });
    const basis = resolveSessionElapsedBasis(session);
    expect(basis.startedAt).toBe(500);
    expect(Number.isNaN(basis.startedAt)).toBe(false);
  });

  it("loading a legacy session never produces a negative elapsed for its own first segment", () => {
    const session = makeSession(); // legacy: falls back to segments[0].startedAt
    const basis = resolveSessionElapsedBasis(session);
    const elapsed = segmentElapsedMs(basis.startedAt, session.segments[0].startedAt, basis.pauseIntervals);
    expect(elapsed).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });
});

describe("formatElapsedClock — M:SS, hours as H:MM:SS", () => {
  it("formats zero as 0:00", () => {
    expect(formatElapsedClock(0)).toBe("0:00");
  });

  it("formats sub-minute durations as M:SS", () => {
    expect(formatElapsedClock(5_000)).toBe("0:05");
    expect(formatElapsedClock(59_000)).toBe("0:59");
  });

  it("formats minute-scale durations as M:SS without zero-padding minutes", () => {
    expect(formatElapsedClock(65_000)).toBe("1:05");
    expect(formatElapsedClock(9 * 60_000 + 9_000)).toBe("9:09");
  });

  it("rolls over to H:MM:SS once elapsed reaches an hour", () => {
    expect(formatElapsedClock(60 * 60_000)).toBe("1:00:00");
    expect(formatElapsedClock(60 * 60_000 + 5 * 60_000 + 9_000)).toBe("1:05:09");
  });

  it("supports multi-hour meetings", () => {
    expect(formatElapsedClock(2 * 60 * 60_000 + 30_000)).toBe("2:00:30");
  });

  it("clamps negative input to 0:00 rather than throwing or showing a negative time", () => {
    expect(formatElapsedClock(-500)).toBe("0:00");
  });

  it("truncates (floors) partial seconds rather than rounding", () => {
    expect(formatElapsedClock(1999)).toBe("0:01");
  });
});
