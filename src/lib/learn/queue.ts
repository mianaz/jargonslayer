// Review-queue composition (#48 step 2). Pure functions — the /review
// UI supplies the recent-meeting candidates (it already lazily caches
// full sessions for the word-cloud/stats aggregation, see
// components/review/ReviewDashboard.tsx's useSessionCache) so this
// module never touches storage itself.

import type { ExpressionCard, TermCard } from "../types";
import { learnKey } from "./store";
import type { LearnKind, LearnRecord } from "./types";

// Never pre-populate the queue from all history — only records due
// today plus meetings from the last ~week get a look-in.
export const RECENT_MEETING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const REVIEW_QUEUE_CAP = 20;

export interface ReviewCandidate {
  learnKey: string;
  kind: LearnKind;
  surface: string;
  lastSeenAt: number;
}

export interface ReviewQueueItem {
  learnKey: string;
  kind: LearnKind;
  surface: string;
  // false = a recent-meeting card not yet in the learn-set — grading
  // it (or voting/glossary-saving it) is what lazily enrolls it.
  enrolled: boolean;
  record?: LearnRecord;
}

export function expressionCardToCandidate(card: ExpressionCard): ReviewCandidate {
  return {
    learnKey: learnKey("expression", card.expression),
    kind: "expression",
    surface: card.expression,
    lastSeenAt: card.lastSeenAt,
  };
}

export function termCardToCandidate(card: TermCard): ReviewCandidate {
  return {
    learnKey: learnKey("term", card.term),
    kind: "term",
    surface: card.term,
    lastSeenAt: card.lastSeenAt,
  };
}

/** Due records: enrolled, not suppressed, dueAt has arrived — ascending
 *  by dueAt (most overdue first). */
export function dueLearnRecords(
  learnset: Record<string, LearnRecord>,
  now: number,
): LearnRecord[] {
  return Object.values(learnset)
    .filter((r) => !r.suppressed && r.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt);
}

/** Review session = due records (asc) + recent-meeting cards not yet
 *  enrolled (most recent first), capped. Enrollment itself never
 *  happens here — this is a read-only view; the store lazily enrolls
 *  on the first vote/grade/glossary-save (see store.ts). */
export function composeReviewQueue(
  learnset: Record<string, LearnRecord>,
  recentCandidates: ReviewCandidate[],
  now: number,
  cap: number = REVIEW_QUEUE_CAP,
): ReviewQueueItem[] {
  const due: ReviewQueueItem[] = dueLearnRecords(learnset, now).map((record) => ({
    learnKey: record.learnKey,
    kind: record.kind,
    surface: record.surface,
    enrolled: true,
    record,
  }));

  const recent: ReviewQueueItem[] = [];
  const seenRecent = new Set<string>();
  const sortedCandidates = recentCandidates
    .filter((c) => now - c.lastSeenAt <= RECENT_MEETING_WINDOW_MS)
    .filter((c) => !learnset[c.learnKey]) // not yet enrolled at all
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  for (const c of sortedCandidates) {
    if (seenRecent.has(c.learnKey)) continue;
    seenRecent.add(c.learnKey);
    recent.push({ learnKey: c.learnKey, kind: c.kind, surface: c.surface, enrolled: false });
  }

  return [...due, ...recent].slice(0, cap);
}

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The local calendar day immediately before `ts`'s local calendar day,
 *  at ITS OWN local midnight (Codex/#48 s1 review item 6). Deliberately
 *  steps by calendar date (`setDate`) and re-normalizes via
 *  `setHours(0,0,0,0)` rather than subtracting a fixed 24h in
 *  milliseconds — a DST transition day is 23 or 25 hours long, so a
 *  fixed-24h subtraction from local midnight lands an hour off true
 *  midnight (and on the wrong side of the calendar-day boundary) the
 *  moment a streak walk crosses one. `setDate` + JS's own calendar
 *  rollover handles month/year boundaries the same way. */
function previousLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Consecutive-day streak ending today: counts back from today while
 *  every day has at least one graded review (lastReviewedAt). Zero if
 *  today itself has no review yet (a streak "at risk" still reads as
 *  0 until today's review lands). */
export function computeReviewStreak(
  learnset: Record<string, LearnRecord>,
  now: number = Date.now(),
): number {
  const reviewedDays = new Set(
    Object.values(learnset)
      .filter((r): r is LearnRecord & { lastReviewedAt: number } => r.lastReviewedAt !== undefined)
      .map((r) => dayStart(r.lastReviewedAt)),
  );
  let streak = 0;
  let cursor = dayStart(now);
  while (reviewedDays.has(cursor)) {
    streak += 1;
    cursor = previousLocalDay(cursor);
  }
  return streak;
}
