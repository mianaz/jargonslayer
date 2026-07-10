// #62 progressive disclosure — SettingsDialog is one big draft-based
// form with 7+ <section> blocks; this module is the single source of
// truth for which sections/rows are simple-visible vs advanced-only,
// so the completeness test and SettingsDialog's JSX can never drift
// apart (SettingsDialog imports SETTINGS_UI_LEVELS directly, never a
// hand-copied literal). Mechanical, zero-logic-move refactor per the
// v0.3.0 plan §4 — this file only decides VISIBILITY, it never moves
// state handling.

import { DEFAULT_SETTINGS, type Settings } from "./types";

export type UiLevel = Settings["uiMode"];

// One entry per taggable section/row in SettingsDialog.tsx. "simple" =
// visible in both modes (advanced is simple ∪ advanced-only, never a
// disjoint view); "advanced" = only rendered when uiMode==="advanced".
// Keys are also used as the JSX `data-ui-level` attribute value on the
// matching element, so they double as light e2e/visual-QA hooks.
export const SETTINGS_UI_LEVELS = {
  // 转录引擎 — engine cards, mic, language, whisper URL. Whole section.
  engine: "simple",
  // 说话人分离 — whole section (needs the local sidecar either way).
  diarization: "advanced",
  // AI 检测 — mixed section, tagged row-by-row:
  aiDetectPreviewBanner: "simple", // preview-tier data-path disclosure
  aiDetectCredentials: "advanced", // CredentialFields (provider/baseUrl/apiKey/detectModel/summaryModel) + 测试连接
  aiDetectAutoDetect: "simple", // 实时检测
  aiDetectCore: "simple", // AI 检测 toggle (the "core" of the section)
  aiDetectConfidence: "advanced", // 置信度阈值
  aiDetectExplainLanguage: "simple", // 解释语言
  aiDetectBilingual: "simple", // 双语转录
  aiDetectProfile: "simple", // 背景画像 opt-in block (#48 step 3)
  aiDetectPacks: "advanced", // 词典主题包
  aiDetectPackSources: "advanced", // 词典源
  // 分任务模型（高级）— whole section (#56, BYOK-only).
  taskLlm: "advanced",
  // 数据与联动 — whole section (export/webhook/backup).
  dataIntegration: "advanced",
  // 订阅直连（实验性）— whole section; also gated by its own build
  // flag independently of uiMode (see SettingsDialog.tsx).
  subscriptionDirect: "advanced",
  // 显示 — theme + font sizes. Whole section.
  display: "simple",
} as const satisfies Record<string, UiLevel>;

export type SettingsSectionId = keyof typeof SETTINGS_UI_LEVELS;

/** A row/section is rendered when its own level is "simple" (shown in
 *  every mode) or the dialog's current level is "advanced" (shows
 *  everything). Advanced mode is always a superset of simple mode. */
export function isSectionVisible(level: UiLevel, itemLevel: UiLevel): boolean {
  return itemLevel === "simple" || level === "advanced";
}

/** Any `taskLlm` domain actually enabled (not just present — an entry
 *  with enabled:false inherits the primary config entirely, see
 *  TaskLlmConfig's own doc comment, so it isn't a real deviation). */
function hasEnabledTaskLlm(settings: Settings): boolean {
  const taskLlm = settings.taskLlm;
  if (!taskLlm) return false;
  return Object.values(taskLlm).some((cfg) => cfg?.enabled);
}

/** Pure, deterministic predicate: true when the user already relies on
 *  an advanced-only setting that deviates from DEFAULT_SETTINGS (BYOK
 *  key/provider/models, per-task overrides, webhook, autoExport,
 *  frontmatter, filtered dictionary packs, diarization, subscription-
 *  direct, custom confidence, …). SettingsDialog re-derives this on
 *  every mount and force-promotes uiMode:"simple" → "advanced" when
 *  true, so nothing a user configured is ever silently hidden from
 *  them. No stored flag, no migration — the same settings blob always
 *  produces the same answer (see v0.3.0 plan §4 point 5). */
export function shouldAutoPromoteToAdvanced(settings: Settings): boolean {
  return (
    settings.provider !== DEFAULT_SETTINGS.provider ||
    settings.baseUrl !== DEFAULT_SETTINGS.baseUrl ||
    settings.apiKey !== DEFAULT_SETTINGS.apiKey ||
    settings.detectModel !== DEFAULT_SETTINGS.detectModel ||
    settings.summaryModel !== DEFAULT_SETTINGS.summaryModel ||
    hasEnabledTaskLlm(settings) ||
    settings.minConfidence !== DEFAULT_SETTINGS.minConfidence ||
    settings.autoExport !== DEFAULT_SETTINGS.autoExport ||
    settings.webhookUrl !== DEFAULT_SETTINGS.webhookUrl ||
    settings.exportFrontmatter !== DEFAULT_SETTINGS.exportFrontmatter ||
    settings.enabledPacks !== null ||
    settings.hfToken !== DEFAULT_SETTINGS.hfToken ||
    settings.realtimeDiarize !== DEFAULT_SETTINGS.realtimeDiarize ||
    settings.subscriptionDirect !== DEFAULT_SETTINGS.subscriptionDirect ||
    settings.subscriptionProvider !== DEFAULT_SETTINGS.subscriptionProvider ||
    settings.agentUrl !== DEFAULT_SETTINGS.agentUrl ||
    settings.agentToken !== DEFAULT_SETTINGS.agentToken
  );
}
