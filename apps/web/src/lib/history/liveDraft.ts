// Live meeting draft persistence — crash/refresh recovery (v0.5 closeout,
// owner field report: a random iOS-Safari refresh mid-meeting lost the
// whole transcript). Persists a snapshot of the CURRENT live meeting
// under one fixed IndexedDB key, via the SAME idb-keyval mechanism/DB
// lib/history/storage.ts's session store uses (see that file's own
// header comment for the key-naming convention this mirrors). Wired
// from useMeeting.ts (the hook that already owns the STT/detection
// lifecycle per meeting) and cleared by store.ts's saveCurrentSession/
// restoreLiveDraft — see each call site's own doc comment.
//
// Identity (Sol adversarial-review fix, post-v1): every draft now
// carries a `draftId` (deriveDraftId — meetingGen + startedAt, stable
// for one meeting's whole life). writeDraft/clearDraft both
// compare-and-act against whatever is CURRENTLY on disk instead of
// blindly overwriting/deleting: a write for a DIFFERENT draftId than
// the one on disk buffer-skips (diag-logged, not thrown) rather than
// clobbering an unresolved older meeting's only recovery copy; a clear
// for a DIFFERENT draftId no-ops rather than deleting a newer meeting's
// own draft out from under it. The v1 fixed-key design below is
// unchanged — only what's allowed to happen TO that one slot changed.
//
// Multi-tab caveat (deliberate v1, now buffer-skip instead of clobber):
// one fixed key means two simultaneous live meetings in two browser
// tabs can't both hold the slot — whichever tab's meeting is currently
// on disk keeps it until resolved (restored/discarded) or that same
// meeting ends normally and clears its own record; the OTHER tab's
// meeting simply never gets a draft written in the meantime (see
// writeDraft's own doc below). Accepted, same as v1: the owner runs one
// meeting at a time, and keying by startedAt would trade this for a
// worse problem — an orphaned draft with no GC story (nothing ever
// revisits an old per-meeting key once its tab closes normally, since a
// normal close never runs this module's own clearDraft).

import { del, get, set } from "idb-keyval";
import type { MeetingSession, MeetingStatus, STTEngineKind } from "@jargonslayer/core/types";
import { diagLog } from "../diag/log";

const DRAFT_KEY = "jargonslayer:liveDraft";

// Interval period for the routine (non-pagehide) write path — see
// useMeeting.ts's own periodic effect. Exported (not a useMeeting.ts-
// local literal) so the two files can never drift apart on what "one
// tick" means.
export const DRAFT_WRITE_INTERVAL_MS = 10_000;

export interface LiveDraft {
  // Per-meeting identity (Sol adversarial-review fix) — see this
  // module's own header comment. Compared, never trusted blindly, by
  // both writeDraft and clearDraft below.
  draftId: string;
  snapshot: MeetingSession;
  savedAt: number;
  startedAt: number;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

/** One meeting's draft identity — stable for that meeting's whole life
 *  (meetingGen only bumps at the NEXT meeting's begin/load/new, and
 *  startedAt is stamped once in beginMeeting and never changes across a
 *  pause/resume), so every write a given meeting ever makes derives the
 *  identical id without needing a ref to remember it. `startedAt` is
 *  `null` before any meeting has started this page load (e.g.
 *  RecoveryBanner's own "what does THIS tab consider itself to be"
 *  comparison at boot) — deliberately formatted so that can never
 *  collide with a real meeting's own numeric startedAt. */
export function deriveDraftId(meetingGen: number, startedAt: number | null): string {
  return `${meetingGen}:${startedAt ?? "none"}`;
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

/** Write policy, part 2 — the cheap "did anything user-visible change"
 *  signature useMeeting.ts's periodic interval compares tick-to-tick
 *  (M1 field fix: the OLD segments/cards-count-reactive effect had no
 *  trailing edge, so a translation-only, speaker-only, or term-only
 *  change inside one interval was never persisted). A plain sum, not a
 *  structural diff — deliberately cheap, "good enough" rather than
 *  exact: every dimension here only ever grows across a live meeting
 *  except the last segment's own text length (a streaming partial can
 *  finalize shorter than its last interim) and the speaker-assignment
 *  count (unlockSegmentSpeaker can drop one) — a shrink in one exactly
 *  offsetting a growth in another within the SAME tick is the one case
 *  this can miss, accepted as vanishingly unlikely for a value nobody
 *  ever compares by eye. */
export function computeDraftSignature(snapshot: MeetingSession): number {
  const segs = snapshot.segments;
  const lastSegmentTextLength = segs.length > 0 ? segs[segs.length - 1].text.length : 0;
  const speakerAssigned = segs.reduce((n, seg) => n + (seg.speaker ? 1 : 0), 0);
  const translated = snapshot.translations ? Object.keys(snapshot.translations).length : 0;
  return (
    segs.length +
    lastSegmentTextLength +
    translated +
    snapshot.cards.length +
    snapshot.terms.length +
    speakerAssigned
  );
}

/** Refuses to overwrite a DIFFERENT, still-unresolved meeting's draft
 *  (Sol adversarial-review fix): reads whatever's CURRENTLY on disk and
 *  buffer-skips (diag-logged, not thrown — this is a routine, expected
 *  outcome, not an error) when its draftId doesn't match `draftId`.
 *  Proceeds when the disk is empty (nothing to conflict with — the
 *  prior draft was cleared, restored, or never existed) or already
 *  carries the SAME draftId (this meeting's own earlier write). */
export async function writeDraft(draftId: string, snapshot: MeetingSession): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    const existing = await get<LiveDraft>(DRAFT_KEY);
    if (existing && existing.draftId !== draftId) {
      diagLog("info", "live-draft", "跳过草稿写入：磁盘上仍有另一场会议的未处理草稿");
      return;
    }
    const draft: LiveDraft = { draftId, snapshot, savedAt: Date.now(), startedAt: snapshot.startedAt };
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

/** Compare-and-delete (Sol adversarial-review fix): a no-op when the
 *  disk's current draft carries a DIFFERENT id than `draftId` — guards
 *  against a slow post-stop saveCurrentSession clearing a NEWER
 *  meeting's draft out from under it once that new meeting has since
 *  started (this meeting's own id no longer matches what's on disk, so
 *  the stale clear harmlessly no-ops instead of deleting it). */
export async function clearDraft(draftId: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    const existing = await get<LiveDraft>(DRAFT_KEY);
    if (!existing || existing.draftId !== draftId) return;
    await del(DRAFT_KEY);
  } catch (err) {
    console.warn("[liveDraft] clear failed", err);
  }
}
