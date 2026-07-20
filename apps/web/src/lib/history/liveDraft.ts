// Live meeting draft persistence — crash/refresh recovery (v0.5 closeout,
// owner field report: a random iOS-Safari refresh mid-meeting lost the
// whole transcript). Persists a throttled snapshot of the CURRENT live
// meeting under one fixed IndexedDB key, via the SAME idb-keyval
// mechanism/DB lib/history/storage.ts's session store uses (see that
// file's own header comment for the key-naming convention this mirrors).
// Wired from useMeeting.ts (the hook that already owns the STT/detection
// lifecycle per meeting) and cleared by store.ts's saveCurrentSession —
// see each call site's own doc comment.
//
// Multi-tab caveat (deliberate v1): one fixed key means two simultaneous
// live meetings in two browser tabs clobber each other's draft — whichever
// tab writes last wins, and the other tab's in-progress meeting has no
// recoverable draft if IT crashes. Accepted: the owner runs one meeting
// at a time, and keying by startedAt would trade this for a worse
// problem — an orphaned draft with no GC story (nothing ever revisits an
// old per-meeting key once its tab closes normally, since a normal close
// never runs this module's own clearDraft).

import { del, get, set } from "idb-keyval";
import type { MeetingSession, MeetingStatus, STTEngineKind } from "@jargonslayer/core/types";

const DRAFT_KEY = "jargonslayer:liveDraft";
const WRITE_THROTTLE_MS = 10_000;

export interface DraftCounts {
  segments: number;
  cards: number;
}

export interface LiveDraft {
  snapshot: MeetingSession;
  savedAt: number;
  startedAt: number;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

/** Write policy, part 1 — status/engine gate: a draft is only ever worth
 *  writing while a meeting is actually live (incl. paused — a soft pause
 *  doesn't make the in-memory transcript any less at risk of a refresh),
 *  and never for "demo" — a scripted preview with nothing real to lose. */
export function isDraftableMeeting(status: MeetingStatus, engine: STTEngineKind): boolean {
  return (
    (status === "connecting" || status === "listening" || status === "paused") &&
    engine !== "demo"
  );
}

/** Write policy, part 2 — throttle + changed-guard: write at most once
 *  per WRITE_THROTTLE_MS, AND only when the segment/card counts actually
 *  moved since the last write (a quiet stretch — paused, or no one
 *  talking — has nothing new worth re-persisting). Pure and timer-free
 *  so the policy itself is unit-testable without vi.useFakeTimers.
 *  `lastWriteAt`/`lastCounts` are both null before this meeting's first
 *  write (see useMeeting.ts's per-meeting reset). */
export function shouldWriteDraft(
  now: number,
  lastWriteAt: number | null,
  lastCounts: DraftCounts | null,
  counts: DraftCounts,
): boolean {
  if (lastWriteAt !== null && now - lastWriteAt < WRITE_THROTTLE_MS) return false;
  if (
    lastCounts !== null &&
    lastCounts.segments === counts.segments &&
    lastCounts.cards === counts.cards
  ) {
    return false;
  }
  return true;
}

export async function writeDraft(snapshot: MeetingSession): Promise<void> {
  if (!hasIndexedDb()) return;
  const draft: LiveDraft = { snapshot, savedAt: Date.now(), startedAt: snapshot.startedAt };
  try {
    await set(DRAFT_KEY, draft);
  } catch (err) {
    console.warn("[liveDraft] write failed", err);
  }
}

export async function loadDraft(): Promise<LiveDraft | null> {
  if (!hasIndexedDb()) return null;
  try {
    const d = await get<LiveDraft>(DRAFT_KEY);
    return d ?? null;
  } catch (err) {
    console.warn("[liveDraft] load failed", err);
    return null;
  }
}

export async function clearDraft(): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await del(DRAFT_KEY);
  } catch (err) {
    console.warn("[liveDraft] clear failed", err);
  }
}
