"use client";

// SRS due-review deck (#48 step 2) — 到期复习 mode. Reuses PracticeDeck's
// flip-card visuals (FlashCard) but grades on the 3-button SM-2-lite
// scale (不认识/模糊/认识) instead of PracticeDeck's mastered/not toggle.
// Deliberately does NOT replace 翻卡浏览 — the two modes ship in
// parallel per the design (usage decides later, see PLAN-v0.3.0.md).

import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/lib/store";
import type { CustomEntry, ExpressionCard, MeetingSession, TermCard } from "@jargonslayer/core/types";
import { learnKey } from "@/lib/learn/store";
import { RELEARN_STEP_MS, type SrsGrade } from "@jargonslayer/core/learn/srs";
import type { LearnRecord } from "@jargonslayer/core/learn/types";
import {
  composeReviewQueue,
  expressionCardToCandidate,
  termCardToCandidate,
  type ReviewCandidate,
  type ReviewQueueItem,
} from "@jargonslayer/core/learn/queue";
import { FlashCard, KIND_LABELS, type FlashCardContent } from "./PracticeDeck";

const GRADE_OPTIONS: { grade: SrsGrade; label: string; cls: string }[] = [
  { grade: 0, label: "不认识", cls: "border-warn-soft/50 text-warn-soft" },
  { grade: 1, label: "模糊", cls: "border-lab-yellow/50 text-lab-yellow" },
  { grade: 2, label: "认识", cls: "border-lab-green/50 text-lab-green" },
];

function expressionCardContent(card: ExpressionCard): FlashCardContent {
  return {
    kindLabel: KIND_LABELS.expression,
    kindBorderCls: "border-l-lab-orange",
    headword: card.expression,
    chineseExplanation: card.chinese_explanation,
    meaning: card.meaning,
    example: card.source_sentence,
  };
}

function termCardContent(card: TermCard): FlashCardContent {
  return {
    kindLabel: KIND_LABELS.term,
    kindBorderCls: "border-l-lab-cyan",
    headword: card.term,
    chineseExplanation: card.gloss_zh,
    meaning: card.gloss_en,
  };
}

function customEntryContent(entry: CustomEntry): FlashCardContent {
  return {
    kindLabel: KIND_LABELS[entry.kind],
    kindBorderCls: entry.kind === "expression" ? "border-l-lab-orange" : "border-l-lab-cyan",
    headword: entry.headword,
    chineseExplanation: entry.chinese_explanation,
    meaning: entry.meaning ?? entry.gloss_en,
    example: entry.example,
    context: entry.context,
  };
}

function fallbackContent(item: ReviewQueueItem): FlashCardContent {
  return {
    kindLabel: item.kind === "term" ? KIND_LABELS.term : KIND_LABELS.expression,
    kindBorderCls: item.kind === "term" ? "border-l-lab-cyan" : "border-l-lab-orange",
    headword: item.surface,
    chineseExplanation: "（原始释义已归档，凭记忆自测一下）",
  };
}

/** learnKey -> display content, sourced from every cached session's
 *  cards/terms first, then the personal glossary (user-curated, so it
 *  wins on the same key — covers manually-added entries that never
 *  appeared as a live card). */
function buildContentIndex(
  sessions: Record<string, MeetingSession>,
  customEntries: CustomEntry[],
): Record<string, FlashCardContent> {
  const index: Record<string, FlashCardContent> = {};
  for (const session of Object.values(sessions)) {
    for (const card of session.cards) {
      index[expressionCardToCandidate(card).learnKey] = expressionCardContent(card);
    }
    for (const term of session.terms) {
      index[termCardToCandidate(term).learnKey] = termCardContent(term);
    }
  }
  for (const entry of customEntries) {
    index[learnKey(entry.kind, entry.headword)] = customEntryContent(entry);
  }
  return index;
}

function buildCandidates(sessions: Record<string, MeetingSession>): ReviewCandidate[] {
  const list: ReviewCandidate[] = [];
  for (const session of Object.values(sessions)) {
    for (const card of session.cards) list.push(expressionCardToCandidate(card));
    for (const term of session.terms) list.push(termCardToCandidate(term));
  }
  return list;
}

// Grade-0 relearn-step hint (E2E 2026-07-11, srs.ts's RELEARN_STEP_MS):
// a card graded 不认识 moments ago leaves the queue for the step window
// instead of pinning at queue[0] (see srs.ts), which is correct but
// means the queue can go briefly empty right after the only due card
// was just failed. Without this hint that reads as "nothing to review"
// when really it's "back in ~10 minutes" — exported for a pure-helper
// unit test since there's no existing DueReview component test file.
// F5 LOW (codex review round 1): used to flag ANY record with dueAt
// inside (now, now + RELEARN_STEP_MS] — but ease/interval math is
// continuous, so a perfectly ordinary, normally-scheduled record
// (intervalDays > 0) can also just happen to come due in the next 10
// minutes, which isn't "a card is mid relearn-step" at all. The signal
// srs.ts's schedule() actually produces on a grade-0 lapse is
// intervalDays reset to exactly 0 (see its lapse branch) with dueAt
// stepped forward by RELEARN_STEP_MS — that's the one case this hint is
// for. Suppressed records are excluded too: a suppressed card sitting
// in that window isn't coming back to the visible queue regardless of
// how soon its dueAt is.
export function hasPendingRelearn(
  learnset: Record<string, LearnRecord>,
  now: number,
): boolean {
  return Object.values(learnset).some(
    (r) =>
      r.intervalDays === 0 &&
      !r.suppressed &&
      r.dueAt > now &&
      r.dueAt <= now + RELEARN_STEP_MS,
  );
}

function EmptyDueState({ pendingRelearn }: { pendingRelearn: boolean }) {
  return (
    <div className="rounded-none border border-edge bg-panel p-6 text-center">
      <div className="text-sm font-medium text-fg">今天没有待复习的词条</div>
      <div className="mt-2 text-xs leading-[1.7] text-mut">
        继续开会积累新表达，或去词库收藏几个术语——到期后会自动出现在这里。
      </div>
      {pendingRelearn && (
        <div className="mt-2 text-xs leading-[1.7] text-warn-soft">
          刚标记「不认识」的词条会在约 10 分钟后重新出现
        </div>
      )}
    </div>
  );
}

export default function DueReview({
  cache,
  onQueueEmptied,
}: {
  cache: Record<string, MeetingSession>;
  /** Fires when the due queue transitions >0 → 0 AND a grade (handleGrade
   *  below) immediately preceded that transition — NOT on mounting with
   *  an already-empty queue, and NOT on a shrink-to-zero from any other
   *  source. F3 MEDIUM (v0.5.1 Bit sprint fix round): the queue is
   *  time-dependent in BOTH directions, not just growing — the 30s tick
   *  below re-evaluates `now`, and composeReviewQueue's own unenrolled-
   *  recent-candidate bucket expires after RECENT_MEETING_WINDOW_MS (7
   *  days, packages/core learn/queue.ts), so a tick (or any other
   *  learnset write — a suppression, a cache refresh) can shrink the
   *  queue to zero with no grade involved. (v0.5.1 Bit sprint:
   *  review/page.tsx wires this to the store's celebrateBit nonce.) */
  onQueueEmptied?: () => void;
}) {
  const learnset = useApp((s) => s.learnset);
  const customEntries = useApp((s) => s.customEntries);
  const gradeReview = useApp((s) => s.gradeReview);

  const candidates = useMemo(() => buildCandidates(cache), [cache]);
  const contentIndex = useMemo(
    () => buildContentIndex(cache, customEntries),
    [cache, customEntries],
  );

  // F2 MEDIUM (codex review round 1): the queue is time-dependent
  // (composeReviewQueue/dueLearnRecords filter on dueAt <= now) but this
  // memo used to read Date.now() ONCE per render with deps [learnset,
  // candidates] only — after the 10-minute relearn step elapses
  // (RELEARN_STEP_MS, srs.ts), a due-again card never resurfaces while
  // this screen just sits open, since nothing else forces a re-render to
  // take a fresh Date.now() reading. The empty-state's own "约 10 分钟
  // 后重新出现" promise (see EmptyDueState below) never came true on its
  // own either. 30s ticks are plenty of granularity for a 10-minute step
  // — no reason to re-render every second just to watch a countdown
  // nobody's staring at.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const queue = useMemo(
    () => composeReviewQueue(learnset, candidates, now),
    [learnset, candidates, now],
  );

  // >0 → 0 transition watcher for onQueueEmptied (see the prop doc).
  // The callback rides a per-render ref so a parent passing a fresh
  // arrow each render can't re-run the effect; the null-seeded prev ref
  // guarantees the first observation never fires, whatever it is.
  const onQueueEmptiedRef = useRef(onQueueEmptied);
  onQueueEmptiedRef.current = onQueueEmptied;
  const prevQueueLenRef = useRef<number | null>(null);
  // F3 MEDIUM: gates the transition above on "a grade is what caused
  // it" — handleGrade arms this immediately before it calls gradeReview
  // (see its own comment for why not after); this effect reads it once
  // per queue.length change and always resets it to false at the end of
  // its own run (consumed or not), so a grade must be the IMMEDIATE
  // cause of the emptying transition to count — any other queue-length
  // change (a tick, another learnset write) clears it first.
  const lastActionWasGradeRef = useRef(false);
  useEffect(() => {
    const prev = prevQueueLenRef.current;
    prevQueueLenRef.current = queue.length;
    if (prev !== null && prev > 0 && queue.length === 0 && lastActionWasGradeRef.current) {
      onQueueEmptiedRef.current?.();
    }
    lastActionWasGradeRef.current = false;
  }, [queue.length]);

  const current = queue[0] ?? null;
  const [flipped, setFlipped] = useState(false);
  // #48 s1 review item 5: a grade write is async (IndexedDB) — without
  // this, a fast double-tap on a grade button fires gradeReview twice
  // before the first write lands, racing itself. The store now
  // serializes same-key mutations, but the button must still be
  // disabled while a grade is in flight so the second tap can't queue
  // up a THIRD point of confusion (a re-grade of what LOOKS like a
  // fresh card once the queue has already advanced).
  const [grading, setGrading] = useState(false);

  // Reset the flip state whenever the front-of-queue card changes
  // (grading advances the queue naturally — see handleGrade below).
  useEffect(() => {
    setFlipped(false);
  }, [current?.learnKey]);

  if (current === null) {
    // Same tick as the queue memo above (F2 MEDIUM) — not a fresh
    // Date.now() read — so this hint and the queue's own due-check never
    // disagree about "now" between two reads a render apart.
    return <EmptyDueState pendingRelearn={hasPendingRelearn(learnset, now)} />;
  }

  const content = contentIndex[current.learnKey] ?? fallbackContent(current);

  const handleGrade = async (grade: SrsGrade) => {
    if (grading) return;
    setGrading(true);
    // F3 MEDIUM: armed BEFORE the write starts, not after it resolves —
    // gradeReview's own persistence write lands via a per-learnKey
    // promise queue (store.ts's withLearnKeyLock) with its OWN extra
    // microtask hop, so the store's `set({learnset})` (and the
    // queue-length effect it triggers) can commit before this async
    // function's continuation resumes past the `await` below. Arming
    // here instead is still race-free: nothing else in this component
    // can touch the queue between this synchronous line and the
    // gradeReview call it immediately precedes (nothing yields the
    // thread until AFTER the store write is dispatched), and the effect
    // below unconditionally disarms itself on every run regardless of
    // whether it fires — so a grade must still immediately precede the
    // transition to count.
    lastActionWasGradeRef.current = true;
    try {
      await gradeReview(current.kind, current.surface, grade);
    } finally {
      setGrading(false);
    }
  };

  return (
    <div className="space-y-4">
      <FlashCard content={content} flipped={flipped} onFlip={() => setFlipped((v) => !v)} />

      <div className="flex items-center justify-center gap-3">
        {GRADE_OPTIONS.map(({ grade, label, cls }) => (
          <button
            key={grade}
            type="button"
            disabled={grading}
            onClick={() => void handleGrade(grade)}
            className={`btn-tactile h-10 rounded-none border px-5 text-sm ${cls} hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="text-center font-mono text-xs tabular-nums text-mut">
        剩余 {queue.length} · {current.enrolled ? "复习" : "新收录"}
      </div>
    </div>
  );
}
