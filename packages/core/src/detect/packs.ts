// Dictionary theme packs — lets users narrow the built-in dictionary
// to the domains relevant to them (e.g. turn off 学术 jargon if they
// never attend academic meetings). OWNER: worker G.

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
];

/** null enabled-list = everything on. "core" (the base tables) is
 *  the product floor and is always enabled regardless of what the
 *  user has unchecked. */
export function isPackEnabled(pack: string, enabled: string[] | null): boolean {
  if (pack === "core") return true;
  if (enabled === null) return true;
  return enabled.includes(pack);
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
