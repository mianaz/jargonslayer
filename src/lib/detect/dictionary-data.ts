// Extended built-in dictionary data. OWNER: worker E (fills the
// arrays). dictionary.ts concatenates these with its base tables;
// entries here must NOT duplicate expressions already in
// dictionary.ts. Keep the quality bar: chinese_explanation 自然商务
// 中文 ≤40字、不要词典腔；plain_english ≤10 words。

import type { ExpressionCategory, TermType } from "../types";

export interface DictExpressionEntry {
  expression: string;
  variants?: string[];
  category: ExpressionCategory;
  meaning: string;
  chinese_explanation: string;
  plain_english: string;
  tone: string;
  confidence: number; // 0.9 for dictionary entries
}

export interface DictTermEntry {
  term: string;
  type: TermType;
  gloss_en: string;
  gloss_zh: string;
}

// STUB — worker E fills (~240 expressions grouped by theme comments,
// ~40 terms). Themes: 会议流程 / 项目管理 / 绩效与反馈 / 销售与市场 /
// 委婉与批评 / 学术与研究会议 / 闲聊与过渡.
export const EXTRA_EXPRESSIONS: DictExpressionEntry[] = [];

export const EXTRA_TERMS: DictTermEntry[] = [];
