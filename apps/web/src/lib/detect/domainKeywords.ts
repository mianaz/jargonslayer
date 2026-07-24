// v0.6 multi-sense-terms sprint (T5) — keyless keyword-based domain
// fallback: dictionary detection MUST work with zero API key (product
// invariant), so this is what feeds dictionary.ts's setSenseContext
// (via senseContext.ts's deriveSenseContext) when there is no key at
// all, or the LLM inference hasn't landed yet — see useMeeting.ts's
// wiring effect, which only reaches for this once store.inferredDomains
// is still empty. Own module, own tests, per spec — deliberately NOT
// merged into senseContext.ts (that function stays a pure fold over
// already-known domains; this one is the thing that GUESSES domains
// from raw text in the first place).

import type { DomainTag } from "@jargonslayer/core/detect/dictionary-data";

const MAX_KEYWORD_DOMAINS = 3;

// ~70 keyword -> DomainTag pairs, en + zh, covering every DomainTag
// except "general" (the catch-all — nothing maps TO it; it's simply
// what a caller falls back to when this returns []). Deliberately
// high-precision, domain-specific phrases over generic single words, to
// keep the false-positive rate low on ordinary meeting chatter.
const DOMAIN_KEYWORDS: readonly [string, DomainTag][] = [
  // biomed
  ["biomedical", "biomed"],
  ["生物医学", "biomed"],
  ["cell biology", "biomed"],
  ["细胞生物学", "biomed"],
  // clinical
  ["clinical trial", "clinical"],
  ["临床试验", "clinical"],
  ["patient cohort", "clinical"],
  ["患者队列", "clinical"],
  // pharma
  ["drug development", "pharma"],
  ["新药研发", "pharma"],
  ["fda approval", "pharma"],
  ["药物研发", "pharma"],
  ["pharmacokinetics", "pharma"],
  // genomics
  ["genome", "genomics"],
  ["基因组", "genomics"],
  ["sequencing", "genomics"],
  ["测序", "genomics"],
  ["single-cell", "genomics"],
  // stats
  ["p-value", "stats"],
  ["p 值", "stats"],
  ["confidence interval", "stats"],
  ["置信区间", "stats"],
  // ml
  ["machine learning", "ml"],
  ["机器学习", "ml"],
  ["neural network", "ml"],
  ["神经网络", "ml"],
  ["deep learning", "ml"],
  // software
  ["software engineering", "software"],
  ["软件工程", "software"],
  ["codebase", "software"],
  ["代码库", "software"],
  ["pull request", "software"],
  // infra
  ["infrastructure", "infra"],
  ["基础设施", "infra"],
  ["kubernetes", "infra"],
  ["云计算", "infra"],
  ["data center", "infra"],
  // finance
  ["quarterly earnings", "finance"],
  ["财报", "finance"],
  ["revenue", "finance"],
  ["营收", "finance"],
  ["burn rate", "finance"],
  // sales
  ["sales pipeline", "sales"],
  ["销售漏斗", "sales"],
  ["sales quota", "sales"],
  ["销售指标", "sales"],
  // hr
  ["performance review", "hr"],
  ["绩效考核", "hr"],
  ["recruiting", "hr"],
  ["招聘", "hr"],
  ["onboarding", "hr"],
  // legal
  ["contract", "legal"],
  ["合同", "legal"],
  ["compliance", "legal"],
  ["合规", "legal"],
  ["intellectual property", "legal"],
  // ops
  ["supply chain", "ops"],
  ["供应链", "ops"],
  ["logistics", "ops"],
  ["物流", "ops"],
  ["inventory", "ops"],
  // edu
  ["curriculum", "edu"],
  ["课程", "edu"],
  ["lecture", "edu"],
  ["讲座", "edu"],
  ["thesis", "edu"],
  // media
  ["content strategy", "media"],
  ["内容策略", "media"],
  ["target audience", "media"],
  ["受众", "media"],
];

/** Keyless domain fallback: counts how many DISTINCT keywords for each
 *  domain appear in `text`, ranks domains by that count (most matched
 *  keywords first), and returns up to MAX_KEYWORD_DOMAINS — same cap as
 *  the LLM-inferred path (InferContextResponse.domains). English
 *  keywords match case-insensitively; CJK keywords match the original
 *  text as-is (case folding is meaningless for them). Returns [] when
 *  nothing matches — a low-signal guess is worse than none, same
 *  posture as the LLM prompt's own "return [] when unsure" rule.
 *
 *  ponytail: naive heuristic — a flat keyword-count ranking with no
 *  weighting by keyword specificity/rarity, and a tie between two
 *  domains breaks in DOMAIN_KEYWORDS' own list order (stable sort),
 *  not anything meaningful about the text. Ceiling: on a transcript
 *  that genuinely straddles two domains equally, the winner is
 *  whichever domain happens to be listed earlier above. Upgrade path
 *  if that ever matters: weight each keyword hit by inverse document
 *  frequency, or just let the real LLM inference (which this only
 *  covers for BEFORE it lands / no key at all) settle it. */
export function inferDomainsFromKeywords(text: string): DomainTag[] {
  const lower = text.toLowerCase();
  const counts = new Map<DomainTag, number>();
  for (const [keyword, domain] of DOMAIN_KEYWORDS) {
    // CJK Unified Ideographs block, U+4E00-U+9FFF — same range/literal
    // form as spanQc.ts's own CJK_RE.
    const isCjk = /[一-鿿]/.test(keyword);
    const hit = isCjk ? text.includes(keyword) : lower.includes(keyword);
    if (hit) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_KEYWORD_DOMAINS)
    .map(([domain]) => domain);
}
