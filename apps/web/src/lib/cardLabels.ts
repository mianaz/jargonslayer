// Shared Chinese label maps for expression/term card chrome. Was
// duplicated between CardsPanel.tsx and HoverGlossCard.tsx (and
// TERM_TYPE_LABELS lived only in CardsPanel.tsx); centralized here so
// every card-rendering surface (list + hover gloss) stays in sync.

import type { ExpressionCategory, TermType } from "@jargonslayer/core/types";

export const CATEGORY_LABELS: Record<ExpressionCategory, string> = {
  idiom: "习语",
  slang: "俚语",
  phrase: "短语",
  metaphor: "隐喻",
  indirect: "委婉",
  other: "其他",
};

export const TERM_TYPE_LABELS: Record<TermType, string> = {
  acronym: "缩写",
  company: "公司",
  product: "产品",
  tech: "技术",
  metric: "指标",
  person: "人名",
  other: "其他",
};
