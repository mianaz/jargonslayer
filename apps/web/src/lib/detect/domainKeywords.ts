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
// LOW fix (v0.6 round-2 review): caps the scanned text to its own
// trailing window instead of the WHOLE transcript-so-far — useMeeting.ts
// calls this on EVERY finalized segment for as long as inferredDomains
// stays empty, i.e. for a WHOLE meeting, permanently, for exactly the
// keyless users this fallback targets (a real key resolves
// inferredDomains from the LLM instead — see this function's own header
// — this path only ever runs for THEM); without a cap, the lowercase +
// ~70-keyword .includes() scan below re-ran over an ever-GROWING string
// every single segment. Mirrors scheduler.ts's own private
// CONTEXT_TAIL_MAX_CHARS (not imported — that constant belongs to a
// different module's own LLM-context-tail concern; same VALUE, same
// "how much recent transcript context is enough" reasoning) — domain
// inference only cares about what's being discussed RECENTLY anyway, so
// a tail is the semantically right cap, not merely a perf one.
const KEYWORD_SCAN_MAX_CHARS = 800;

export function inferDomainsFromKeywords(text: string): DomainTag[] {
  const recent = text.slice(-KEYWORD_SCAN_MAX_CHARS);
  const lower = recent.toLowerCase();
  const counts = new Map<DomainTag, number>();
  for (const [keyword, domain] of DOMAIN_KEYWORDS) {
    // CJK Unified Ideographs block, U+4E00-U+9FFF — same range/literal
    // form as spanQc.ts's own CJK_RE.
    const isCjk = /[一-鿿]/.test(keyword);
    const hit = isCjk ? recent.includes(keyword) : lower.includes(keyword);
    if (hit) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_KEYWORD_DOMAINS)
    .map(([domain]) => domain);
}
