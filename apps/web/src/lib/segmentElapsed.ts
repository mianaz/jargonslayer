// Per-segment elapsed-time mapping (fix: transcript timestamps showed
// wall-clock time instead of time elapsed since the meeting started).
//
// Maps a transcript segment's own `startedAt` (epoch ms) onto "elapsed
// since meeting start, excluding paused time" — the same accounting
// store.ts's elapsedActiveMs uses for the LIVE ticking header readout,
// but for a segment's fixed PAST moment rather than the ever-advancing
// "now": only pause intervals that happened BEFORE the segment count
// against it (a LATER pause must never retroactively shrink an
// earlier segment's own reading).
//
// Deliberately standalone (imports only @jargonslayer/core/types, no
// store.ts import) so both store.ts (live meeting save/load) and
// history/export.ts (Markdown report) can depend on it without a
// cycle: store.ts already imports history/autoExport.ts, which
// imports history/export.ts — so store.ts must never import from
// export.ts or anything export.ts itself depends on. This module sits
// below both.

import type { MeetingSession, TranscriptSegment } from "@jargonslayer/core/types";

export interface PauseInterval {
  start: number;
  end: number;
}

/** Elapsed time at a past segment's own `segmentStartedAt`, excluding
 *  every pause interval that finished before it. `pauseIntervals` are
 *  the meeting's COMPLETED pauses only — a currently-OPEN pause never
 *  needs to be passed in here, because no new segment can arrive while
 *  the engine is torn down mid-pause (see MeetingStatus's "paused" doc
 *  in @jargonslayer/core/types), so no segment's own startedAt can
 *  ever fall inside an open pause window. The `else if` branch below
 *  is defensive only (an interval that started before the segment but
 *  didn't "end" before it — shouldn't happen in practice, but clamps
 *  rather than producing a nonsensical negative contribution). */
export function segmentElapsedMs(
  meetingStartedAt: number,
  segmentStartedAt: number,
  pauseIntervals: PauseInterval[],
): number {
  let paused = 0;
  for (const iv of pauseIntervals) {
    if (iv.end <= segmentStartedAt) {
      paused += Math.max(0, iv.end - iv.start);
    } else if (iv.start < segmentStartedAt) {
      paused += Math.max(0, segmentStartedAt - iv.start);
    }
  }
  return Math.max(0, segmentStartedAt - meetingStartedAt - paused);
}

/** Resolves the (startedAt, pauseIntervals) basis to feed segmentElapsedMs
 *  for a given session — unifies the live and history render paths,
 *  since store.ts's loadSession funnels a saved session into the SAME
 *  store fields a live meeting uses (see store.ts).
 *
 *  `session.pauseIntervals` absent (`undefined`, not merely `[]`)
 *  marks a session saved BEFORE this field existed: its pause history,
 *  if any, isn't recoverable, so pauseIntervals folds to empty (any
 *  real gap simply shows as a jump between segments, not excluded —
 *  acceptable, not fixable after the fact) and the zero point ALSO
 *  switches from session.startedAt to the first segment's own
 *  timestamp. Rationale for that second switch: session.startedAt on
 *  a live meeting is stamped at beginMeeting() — before the engine's
 *  connecting phase resolves into a first final segment — a few
 *  seconds ahead of segments[0].startedAt for a NORMAL session
 *  (immaterial there), but for a legacy session that may ALSO be
 *  carrying an un-excluded pause gap, anchoring to the actual first
 *  spoken line is the more conservative reading (never negative, never
 *  overstated). A session saved by this fix or later (pauseIntervals
 *  present, even [] when the meeting was never paused) always keeps
 *  the true meeting start. */
export function resolveSessionElapsedBasis(
  session: Pick<MeetingSession, "startedAt" | "segments" | "pauseIntervals">,
): { startedAt: number; pauseIntervals: PauseInterval[] } {
  if (session.pauseIntervals === undefined) {
    return {
      startedAt: session.segments[0]?.startedAt ?? session.startedAt,
      pauseIntervals: [],
    };
  }
  return { startedAt: session.startedAt, pauseIntervals: session.pauseIntervals };
}

/** M:SS, or H:MM:SS once the elapsed time reaches an hour — distinct
 *  from Header.tsx's own local `formatElapsed` (MM:SS only, no hour
 *  rollover; not reused here since it can't represent a >59-minute
 *  meeting the way a transcript timestamp needs to, and it isn't
 *  exported from that file anyway). */
export function formatElapsedClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Re-exported so a consumer that only needs the segment type for a
// helper signature doesn't have to reach into @jargonslayer/core
// separately (mirrors history/export.ts's own re-export pattern at
// the bottom of that file).
export type { TranscriptSegment };
