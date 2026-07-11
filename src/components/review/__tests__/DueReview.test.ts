// hasPendingRelearn — the "queue is empty but a just-lapsed card is
// mid relearn-step" hint used by DueReview.tsx's EmptyDueState (E2E
// 2026-07-11, srs.ts's RELEARN_STEP_MS). No DueReview component test
// file exists yet, so per the batch spec a pure-helper unit test is
// enough — mirrors srs.test.ts's plain-function style (no jsdom needed).

import { describe, expect, it } from "vitest";
import { hasPendingRelearn } from "../DueReview";
import { RELEARN_STEP_MS } from "@/lib/learn/srs";
import type { LearnRecord } from "@/lib/learn/types";

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

describe("hasPendingRelearn", () => {
  it("is false for an empty learnset", () => {
    expect(hasPendingRelearn({}, 100_000)).toBe(false);
  });

  it("is false when nothing is due within the relearn step window", () => {
    const now = 100_000;
    const learnset: Record<string, LearnRecord> = {
      // Already due (a normal due card, not a just-lapsed one) — the
      // queue wouldn't be empty in this case anyway, but the helper
      // itself must not flag it as "pending".
      a: makeRecord({ learnKey: "a", dueAt: now - 1000 }),
      // Due well past the relearn step window (a normal future review).
      b: makeRecord({ learnKey: "b", dueAt: now + RELEARN_STEP_MS + 1 }),
    };
    expect(hasPendingRelearn(learnset, now)).toBe(false);
  });

  it("is true when a record's dueAt falls inside (now, now + RELEARN_STEP_MS]", () => {
    const now = 100_000;
    const learnset: Record<string, LearnRecord> = {
      a: makeRecord({ learnKey: "a", dueAt: now + RELEARN_STEP_MS }),
    };
    expect(hasPendingRelearn(learnset, now)).toBe(true);
  });

  it("is false exactly at the boundary dueAt === now (that record is already due, not pending)", () => {
    const now = 100_000;
    const learnset: Record<string, LearnRecord> = {
      a: makeRecord({ learnKey: "a", dueAt: now }),
    };
    expect(hasPendingRelearn(learnset, now)).toBe(false);
  });
});
