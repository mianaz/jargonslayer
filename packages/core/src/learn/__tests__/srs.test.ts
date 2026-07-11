import { describe, expect, it } from "vitest";
import {
  RELEARN_STEP_MS,
  SRS_AUTO_SUPPRESS_FAMILIARITY,
  SRS_AUTO_SUPPRESS_INTERVAL_DAYS,
  SRS_EASE_FLOOR,
  SRS_FIRST_INTERVAL_DAYS,
  SRS_SECOND_INTERVAL_DAYS,
  schedule,
} from "../srs";
import type { LearnRecord } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRecord(overrides: Partial<LearnRecord> = {}): LearnRecord {
  const now = 1_000_000;
  return {
    learnKey: "expression:circle back",
    kind: "expression",
    surface: "circle back",
    familiarity: 0,
    suppressed: false,
    reps: 0,
    intervalDays: 0,
    ease: 2.5,
    dueAt: now,
    lapses: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("schedule — SM-2-lite grade path table", () => {
  it("grade 2 (认识) from a fresh record: reps=1, interval=1d, ease +0.1", () => {
    const now = 10_000;
    const next = schedule(makeRecord(), 2, now);
    expect(next.reps).toBe(1);
    expect(next.intervalDays).toBe(SRS_FIRST_INTERVAL_DAYS);
    expect(next.ease).toBe(2.5 + 0.1);
    expect(next.dueAt).toBe(now + SRS_FIRST_INTERVAL_DAYS * DAY_MS);
    expect(next.lastReviewedAt).toBe(now);
    expect(next.updatedAt).toBe(now);
    expect(next.suppressed).toBe(false);
  });

  it("grade 2 second review: reps=2, interval=4d, ease +0.1 again", () => {
    const rec = makeRecord({ reps: 1, intervalDays: 1, ease: 2.6, familiarity: 0.4 });
    const now = 20_000;
    const next = schedule(rec, 2, now);
    expect(next.reps).toBe(2);
    expect(next.intervalDays).toBe(SRS_SECOND_INTERVAL_DAYS);
    expect(next.ease).toBe(2.6 + 0.1);
    expect(next.dueAt).toBe(now + SRS_SECOND_INTERVAL_DAYS * DAY_MS);
  });

  it("grade 2 third+ review: interval = round(prevInterval * newEase)", () => {
    const rec = makeRecord({ reps: 2, intervalDays: 4, ease: 2.7, familiarity: 0.64 });
    const now = 30_000;
    const next = schedule(rec, 2, now);
    expect(next.reps).toBe(3);
    expect(next.ease).toBe(2.7 + 0.1);
    expect(next.intervalDays).toBe(Math.round(4 * (2.7 + 0.1)));
    expect(next.dueAt).toBe(now + next.intervalDays * DAY_MS);
  });

  it("grade 1 (模糊) from a fresh record: still reps=1/interval=1d, but ease moves down", () => {
    const now = 10_000;
    const next = schedule(makeRecord(), 1, now);
    expect(next.reps).toBe(1);
    expect(next.intervalDays).toBe(SRS_FIRST_INTERVAL_DAYS);
    expect(next.ease).toBe(2.5 - 0.15);
    expect(next.suppressed).toBe(false);
  });

  it("grade 1 second review: interval=4d, same fixed-step schedule as grade 2", () => {
    const rec = makeRecord({ reps: 1, intervalDays: 1, ease: 2.35, familiarity: 0.2 });
    const next = schedule(rec, 1, 20_000);
    expect(next.reps).toBe(2);
    expect(next.intervalDays).toBe(SRS_SECOND_INTERVAL_DAYS);
  });
});

describe("schedule — lapse path (grade 0 不认识)", () => {
  it("resets reps, bumps lapses, interval 0 (relearn today), penalizes ease", () => {
    const rec = makeRecord({
      reps: 3,
      intervalDays: 11,
      ease: 2.8,
      familiarity: 0.784,
      lapses: 1,
    });
    const now = 40_000;
    const next = schedule(rec, 0, now);
    expect(next.reps).toBe(0);
    expect(next.lapses).toBe(2);
    expect(next.intervalDays).toBe(0);
    expect(next.ease).toBe(2.8 - 0.2);
    expect(next.dueAt).toBe(now + RELEARN_STEP_MS); // relearn step, not "now"
    expect(next.lastReviewedAt).toBe(now);
    expect(next.familiarity).toBeCloseTo(0.784 * 0.6 + 0 * 0.4, 10);
  });

  it("a lapse never un-suppresses (queue never grades a suppressed record anyway)", () => {
    const rec = makeRecord({ suppressed: false });
    const next = schedule(rec, 0, 1000);
    expect(next.suppressed).toBe(false);
  });

  // Regression (E2E 2026-07-11): a card graded 不认识 must actually
  // LEAVE the front of the due queue — dueAt === now (the pre-fix
  // behavior) meant DueReview.tsx's queue recomputed with the same
  // card back at queue[0], so grading looked like a dead button.
  it("regression: a just-lapsed record is NOT due at `now`, only after RELEARN_STEP_MS", () => {
    const now = 100_000;
    const next = schedule(makeRecord(), 0, now);
    expect(next.dueAt).not.toBe(now);
    expect(next.dueAt).toBe(now + RELEARN_STEP_MS);
  });
});

describe("schedule — ease floor (SRS_EASE_FLOOR = 1.3)", () => {
  it("grade 0 floors ease at 1.3 rather than going lower", () => {
    const rec = makeRecord({ ease: 1.35 });
    const next = schedule(rec, 0, 1000);
    expect(next.ease).toBe(SRS_EASE_FLOOR);
  });

  it("grade 1 (fuzzy) floors ease at 1.3 rather than going lower", () => {
    const rec = makeRecord({ ease: 1.4 });
    const next = schedule(rec, 1, 1000);
    expect(next.ease).toBe(SRS_EASE_FLOOR);
  });

  it("grade 2 never needs the floor (ease only goes up)", () => {
    const rec = makeRecord({ ease: SRS_EASE_FLOOR });
    const next = schedule(rec, 2, 1000);
    expect(next.ease).toBe(SRS_EASE_FLOOR + 0.1);
  });
});

describe("schedule — familiarity EMA (0.6 old / 0.4 new; grade -> 0/0.5/1)", () => {
  it.each([
    [0, 0.5, 0.3],
    [1, 0.5, 0.5],
    [2, 0.5, 0.7],
  ] as const)("grade %i from familiarity 0.5 -> %s", (grade, _old, expected) => {
    const rec = makeRecord({ familiarity: 0.5 });
    const next = schedule(rec, grade, 1000);
    expect(next.familiarity).toBeCloseTo(expected, 10);
  });

  it("chains correctly across repeated grade-2 reviews", () => {
    let rec = makeRecord({ familiarity: 0 });
    rec = schedule(rec, 2, 1000);
    expect(rec.familiarity).toBeCloseTo(0.4, 10);
    rec = schedule(rec, 2, 2000);
    expect(rec.familiarity).toBeCloseTo(0.64, 10);
  });
});

describe("schedule — auto-suppression boundary (interval axis, 29d vs 30d)", () => {
  it("interval 29d (just under the 30d threshold) does NOT auto-suppress even with familiarity=1", () => {
    // reps 2 -> 3 takes the round(interval*ease) branch.
    const rec = makeRecord({ reps: 2, intervalDays: 20, ease: 1.35, familiarity: 1 });
    const next = schedule(rec, 2, 1000);
    expect(next.intervalDays).toBe(29);
    expect(next.intervalDays).toBeLessThan(SRS_AUTO_SUPPRESS_INTERVAL_DAYS);
    expect(next.suppressed).toBe(false);
  });

  it("interval 30d (at the threshold) DOES auto-suppress when familiarity=1", () => {
    const rec = makeRecord({ reps: 2, intervalDays: 20, ease: 1.4, familiarity: 1 });
    const next = schedule(rec, 2, 5000);
    expect(next.intervalDays).toBe(30);
    expect(next.suppressed).toBe(true);
    expect(next.suppressedAt).toBe(5000);
  });
});

describe("schedule — auto-suppression boundary (familiarity axis, ~0.84 vs 0.85)", () => {
  it("familiarity just under 0.85 does NOT auto-suppress even with interval well past 30d", () => {
    // old familiarity 11/15 -> new = 0.8400000000000001 (< 0.85)
    const rec = makeRecord({ reps: 5, intervalDays: 25, ease: 1.5, familiarity: 11 / 15 });
    const next = schedule(rec, 2, 1000);
    expect(next.intervalDays).toBeGreaterThanOrEqual(SRS_AUTO_SUPPRESS_INTERVAL_DAYS);
    expect(next.familiarity).toBeLessThan(SRS_AUTO_SUPPRESS_FAMILIARITY);
    expect(next.suppressed).toBe(false);
  });

  it("familiarity exactly 0.85 DOES auto-suppress when interval is also past 30d", () => {
    const rec = makeRecord({ reps: 5, intervalDays: 25, ease: 1.5, familiarity: 0.75 });
    const next = schedule(rec, 2, 1000);
    expect(next.intervalDays).toBeGreaterThanOrEqual(SRS_AUTO_SUPPRESS_INTERVAL_DAYS);
    expect(next.familiarity).toBe(SRS_AUTO_SUPPRESS_FAMILIARITY);
    expect(next.suppressed).toBe(true);
  });
});

describe("schedule — auto-suppression only fires on grade 2 (认识)", () => {
  it("grade 1 never auto-suppresses, even past both thresholds", () => {
    const rec = makeRecord({ reps: 5, intervalDays: 25, ease: 1.5, familiarity: 1 });
    const next = schedule(rec, 1, 1000);
    expect(next.suppressed).toBe(false);
  });

  it("grade 0 never auto-suppresses (interval is forced to 0 anyway)", () => {
    const rec = makeRecord({ reps: 5, intervalDays: 40, ease: 2, familiarity: 1 });
    const next = schedule(rec, 0, 1000);
    expect(next.suppressed).toBe(false);
  });
});

describe("schedule — identity fields carry through untouched", () => {
  it("preserves learnKey/kind/surface/createdAt across a grade", () => {
    const rec = makeRecord({ createdAt: 42 });
    const next = schedule(rec, 2, 1000);
    expect(next.learnKey).toBe(rec.learnKey);
    expect(next.kind).toBe(rec.kind);
    expect(next.surface).toBe(rec.surface);
    expect(next.createdAt).toBe(42);
  });
});
