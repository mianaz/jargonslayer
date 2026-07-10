"use client";

// SRS due-review deck (#48 step 2) — 复习到期 mode. Reuses PracticeDeck's
// flip-card visuals (FlashCard) but grades on the 3-button SM-2-lite
// scale (不认识/模糊/认识) instead of PracticeDeck's mastered/not toggle.
// Deliberately does NOT replace 翻卡浏览 — the two modes ship in
// parallel per the design (usage decides later, see PLAN-v0.3.0.md).

import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/lib/store";
import type { CustomEntry, ExpressionCard, MeetingSession, TermCard } from "@/lib/types";
import { learnKey } from "@/lib/learn/store";
import type { SrsGrade } from "@/lib/learn/srs";
import {
  composeReviewQueue,
  expressionCardToCandidate,
  termCardToCandidate,
  type ReviewCandidate,
  type ReviewQueueItem,
} from "@/lib/learn/queue";
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

function EmptyDueState() {
  return (
    <div className="rounded-none border border-edge bg-panel p-6 text-center">
      <div className="text-sm font-medium text-fg">今天没有待复习的词条</div>
      <div className="mt-2 text-xs leading-[1.7] text-mut">
        继续开会积累新表达，或去词库收藏几个术语——到期后会自动出现在这里。
      </div>
    </div>
  );
}

export default function DueReview({ cache }: { cache: Record<string, MeetingSession> }) {
  const learnset = useApp((s) => s.learnset);
  const customEntries = useApp((s) => s.customEntries);
  const gradeReview = useApp((s) => s.gradeReview);

  const candidates = useMemo(() => buildCandidates(cache), [cache]);
  const contentIndex = useMemo(
    () => buildContentIndex(cache, customEntries),
    [cache, customEntries],
  );
  const queue = useMemo(
    () => composeReviewQueue(learnset, candidates, Date.now()),
    [learnset, candidates],
  );

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
    return <EmptyDueState />;
  }

  const content = contentIndex[current.learnKey] ?? fallbackContent(current);

  const handleGrade = async (grade: SrsGrade) => {
    if (grading) return;
    setGrading(true);
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
