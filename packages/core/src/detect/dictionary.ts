// Built-in offline dictionary of business idioms + terms.
// OWNER: worker B (fills DICTIONARY/TERM_DICTIONARY + scan logic).
// #54: this is the INSTANT FLOOR — scanned synchronously on every
// finalized segment (see scheduler.ts). The LLM layer (settings.
// aiDetect) only upgrades these hits in place; when it's off or
// failing, this dictionary is the whole detection story.

import type {
  DetectedExpression,
  DetectedTerm,
  DetectResponse,
  ExpressionCategory,
  TermType,
} from "../types";
import { EXTRA_EXPRESSIONS, EXTRA_TERMS } from "./dictionary-data";
import { COMPILED_PACK_TERMS } from "./dictionary-packs-compiled";
import { findEntryBySurface } from "../history/glossaryLookup";
import { isPackEnabled } from "./packs";
import { getLoadedRemotePacks } from "./remotePacksRegistry";

// ---------------------------------------------------------------
// Dictionary entry shapes (internal — not part of the wire schema)
// ---------------------------------------------------------------

interface ExpressionEntry {
  expression: string;
  variants?: string[];
  category: ExpressionCategory;
  meaning: string;
  chinese_explanation: string;
  plain_english: string;
  tone: string;
  confidence: number;
  pack: string;
}

interface TermEntry {
  term: string;
  type: TermType;
  gloss_en: string;
  gloss_zh: string;
  pack: string;
  // See DictTermEntry.commonWord — everyday-English headwords from the
  // compiled domain packs, kept opt-in in scanDictionary's term loop.
  commonWord?: boolean;
}

// Base tables (below) are the product floor — always tagged "core",
// which isPackEnabled() treats as permanently enabled regardless of
// the user's enabledPacks selection.
const CORE_PACK = "core";

// ---------------------------------------------------------------
// Expressions (>=60). chinese_explanation: natural business
// Chinese, <=40 chars, no dictionary tone. plain_english: <=10 words.
// ---------------------------------------------------------------

const BASE_EXPRESSIONS: ExpressionEntry[] = [
  {
    expression: "get the ball rolling",
    category: "idiom",
    meaning: "start something, kick off an activity or process",
    chinese_explanation: "先启动起来，把事情推进下去",
    plain_english: "start it now",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "low-hanging fruit",
    category: "metaphor",
    meaning: "easy tasks or wins to tackle first",
    chinese_explanation: "容易搞定、见效快的事情，先捡软柿子捏",
    plain_english: "the easy wins",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "move the needle",
    category: "idiom",
    meaning: "make a meaningful, measurable impact",
    chinese_explanation: "真正带来明显变化、有实际效果",
    plain_english: "actually make an impact",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "circle back",
    category: "phrase",
    meaning: "revisit a topic later",
    chinese_explanation: "回头再聊、之后再讨论这个话题",
    plain_english: "discuss again later",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "take this offline",
    variants: ["take it offline"],
    category: "phrase",
    meaning: "discuss privately outside the current meeting",
    chinese_explanation: "会后私下再聊，别占用大家时间",
    plain_english: "discuss privately later",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "table this",
    variants: ["table it"],
    category: "phrase",
    meaning: "postpone discussion of a topic",
    chinese_explanation: "先搁置这个话题，之后再议",
    plain_english: "postpone this topic",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "push back",
    variants: ["pushback"],
    category: "phrase",
    meaning: "resist or object to a proposal",
    chinese_explanation: "提出反对意见，不太认同这个方案",
    plain_english: "object or resist",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "bandwidth",
    category: "metaphor",
    meaning: "available time or capacity to take on work",
    chinese_explanation: "手头精力和时间够不够做这件事",
    plain_english: "available time/capacity",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "boil the ocean",
    category: "idiom",
    meaning: "attempt something unnecessarily large or unfeasible",
    chinese_explanation: "把事情做得太大太全，贪多嚼不烂",
    plain_english: "overcomplicate/overreach",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "on the same page",
    category: "idiom",
    meaning: "in agreement or aligned understanding",
    chinese_explanation: "大家想法一致，理解得一样",
    plain_english: "we all agree",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "read the room",
    category: "idiom",
    meaning: "sense the mood/attitude of a group before acting",
    chinese_explanation: "察言观色，感受一下现场的气氛",
    plain_english: "sense the mood first",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "elephant in the room",
    category: "metaphor",
    meaning: "an obvious problem everyone avoids discussing",
    chinese_explanation: "大家都心知肚明却没人挑明的问题",
    plain_english: "the obvious unspoken issue",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "unpack",
    category: "metaphor",
    meaning: "break down and examine something in detail",
    chinese_explanation: "把这件事拆开来，仔细讲讲清楚",
    plain_english: "break it down in detail",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "raise eyebrows",
    variants: ["raised eyebrows"],
    category: "idiom",
    meaning: "cause surprise, mild shock, or suspicion",
    chinese_explanation: "让人感到意外或有点起疑心",
    plain_english: "cause surprise/suspicion",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "align",
    variants: ["align on", "aligned"],
    category: "phrase",
    meaning: "reach shared agreement or consistent direction",
    chinese_explanation: "对齐想法，达成一致的方向",
    plain_english: "agree on the same direction",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "touch base",
    category: "idiom",
    meaning: "make brief contact to check in",
    chinese_explanation: "简单碰个头，同步一下情况",
    plain_english: "check in briefly",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "ping me",
    category: "slang",
    meaning: "send me a quick message",
    chinese_explanation: "有事直接给我发个消息",
    plain_english: "message me",
    tone: "casual, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "ballpark",
    category: "metaphor",
    meaning: "a rough estimate, not exact",
    chinese_explanation: "大概估个数，不用太精确",
    plain_english: "a rough estimate",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "back to the drawing board",
    category: "idiom",
    meaning: "start over after a failed attempt",
    chinese_explanation: "推倒重来，之前的方案不行了",
    plain_english: "start over from scratch",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "drop the ball",
    category: "idiom",
    meaning: "fail to follow through on a responsibility",
    chinese_explanation: "掉链子了，该做的事没做好",
    plain_english: "fail to follow through",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "on my plate",
    category: "metaphor",
    meaning: "currently assigned tasks/workload",
    chinese_explanation: "手上正在忙的活儿、待办事项",
    plain_english: "my current workload",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "hard stop",
    category: "phrase",
    meaning: "a firm time limit that cannot be moved",
    chinese_explanation: "必须准时结束，后面有硬性安排",
    plain_english: "a firm deadline/end time",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "deep dive",
    category: "metaphor",
    meaning: "a thorough, detailed examination of a topic",
    chinese_explanation: "深入研究一下，仔细过一遍细节",
    plain_english: "look into it thoroughly",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "double-click on",
    category: "metaphor",
    meaning: "examine a point in more detail",
    chinese_explanation: "针对这一点再深入展开说说",
    plain_english: "go deeper on this point",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "level set",
    category: "phrase",
    meaning: "make sure everyone has the same baseline understanding",
    chinese_explanation: "先拉齐信息，确保大家认知一致",
    plain_english: "get everyone on the same page",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "north star",
    category: "metaphor",
    meaning: "the primary guiding goal or metric",
    chinese_explanation: "最重要的目标，指引方向的那个东西",
    plain_english: "the main guiding goal",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "quick win",
    category: "phrase",
    meaning: "a fast, easy improvement with visible results",
    chinese_explanation: "能快速见效的小成果",
    plain_english: "a fast easy improvement",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "out of the loop",
    category: "idiom",
    meaning: "not informed about recent developments",
    chinese_explanation: "没被同步到最新情况，信息滞后了",
    plain_english: "not kept informed",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "in the weeds",
    category: "idiom",
    meaning: "overly focused on small details, losing the big picture",
    chinese_explanation: "陷在细节里出不来，忘了大方向",
    plain_english: "stuck in the details",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "30,000-foot view",
    category: "metaphor",
    meaning: "a high-level overview without details",
    chinese_explanation: "站在高处看全局，不纠结细节",
    plain_english: "a big-picture overview",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "put a pin in it",
    category: "idiom",
    meaning: "pause the topic to return to it later",
    chinese_explanation: "先记下来，这个话题稍后再聊",
    plain_english: "pause this, revisit later",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "park this",
    category: "phrase",
    meaning: "set a topic aside for now",
    chinese_explanation: "先放一放，暂时不处理这个",
    plain_english: "set this aside for now",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "moving the goalposts",
    category: "idiom",
    meaning: "unfairly changing the criteria for success mid-process",
    chinese_explanation: "标准中途被改了，之前说好的不算数",
    plain_english: "changing the rules mid-way",
    tone: "critical, mild frustration",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "herding cats",
    category: "metaphor",
    meaning: "trying to organize a chaotic, hard-to-manage group",
    chinese_explanation: "想把一群各干各的人协调好，非常费劲",
    plain_english: "hard to coordinate people",
    tone: "neutral, mildly humorous",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "run it up the flagpole",
    category: "idiom",
    meaning: "float an idea to see how people react",
    chinese_explanation: "先把想法抛出去，看看大家反应",
    plain_english: "float the idea and see",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "straw man",
    category: "metaphor",
    meaning: "a simplified draft proposal meant to spark feedback",
    chinese_explanation: "先搭个粗糙的草案，抛出来听意见",
    plain_english: "a rough draft to react to",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "steel man",
    category: "metaphor",
    meaning: "present the strongest version of an opposing argument",
    chinese_explanation: "把对方的观点讲到最有说服力的程度",
    plain_english: "argue the strongest opposing case",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "sanity check",
    category: "phrase",
    meaning: "a quick verification that something makes sense",
    chinese_explanation: "简单核实一下，看这靠不靠谱",
    plain_english: "a quick reasonableness check",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "rubber stamp",
    category: "metaphor",
    meaning: "approve something without real scrutiny",
    chinese_explanation: "走个流程盖章，没真正认真审核",
    plain_english: "approve without real review",
    tone: "neutral, slightly critical",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "buy-in",
    category: "phrase",
    meaning: "agreement and support from stakeholders",
    chinese_explanation: "大家真心认可并愿意支持这件事",
    plain_english: "everyone's genuine agreement",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "pushing the envelope",
    category: "idiom",
    meaning: "going beyond normal limits, being innovative or risky",
    chinese_explanation: "突破常规界限，做点大胆创新的事",
    plain_english: "going beyond the usual limits",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "singing from the same hymn sheet",
    category: "idiom",
    meaning: "everyone communicating the same consistent message",
    chinese_explanation: "对外口径完全一致，说法统一",
    plain_english: "all saying the same thing",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "throw under the bus",
    category: "idiom",
    meaning: "blame or betray someone to protect oneself",
    chinese_explanation: "把责任甩给别人，牺牲对方保自己",
    plain_english: "blame someone to save yourself",
    tone: "critical, negative",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "skin in the game",
    category: "idiom",
    meaning: "personal stake or risk in the outcome",
    chinese_explanation: "自己也有切身利益，不是站着说话",
    plain_english: "having a personal stake",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "big picture",
    category: "metaphor",
    meaning: "the overall situation, not the details",
    chinese_explanation: "从整体大局出发考虑，不看细枝末节",
    plain_english: "the overall situation",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "granular",
    category: "metaphor",
    meaning: "very detailed, fine-grained",
    chinese_explanation: "非常细化、具体到很小的颗粒度",
    plain_english: "very detailed/specific",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "evangelize",
    category: "metaphor",
    meaning: "actively promote and champion an idea or product",
    chinese_explanation: "大力推广、四处安利这个想法或产品",
    plain_english: "actively promote it",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "dogfooding",
    category: "slang",
    meaning: "using your own product internally before shipping it",
    chinese_explanation: "自己先用自家产品，内部实测一下",
    plain_english: "using your own product first",
    tone: "casual, tech jargon",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "bake in",
    category: "metaphor",
    meaning: "build a feature or assumption in from the start",
    chinese_explanation: "从一开始就把这个考虑进去、内置进去",
    plain_english: "build it in from the start",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "greenfield",
    category: "metaphor",
    meaning: "a project starting from scratch, no constraints",
    chinese_explanation: "从零开始的新项目，没有历史包袱",
    plain_english: "a brand-new project from scratch",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "brownfield",
    category: "metaphor",
    meaning: "a project built on existing legacy systems/constraints",
    chinese_explanation: "在旧系统基础上改造，带着历史包袱",
    plain_english: "built on existing legacy systems",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "tiger team",
    category: "metaphor",
    meaning: "a small dedicated team formed to solve an urgent problem",
    chinese_explanation: "临时抽调的精锐小组，专门攻克难题",
    plain_english: "a special task force",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "boots on the ground",
    category: "metaphor",
    meaning: "people actually present and doing the work on-site",
    chinese_explanation: "真正在一线干活、在现场的人",
    plain_english: "people actually on-site",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "over the wall",
    category: "metaphor",
    meaning: "handed off to another team without collaboration",
    chinese_explanation: "直接甩给另一个团队，缺乏配合沟通",
    plain_english: "handed off without collaboration",
    tone: "neutral, mildly critical",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "air cover",
    category: "metaphor",
    meaning: "protection or backing from leadership to do your work",
    chinese_explanation: "上层给的支持和保护，让你能放手做事",
    plain_english: "leadership backing/protection",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "keep me honest",
    category: "phrase",
    meaning: "correct me if I get something wrong",
    chinese_explanation: "我说得不对的话，请大家帮忙纠正",
    plain_english: "correct me if wrong",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "long story short",
    category: "phrase",
    meaning: "a shortened summary of a longer explanation",
    chinese_explanation: "长话短说，简单总结一下",
    plain_english: "to summarize quickly",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "squeaky wheel",
    category: "metaphor",
    meaning: "the person who complains loudest gets attention first",
    chinese_explanation: "谁闹得凶谁先被搭理，会哭的孩子有奶吃",
    plain_english: "whoever complains loudest gets attention",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "whiteboard this",
    category: "phrase",
    meaning: "work through an idea visually/interactively together",
    chinese_explanation: "拉个白板，大家一起把思路画出来讨论",
    plain_english: "work it out together visually",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "socialize this",
    category: "phrase",
    meaning: "share an idea informally to gather early reactions",
    chinese_explanation: "先私下和大家通个气，听听初步反应",
    plain_english: "share it informally first",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "take a step back",
    category: "idiom",
    meaning: "pause to reconsider the bigger picture",
    chinese_explanation: "先停一停，跳出来看看整体情况",
    plain_english: "pause and reconsider",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "peel the onion",
    category: "metaphor",
    meaning: "investigate a problem layer by layer",
    chinese_explanation: "一层一层地深挖问题的根源",
    plain_english: "investigate layer by layer",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "move fast and break things",
    category: "idiom",
    meaning: "prioritize speed over caution, accepting some mistakes",
    chinese_explanation: "追求速度，容忍一定的试错和瑕疵",
    plain_english: "prioritize speed over caution",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "not the hill to die on",
    category: "idiom",
    meaning: "not worth the fight or strong disagreement",
    chinese_explanation: "不值得为这件事死磕到底",
    plain_english: "not worth fighting over",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
  {
    expression: "wear many hats",
    category: "idiom",
    meaning: "handle multiple different roles/responsibilities",
    chinese_explanation: "身兼多职，一人干好几摊活儿",
    plain_english: "handling multiple roles",
    tone: "neutral, common business phrase",
    confidence: 0.9,
    pack: CORE_PACK,
  },
];

// ---------------------------------------------------------------
// Terms (>=25). gloss_zh <=25 chars.
// ---------------------------------------------------------------

const BASE_TERM_DICTIONARY: TermEntry[] = [
  {
    term: "ARR",
    type: "metric",
    gloss_en: "Annual Recurring Revenue",
    gloss_zh: "年度经常性收入",
    pack: CORE_PACK,
  },
  {
    term: "OKR",
    type: "other",
    gloss_en: "Objectives and Key Results, a goal-setting framework",
    gloss_zh: "目标与关键成果法",
    pack: CORE_PACK,
  },
  {
    term: "churn",
    type: "metric",
    gloss_en: "rate at which customers stop using a product",
    gloss_zh: "客户流失率",
    pack: CORE_PACK,
  },
  {
    term: "runway",
    type: "metric",
    gloss_en: "how long a company can operate before running out of cash",
    gloss_zh: "现金可支撑的时间",
    pack: CORE_PACK,
  },
  {
    term: "Series B",
    type: "other",
    gloss_en: "a company's third major round of venture funding",
    gloss_zh: "第三轮主要融资",
    pack: CORE_PACK,
  },
  {
    term: "MVP",
    type: "acronym",
    gloss_en: "Minimum Viable Product",
    gloss_zh: "最小可行产品",
    pack: CORE_PACK,
  },
  {
    term: "MRR",
    type: "metric",
    gloss_en: "Monthly Recurring Revenue",
    gloss_zh: "月度经常性收入",
    pack: CORE_PACK,
  },
  {
    term: "KPI",
    type: "metric",
    gloss_en: "Key Performance Indicator",
    gloss_zh: "关键绩效指标",
    pack: CORE_PACK,
  },
  {
    term: "ROI",
    type: "metric",
    gloss_en: "Return on Investment",
    gloss_zh: "投资回报率",
    pack: CORE_PACK,
  },
  {
    term: "YoY",
    type: "metric",
    gloss_en: "Year-over-Year comparison",
    gloss_zh: "同比",
    pack: CORE_PACK,
  },
  {
    term: "QoQ",
    type: "metric",
    gloss_en: "Quarter-over-Quarter comparison",
    gloss_zh: "环比（季度）",
    pack: CORE_PACK,
  },
  {
    term: "GTM",
    type: "acronym",
    gloss_en: "Go-To-Market strategy",
    gloss_zh: "市场推广策略",
    pack: CORE_PACK,
  },
  {
    term: "ICP",
    type: "acronym",
    gloss_en: "Ideal Customer Profile",
    gloss_zh: "理想客户画像",
    pack: CORE_PACK,
  },
  {
    term: "CAC",
    type: "metric",
    gloss_en: "Customer Acquisition Cost",
    gloss_zh: "获客成本",
    pack: CORE_PACK,
  },
  {
    term: "LTV",
    type: "metric",
    gloss_en: "Customer Lifetime Value",
    gloss_zh: "客户终身价值",
    pack: CORE_PACK,
  },
  {
    term: "NPS",
    type: "metric",
    gloss_en: "Net Promoter Score, a loyalty metric",
    gloss_zh: "净推荐值",
    pack: CORE_PACK,
  },
  {
    term: "EOD",
    type: "acronym",
    gloss_en: "End Of Day",
    gloss_zh: "今天下班前",
    pack: CORE_PACK,
  },
  {
    term: "EOW",
    type: "acronym",
    gloss_en: "End Of Week",
    gloss_zh: "本周结束前",
    pack: CORE_PACK,
  },
  {
    term: "ETA",
    type: "acronym",
    gloss_en: "Estimated Time of Arrival/completion",
    gloss_zh: "预计完成时间",
    pack: CORE_PACK,
  },
  {
    term: "WFH",
    type: "acronym",
    gloss_en: "Work From Home",
    gloss_zh: "居家办公",
    pack: CORE_PACK,
  },
  {
    term: "OOO",
    type: "acronym",
    gloss_en: "Out Of Office",
    gloss_zh: "不在办公室/休假",
    pack: CORE_PACK,
  },
  {
    term: "PTO",
    type: "acronym",
    gloss_en: "Paid Time Off",
    gloss_zh: "带薪休假",
    pack: CORE_PACK,
  },
  {
    term: "SOW",
    type: "acronym",
    gloss_en: "Statement of Work, a contract document",
    gloss_zh: "工作说明书",
    pack: CORE_PACK,
  },
  {
    term: "NDA",
    type: "acronym",
    gloss_en: "Non-Disclosure Agreement",
    gloss_zh: "保密协议",
    pack: CORE_PACK,
  },
  {
    term: "RFP",
    type: "acronym",
    gloss_en: "Request For Proposal",
    gloss_zh: "招标/征求方案书",
    pack: CORE_PACK,
  },
  {
    term: "B2B",
    type: "acronym",
    gloss_en: "Business-to-Business",
    gloss_zh: "企业对企业",
    pack: CORE_PACK,
  },
  {
    term: "SaaS",
    type: "tech",
    gloss_en: "Software as a Service",
    gloss_zh: "软件即服务",
    pack: CORE_PACK,
  },
  {
    term: "PoC",
    type: "acronym",
    gloss_en: "Proof of Concept",
    gloss_zh: "概念验证",
    pack: CORE_PACK,
  },
  {
    term: "P&L",
    type: "acronym",
    gloss_en: "Profit and Loss statement",
    gloss_zh: "损益表",
    pack: CORE_PACK,
  },
  {
    term: "headcount",
    type: "metric",
    gloss_en: "the number of employees",
    gloss_zh: "员工人数",
    pack: CORE_PACK,
  },
];

// ---------------------------------------------------------------
// Merge base + extended (dictionary-data.ts, filled separately) —
// dedupe by normalized expression/term string, base wins on conflict.
// ---------------------------------------------------------------

function normalizeDictKey(s: string): string {
  return s.trim().toLowerCase();
}

function dedupeByKey<T>(base: T[], extra: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set(base.map((item) => normalizeDictKey(keyOf(item))));
  const merged = [...base];
  for (const item of extra) {
    const key = normalizeDictKey(keyOf(item));
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

const EXPRESSIONS: ExpressionEntry[] = dedupeByKey(
  BASE_EXPRESSIONS,
  EXTRA_EXPRESSIONS,
  (e) => e.expression,
);

// Third source: compiled built-in domain packs (stats/ml-stats/
// bioinformatics-edam — see dictionary-packs-compiled.ts, generated by
// scripts/dictpacks/gen-compiled-packs.mjs). Deduped in AFTER the
// base+EXTRA merge, so base/EXTRA still win on a normalized-key
// collision — compiled pack terms only fill gaps.
const TERM_DICTIONARY: TermEntry[] = dedupeByKey(
  dedupeByKey(BASE_TERM_DICTIONARY, EXTRA_TERMS, (t) => t.term),
  COMPILED_PACK_TERMS,
  (t) => t.term,
);

/** Entry counts per pack id, for the Settings dialog (shows how many
 *  items a pack contributes before the user decides to disable it). */
export function packCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of EXPRESSIONS) {
    counts[entry.pack] = (counts[entry.pack] ?? 0) + 1;
  }
  for (const entry of TERM_DICTIONARY) {
    counts[entry.pack] = (counts[entry.pack] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------
// Enabled-packs registry — mirrors the glossary module's in-memory
// cache pattern (see history/glossary.ts): scanDictionary runs
// synchronously per transcript segment inside the live detection
// scheduler, so pack selection can't be threaded through as a prop
// on every call site. Instead SettingsDialog calls setEnabledPacks()
// once on save (and once on mount, to apply persisted settings after
// a fresh page load); scanDictionary consults this module-level value
// whenever its own optional `enabledPacks` param is omitted.
// ---------------------------------------------------------------

let registeredEnabledPacks: string[] | null = null;

export function setEnabledPacks(packs: string[] | null): void {
  registeredEnabledPacks = packs;
}

// ---------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------

/** Escape a string for safe inclusion inside a RegExp source. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a case-insensitive, whitespace/inflection-tolerant regex for
 *  a multi-word expression. The last word may carry a common suffix
 *  (s, es, ed, d, ing) so "circling back" matches "circle back". */
function buildExpressionRegex(phrase: string): RegExp {
  const words = phrase.trim().split(/\s+/);
  const last = words[words.length - 1];
  const head = words.slice(0, -1).map(escapeRe);
  const lastEscaped = escapeRe(last);
  const parts = [...head, `${lastEscaped}(?:s|es|ed|d|ing)?`];
  const source = `\\b${parts.join("\\s+")}\\b`;
  return new RegExp(source, "i");
}

/** Naive sentence splitter — keeps original substrings, splits on
 *  ./?/! followed by whitespace (or end of string). */
function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const raw = trimmed.split(/(?<=[.?!])\s+/);
  return raw.map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------
// Remote packs (#53 core extraction): this package only ever READS
// remotePacksRegistry.ts's in-memory cache — the actual fetch +
// idb-keyval load is inherently impure/browser-only and lives in
// apps/web's remotePacks.ts, which populates that shared registry.
// Before #53, this function used to lazily kick off the load itself
// on its first call (fire-and-forget); that trigger can no longer
// live here since this package cannot import apps/web's loader.
// Behavior is unchanged in practice: SettingsDialog is unconditionally
// mounted by page.tsx and already triggers the same load, unconditional
// of whether the dialog is open, on every app start (see that file's
// mount effect) — this was already the dominant trigger path (it fires
// on mount, before any user action could call scanDictionary), so
// dropping the redundant internal trigger here does not change
// observable behavior. See PLAN-v0.4 S1 report for the full reasoning.
// ---------------------------------------------------------------

/** Scan text against the built-in dictionaries. Word-boundary,
 *  case-insensitive, light inflection tolerance (e.g. "circling back").
 *  `enabledPacks` defaults to the value last set via setEnabledPacks()
 *  when omitted — see the registry comment above. Remote packs loaded
 *  via apps/web's remotePacks.ts (see the comment above) participate
 *  exactly like EXTRA_EXPRESSIONS/EXTRA_TERMS, filtered by their own
 *  pack id. */
export function scanDictionary(
  text: string,
  enabledPacks: string[] | null = registeredEnabledPacks,
): DetectResponse {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return { expressions: [], terms: [] };

  const expressions: DetectedExpression[] = [];
  const terms: DetectedTerm[] = [];

  const remotePacks = getLoadedRemotePacks();
  const remoteExpressions: ExpressionEntry[] = remotePacks.flatMap((p) => p.expressions);
  const remoteTerms: TermEntry[] = remotePacks.flatMap((p) => p.terms);

  for (const entry of [...EXPRESSIONS, ...remoteExpressions]) {
    if (!isPackEnabled(entry.pack, enabledPacks)) continue;
    // A personal-glossary entry on this exact surface owns the word —
    // the custom scan (store.addFinal) already emits it as source
    // "custom"; skip the dictionary's own version entirely.
    if (findEntryBySurface(entry.expression)) continue;
    const candidates = [entry.expression, ...(entry.variants ?? [])];
    const regexes = candidates.map(buildExpressionRegex);
    let matched = false;
    for (const sentence of sentences) {
      if (matched) break;
      for (const re of regexes) {
        const m = re.exec(sentence);
        if (m) {
          expressions.push({
            expression: entry.expression,
            category: entry.category,
            meaning: entry.meaning,
            chinese_explanation: entry.chinese_explanation,
            plain_english: entry.plain_english,
            tone: entry.tone,
            confidence: entry.confidence,
            source_sentence: sentence.trim(),
          });
          matched = true;
          break;
        }
      }
    }
  }

  for (const entry of [...TERM_DICTIONARY, ...remoteTerms]) {
    if (!isPackEnabled(entry.pack, enabledPacks)) continue;
    // A few compiled domain-pack terms are also everyday English words
    // ("mean", "precision", "epoch"...). Under the default all-on state
    // (enabledPacks === null) they'd fire on casual speech ("I mean...",
    // "pay attention"), so they stay opt-in: matched only once the user
    // has actively customized their pack selection (enabledPacks is an
    // explicit list). Non-common terms are unaffected.
    if (entry.commonWord && enabledPacks === null) continue;
    // Same personal-glossary shadowing as the expressions loop above.
    if (findEntryBySurface(entry.term)) continue;
    // All-caps acronyms match case-sensitively (\bARR\b); mixed-case
    // terms (e.g. "Series B", "headcount") match case-insensitively.
    const isAllCaps = /^[A-Z0-9&]+$/.test(entry.term);
    const re = new RegExp(`\\b${escapeRe(entry.term)}\\b`, isAllCaps ? "" : "i");
    if (re.test(text)) {
      terms.push({
        term: entry.term,
        type: entry.type,
        gloss_en: entry.gloss_en,
        gloss_zh: entry.gloss_zh,
      });
    }
  }

  return { expressions, terms };
}
