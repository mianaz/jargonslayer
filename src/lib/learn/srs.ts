// SM-2-lite scheduler for the learn-set (#48 step 2 — real SRS
// review). FSRS was rejected by the design pass (its calibration
// advantage needs data volumes a single user never produces — see
// docs/design-explorations/48-learning-loop.md Q3); this is ~15 lines,
// deterministic, unit-testable. All thresholds are named constants —
// Miana dogfoods and tunes them directly, no adaptive machinery.

import type { LearnRecord } from "./types";

/** 0 不认识 / 1 模糊 / 2 认识 — three-button grading. Binary loses the
 *  "almost" signal; six (Anki-style) is overkill for a single-user
 *  in-meeting tool. */
export type SrsGrade = 0 | 1 | 2;

const DAY_MS = 24 * 60 * 60 * 1000;

export const SRS_FIRST_INTERVAL_DAYS = 1;
export const SRS_SECOND_INTERVAL_DAYS = 4;
export const SRS_EASE_FLOOR = 1.3;
export const SRS_LAPSE_EASE_PENALTY = 0.2;
// grade 2 (认识) nudges ease up; grade 1 (模糊) nudges it down — the
// classic SM-2 quality-dependent EF update, collapsed onto 3 grades.
export const SRS_EASE_DELTA_GOOD = 0.1;
export const SRS_EASE_DELTA_FUZZY = -0.15;
export const SRS_FAMILIARITY_EMA_OLD_WEIGHT = 0.6;
export const SRS_FAMILIARITY_EMA_NEW_WEIGHT = 0.4;
// "Repeated known → stops surfacing" is earned through spacing, not a
// single tap (that's the vote-based suppression in learn/store.ts).
export const SRS_AUTO_SUPPRESS_INTERVAL_DAYS = 30;
export const SRS_AUTO_SUPPRESS_FAMILIARITY = 0.85;

const GRADE_FAMILIARITY_VALUE: Record<SrsGrade, number> = { 0: 0, 1: 0.5, 2: 1 };

function nextFamiliarity(rec: LearnRecord, grade: SrsGrade): number {
  return (
    rec.familiarity * SRS_FAMILIARITY_EMA_OLD_WEIGHT +
    GRADE_FAMILIARITY_VALUE[grade] * SRS_FAMILIARITY_EMA_NEW_WEIGHT
  );
}

/** Pure SM-2-lite step: `rec` is the record BEFORE this review, `now`
 *  is the review timestamp. Returns the full next record (spread over
 *  `rec` so identity/surface/kind/createdAt/etc. carry through
 *  untouched). Never reads or writes storage — callers persist the
 *  result (see store.ts's gradeReview action). */
export function schedule(rec: LearnRecord, grade: SrsGrade, now: number): LearnRecord {
  const familiarity = nextFamiliarity(rec, grade);

  if (grade === 0) {
    // Lapse: relearn today, reps reset, ease penalized (floored).
    return {
      ...rec,
      reps: 0,
      lapses: rec.lapses + 1,
      intervalDays: 0,
      ease: Math.max(SRS_EASE_FLOOR, rec.ease - SRS_LAPSE_EASE_PENALTY),
      familiarity,
      dueAt: now,
      lastReviewedAt: now,
      updatedAt: now,
    };
  }

  const easeDelta = grade === 2 ? SRS_EASE_DELTA_GOOD : SRS_EASE_DELTA_FUZZY;
  const ease = Math.max(SRS_EASE_FLOOR, rec.ease + easeDelta);
  const reps = rec.reps + 1;
  const intervalDays =
    reps === 1
      ? SRS_FIRST_INTERVAL_DAYS
      : reps === 2
        ? SRS_SECOND_INTERVAL_DAYS
        : Math.round(rec.intervalDays * ease);

  const autoSuppress =
    grade === 2 &&
    intervalDays >= SRS_AUTO_SUPPRESS_INTERVAL_DAYS &&
    familiarity >= SRS_AUTO_SUPPRESS_FAMILIARITY;

  return {
    ...rec,
    reps,
    intervalDays,
    ease,
    familiarity,
    dueAt: now + intervalDays * DAY_MS,
    lastReviewedAt: now,
    updatedAt: now,
    suppressed: autoSuppress ? true : rec.suppressed,
    suppressedAt: autoSuppress ? now : rec.suppressedAt,
  };
}
