import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RECENT_MEETING_WINDOW_MS,
  REVIEW_QUEUE_CAP,
  composeReviewQueue,
  computeReviewStreak,
  dueLearnRecords,
  expressionCardToCandidate,
  termCardToCandidate,
  type ReviewCandidate,
} from "../queue";
import type { LearnRecord } from "../types";
import type { ExpressionCard, TermCard } from "../../types";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000;

function makeRecord(overrides: Partial<LearnRecord> = {}): LearnRecord {
  return {
    learnKey: "expression:circle back",
    kind: "expression",
    surface: "circle back",
    familiarity: 0,
    suppressed: false,
    reps: 0,
    intervalDays: 0,
    ease: 2.5,
    dueAt: NOW,
    lapses: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    learnKey: "expression:touch base",
    kind: "expression",
    surface: "touch base",
    lastSeenAt: NOW,
    ...overrides,
  };
}

describe("dueLearnRecords", () => {
  it("includes only unsuppressed records whose dueAt has arrived, ascending", () => {
    const learnset: Record<string, LearnRecord> = {
      a: makeRecord({ learnKey: "a", dueAt: NOW - 1000 }),
      b: makeRecord({ learnKey: "b", dueAt: NOW - 5000 }),
      c: makeRecord({ learnKey: "c", dueAt: NOW + 1000 }), // not yet due
      d: makeRecord({ learnKey: "d", dueAt: NOW - 1, suppressed: true }), // suppressed
    };
    const due = dueLearnRecords(learnset, NOW);
    expect(due.map((r) => r.learnKey)).toEqual(["b", "a"]);
  });

  it("returns an empty array for an empty learnset", () => {
    expect(dueLearnRecords({}, NOW)).toEqual([]);
  });
});

describe("composeReviewQueue — due + recent, capped, ordered", () => {
  it("orders due records first (ascending dueAt), then recent not-yet-enrolled (most recent first)", () => {
    const learnset: Record<string, LearnRecord> = {
      "expression:a": makeRecord({ learnKey: "expression:a", surface: "a", dueAt: NOW - 2000 }),
      "expression:b": makeRecord({ learnKey: "expression:b", surface: "b", dueAt: NOW - 1000 }),
    };
    const candidates = [
      makeCandidate({ learnKey: "expression:c", surface: "c", lastSeenAt: NOW - DAY_MS }),
      makeCandidate({ learnKey: "expression:d", surface: "d", lastSeenAt: NOW - 2 * DAY_MS }),
    ];
    const queue = composeReviewQueue(learnset, candidates, NOW);
    expect(queue.map((q) => q.learnKey)).toEqual([
      "expression:a",
      "expression:b",
      "expression:c",
      "expression:d",
    ]);
    expect(queue.slice(0, 2).every((q) => q.enrolled)).toBe(true);
    expect(queue.slice(2).every((q) => !q.enrolled)).toBe(true);
  });

  it("excludes recent candidates already enrolled (regardless of due state)", () => {
    const learnset: Record<string, LearnRecord> = {
      "expression:a": makeRecord({
        learnKey: "expression:a",
        surface: "a",
        dueAt: NOW + 10 * DAY_MS, // not due yet
      }),
    };
    const candidates = [makeCandidate({ learnKey: "expression:a", surface: "a" })];
    const queue = composeReviewQueue(learnset, candidates, NOW);
    expect(queue).toEqual([]); // not due, and not eligible as "recent" since it's enrolled
  });

  it("excludes recent candidates older than the recent-meeting window", () => {
    const candidates = [
      makeCandidate({ lastSeenAt: NOW - RECENT_MEETING_WINDOW_MS - 1 }), // just outside
      makeCandidate({ learnKey: "expression:in-window", lastSeenAt: NOW - RECENT_MEETING_WINDOW_MS }), // at the edge, inside
    ];
    const queue = composeReviewQueue({}, candidates, NOW);
    expect(queue.map((q) => q.learnKey)).toEqual(["expression:in-window"]);
  });

  it("de-duplicates recent candidates by learnKey, keeping the most-recently-seen occurrence", () => {
    const candidates = [
      makeCandidate({ lastSeenAt: NOW - 5 * DAY_MS }),
      makeCandidate({ lastSeenAt: NOW - 1 * DAY_MS }), // same learnKey, seen more recently
    ];
    const queue = composeReviewQueue({}, candidates, NOW);
    expect(queue).toHaveLength(1);
  });

  it("caps the total queue at the given cap, due records taking priority", () => {
    const learnset: Record<string, LearnRecord> = {};
    for (let i = 0; i < 5; i++) {
      learnset[`expression:due-${i}`] = makeRecord({
        learnKey: `expression:due-${i}`,
        surface: `due-${i}`,
        dueAt: NOW - i,
      });
    }
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ learnKey: `expression:recent-${i}`, surface: `recent-${i}`, lastSeenAt: NOW - i }),
    );
    const queue = composeReviewQueue(learnset, candidates, NOW, 7);
    expect(queue).toHaveLength(7);
    expect(queue.filter((q) => q.enrolled)).toHaveLength(5); // all 5 due records kept
    expect(queue.filter((q) => !q.enrolled)).toHaveLength(2); // only 2 of 10 recent slots left
  });

  it("defaults the cap to REVIEW_QUEUE_CAP when not given", () => {
    const candidates = Array.from({ length: REVIEW_QUEUE_CAP + 5 }, (_, i) =>
      makeCandidate({ learnKey: `expression:recent-${i}`, surface: `recent-${i}` }),
    );
    const queue = composeReviewQueue({}, candidates, NOW);
    expect(queue).toHaveLength(REVIEW_QUEUE_CAP);
  });

  it("never pre-populates from all history — an empty learnset and no recent candidates yields an empty queue", () => {
    expect(composeReviewQueue({}, [], NOW)).toEqual([]);
  });
});

describe("expressionCardToCandidate / termCardToCandidate — learnKey matches learn/store.ts's derivation", () => {
  it("derives the same learnKey an expression card would get suppressed/enrolled under", () => {
    const card: ExpressionCard = {
      id: "c1",
      normKey: "circle back",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      count: 1,
      source: "dictionary",
      expression: "Circling Back!",
      category: "phrase",
      meaning: "m",
      chinese_explanation: "z",
      plain_english: "p",
      tone: "t",
      confidence: 0.9,
      source_sentence: "s",
    };
    const candidate = expressionCardToCandidate(card);
    expect(candidate.learnKey).toBe("expression:circling back");
    expect(candidate.kind).toBe("expression");
    expect(candidate.lastSeenAt).toBe(NOW);
  });

  it("derives the same learnKey a term card would get suppressed/enrolled under", () => {
    const term: TermCard = {
      id: "t1",
      normKey: "ARR",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      count: 1,
      source: "dictionary",
      term: "arr",
      type: "metric",
      gloss_en: "Annual Recurring Revenue",
      gloss_zh: "年度经常性收入",
    };
    const candidate = termCardToCandidate(term);
    expect(candidate.learnKey).toBe("term:ARR");
    expect(candidate.kind).toBe("term");
  });
});

describe("computeReviewStreak", () => {
  function dayStart(ts: number): number {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  it("is 0 when nothing has ever been reviewed", () => {
    expect(computeReviewStreak({}, NOW)).toBe(0);
  });

  it("is 0 when today has no review yet, even if yesterday did", () => {
    const yesterday = dayStart(NOW) - DAY_MS + 1000;
    const learnset: Record<string, LearnRecord> = {
      a: makeRecord({ lastReviewedAt: yesterday }),
    };
    expect(computeReviewStreak(learnset, NOW)).toBe(0);
  });

  it("counts 1 when today has a review and yesterday does not", () => {
    const learnset: Record<string, LearnRecord> = {
      a: makeRecord({ lastReviewedAt: NOW }),
    };
    expect(computeReviewStreak(learnset, NOW)).toBe(1);
  });

  it("counts consecutive days ending today across multiple records", () => {
    const today = dayStart(NOW) + 1000;
    const yesterday = today - DAY_MS;
    const twoDaysAgo = today - 2 * DAY_MS;
    const fourDaysAgo = today - 4 * DAY_MS; // gap on day 3 — breaks the streak
    const learnset: Record<string, LearnRecord> = {
      a: makeRecord({ learnKey: "a", lastReviewedAt: today }),
      b: makeRecord({ learnKey: "b", lastReviewedAt: yesterday }),
      c: makeRecord({ learnKey: "c", lastReviewedAt: twoDaysAgo }),
      d: makeRecord({ learnKey: "d", lastReviewedAt: fourDaysAgo }),
    };
    expect(computeReviewStreak(learnset, NOW)).toBe(3);
  });

  it("records with no lastReviewedAt are ignored", () => {
    const learnset: Record<string, LearnRecord> = {
      a: makeRecord({ lastReviewedAt: undefined }),
    };
    expect(computeReviewStreak(learnset, NOW)).toBe(0);
  });

  describe("DST boundary (#48 s1 review item 6)", () => {
    // The consecutive-day walk must compare local CALENDAR dates, not
    // subtract a fixed 24h in ms — a US "spring forward" transition
    // day is only 23 hours long, so a fixed-24h step from local
    // midnight lands an hour short of the true previous midnight (and
    // on the wrong side of the day boundary) the moment the walk
    // crosses one. 2026-03-08 is the US spring-forward date (America/
    // New_York: 02:00 -> 03:00). Force that specific timezone for
    // these two tests only — DST doesn't exist in every TZ, so this
    // must not depend on whatever TZ the test runner happens to use.
    const ORIGINAL_TZ = process.env.TZ;

    beforeEach(() => {
      process.env.TZ = "America/New_York";
    });

    afterEach(() => {
      process.env.TZ = ORIGINAL_TZ;
    });

    function localNoon(year: number, monthIndex: number, day: number): number {
      return new Date(year, monthIndex, day, 12, 0, 0).getTime();
    }

    it("a 4-day streak spanning the spring-forward transition (Mar 6-9, 2026) still counts all 4 days", () => {
      const mar6 = localNoon(2026, 2, 6);
      const mar7 = localNoon(2026, 2, 7); // day BEFORE the transition
      const mar8 = localNoon(2026, 2, 8); // transition day — only 23h long
      const mar9 = localNoon(2026, 2, 9); // day AFTER the transition
      const learnset: Record<string, LearnRecord> = {
        a: makeRecord({ learnKey: "a", lastReviewedAt: mar6 }),
        b: makeRecord({ learnKey: "b", lastReviewedAt: mar7 }),
        c: makeRecord({ learnKey: "c", lastReviewedAt: mar8 }),
        d: makeRecord({ learnKey: "d", lastReviewedAt: mar9 }),
      };

      expect(computeReviewStreak(learnset, mar9)).toBe(4);
    });

    it("a gap on the transition day itself still correctly breaks the streak at exactly 1 (the DST math doesn't paper over a real gap)", () => {
      const mar7 = localNoon(2026, 2, 7);
      const mar9 = localNoon(2026, 2, 9); // no review on mar8 (transition day) or mar7-adjacent chain
      const learnset: Record<string, LearnRecord> = {
        a: makeRecord({ learnKey: "a", lastReviewedAt: mar7 }), // isolated, 2 days back
        d: makeRecord({ learnKey: "d", lastReviewedAt: mar9 }),
      };

      expect(computeReviewStreak(learnset, mar9)).toBe(1);
    });
  });
});
