// The demo meeting's post-meeting report (UI-1, ui-upgrade-plan-2026-09
// U-2). A first-run web user has no API key, so 生成会议报告 would end
// the demo on a 「需要 API Key」 toast and the bilingual report (and the
// vault export behind it) would never be seen. The demo is a replay, so
// its report is too: the summary text below is written for this exact
// script (its topic, points and first decision follow a real report the
// summarize pipeline produced for the same meeting, the README's
// assets/summary.png). The bilingual transcript and flashcards are
// built from what this run actually produced: the replayed
// translations and the cards live detection surfaced.
//
// `model: "demo"` is the marker: SummaryPanel labels the report as a
// sample, so it never passes for an LLM result.

import type { ExpressionCard, SummaryResult, TermCard, TranscriptSegment } from "@jargonslayer/core/types";
import { demoTranslationFor } from "./stt/demo";

export const DEMO_REPORT_MODEL = "demo";

const MAX_FLASHCARDS = 12;

export function isDemoReport(summary: SummaryResult | null | undefined): boolean {
  return summary?.model === DEMO_REPORT_MODEL;
}

export function buildDemoReport(
  segments: TranscriptSegment[],
  cards: ExpressionCard[],
  terms: TermCard[],
  now: number = Date.now(),
): SummaryResult {
  const translations = segments.flatMap((s) => {
    const zh = demoTranslationFor(s.text);
    return zh === undefined ? [] : [{ index: s.index, zh }];
  });

  const expressionCards = [...cards]
    .sort((a, b) => b.count - a.count)
    .map((c) => ({
      front: c.expression,
      back_zh: c.chinese_explanation,
      back_en: c.meaning,
      example: c.source_sentence,
      tags: [c.category],
    }));
  const termCards = [...terms]
    .sort((a, b) => b.count - a.count)
    .map((t) => ({
      front: t.term,
      back_zh: t.gloss_zh,
      back_en: t.gloss_en,
      example: "",
      tags: ["term"],
    }));

  return {
    summary: {
      topic: {
        en: "Q3 planning: billing fixes vs. churn dashboard under Series B time pressure",
        zh: "Q3 规划：Series B 占用工程时间的背景下，计费修复与流失看板的优先级取舍",
      },
      key_points: [
        {
          en: "ARR grew this quarter, but churn improvements are not yet moving retention",
          zh: "本季度 ARR 增长不错，但流失改善还没真正拉动留存",
        },
        {
          en: "Billing-flow quick fixes are the agreed low-cost, fast-payoff bet",
          zh: "计费流程的小修复，大家一致认为成本低、见效快",
        },
        {
          en: "Series B diligence calls are consuming half of engineering's time",
          zh: "Series B 尽调电话占掉了工程一半的时间",
        },
        {
          en: "Leadership keeps asking for the churn dashboard",
          zh: "管理层一直在要流失看板",
        },
      ],
      decisions: [
        {
          en: "Scope the billing fixes tightly instead of fixing every edge case",
          zh: "计费修复收紧范围，不求一次覆盖所有边缘情况",
        },
        {
          en: "Table the dashboard debate until the Series B numbers are final",
          zh: "看板之争先搁置，等 B 轮数字定下来再议",
        },
      ],
      action_items: [
        { owner: "Mike", en: "Own the billing fixes", zh: "负责计费修复", due: "" },
        { owner: "Lily", en: "Own the churn dashboard", zh: "负责流失看板", due: "" },
        {
          owner: "Mike, Lily",
          en: "Meet for fifteen minutes after the call to sort out the priority order",
          zh: "会后碰十五分钟，理清优先级",
          due: "会后",
        },
        { owner: "Sarah", en: "Share runway updates", zh: "同步现金储备的最新情况", due: "周五" },
      ],
    },
    translations,
    flashcards: [...expressionCards, ...termCards].slice(0, MAX_FLASHCARDS),
    generatedAt: now,
    model: DEMO_REPORT_MODEL,
  };
}
