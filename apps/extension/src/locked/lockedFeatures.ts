// Pure registry for the "更多能力" (more capabilities) section — the
// greyed/locked rows S7 Decision D introduces (see the blueprint
// docs/design-explorations/s7-extension-capture-blueprint.md, §2D and
// §7's verbatim copy block). Adapts apps/web's `本地版功能` idiom
// (PreviewLockedBadge.tsx, deployTier.ts's "show everything, no dead
// ends" posture) to Lite's own unlock ladder: a row unlocks in the web
// app (`完整版`) or the desktop app (`桌面版`) — never "local", since
// Lite itself IS the local/offline surface. Pure data, no DOM, no
// module state; src/sidepanel/renderLocked.ts is the only consumer
// that touches the DOM. Every string below is VERBATIM from blueprint
// §7 — lockedFeatures.test.ts hardcodes the same copy independently so
// an accidental edit here fails a test instead of drifting silently.

export type LockedFeatureBadge = "完整版" | "桌面版";

export interface LockedFeature {
  id: string;
  title: string;
  desc: string;
  badge: LockedFeatureBadge;
}

export const LOCKED_SECTION_TITLE = "更多能力";
export const LOCKED_SECTION_SUBTITLE = "下面这些在网页版和桌面版里可以用。";

export const LOCKED_FEATURES: LockedFeature[] = [
  {
    id: "llm-detection",
    title: "LLM 智能检测",
    desc: "用大模型结合上下文找出更多黑话，并给出贴合语境的解释；词典检测只能匹配已收录的词条。",
    badge: "完整版",
  },
  {
    id: "tab-audio",
    title: "标签页音频",
    desc: "直接转录网页或会议标签页里的声音。Web Speech 只能听麦克风。",
    badge: "完整版",
  },
  {
    id: "speaker-diarization",
    title: "说话人分离",
    desc: "把不同的发言人分开标注。",
    badge: "桌面版",
  },
  {
    id: "review-cards",
    title: "复习卡片 · 间隔重复",
    desc: "把收藏的词条整理成复习卡片，按遗忘曲线安排复习。",
    badge: "完整版",
  },
];
