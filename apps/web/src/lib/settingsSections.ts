// #62 progressive disclosure — SettingsDialog is one big draft-based
// form with 7+ <section> blocks; this module is the single source of
// truth for which sections/rows are simple-visible vs advanced-only,
// so the completeness test and SettingsDialog's JSX can never drift
// apart (SettingsDialog imports SETTINGS_UI_LEVELS directly, never a
// hand-copied literal). Mechanical, zero-logic-move refactor per the
// v0.3.0 plan §4 — this file only decides VISIBILITY, it never moves
// state handling.

import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import { hasAnyProviderApiKey } from "./llm/providerKeys";

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
  // v0.6 field-fix (item 3): 实时检测/AI 检测 merged into ONE 检测模式
  // segmented control (SettingsDialog.tsx) — aiDetectAutoDetect retired,
  // aiDetectCore now tags that single merged row.
  aiDetectCore: "simple", // 检测模式 segmented control (the "core" of the section)
  aiDetectConfidence: "advanced", // 置信度阈值
  aiDetectExplainLanguage: "simple", // 解释语言
  aiDetectBilingual: "simple", // 双语转录
  aiDetectTranslateEngine: "simple", // 翻译引擎 (v0.5 F6: LLM vs 系统翻译)
  aiDetectProfile: "simple", // 背景画像 opt-in block (#48 step 3)
  aiDetectPacks: "simple", // 词典主题包 (v0.6: promoted from advanced — installable dict packs are mainstream now)
  aiDetectPackCatalog: "simple", // 词典库 (v0.6 T6: catalog browse, simple alongside aiDetectPacks/aiDetectPackSources)
  aiDetectPackSources: "simple", // 词典源 (v0.6: promoted alongside aiDetectPacks)
  // 密钥 — dedicated credential hub (ft6). Simple so every configured
  // key is visible at a glance without flipping 高级; storage/resolve
  // paths are unchanged — this is presentation only.
  keys: "simple",
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
/** True when any per-task LLM override carries its own apiKey — even
 *  with enabled:false the secret is real stored material the Keys
 *  section surfaces; promoting still reveals the advanced 分任务模型
 *  editors that own provider/model alongside that key. */
function hasTaskLlmApiKey(settings: Settings): boolean {
  const taskLlm = settings.taskLlm;
  if (!taskLlm) return false;
  return Object.values(taskLlm).some((cfg) => !!cfg?.apiKey);
}

export function shouldAutoPromoteToAdvanced(settings: Settings): boolean {
  // Provider / HF / agent keys remain promote triggers because their
  // *engine* editors (AI 检测 credentials, 说话人分离, 订阅直连) are
  // still advanced-only. Transcription/translate keys (sonioxKey,
  // deepgramKey, elevenLabsKey, deeplKey, youdao*) live under simple
  // engine/translate rows AND the simple「密钥」hub, so they do not
  // need to force advanced on their own.
  return (
    settings.provider !== DEFAULT_SETTINGS.provider ||
    settings.baseUrl !== DEFAULT_SETTINGS.baseUrl ||
    hasAnyProviderApiKey(settings) ||
    settings.detectModel !== DEFAULT_SETTINGS.detectModel ||
    settings.summaryModel !== DEFAULT_SETTINGS.summaryModel ||
    hasEnabledTaskLlm(settings) ||
    hasTaskLlmApiKey(settings) ||
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
