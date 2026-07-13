import { describe, expect, it } from "vitest";

import {
  LOCKED_FEATURES,
  LOCKED_SECTION_SUBTITLE,
  LOCKED_SECTION_TITLE,
} from "../lockedFeatures";
import type { LockedFeatureBadge } from "../lockedFeatures";

const VALID_BADGES: LockedFeatureBadge[] = ["完整版", "桌面版"];

describe("LOCKED_FEATURES registry", () => {
  it("every row has a non-empty id/title/desc/badge", () => {
    for (const feature of LOCKED_FEATURES) {
      expect(feature.id.trim().length).toBeGreaterThan(0);
      expect(feature.title.trim().length).toBeGreaterThan(0);
      expect(feature.desc.trim().length).toBeGreaterThan(0);
      expect(feature.badge.trim().length).toBeGreaterThan(0);
    }
  });

  it("has unique ids", () => {
    const ids = LOCKED_FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes the four expected ids", () => {
    const ids = LOCKED_FEATURES.map((f) => f.id);
    expect(ids).toEqual(["llm-detection", "tab-audio", "speaker-diarization", "review-cards"]);
  });

  it("only uses badge values from the LockedFeatureBadge union", () => {
    for (const feature of LOCKED_FEATURES) {
      expect(VALID_BADGES).toContain(feature.badge);
    }
  });

  // Verbatim zh copy from the S7 blueprint §7 "更多能力" block,
  // hardcoded independently of lockedFeatures.ts so an accidental edit
  // to the registry's copy fails HERE instead of drifting silently.
  it("locks the section title/subtitle copy verbatim", () => {
    expect(LOCKED_SECTION_TITLE).toBe("更多能力");
    expect(LOCKED_SECTION_SUBTITLE).toBe("下面这些在网页版和桌面版里可以用。");
  });

  it("locks each row's copy verbatim", () => {
    const byId = Object.fromEntries(LOCKED_FEATURES.map((f) => [f.id, f]));

    expect(byId["llm-detection"]).toMatchObject({
      title: "LLM 智能检测",
      desc: "用大模型结合上下文找出更多黑话，并给出贴合语境的解释；词典检测只能匹配已收录的词条。",
      badge: "完整版",
    });
    expect(byId["tab-audio"]).toMatchObject({
      title: "标签页音频",
      desc: "直接转录网页或会议标签页里的声音。Web Speech 只能听麦克风。",
      badge: "完整版",
    });
    expect(byId["speaker-diarization"]).toMatchObject({
      title: "说话人分离",
      desc: "把不同的发言人分开标注。",
      badge: "桌面版",
    });
    expect(byId["review-cards"]).toMatchObject({
      title: "复习卡片 · 间隔重复",
      desc: "把收藏的词条整理成复习卡片，按遗忘曲线安排复习。",
      badge: "完整版",
    });
  });
});
