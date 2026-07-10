import { describe, expect, it } from "vitest";
import { REFRESH_MS, sweepStaleSuppressedLearnset } from "../store";
import type { LearnRecord } from "../types";

function makeRecord(suppressedAt: number): LearnRecord {
  return {
    learnKey: "expression:circle back",
    kind: "expression",
    surface: "circle back",
    familiarity: 1,
    suppressed: true,
    suppressedAt,
    reps: 0,
    intervalDays: 0,
    ease: 2.5,
    dueAt: suppressedAt,
    lapses: 0,
    createdAt: suppressedAt,
    updatedAt: suppressedAt,
  };
}

describe("sweepStaleSuppressedLearnset", () => {
  it("keeps 89-day-old suppressed records suppressed", () => {
    const now = 1_000_000_000;
    const record = makeRecord(now - REFRESH_MS + 24 * 60 * 60 * 1000);
    const next = sweepStaleSuppressedLearnset({ [record.learnKey]: record }, now);

    expect(next[record.learnKey]).toEqual(record);
  });

  it("un-suppresses records at the 90-day boundary and makes them due now", () => {
    const now = 1_000_000_000;
    const record = makeRecord(now - REFRESH_MS);
    const next = sweepStaleSuppressedLearnset({ [record.learnKey]: record }, now);

    expect(next[record.learnKey]).toMatchObject({
      suppressed: false,
      dueAt: now,
      updatedAt: now,
    });
  });

  it("un-suppresses 91-day-old suppressed records", () => {
    const now = 1_000_000_000;
    const record = makeRecord(now - REFRESH_MS - 24 * 60 * 60 * 1000);
    const next = sweepStaleSuppressedLearnset({ [record.learnKey]: record }, now);

    expect(next[record.learnKey].suppressed).toBe(false);
    expect(next[record.learnKey].dueAt).toBe(now);
  });
});
