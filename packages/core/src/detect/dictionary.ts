// Built-in offline dictionary of business idioms + terms.
// OWNER: worker B (fills DICTIONARY/TERM_DICTIONARY + scan logic).
// #54: this is the INSTANT FLOOR — scanned synchronously on every
// finalized segment (see scheduler.ts). The LLM layer (settings.
// aiDetect) only upgrades these hits in place; when it's off or
// failing, this dictionary is the whole detection story.

import type {
  CustomEntry,
  DetectedExpression,
  DetectedTerm,
  DetectResponse,
  ExpressionCategory,
  TermType,
} from "../types";
import { EXTRA_EXPRESSIONS, EXTRA_TERMS, type DictSense, type DomainTag } from "./dictionary-data";
import { COMPILED_PACK_TERMS } from "./dictionary-packs-compiled";
import { MODERN_USAGE_EXPRESSIONS, MODERN_USAGE_TERMS } from "./dictionary-data-modern";
import { FINANCE_CONSUMER_EXPRESSIONS, FINANCE_CONSUMER_TERMS } from "./dictionary-data-finance";
import { DAILY_IDIOM_EXPRESSIONS } from "./dictionary-data-idiom";
import { findEntryBySurface } from "../history/glossaryLookup";
import { isPackEnabled, isPackExplicitlyEnabled } from "./packs";
import { getLoadedRemotePacks, getRemotePacksGeneration } from "./remotePacksRegistry";

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
  // See DictTermEntry.variants — matched in scanDictionary's term loop
  // below alongside `term` itself.
  variants?: string[];
  type: TermType;
  gloss_en: string;
  gloss_zh: string;
  pack: string;
  // See DictTermEntry.commonWord — everyday-English headwords from the
  // compiled domain packs, kept opt-in in scanDictionary's term loop.
  commonWord?: boolean;
  // v0.6 multi-sense terms (T1) — see DictTermEntry.senses (dictionary-
  // data.ts) for the full doc; mirrors that field exactly, same as
  // every other field on this internal interface.
  senses?: DictSense[];
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
    variants: ["keep the ball rolling", "kept the ball rolling", "keeps the ball rolling"],
    category: "idiom",
    meaning: "start something, kick off an activity or process",
    chinese_explanation: "让事情动起来、继续推进下去",
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
    variants: ["moving the needle", "moved the needle"],
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
    variants: ["boiling the ocean", "boiled the ocean"],
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
    variants: ["touching base", "touched base"],
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
    variants: ["pinged me", "pinging me"],
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
    variants: ["dropped the ball", "dropping the ball"],
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
    variants: ["double-clicking on", "double-clicked on"],
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
    variants: ["putting a pin in it"],
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
    variants: ["parking this", "parked this"],
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
    variants: ["move the goalposts", "moved the goalposts"],
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
    variants: ["running it up the flagpole", "ran it up the flagpole"],
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
    variants: ["straw men"],
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
    variants: ["push the envelope", "pushed the envelope"],
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
    variants: ["throwing under the bus", "threw under the bus"],
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
    variants: ["evangelizing"],
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
    variants: ["baking in", "baked in"],
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
    variants: ["keeping me honest", "kept me honest"],
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
    variants: ["whiteboarding this"],
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
    variants: ["socializing this", "socialized this"],
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
    variants: ["taking a step back", "took a step back"],
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
    variants: ["peeling the onion"],
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
    variants: ["wearing many hats", "wore many hats"],
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
    variants: ["P and L"],
    type: "acronym",
    gloss_en: "Profit and Loss statement",
    gloss_zh: "损益表",
    pack: CORE_PACK,
  },
  {
    term: "headcount",
    variants: ["head count"],
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

// Core content added in v0.6 (dictionary-data-{modern,finance,idiom}.ts):
// field-agnostic vocabulary a person meets regardless of background —
// recently-coined usages (modern-usage), consumer money/benefits
// language (finance-consumer), and the conversational register around
// meetings (daily-idiom). Merged at the same precedence as EXTRA_*:
// base still wins a normalized-key collision, these only fill gaps.
const EXPRESSIONS: ExpressionEntry[] = dedupeByKey(
  dedupeByKey(BASE_EXPRESSIONS, EXTRA_EXPRESSIONS, (e) => e.expression),
  [...MODERN_USAGE_EXPRESSIONS, ...FINANCE_CONSUMER_EXPRESSIONS, ...DAILY_IDIOM_EXPRESSIONS],
  (e) => e.expression,
);

// v0.7.2 fix (dictionary audit, Bug B): dedupeByKey above collapses ANY
// normalized-key collision to a single winner, even across packs whose
// glosses mean genuinely different things ("SAM" = business-terms'
// "Serviceable Addressable Market" vs. bioinformatics-edam's "Sequence
// Alignment/Map format") — a user with only the OTHER pack enabled then
// gets no entry at all, since the surviving one is tagged with the
// pack that lost and isPackEnabled filters it out downstream. Terms
// only (the reported bug, and the only table where compiled domain
// packs can collide with hand-authored ones); EXPRESSIONS above is
// unaffected and keeps the simple dedupeByKey chain.
//
// mergeTermTables groups same-key entries across ALL tables (in the
// priority order given) and, per group:
//   - a single entry: kept as-is.
//   - byte-identical gloss_en+gloss_zh across entries (mere re-authoring
//     of the same fact in more than one pack, ~16 cases in the built-in
//     tables): collapsed to the first occurrence, same as before — no
//     duplicate card, and packCounts() stays accurate.
//   - genuinely different glosses, one of them CORE_PACK: collapsed to
//     the core entry only. CORE_PACK is unconditionally enabled
//     regardless of the user's pack selection (isPackEnabled), so a
//     non-core sibling can never win scanDictionary's own tie-break
//     below anyway — keeping it around would just inflate packCounts().
//   - genuinely different glosses, neither CORE_PACK (the actual bug —
//     SAM, regression): ALL survive as separate entries, each still
//     tagged with its own source pack, so scan-time isPackEnabled
//     filtering (below) can select per the user's actual pack choice.
//     Documented deterministic priority when more than one is enabled
//     at once: first-in-table-order wins (see scanDictionary's term
//     loop) — i.e. this function's own table-priority argument order.
function mergeTermTables(tables: TermEntry[][]): TermEntry[] {
  const groups = new Map<string, TermEntry[]>();
  const order: string[] = [];
  for (const item of tables.flat()) {
    const key = normalizeDictKey(item.term);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(item);
  }

  const merged: TermEntry[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const distinct: TermEntry[] = [];
    for (const item of group) {
      const isDuplicate = distinct.some(
        (d) => d.gloss_en === item.gloss_en && d.gloss_zh === item.gloss_zh,
      );
      if (!isDuplicate) distinct.push(item);
    }
    if (distinct.length === 1) {
      merged.push(distinct[0]);
      continue;
    }
    const core = distinct.find((d) => d.pack === CORE_PACK);
    merged.push(...(core ? [core] : distinct));
  }
  return merged;
}

// Third source: compiled built-in domain packs (stats/ml-stats/
// bioinformatics-edam — see dictionary-packs-compiled.ts, generated by
// scripts/dictpacks/gen-compiled-packs.mjs). Table priority order below
// (base > EXTRA > modern/finance > compiled) is also the tie-break
// order mergeTermTables documents above for a same-key collision that
// survives as more than one entry.
const TERM_DICTIONARY: TermEntry[] = mergeTermTables([
  BASE_TERM_DICTIONARY,
  EXTRA_TERMS,
  [...MODERN_USAGE_TERMS, ...FINANCE_CONSUMER_TERMS],
  COMPILED_PACK_TERMS,
]);

/** Entry counts per pack id, for the Settings dialog (shows how many
 *  items a pack contributes before the user decides to disable it).
 *  Counts INSTALLED remote packs too, from the same registry
 *  scanDictionary reads — without that, every installed pack renders
 *  "0 条" next to its toggle and the install looks like it silently
 *  failed. (Null-prototype so a pack id of "__proto__" can never make
 *  a lookup return Object.prototype; validateManifest also rejects
 *  such ids, but this map is read by UI that predates that gate.) */
export function packCounts(): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const entry of EXPRESSIONS) {
    counts[entry.pack] = (counts[entry.pack] ?? 0) + 1;
  }
  for (const entry of TERM_DICTIONARY) {
    counts[entry.pack] = (counts[entry.pack] ?? 0) + 1;
  }
  for (const pack of getLoadedRemotePacks()) {
    counts[pack.id] = (counts[pack.id] ?? 0) + pack.expressions.length + pack.terms.length;
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
// Sense context (v0.6 T2, multi-sense dictionary terms) — mirrors
// registeredEnabledPacks/setEnabledPacks immediately above: a
// module-level cache, PRECOMPUTED outside the scan loop and read
// synchronously inside it (selectSense, below scanDictionary's term
// loop). apps/web calls setSenseContext() whenever the inferred
// meeting domain(s), enabled packs, or the detected-term set change
// (see apps/web's senseContext.ts derivation + useMeeting.ts's wiring
// effect) — NEVER from inside scanDictionary itself, so a scan stays a
// cheap read of whatever was last computed rather than doing any of
// that derivation work per segment. `null` (the default, same posture
// as registeredEnabledPacks) means no context at all yet — keyless, or
// before the first inference has landed — and selectSense falls back
// to plain `prior` ordering in that case (dictionary detection must
// keep working with zero API key; this is the fallback that guarantees
// it for multi-sense entries too).
// ---------------------------------------------------------------

export interface SenseContextInput {
  domainWeights?: Partial<Record<DomainTag, number>>;
  cooccurrence?: Partial<Record<DomainTag, number>>;
}

let registeredSenseContext: SenseContextInput | null = null;

export function setSenseContext(input: SenseContextInput | null): void {
  registeredSenseContext = input;
}

// ---------------------------------------------------------------
// Personal-glossary shadow lookup (pre-merge review Finding 2 fix) —
// same injection-seam shape as registeredEnabledPacks immediately
// above: core cannot import apps/web's pack-aware history/glossary.ts,
// so apps/web REGISTERS a function into core instead, rather than core
// reaching out for one.
//
// The mechanism found: scanDictionary's two shadow-check call sites
// below used to call findEntryBySurface directly (a plain static
// import from THIS package's own history/glossaryLookup.ts) to decide
// whether a personal-glossary entry already owns a surface the built-in
// dictionary is about to emit. That lookup reads glossaryLookup.ts's
// RAW cache — every custom entry, regardless of which pack it's in or
// whether that pack is enabled — so a custom entry sitting in a
// DISABLED pack still shadowed the built-in dictionary's own version of
// that surface even though the disabled entry itself never fires
// (apps/web's glossary.ts scanCustomEntries is already pack-aware).
// Net effect: the surface vanished from detection entirely.
//
// Fix: `shadowLookup` below defaults to the raw findEntryBySurface (so
// a caller that never registers anything — a unit test, or this
// package used standalone — keeps today's literal behavior), but
// apps/web's glossary.ts overrides it at module load with an
// ENABLED-PACK-FILTERED lookup (findEnabledEntryBySurface, mirroring
// glossary.ts's own getCachedEntries() filtering) via
// setGlossaryShadowLookup. findEntryBySurface ITSELF is UNCHANGED and
// stays correct for its OTHER callers (SummaryPanel's "收藏本场卡片"
// dedup, LookupPopover's "already in glossary" check) — a disabled
// pack's entry is still a real duplicate for THOSE management/
// duplicate-prevention purposes, so they keep consuming the raw lookup
// directly rather than this registered one.
// ---------------------------------------------------------------

let shadowLookup: (surface: string) => CustomEntry | null = findEntryBySurface;

export function setGlossaryShadowLookup(
  fn: (surface: string) => CustomEntry | null,
): void {
  shadowLookup = fn;
}

/** Built-in + remote pack TERM entries (bare term string + pack id),
 *  filtered by isPackEnabled — the same universe scanDictionary's own
 *  term loop reads (minus personal-glossary shadowing, which doesn't
 *  apply here — this list feeds a BIAS hint, not the detector).
 *
 *  commonWord guard, PER-ENTRY semantics (v0.6 multi-sense-terms sprint,
 *  T6 fix round — NOT the earlier "v0.6 dictpacks" T1-T6 labels used
 *  elsewhere in this file for the unrelated remote-packs/variants sprint.
 *  This doc used to be misread as "null -> commonWord entries fire",
 *  which drove packs.ts's now-deleted materializeEnabledPacks into doing
 *  the OPPOSITE of its intent — see that file's git history; the FIX
 *  below closes a second, narrower misread the original fix left open —
 *  see isPackExplicitlyEnabled's own doc, packs.ts):
 *    enabledPacks === null (default, "everything on") -> commonWord
 *      entries are SUPPRESSED (the line below skips them).
 *    enabledPacks is an explicit list that NAMES this entry's own pack
 *      -> commonWord entries are treated like any other term and CAN
 *      fire.
 *    enabledPacks is an explicit list that does NOT name this entry's
 *      own pack -> still SUPPRESSED. In practice this third case is
 *      unreachable for a normal pack (isPackEnabled already filtered
 *      the entry out above) — it only matters for the "core" pack,
 *      which isPackEnabled always treats as enabled regardless of the
 *      list. Before this fix, a hypothetical commonWord entry tagged
 *      "core" fired under ANY explicit selection, even one that never
 *      named "core" at all; now it requires "core" itself to be named.
 *  Rationale: a bias hint toward an everyday English word ("mean",
 *  "precision"...) is at best inert and at worst nudges the decoder the
 *  wrong way on ordinary speech under the default all-on state. See
 *  scanDictionary's own term loop below for the matching (not just
 *  bias-hint) guard, same semantics.
 *
 *  Expressions are NOT included — recognizer bias earns its keep on
 *  exact jargon/acronym recall; idiom phrasing is already well-modeled
 *  by the decoder's own LM (v0.4.7 Lane B, docs/design-explorations/
 *  stt-provider-wiring-2026-07.md §3/D3 — apps/web's lexicon.ts is the
 *  one consumer). */
export function packTermsForBias(
  enabledPacks: string[] | null = registeredEnabledPacks,
): { term: string; pack: string }[] {
  const remotePacks = getLoadedRemotePacks();
  const remoteTerms: TermEntry[] = remotePacks.flatMap((p) => p.terms);
  const result: { term: string; pack: string }[] = [];
  for (const entry of [...TERM_DICTIONARY, ...remoteTerms]) {
    if (!isPackEnabled(entry.pack, enabledPacks)) continue;
    if (entry.commonWord && !isPackExplicitlyEnabled(entry.pack, enabledPacks)) continue;
    result.push({ term: entry.term, pack: entry.pack });
  }
  return result;
}

// ---------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------

/** Escape a string for safe inclusion inside a RegExp source. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** S11 fix (v0.6 round-2 review): `\b` only makes sense adjacent to a
 *  word character — it asserts "exactly one of the two neighboring
 *  characters is a word character", so placed right next to a NON-word
 *  edge character (e.g. the trailing "%" in "100%") it can never
 *  actually match once that symbol is itself followed by whitespace,
 *  punctuation, or the end of the string — the overwhelmingly common
 *  case for how such a token appears in real text (both neighbors end
 *  up non-word). An expression edge like that needs no `\b` at all: the
 *  "don't match a substring of a longer word" concern `\b` exists for
 *  (e.g. "cat" inside "category") only applies when the edge itself IS
 *  a word character. */
function boundaryFor(edgeChar: string): string {
  return /\w/.test(edgeChar) ? "\\b" : "";
}

/** Build a case-insensitive, whitespace/inflection-tolerant regex for
 *  a multi-word expression. The last word may carry a common suffix
 *  (s, es, ed, d, ing) so "circling back" matches "circle back". */
function buildExpressionRegex(phrase: string): RegExp {
  const words = phrase.trim().split(/\s+/);
  const first = words[0];
  const last = words[words.length - 1];
  const head = words.slice(0, -1).map(escapeRe);
  const lastEscaped = escapeRe(last);
  const parts = [...head, `${lastEscaped}(?:s|es|ed|d|ing)?`];
  const leadingBoundary = boundaryFor(first[0]);
  const trailingBoundary = boundaryFor(last[last.length - 1]);
  const source = `${leadingBoundary}${parts.join("\\s+")}${trailingBoundary}`;
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
// Compiled-regex cache (M4, adversarial review v0.6 dictpacks fix
// round): scanDictionary used to build a fresh RegExp for every
// entry+variant on EVERY call (it runs synchronously per finalized
// transcript segment) — fine for the small built-in tables, but the
// new remote-pack size caps sanction up to ~100k entries across 20
// installed packs. Keyed by the raw candidate STRING, not the owning
// entry: buildExpressionRegex/the term-candidate regex below are both
// pure functions of that string alone, so two different entries that
// happen to share a surface safely share one compiled RegExp, and a
// cache miss just self-heals (a pack installed mid-session is
// matchable immediately — no invalidation needed for CORRECTNESS).
// Neither regex uses the "g"/"y" flags, so reusing a cached instance
// across many exec()/test() calls is safe (no shared lastIndex state).
//
// Cleared wholesale whenever remotePacksRegistry's generation counter
// changes (a pack install/remove/update) — this bounds cache SIZE over
// a long session with many install/remove cycles (a removed pack's
// surfaces would otherwise sit cached forever); it is not required for
// correctness, since a stale-but-present entry for a surface that no
// longer belongs to any loaded pack is simply never looked up again.
// ---------------------------------------------------------------

const expressionRegexCache = new Map<string, RegExp>();
const termRegexCache = new Map<string, RegExp>();
let cachedRemotePacksGeneration = -1;

function refreshRegexCachesIfStale(): void {
  const generation = getRemotePacksGeneration();
  if (generation === cachedRemotePacksGeneration) return;
  expressionRegexCache.clear();
  termRegexCache.clear();
  cachedRemotePacksGeneration = generation;
}

function getCachedExpressionRegex(phrase: string): RegExp {
  let re = expressionRegexCache.get(phrase);
  if (!re) {
    re = buildExpressionRegex(phrase);
    expressionRegexCache.set(phrase, re);
  }
  return re;
}

// v0.7.2 fix (dictionary audit, Bug A): same S11 problem buildExpressionRegex
// already solved above — a headword ending in ')' (e.g. "mode (statistics)",
// "stochastic gradient descent (SGD)") could never satisfy an unconditional
// trailing \b, since both neighbors of that ')' end up non-word once it's
// followed by whitespace/punctuation/end-of-string, the overwhelmingly
// common case in real text. Reuses boundaryFor() rather than re-deriving
// the same rule, so terms/variants/user-dictionary entries/future remote
// packs all benefit identically.
function getCachedTermRegex(candidate: string): RegExp {
  let re = termRegexCache.get(candidate);
  if (!re) {
    const isAllCaps = /^[A-Z0-9&]+$/.test(candidate);
    const leadingBoundary = boundaryFor(candidate[0]);
    const trailingBoundary = boundaryFor(candidate[candidate.length - 1]);
    re = new RegExp(
      `${leadingBoundary}${escapeRe(candidate)}${trailingBoundary}`,
      isAllCaps ? "" : "i",
    );
    termRegexCache.set(candidate, re);
  }
  return re;
}

// ---------------------------------------------------------------
// Sense selection (v0.6 T3) — chooses which DictSense a multi-sense
// term entry surfaces as, from whatever setSenseContext last cached
// (see that function's own doc above). Called once per MATCHED entry
// inside scanDictionary's term loop below — O(senses.length), capped
// at 6 by T1's wire validation (validateTerms, apps/web's
// remotePacks.ts), so this stays well inside the ~ms per-segment scan
// budget the scheduler requires (scheduler.ts calls scanDictionary
// synchronously on every finalized segment).
// ---------------------------------------------------------------

// Exported (MEDIUM-4 fix, v0.6 round-2 review): dedupe.ts's own
// dictionary-to-dictionary term merge reuses this SAME margin to gate
// an in-place sense swap on an existing card, rather than a second,
// independently-tunable copy — see that file's own mergeTerms doc.
export const AMBIGUOUS_MARGIN = 0.15;

interface RankedSense {
  senseId: string;
  gloss_en: string;
  gloss_zh: string;
  domain: DomainTag;
  score: number;
}

interface SenseSelection {
  chosen: DictSense;
  ranked: RankedSense[];
  ambiguous: boolean;
}

/** score = 0.45*domainWeights[domain] + 0.25*cooccurrence[domain] +
 *  0.15*(entry's own pack explicitly enabled ? 1 : 0) + 0.15*prior —
 *  missing weights count as 0. The pack-bonus term is entry-level (all
 *  of one entry's senses share the same `pack`), so it never changes
 *  which sense WINS within that entry, but it is still part of each
 *  sense's own displayed `score` — implemented exactly as specified.
 *
 *  With NO sense context at all (registeredSenseContext === null —
 *  keyless, or before the first inference lands), falls back to plain
 *  `prior` ordering instead of the weighted formula.
 *
 *  `ambiguous`: true when the top two scores are within
 *  AMBIGUOUS_MARGIN of each other, OR — only on the scored path, since
 *  there is no domainWeights to consult on the fallback path, AND only
 *  when domainWeights actually carries at least one real entry — the
 *  chosen sense's own domain carries zero weight in the current
 *  context.
 *
 *  Fix (LOW, v0.6 round-2 review): that second trigger used to fire
 *  whenever `ctx.domainWeights` was EMPTY (`{}`, not `undefined`) too
 *  — which in practice is every meeting's own starting state (before
 *  any domain is inferred) — because "this sense's own domain has zero
 *  weight" is trivially true of every domain when NOTHING has non-zero
 *  weight. That's not a real ambiguity signal ("we have context and it
 *  disagrees with this pick"), it's "we have no context at all yet",
 *  which made `ambiguous` effectively always true in-app (this app
 *  ALWAYS calls setSenseContext with a real, if often still-empty,
 *  object — see useMeeting.ts's own wiring — so the `ctx === null`
 *  fallback path right above is unreachable there in practice; the
 *  scored-but-empty path was the one that actually mattered). Gating
 *  on a non-empty domainWeights map restores the intended meaning:
 *  ambiguous only from a genuine domain mismatch, never from simply not
 *  knowing the domain yet. */
function selectSense(
  entry: { pack: string; senses: DictSense[] },
  enabledPacks: string[] | null,
): SenseSelection {
  const ctx = registeredSenseContext;
  const packBonus = isPackExplicitlyEnabled(entry.pack, enabledPacks) ? 1 : 0;

  const scored = entry.senses.map((sense) => ({
    sense,
    score: ctx
      ? 0.45 * (ctx.domainWeights?.[sense.domain] ?? 0) +
        0.25 * (ctx.cooccurrence?.[sense.domain] ?? 0) +
        0.15 * packBonus +
        0.15 * sense.prior
      : sense.prior,
  }));
  scored.sort((a, b) => b.score - a.score);

  const top1 = scored[0];
  const top2 = scored[1];
  const marginAmbiguous = top2 !== undefined && top1.score - top2.score < AMBIGUOUS_MARGIN;
  const domainMismatchAmbiguous =
    ctx !== null &&
    Object.keys(ctx.domainWeights ?? {}).length > 0 &&
    (ctx.domainWeights?.[top1.sense.domain] ?? 0) === 0;
  const ambiguous = marginAmbiguous || domainMismatchAmbiguous;

  return {
    chosen: top1.sense,
    ranked: scored.map(({ sense, score }) => ({
      senseId: sense.senseId,
      gloss_en: sense.gloss_en,
      gloss_zh: sense.gloss_zh,
      domain: sense.domain,
      score,
    })),
    ambiguous,
  };
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
 *  pack id. A matched term entry that declares `senses` (v0.6 T3) is
 *  ranked against whatever setSenseContext last cached (see selectSense
 *  below); cardinality never changes — still one DetectedTerm per
 *  matched entry either way. */
export function scanDictionary(
  text: string,
  enabledPacks: string[] | null = registeredEnabledPacks,
): DetectResponse {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return { expressions: [], terms: [] };

  const expressions: DetectedExpression[] = [];
  // S8 fix (v0.6 round-2 review): each hit carries its own match SPAN
  // now (matchStart/matchEnd, the candidate's actual position in
  // `text`) alongside the DetectedTerm — dropSubsumedTerms below needs
  // it to tell a genuinely SEPARATE, non-overlapping occurrence of a
  // shorter surface (e.g. a standalone "vesting" elsewhere in the same
  // segment) apart from one that's truly subsumed inside a longer
  // match (e.g. "vesting" inside "vesting cliff", same position) — see
  // that function's own doc comment. Stripped back down to plain
  // DetectedTerm[] at this function's own return statement.
  const termHits: { term: DetectedTerm; matchStart: number; matchEnd: number }[] = [];

  refreshRegexCachesIfStale();
  const remotePacks = getLoadedRemotePacks();
  const remoteExpressions: ExpressionEntry[] = remotePacks.flatMap((p) => p.expressions);
  const remoteTerms: TermEntry[] = remotePacks.flatMap((p) => p.terms);

  for (const entry of [...EXPRESSIONS, ...remoteExpressions]) {
    if (!isPackEnabled(entry.pack, enabledPacks)) continue;
    // A personal-glossary entry on this exact surface owns the word —
    // the custom scan (store.addFinal) already emits it as source
    // "custom"; skip the dictionary's own version entirely. Enabled-
    // pack-filtered (Finding 2 fix) — see shadowLookup's own doc above.
    if (shadowLookup(entry.expression)) continue;
    const candidates = [entry.expression, ...(entry.variants ?? [])];
    const regexes = candidates.map(getCachedExpressionRegex);
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
            matched_surface: m[0],
          });
          matched = true;
          break;
        }
      }
    }
  }

  // v0.7.2 fix (Bug B): TERM_DICTIONARY can now carry more than one
  // entry for the same normalized term key (mergeTermTables above kept
  // BOTH senses of a genuine cross-pack collision like "SAM"/
  // "regression" instead of silently deleting one). Without this guard,
  // a user with both colliding packs enabled would get TWO cards for
  // one surface at the same position — dropSubsumedTerms deliberately
  // does not collapse equal-span hits from different entries (see its
  // own doc). First entry to match wins, deterministically.
  //
  // Priority fix (adjudicated review, F1): iterate remoteTerms BEFORE
  // TERM_DICTIONARY. A user-installed remote pack is explicit intent —
  // it should win any key collision with a built-in entry, not lose to
  // it silently. So the deterministic order is: remote packs first (in
  // registry-load order, i.e. remoteTerms' own flattened order), THEN
  // TERM_DICTIONARY's own table-priority order (documented on
  // mergeTermTables above) for anything a remote pack didn't already
  // claim. A user who wants the built-in back can disable the
  // colliding remote pack.
  const matchedTermKeys = new Set<string>();
  for (const entry of [...remoteTerms, ...TERM_DICTIONARY]) {
    if (!isPackEnabled(entry.pack, enabledPacks)) continue;
    if (matchedTermKeys.has(normalizeDictKey(entry.term))) continue;
    // commonWord guard, PER-ENTRY semantics (v0.6 multi-sense-terms
    // sprint, T6 fix round — see packTermsForBias's own doc above for
    // the full explanation/history, including the exact case this fix
    // closes):
    //   enabledPacks === null (default, "everything on") -> SUPPRESSED.
    //   enabledPacks explicit AND names this entry's own pack -> FIRES.
    //   enabledPacks explicit but does NOT name this entry's own pack ->
    //     SUPPRESSED (previously fired for the "core" pack specifically,
    //     since isPackEnabled above always lets "core" through).
    // A few compiled domain-pack terms are also everyday English words
    // ("mean", "precision", "epoch"...) that would otherwise fire on
    // casual speech ("I mean...", "pay attention") under the default
    // all-on state. Non-common terms are unaffected.
    if (entry.commonWord && !isPackExplicitlyEnabled(entry.pack, enabledPacks)) continue;
    // Same personal-glossary shadowing as the expressions loop above
    // (enabled-pack-filtered — Finding 2 fix).
    if (shadowLookup(entry.term)) continue;
    // T2: also try the entry's `variants` alongside its own headword
    // (mirrors the expressions loop's candidates array above) — but
    // terms keep their OWN existing semantics per surface: no
    // inflection tolerance, and each CANDIDATE's case-sensitivity is
    // judged independently (all-caps acronyms match case-sensitively,
    // e.g. \bARR\b; anything else, e.g. "Series B"/"CAC", matches
    // case-insensitively — a mixed-case headword can still have an
    // all-caps variant or vice versa). First candidate to hit wins; the
    // emitted card always reports the entry's own headword
    // (entry.term), never the variant that actually matched.
    const candidates = [entry.term, ...(entry.variants ?? [])];
    // S8 fix: finds the actual match (position, not just a boolean) for
    // whichever candidate hits first — getCachedTermRegex carries no
    // g/y flag (see its own doc comment), so .exec() is safe here
    // without mutating any shared lastIndex state. Same "first candidate
    // to hit wins" precedent the emitted headword already follows.
    let match: RegExpExecArray | null = null;
    for (const candidate of candidates) {
      match = getCachedTermRegex(candidate).exec(text);
      if (match) break;
    }
    if (!match) continue;
    matchedTermKeys.add(normalizeDictKey(entry.term));
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;

    // v0.6 T3 (multi-sense terms): cardinality is UNCHANGED — still
    // exactly one DetectedTerm per matched entry — but when the entry
    // declares `senses`, the chosen sense's own gloss/type is flattened
    // into the same term/gloss_en/gloss_zh/type fields every consumer
    // already reads, plus the new optional senseId/senses/ambiguous
    // fields below. An entry without `senses` (or an empty array) is
    // untouched — byte-identical to today, pinned by test.
    if (entry.senses && entry.senses.length > 0) {
      const { chosen, ranked, ambiguous } = selectSense(
        { pack: entry.pack, senses: entry.senses },
        enabledPacks,
      );
      termHits.push({
        term: {
          term: entry.term,
          type: chosen.type ?? entry.type,
          gloss_en: chosen.gloss_en,
          gloss_zh: chosen.gloss_zh,
          senseId: chosen.senseId,
          senses: ranked,
          ambiguous,
        },
        matchStart,
        matchEnd,
      });
    } else {
      termHits.push({
        term: {
          term: entry.term,
          type: entry.type,
          gloss_en: entry.gloss_en,
          gloss_zh: entry.gloss_zh,
        },
        matchStart,
        matchEnd,
      });
    }
  }

  return { expressions, terms: dropSubsumedTerms(termHits).map((h) => h.term) };
}

/** Span-shaped hit dropSubsumedTerms below consumes — matchStart/matchEnd
 *  are the candidate's actual character positions in the scanned `text`
 *  (see scanDictionary's own termHits construction). Generic over `T`
 *  purely so dropSubsumedTermsForTests can exercise this with plain
 *  fixtures instead of a real DetectedTerm. */
interface SpannedHit<T> {
  term: T;
  matchStart: number;
  matchEnd: number;
}

/** Longest-match-wins across overlapping term surfaces. "vesting cliff"
 *  contains "vesting" as a word-bounded substring, so both entries match
 *  the same phrase and the user gets two cards for one thing — the
 *  shorter one always the less informative. Drops a hit whose match SPAN
 *  is fully contained within another, STRICTLY LONGER hit's own match
 *  span in the SAME scan.
 *
 *  S8 fix (v0.6 round-2 review): compares actual match POSITIONS now,
 *  not the matched surface strings against each other — the old
 *  string-containment check couldn't tell a genuinely subsumed
 *  occurrence ("vesting" inside "vesting cliff", same position) apart
 *  from a completely separate, non-overlapping occurrence of the
 *  shorter surface elsewhere in the same segment (e.g. a standalone
 *  "vesting" mentioned earlier, plus a later "vesting cliff") — the old
 *  code dropped the legitimate standalone occurrence too, since it only
 *  ever compared LABELS. Equal-length spans never subsume each other
 *  (mirrors the old code's own `<=` tie rule) — two different entries
 *  matching the exact same span both survive.
 *
 *  Also drops the old per-comparison `new RegExp` entirely (pure integer
 *  span comparison instead) — the previous `hits.length > 64` guard
 *  existed specifically to bound that regex-allocation cost and, as a
 *  side effect, silently DISABLED filtering outright above 64 hits
 *  (the opposite of what a safety guard should do). With comparisons
 *  this cheap, O(n²) is trivial at the realistic scale here (hits
 *  matched within ONE finalized segment — always a handful in
 *  practice), so no upper bound is needed at all. */
export function dropSubsumedTermsForTests<T>(hits: SpannedHit<T>[]): SpannedHit<T>[] {
  return dropSubsumedTerms(hits);
}

function dropSubsumedTerms<T>(hits: SpannedHit<T>[]): SpannedHit<T>[] {
  if (hits.length < 2) return hits;
  return hits.filter((hit, i) => {
    const hitLen = hit.matchEnd - hit.matchStart;
    for (let j = 0; j < hits.length; j++) {
      if (i === j) continue;
      const other = hits[j];
      if (other.matchEnd - other.matchStart <= hitLen) continue; // only a STRICTLY longer span can subsume
      if (hit.matchStart >= other.matchStart && hit.matchEnd <= other.matchEnd) return false;
    }
    return true;
  });
}
