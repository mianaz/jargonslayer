// Dictionary theme packs — lets users narrow the built-in dictionary
// to the domains relevant to them (e.g. turn off 学术 jargon if they
// never attend academic meetings). OWNER: worker G.

import type { DomainTag } from "./dictionary-data";
import { getLoadedRemotePacks } from "./remotePacksRegistry";

export interface DictPack {
  id: string;
  name: string;
  description: string;
  remote?: boolean;
}

export const PACKS: DictPack[] = [
  {
    id: "core",
    name: "基础包",
    description: "内置必备表达与商务黑话，始终启用",
  },
  {
    id: "meeting-flow",
    name: "会议流程与推进",
    description: "开场、收尾、议程控制类的常用会议用语",
  },
  {
    id: "project",
    name: "项目与执行",
    description: "项目推进、排期、技术债相关的表达",
  },
  {
    id: "feedback",
    name: "绩效与反馈",
    description: "绩效评估、辅导、批评与表扬相关的表达",
  },
  {
    id: "sales",
    name: "销售市场与增长",
    description: "销售漏斗、市场定位、增长策略相关的表达",
  },
  {
    id: "softening",
    name: "委婉与批评",
    description: "婉转提出异议、软化批评的常见说法",
  },
  {
    id: "academic",
    name: "学术与研究会议",
    description: "论文评审、实验设计、学术黑话相关的表达",
  },
  {
    id: "chitchat",
    name: "闲聊与过渡",
    description: "寒暄、话题切换、会议间隙的轻松用语",
  },
  {
    id: "business-terms",
    name: "商务术语",
    description: "融资、财务、HR 等商务缩写与术语",
  },
  {
    id: "tech-terms",
    name: "技术术语",
    description: "研发、运维相关的技术缩写与术语",
  },
  {
    id: "pharma-biotech",
    name: "医药与生物科技",
    description: "新药研发、临床试验、监管申报相关的术语",
  },
  {
    id: "stats",
    name: "统计学术语",
    description: "假设检验、置信区间、p 值等经典推断统计术语",
  },
  {
    id: "ml-stats",
    name: "机器学习术语",
    description: "模型训练、评估、深度学习相关的机器学习术语",
  },
  {
    id: "bioinformatics-edam",
    name: "生物信息学术语",
    description: "测序、比对、组学分析等生物信息学操作与数据类型",
  },
  // v0.6: field-agnostic vocabulary — the terms a person meets whatever
  // their background, which is what belongs in a default-on dictionary.
  {
    id: "modern-usage",
    name: "新兴用法",
    description: "近几年才有当前含义的词：harness、agent、RAG、guardrails 等",
  },
  {
    id: "finance-consumer",
    name: "钱与福利",
    description: "保险、薪酬、股权、税务等日常场合绕不开的英文说法",
  },
  {
    id: "daily-idiom",
    name: "日常口语与俗语",
    description: "会议前后的寒暄、委婉说法、体育比喻等课本不教的表达",
  },
];

/** Packs-schema version (MEDIUM-5 fix, v0.6 round-2 review) — bumped
 *  whenever a NEW built-in pack is added to PACKS above. store.ts's
 *  migrateSettings() reads this (via PACKS_ADDED_AT_VERSION below) to
 *  union newly-introduced pack ids into an OLD saved EXPLICIT
 *  enabledPacks array (SettingsDialog.tsx's own 保存 writes one the
 *  moment a user unchecks even a single pack — see PACKS_ADDED_AT_
 *  VERSION's own doc for the "explicit exclusions survive, genuinely
 *  new packs default on" contract this backs). Settings.
 *  packsSchemaVersion (types.ts) mirrors this exact literal value —
 *  types.ts is a dependency-free leaf (see its own header comment) and
 *  cannot import this constant, so keep the two in sync by hand
 *  whenever this bumps. */
export const CURRENT_PACKS_SCHEMA_VERSION = 1;

/** Built-in pack ids introduced AT each packs-schema version, keyed by
 *  the version they first appeared in. Version 1 is this mechanism's
 *  own introduction (v0.6 round-2 fix round): the three field-agnostic
 *  packs added earlier in v0.6 (see PACKS' own "v0.6: field-agnostic
 *  vocabulary" comment above) — exactly what a pre-this-fix saved
 *  enabledPacks array (frozen before they existed) is missing.
 *  migrateSettings unions every entry strictly newer than whatever
 *  version a saved settings blob last recorded; a future pack addition
 *  bumps CURRENT_PACKS_SCHEMA_VERSION and adds its own entry here. */
export const PACKS_ADDED_AT_VERSION: Record<number, string[]> = {
  1: ["modern-usage", "finance-consumer", "daily-idiom"],
};

/** v0.6 T5 (multi-sense terms): a CONSERVATIVE built-in-pack ->
 *  DomainTag map, feeding apps/web's senseContext.ts derivation ("domains
 *  of explicitly-enabled packs" contribute 0.5 weight — see that file's
 *  own doc). Deliberately only covers packs whose id/description names
 *  ONE DomainTag unambiguously; a pack with no obvious single domain
 *  (meeting-flow, project, feedback, sales-adjacent softening, chitchat,
 *  tech-terms, core) is left OUT rather than guessed —
 *  an absent mapping just contributes 0 (T3's scoring formula already
 *  treats a missing weight as 0), never a wrong nudge. Remote packs are
 *  never in this map (their own domain signal, if any, is author-set
 *  per SENSE via DictSense.domain, not per-pack). `business-terms` is
 *  the one intentionally broad mapping: its unambiguous SaaS/revenue
 *  headwords provide the meeting-level business/sales signal used to
 *  disambiguate otherwise ordinary business language. */
export const PACK_DOMAINS: Partial<Record<string, DomainTag>> = {
  "business-terms": "sales",
  sales: "sales",
  academic: "edu",
  "pharma-biotech": "pharma",
  stats: "stats",
  "ml-stats": "ml",
  "bioinformatics-edam": "genomics",
  "finance-consumer": "finance",
  // modern-usage and daily-idiom are deliberately absent: both are
  // cross-domain by construction, so mapping either to one DomainTag
  // would nudge sense selection toward a domain the pack does not
  // actually imply.
};

/** null enabled-list = everything on. "core" (the base tables) is
 *  the product floor and is always enabled regardless of what the
 *  user has unchecked. */
export function isPackEnabled(pack: string, enabled: string[] | null): boolean {
  if (pack === "core") return true;
  if (enabled === null) return true;
  return enabled.includes(pack);
}

/** True only when the user has an EXPLICIT pack selection (enabled !==
 *  null) that NAMES this exact pack — unlike isPackEnabled above, "core"
 *  gets NO special-case here: this answers "did the user actively opt
 *  into this pack", not "is this pack currently active". v0.6 T3/T6:
 *  feeds the multi-sense scoring bonus (dictionary.ts's selectSense) and
 *  the commonWord opt-in guard (scanDictionary/packTermsForBias) — a
 *  commonWord entry now fires only when ITS OWN pack is explicitly
 *  enabled, never merely because SOME OTHER pack was explicitly named
 *  (see dictionary.ts's packTermsForBias doc for the misread history
 *  this closes — the "core" special-case in isPackEnabled used to let a
 *  hypothetical commonWord entry tagged "core" fire under ANY explicit
 *  selection, even one that never named "core" at all). */
export function isPackExplicitlyEnabled(pack: string, enabled: string[] | null): boolean {
  return enabled !== null && enabled.includes(pack);
}

/** Built-in packs plus metadata for every currently-loaded remote pack
 *  (see apps/web's remotePacks.ts), so the Settings checkbox list and
 *  any other pack-aware UI can render both sources uniformly. Remote
 *  packs are tagged `remote: true` and only appear once apps/web's
 *  remotePacks.ts has populated remotePacksRegistry.ts's in-memory
 *  registry (triggered by SettingsDialog's app-mount effect — #53 core
 *  extraction moved this registry here since it's pure; the fetch/
 *  idb-keyval load itself stays in apps/web and can't be triggered
 *  from this package). */
export function getAllPacks(): DictPack[] {
  const remotePacks: DictPack[] = getLoadedRemotePacks().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description ?? `社区词典包 · v${p.version}`,
    remote: true,
  }));
  return [...PACKS, ...remotePacks];
}
