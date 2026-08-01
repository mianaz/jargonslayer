"use client";

// Settings modal: transcription engine + AI detection configuration.
// Edits a local draft; only committed to the store on 保存.

import { useEffect, useRef, useState } from "react";
import { CaretDown, CaretRight, Eye, EyeSlash, X } from "@phosphor-icons/react";
import { modeForPersistedEngine, useApp, type ModePlatform } from "@/lib/store";
import { listAudioInputs } from "@/lib/audio/devices";
import { testConnection } from "@/lib/llm/client";
import { resolveTaskCreds, type ResolvedTaskCreds } from "@/lib/llm/taskConfig";
import { useLlmTelemetry } from "@/lib/llm/telemetry";
import { sanitizeSecretValue } from "@/lib/settings/sanitizeSecret";
import {
  credsMatch,
  deriveKeyStatus,
  domainUsesOwnKey,
  llmKeyEvidence,
  primaryTelemetryDomains,
  TASK_DOMAIN_TELEMETRY,
  type KeyStatus,
} from "@/lib/settings/keyStatus";
import { packCounts, setEnabledPacks } from "@jargonslayer/core/detect/dictionary";
import { getAllPacks, type DictPack } from "@jargonslayer/core/detect/packs";
import {
  addPackFromManifest,
  addPackSource,
  checkUpdates,
  classifyPackOrigin,
  compareSemver,
  listPackSources,
  loadRemotePacksIntoRegistry,
  MAX_PACK_BYTES,
  removePackSource,
  type RemotePackSource,
} from "@/lib/detect/remotePacks";
import { toRawGithubUrl } from "@/lib/detect/githubUrl";
import { fetchDictCatalog, type CatalogPackEntry } from "@/lib/detect/dictCatalog";
import {
  buildFullBackup,
  chooseExportFolder,
  clearExportFolder,
  getExportFolderName,
  previewBackup,
  restoreFullBackup,
} from "@/lib/history/autoExport";
import { downloadFile } from "@/lib/history/export";
import { fetchSidecarHealth } from "@/lib/stt/upload";
import { probeSidecar, type SidecarProbeResult } from "@/lib/stt/sidecarHealth";
import { RETENTION_COPY, resolveEngineRetentionClass } from "@/lib/stt/engineOptions";
import {
  appAudioLockReason,
  isAppAudioFloorLocked,
  probeAudiocapCaps,
  type AudiocapCapabilities,
} from "@/lib/desktop/audiocapCaps";
import {
  isOsSpeechFloorLocked,
  osSpeechLockReason,
  preinstallOsSpeech,
  useOsSpeechCaps,
} from "@/lib/desktop/osspeechCaps";
import type {
  EnglishLevel,
  ExplainLanguage,
  LlmProvider,
  LlmTaskDomain,
  STTEngineKind,
  Settings,
  TaskLlmConfig,
} from "@jargonslayer/core/types";
import { withBase } from "@/lib/basePath";
import { IOS_ENGINE_KINDS } from "@/lib/stt/engineCapabilities";
import { isValidProxyUrl, normalizeProxyUrl } from "@/lib/proxyUrl";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { IS_IOS, IS_TAURI } from "@/lib/platform/ios";
import { openExternal } from "@/lib/platform/openExternal";
import { getInvoke } from "@/lib/desktop/tauriApi";
import { initDesktop, type DesktopLogSource } from "@/lib/desktop/bootstrap";
import { trackInstallDiar, trackSwitchModel } from "@/lib/desktop/jobsBridge";
import { useTasks } from "@/lib/tasks/registry";
import { connectOpenRouterDesktop } from "@/lib/oauth/openrouterDesktop";
import { describeOAuthFailure } from "@/components/desktop/onboardingSettings";
import { isEngineControlBusy } from "@/components/Header";
import { agentHealth, type AgentHealth } from "@/lib/agent/localHost";
import {
  isSectionVisible,
  SETTINGS_UI_LEVELS,
  shouldAutoPromoteToAdvanced,
} from "@/lib/settingsSections";
import { BUILTIN_THEMES } from "@/lib/theme/themes";
import { activateTheme, resetToDefaultTheme } from "@/lib/theme/apply";
import {
  CUSTOM_THEME_CAP,
  CUSTOM_THEME_ID_PREFIX,
  mintCustomThemeId,
  resolveThemeById,
} from "@/lib/theme/resolve";
import { parseTheme, type ThemeDefinition } from "@/lib/theme/schema";
import {
  CUSTOM_FONT_PREFIX,
  MONO_FONT_PRESETS,
  UI_FONT_PRESETS,
  sanitizeFontFamily,
} from "@/lib/theme/fonts";
import { BIT_COSTUME_LABELS } from "@/lib/bitCostumes";
import {
  PREVIEW_LIVE_MODELS,
  PREVIEW_SUMMARY_MODELS,
  PREVIEW_TIER,
  SONIOX_PREVIEW_LANE,
} from "@/lib/deployTier";
import { clearDiag, getDiagEntries, type DiagEntry } from "@/lib/diag/log";
import { buildFullDiagnosticReport, copyDiagnosticReport } from "@/lib/diag/report";
import PreviewLockedBadge from "@/components/PreviewLockedBadge";
import ToggleSwitch from "@/components/ToggleSwitch";
import TranslationEngineRow from "@/components/settings/TranslationEngineRow";
import AnkiConnectSection from "@/components/settings/AnkiConnectSection";
import UsagePanel from "@/components/settings/UsagePanel";
import ThemeEditor from "@/components/settings/ThemeEditor";
import { langPairFromSettings } from "@/lib/translate/providers";
import ModelPicker from "@/components/desktop/ModelPicker";
import { MODEL_CATALOG } from "@/lib/desktop/modelCatalog";
import CredentialFields, {
  KeyStatusChip,
  SecretKeyRow,
  presetIdFor,
  type ProviderPreset,
  type ProviderPresetId,
} from "@/components/CredentialFields";
import {
  keysCatalogFieldId,
  PROVIDER_KEY_CATALOG,
  SERVICE_KEY_CATALOG,
  TASK_KEY_CATALOG,
} from "@/lib/settings/keysCatalog";
import AiStatusPanel from "@/components/AiStatusPanel";
// v0.6 field-fix (item 3): the merged 检测模式 segmented control reuses
// StatusLine's own off/dictionary/llm label strings verbatim — single
// source of truth, never a second hand-copied set.
import { DETECT_MODE_LABEL } from "@/components/StatusLine";
import {
  buildAuthUrl,
  codeChallengeS256,
  generateCodeVerifier,
  OAUTH_STATE_STORAGE_KEY,
  OAUTH_VERIFIER_STORAGE_KEY,
} from "@/lib/oauth/openrouterPkce";
import {
  providerApiKeyNameFor,
  providerApiKeyPatch,
  providerHostFor,
  resolveProviderApiKey,
} from "@/lib/llm/providerKeys";

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

// Sol #4 fix (BYOK preview sprint, 2026-07-21): the tabaudio-cloud
// card's own SONIOX_PREVIEW_LANE branch below (module scope, no draft
// in reach) only describes a Soniox session — hoisted so the render
// step (ENGINE_CARDS.map, far below) can swap this SAME string back in
// once the draft's own 转录服务商 selection resolves to Deepgram, where
// neither the trial promise nor a Soniox key are relevant. One source
// of truth, so the copy can never drift between the two spots (same
// rationale SonioxKeyRestoredNotice below already documents for itself).
const TABAUDIO_CLOUD_NEUTRAL_HINT =
  "需要 Soniox 或 Deepgram Key、浏览器分享标签页并勾选共享音频；选择 Deepgram 时仅支持英文";

// Real capture engines only — demo is a scripted preview, not a peer
// engine (see Header.tsx's 演示 button, the app's single demo entry
// point). ITEM 2 fix (fix round, Sol#4 + Lane C flag): the retention
// badge below each card is now derived per-render from
// resolveEngineRetentionClass/RETENTION_COPY (lib/stt/engineOptions.ts)
// instead of a hand-rolled `posture` field on this array — the SAME
// tri-state source Header/StatusLine already read, so this dialog can
// never disagree with what those surfaces show for the live engine.
const ALL_ENGINE_CARDS: {
  value: Exclude<STTEngineKind, "demo">;
  label: string;
  hint: string;
  disabled?: boolean;
  // #61 preview tier: needs the local sidecar — greyed there (same
  // lock as lib/stt/engineOptions.ts's ENGINE_OPTIONS.sidecarOnly;
  // without it a preview user could still save engine:"whisper" from
  // THIS dialog and dead-end on ws://localhost until the next reload's
  // applyTierDefaults coercion).
  sidecarOnly?: boolean;
  // v0.4 S4 (blueprint decision E): a BYOK cloud engine that hasn't
  // cleared the zh-en benchmark gate yet — same preview lock as
  // sidecarOnly (preview never collects a visitor's own credentials),
  // AND doubles as this card's "实验" tag trigger below (every byokOnly
  // engine is, by definition, still opt-in experimental — see soniox's
  // own hint copy).
  byokOnly?: boolean;
}[] = [
  {
    value: "webspeech",
    label: "浏览器识别",
    // The Web Speech capture chain (echo cancellation etc.) is fixed
    // by the browser and tuned for near-field voice — speaker-played
    // meeting audio comes through weak, and that is not fixable from
    // our side (the local engines are: whisperSocket.ts acquires its
    // own stream with raw-capture constraints).
    hint: "由浏览器厂商云端识别（音频会离开设备）；扬声器外放拾音较弱，线上会议建议标签页音频或本地 Whisper",
  },
  {
    value: "whisper",
    label: "本地 Whisper",
    hint: "麦克风收音，本地 Whisper 模型识别，音频不出设备",
    sidecarOnly: true,
  },
  // D7 desktop tabaudio replacement (docs/design-explorations/
  // s9-app-audio-tap-blueprint.md): tabaudio (getDisplayMedia) can only
  // ever fail inside Tauri's WKWebView — there is no tab-share picker
  // to launch there — so desktop shows 系统/App 音频 (a CoreAudio process
  // tap, S9) in its slot instead; the web build keeps 标签页音频 exactly
  // as before (D7 pinned decision: browser behavior stays
  // byte-identical). D3/D4: captures what plays out of THIS Mac —
  // including other apps/sounds, not just the call's other side — never
  // the user's own microphone. Unlike tabaudio's static `disabled`
  // above, appaudio's disabled/title is computed dynamically below
  // (audiocapCaps, the audiocap_capabilities() probe) — whether it's
  // selectable depends on THIS machine's macOS version (D6's "shown-but-
  // disabled below floor", never hidden), not a fixed product decision.
  IS_DESKTOP
    ? {
        value: "appaudio",
        label: "系统/App 音频",
        hint: "捕获 Mac 系统/App 播放的声音（对方语音，不含你的麦克风），同样由本地 Whisper 识别",
        sidecarOnly: true,
      }
    : {
        value: "tabaudio",
        label: "标签页音频",
        hint: "在本机转录标签页音频",
        disabled: true,
        sidecarOnly: true,
      },
  // v0.5 Wave-1 Feature 4 (tab audio without the sidecar, cloud path —
  // docs/design-explorations/v05-wave1-blueprint.md §1 Feature 4 + §5
  // A4): web-only, same `!IS_DESKTOP` guard lib/stt/engineOptions.ts's
  // own ENGINE_OPTIONS entry uses (desktop already has sidecar+appaudio
  // in the slot above; store.ts's applyPlatformEngineDefaults coerces a
  // persisted value away there — the IS_IOS filter on ENGINE_CARDS below
  // drops it on iOS too, so no separate guard is needed for that). BYOK,
  // same preview lock/实验 tag as Soniox/Deepgram above — the actual
  // provider (Settings.tabAudioCloudProvider, default Soniox) picks
  // which key this card needs; see the hint block below the Deepgram key
  // field (this card has no key input of its own).
  ...(!IS_DESKTOP
    ? [
        {
          value: "tabaudio-cloud" as const,
          label: "标签页音频·云端",
          // Soniox preview lane (SONIOX_PREVIEW_LANE): same trial-copy
          // swap as the Soniox card's own hint above, for when this
          // card's resolved provider genuinely IS Soniox. Sol #4 fix
          // (BYOK preview sprint, 2026-07-21): tabAudioCloud.ts no
          // longer force-routes to Soniox on this lane (D3 — a Deepgram
          // selection actually runs Deepgram now), so this module-scope
          // ternary (no draft in reach here) is only the DEFAULT; the
          // render step below (ENGINE_CARDS.map) swaps back to
          // TABAUDIO_CLOUD_NEUTRAL_HINT whenever the draft's own 转录
          // 服务商 resolves to Deepgram instead.
          hint: SONIOX_PREVIEW_LANE
            ? "预览体验：无需密钥，每人每天最多 3 段、单次最长约 10 分钟，总额度先到先得；标签页音频经 Soniox 云端转写（不留存）"
            : TABAUDIO_CLOUD_NEUTRAL_HINT,
          byokOnly: true,
        },
      ]
    : []),
  // S11 (v0.4.3, docs/design-explorations/s11-osspeech-blueprint.md) —
  // Zero-Install 系统识别 (SpeechAnalyzer): NOT sidecarOnly (needs no
  // local Whisper sidecar at all — that's the whole point), so it's
  // structurally unaffected by the #61 preview-tier lock. Label matches
  // lib/stt/engineOptions.ts's own ENGINE_OPTIONS entry verbatim
  // (Miana-veto #2) — the two surfaces must never say this engine's name
  // differently. Floor-gated below like appaudio's own macOS-14.4 floor
  // (isOsSpeechFloorLocked/osSpeechLockReason, macOS 26 via
  // os_speech_capabilities) — shown-but-disabled below the floor, never
  // hidden. S13 (docs/design-explorations/s13-ios-blueprint.md, §6):
  // IS_TAURI, not IS_DESKTOP — this engine also exists on iOS (same
  // invoke names, D2), where it's the ONLY card ENGINE_CARDS keeps (see
  // that const below).
  ...(IS_TAURI
    ? [
        {
          value: "osspeech" as const,
          // v0.6 field-fix (item 2): trimmed "· 开箱即用" — see
          // engineCapabilities.ts's own osspeech entry, the canonical
          // copy of this label every surface pins verbatim.
          label: "系统识别",
          // S13 lead fix (Lane D report flag #1): the card is shared by
          // both Tauri shells — the OS-version tail must name the right
          // platform (IS_IOS is a build-time const, so this folds).
          hint: `无需下载模型、无需 Python，音频不离开本机；不支持说话人分离，需要 ${IS_IOS ? "iOS" : "macOS"} 26 或更高版本`,
        },
      ]
    : []),
  {
    value: "soniox",
    label: "Soniox 云端识别",
    // Honest per the blueprint's benchmark gate (decision E) — BYOK,
    // opt-in, NOT claimed to beat local Whisper until Miana's zh-en
    // clip benchmark clears it. Soniox preview lane (hosted trial,
    // SONIOX_PREVIEW_LANE, deployTier.ts): the trial needs no BYOK key
    // at all, so the benchmark-gate hint is replaced entirely rather
    // than appended to — mirrors this same array's own IS_DESKTOP/
    // IS_TAURI module-scope ternaries above (appaudio/tabaudio,
    // osspeech) for reading a build-time const directly in a card
    // literal. byokOnly stays true unconditionally (still the correct
    // description of the mechanism) — the render block below is what
    // actually carves the preview LOCK out for this one card.
    hint: SONIOX_PREVIEW_LANE
      ? "预览体验：无需密钥，每人每天最多 3 段、单次最长约 10 分钟，总额度先到先得；音频经 Soniox 云端转写（不留存）"
      : "BYOK 按量计费、音频经 Soniox 云端、中英混说场景的候选引擎（尚未通过本地对照测试）",
    byokOnly: true,
  },
  // v0.4.7 (docs/design-explorations/stt-provider-wiring-2026-07.md,
  // Lane D) — second cloud engine, same BYOK/byokOnly posture as soniox
  // above. Honest about scope: Nova-3's own `language=multi` mode has no
  // Chinese (doc §9 Lane D wire spec), so this is single-language
  // English-only in v0.4.7 — soniox stays the zh-en code-switching
  // engine; the hint must not market this one for zh-en.
  {
    value: "deepgram",
    label: "Deepgram 云端识别",
    hint: "BYOK 按量计费、音频经 Deepgram 云端、仅英文（中英混说请用 Soniox）",
    byokOnly: true,
  },
  // v0.6 round 2 — third BYOK cloud engine (ElevenLabs Scribe realtime).
  // The 云端·不留存/云端·可能留存 badge under this card is derived
  // automatically from engineCapabilities.ts's own "elevenlabs" row
  // (ITEM 2 fix precedent, this array's own header comment) — that row
  // is honestly "cloud-stored" here (可能留存), NOT "cloud-transient"
  // like Soniox/Deepgram: ElevenLabs' own zero-retention opt-out is
  // enterprise-tier-gated (verified against their docs — see
  // elevenLabsTransport.ts's header), so this card's own hint spells
  // that out explicitly rather than letting the badge alone carry it.
  {
    value: "elevenlabs",
    label: "ElevenLabs 云端识别",
    hint: "BYOK 按量计费、音频经 ElevenLabs 云端（Scribe）识别、默认留存供 History 查看（企业版账户可关闭留存）；按单一语言识别，中英混说请用 Soniox",
    byokOnly: true,
  },
];

// S10 field-fix #1: desktop drops the webspeech card entirely —
// WKWebView has no SpeechRecognition API, so it has never once worked
// there (unlike tabaudio, which at least had a picker-shaped reason to
// exist pre-S9 before D7's appaudio swap above). Mirrors lib/stt/
// engineOptions.ts's own ENGINE_OPTIONS filter (same IS_DESKTOP
// condition, same drop) rather than importing that module directly —
// this card grid's richer per-card `hint` copy keeps the two arrays
// from cleanly sharing one data shape (see that module's own header
// comment), so the semantics are mirrored here instead of forked.
// S13 (§6 Sol F5, BLOCKER) pinned iOS to the osspeech card only; the
// iOS-cloud round (post-v0.6.0, 手机版显然应该允许云端) widens it to the
// SAME osspeech+BYOK-cloud-trio matrix — read from IOS_ENGINE_KINDS
// (engineCapabilities.ts), the single source all four iOS engine-matrix
// surfaces share (Opus F3 fix round; the Set is typed so a renamed kind
// fails tsc instead of silently shrinking the card list). The
// per-engine key inputs below are `draft.engine === …`-conditional, so
// they follow automatically.
const IOS_ENGINE_CARD_VALUES = new Set<STTEngineKind>(IOS_ENGINE_KINDS);
const ENGINE_CARDS = IS_IOS
  ? ALL_ENGINE_CARDS.filter((c) => IOS_ENGINE_CARD_VALUES.has(c.value))
  : IS_DESKTOP
    ? ALL_ENGINE_CARDS.filter((c) => c.value !== "webspeech")
    : ALL_ENGINE_CARDS;

// Platform shape for modeForPersistedEngine — same construction
// StatusLine's MODE_PLATFORM and TutorialOverlay's ITEM 4 fix use for
// their own paired {engine, mode} writes.
const MODE_PLATFORM: ModePlatform = IS_IOS ? "ios" : IS_DESKTOP ? "desktop" : "web";

// S11 osspeech blueprint §Q5's 预下载模型 button (see its own JSX below):
// exported (tech-debt ledger #4, 2026-07-17) so SettingsDialog.desktop.
// test.tsx imports these instead of re-pinning its own copy of the zh
// busy/done/idle labels.
export const OSSPEECH_PREINSTALL_IDLE_LABEL = "预下载模型";
export const OSSPEECH_PREINSTALL_BUSY_LABEL = "下载中…";
export const OSSPEECH_PREINSTALL_DONE_LABEL = "已下载";

const LANGUAGE_OPTIONS = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "en-AU", label: "English (Australia)" },
  { value: "en-IN", label: "English (India)" },
];

// Field-test fix (v0.4.4): the DeepSeek OpenRouter slug leads each
// list — it's the new DEFAULT_DETECT_MODEL/DEFAULT_SUMMARIZE_MODEL
// (tasks/detect.ts, tasks/summarize.ts), so it's what an OpenRouter
// user actually gets absent a typed override. The bare Anthropic ids
// stay listed too (datalists are suggestions, not an allowlist) —
// still correct for an Anthropic-direct user, who gets them pre-filled
// via the "anthropic" PROVIDER_PRESETS entry below instead.
const DETECT_MODEL_OPTIONS = [
  "deepseek/deepseek-v4-flash",
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "deepseek-chat",
  "qwen-plus",
  "gpt-5.6-luna",
];

const SUMMARY_MODEL_OPTIONS = [
  "deepseek/deepseek-v4-pro",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "deepseek-chat",
  "gpt-5.6-sol",
];

// #56: translate has no PRIMARY top-level model field of its own — R1
// field fix (v0.4.4): when inherited (no enabled taskLlm.translate
// override), resolveTaskCreds now folds in the top-level 检测模型
// (settings.detectModel) rather than sending no body model at all, so
// an unconfigured translate call always rides whatever the user
// already set for detection instead of silently falling to the
// server/task-wide (DeepSeek-slug) DEFAULT_TRANSLATE_MODEL fallback.
// This list — unlike DETECT_MODEL_OPTIONS/SUMMARY_MODEL_OPTIONS above
// — only exists for the 分任务模型（高级） translate block's own
// datalist seed (the per-domain OVERRIDE, still independent of 检测模型).
const TRANSLATE_MODEL_OPTIONS = [
  "deepseek/deepseek-v4-flash",
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "deepseek-chat",
];

const EXPLAIN_LANGUAGE_OPTIONS: { value: ExplainLanguage; label: string }[] = [
  { value: "zh", label: "中文（默认）" },
  { value: "en", label: "English" },
];

// 背景画像 (#48 step 3): englishLevel select options.
const ENGLISH_LEVEL_OPTIONS: { value: EnglishLevel; label: string }[] = [
  { value: "basic", label: "初级" },
  { value: "intermediate", label: "中级" },
  { value: "advanced", label: "高级" },
];

// 显示设置 (v0.2.1): 全局字号 4 档 + 转录字号/行距各 3 档。
const FONT_SIZE_OPTIONS: { value: Settings["fontSize"]; label: string }[] = [
  { value: "sm", label: "小" },
  { value: "md", label: "标准" },
  { value: "lg", label: "大" },
  { value: "xl", label: "特大" },
];

const TRANSCRIPT_SCALE_OPTIONS: { value: Settings["transcriptScale"]; label: string }[] = [
  { value: "follow", label: "跟随" },
  { value: "lg", label: "大" },
  { value: "xl", label: "特大" },
];

const TRANSCRIPT_LEADING_OPTIONS: { value: Settings["transcriptLeading"]; label: string }[] = [
  { value: "compact", label: "紧凑" },
  { value: "standard", label: "标准" },
  { value: "relaxed", label: "宽松" },
];

// #62 progressive disclosure: dialog-header segmented control.
const UI_MODE_OPTIONS: { value: Settings["uiMode"]; label: string }[] = [
  { value: "simple", label: "简单" },
  { value: "advanced", label: "高级" },
];

// v0.6 field-fix (item 3, iOS TestFlight report): a user looking for
// "检测模式" in settings found two separate 实时检测/AI 检测 toggles
// instead — merged into one three-way segmented control here, same
// FONT_SIZE_OPTIONS-style button row. Labels borrowed verbatim from
// StatusLine's own DETECT_MODE_LABEL (see the import above) rather than
// a second hand-copied set of strings — except `llm`, which appends its
// own "（Beta）" qualifier LOCALLY here (TestFlight batch fix: 词典模式 is
// the new default, AI 模式 stays an opt-in beta): StatusLine's bottom-bar
// chip and Header's badge stay on the bare DETECT_MODE_LABEL.llm string,
// no room there for the qualifier.
const DETECT_MODE_OPTIONS: { value: "off" | "dictionary" | "llm"; label: string }[] = [
  { value: "off", label: DETECT_MODE_LABEL.off },
  { value: "dictionary", label: DETECT_MODE_LABEL.dictionary },
  { value: "llm", label: `${DETECT_MODE_LABEL.llm}（Beta）` },
];

// v0.6 field-fix (item 1, iOS TestFlight report): "too many small
// dictionaries" — a UI-only regroup of the 16 flat toggleable built-in
// packs into 3 collapsible buckets. Never a data/pack-id merge: every
// group here still keys off the SAME individual pack ids packs.ts
// defines (licensing + commonWord gating + domain tags stay per-id).
// Remote/imported packs (p.remote) are NOT part of this map — they stay
// outside the groups, rendered exactly as before. A future built-in
// pack id landing without an entry here falls into 其他 instead of
// silently vanishing.
const BUILTIN_PACK_GROUP_ORDER = ["通用表达", "职场与会议", "专业领域", "其他"] as const;
type BuiltinPackGroup = (typeof BUILTIN_PACK_GROUP_ORDER)[number];
const BUILTIN_PACK_GROUP: Record<string, Exclude<BuiltinPackGroup, "其他">> = {
  "daily-idiom": "通用表达",
  "modern-usage": "通用表达",
  chitchat: "通用表达",
  softening: "通用表达",
  "finance-consumer": "通用表达",
  "meeting-flow": "职场与会议",
  project: "职场与会议",
  feedback: "职场与会议",
  sales: "职场与会议",
  "business-terms": "职场与会议",
  academic: "职场与会议",
  "tech-terms": "专业领域",
  "ml-stats": "专业领域",
  stats: "专业领域",
  "bioinformatics-edam": "专业领域",
  "pharma-biotech": "专业领域",
};

// Settings redesign (owner ask 2026-07-11: "side navbar for each
// category"): one nav entry per existing <section> — id per category,
// label copied verbatim from that section's own <SectionHeading>. Order
// matches the dialog's previous top-to-bottom section order exactly.
export type SettingsCategoryId =
  | "engine"
  | "diarization"
  | "aiDetect"
  | "keys"
  | "taskLlm"
  | "dataIntegration"
  | "subscriptionDirect"
  | "display";

// Exported (tech-debt ledger #4, 2026-07-17): SettingsDialog.test.tsx
// derives its expected nav-label arrays from this instead of re-pinning
// its own copy of the zh labels, so a reword here can't silently desync
// from a test asserting the old string.
export const SETTINGS_CATEGORIES: { id: SettingsCategoryId; label: string }[] = [
  { id: "engine", label: "转录引擎" },
  { id: "diarization", label: "说话人分离" },
  { id: "aiDetect", label: "AI 检测" },
  { id: "keys", label: "密钥" },
  { id: "taskLlm", label: "分任务模型（高级）" },
  { id: "dataIntegration", label: "数据与联动" },
  { id: "subscriptionDirect", label: "订阅直连（实验性）" },
  { id: "display", label: "显示" },
];

// S13 iOS mobile-UX round (Part B #2) — iOS's two-level root list groups
// visibleCategories into 常用/高级 instead of the desktop nav-rail's flat
// list. diarization never appears in either group (already excluded from
// categoryVisible on iOS below, Part A #1); subscriptionDirect is also
// excluded because it requires a computer-side localhost agent. Data
// integration stays available, but below 高级 rather than in 常用.
// 「密钥」stays in 常用 (simple-tagged) so every credential is reachable
// without opening 高级 — matching the dedicated Keys hub's purpose.
//
// #58 fix round FIX 5 (Opus MEDIUM): 常用 has no list of its own below —
// it's everything in visibleCategories NOT tagged advanced here. A twin
// hardcoded 常用 array used to exist alongside this one; a category added
// to SETTINGS_CATEGORIES later without a matching entry in EITHER array
// would have silently vanished from the iOS root list. Exclusion can't
// have that failure mode: an untagged category defaults into 常用.
const IOS_ADVANCED_CATEGORY_IDS: SettingsCategoryId[] = [
  "taskLlm",
  "dataIntegration",
  "subscriptionDirect",
];

// "AI 检测" is settingsSections.ts's one MIXED section (tagged row-by-
// row, not one whole-section key) — every row-level key that lives
// under it, used only to decide whether the CATEGORY itself belongs in
// the nav at the current uiMode (visible whenever at least one of its
// own rows would be; individual rows keep their own existing
// isSectionVisible calls below, untouched).
const AI_DETECT_ROW_LEVELS = [
  SETTINGS_UI_LEVELS.aiDetectPreviewBanner,
  SETTINGS_UI_LEVELS.aiDetectCredentials,
  SETTINGS_UI_LEVELS.aiDetectCore,
  SETTINGS_UI_LEVELS.aiDetectConfidence,
  SETTINGS_UI_LEVELS.aiDetectExplainLanguage,
  SETTINGS_UI_LEVELS.aiDetectBilingual,
  SETTINGS_UI_LEVELS.aiDetectProfile,
  SETTINGS_UI_LEVELS.aiDetectPacks,
  SETTINGS_UI_LEVELS.aiDetectPackSources,
];

// Primary-only preset extras: applied to draft.detectModel/
// summaryModel on selection (handleSelectPreset below) — CredentialFields
// itself (shared with the #56 domain blocks) knows nothing about these,
// since a domain override has no "suggested defaults" behavior (design
// Q5 lists no such affordance for domain blocks).
interface SettingsProviderPreset extends ProviderPreset {
  suggestedModels?: { detectModel: string; summaryModel?: string };
  /** Shown as a hint near the model inputs, not force-applied. */
  modelHint?: string;
}

const PROVIDER_PRESETS: SettingsProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic 官方 (api.anthropic.com)",
    provider: "anthropic",
    baseUrl: "",
    // Field-test fix (v0.4.4): DEFAULT_SETTINGS.detectModel/summaryModel
    // switched to the DeepSeek OpenRouter slugs (product decision) —
    // an Anthropic-direct user picking THIS preset still gets today's
    // Claude models pre-filled, via this suggestedModels entry rather
    // than the (now DeepSeek-flavored) global default.
    suggestedModels: { detectModel: "claude-haiku-4-5", summaryModel: "claude-sonnet-5" },
  },
  {
    // Tech-debt ledger item 4 (2026-07-17). suggestedModels ids verified
    // against OpenAI's own current model listing rather than guessed:
    // the requested "gpt-5-mini"/"gpt-5.4" pair doesn't match — OpenAI's
    // live lineup is the GPT-5.6 family (Sol = frontier/flagship, Terra
    // = balanced, Luna = budget/cost-sensitive), no "mini" tier exists
    // today. Mapped onto this preset's own cheap-tier/flagship-tier
    // roles: gpt-5.6-luna (budget) for 检测模型, gpt-5.6-sol (frontier)
    // for 会议报告模型 — same "force-applied is fine, it's just a suggested
    // pre-fill the user can retype" posture the anthropic/deepseek/
    // openrouter presets above already take.
    id: "openai",
    label: "OpenAI (https://api.openai.com/v1)",
    provider: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    suggestedModels: { detectModel: "gpt-5.6-luna", summaryModel: "gpt-5.6-sol" },
  },
  {
    id: "deepseek",
    label: "DeepSeek (https://api.deepseek.com)",
    provider: "openai-compat",
    baseUrl: "https://api.deepseek.com",
    suggestedModels: { detectModel: "deepseek-chat", summaryModel: "deepseek-chat" },
  },
  {
    id: "qwen",
    label: "通义千问 (https://dashscope.aliyuncs.com/compatible-mode/v1)",
    provider: "openai-compat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    suggestedModels: { detectModel: "qwen-plus" },
  },
  {
    id: "openrouter",
    label: "OpenRouter (https://openrouter.ai/api/v1)",
    provider: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    // Field-test fix (v0.4.4): picking this preset by hand (as opposed
    // to the "Connect with OpenRouter" OAuth button, which does its
    // own conditional remap — see openrouterModelDefaults.ts) must
    // ALSO land on real OpenRouter slugs, not whatever bare id happened
    // to be in the field before — a bare Anthropic id here 400s on the
    // very first detect/summary call.
    suggestedModels: { detectModel: "deepseek/deepseek-v4-flash", summaryModel: "deepseek/deepseek-v4-pro" },
  },
  {
    // Poe's OpenAI-compatible endpoint lets a Poe subscription drive
    // any compatible client (officially sanctioned for non-coding
    // apps, unlike the vendor coding plans). Key from poe.com/api/keys;
    // models are Poe bot names (Claude-Sonnet-4.6, GPT-5.4, …).
    id: "poe",
    label: "Poe 订阅 (https://api.poe.com/v1)",
    provider: "openai-compat",
    baseUrl: "https://api.poe.com/v1",
    modelHint: "Claude-Sonnet-4.6",
  },
  {
    id: "ollama",
    label: "Ollama 本地 (http://localhost:11434/v1)",
    provider: "openai-compat",
    baseUrl: "http://localhost:11434/v1",
    modelHint: "qwen3:8b",
  },
  {
    id: "custom",
    label: "自定义…",
    provider: "openai-compat",
    baseUrl: "",
  },
];

// Preview tier (#61): the detectModel/summaryModel <select>s only ever
// offer PREVIEW_LIVE_MODELS/PREVIEW_SUMMARY_MODELS — a persisted value
// from BEFORE the build switched to preview (or from a full-tier
// export) that isn't in the relevant list would otherwise render as a
// blank/mismatched <select> and could get silently submitted on 保存.
// Coerced to the list's first entry at its ORIGINAL call site — the
// draft seed (dialog open, below) — never overwriting a value the user
// picks from the select afterward. BYOK preview sprint (2026-07-21):
// skipped entirely when the seeded draft already carries a primary
// apiKey — that user's model field is about to render as full-tier
// free-text (see the primary CredentialFields' own previewOptions doc
// below), and their persisted custom model string must survive the
// dialog opening rather than getting silently clobbered to a preview-
// allowlist id it was never validated against. A keyless open keeps
// coercing exactly as today (still bound to the locked <select>).
//
// Sol #3 fix, same sprint: ALSO called at the 保存 boundary now
// (handleSave below) — the open-time pass alone missed two in-dialog
// paths that leave the OUTGOING draft keyless with an off-allowlist
// model the locked <select> never actually offered: clearing the
// primary Key field after opening keyed (the model field was free-text
// until that edit), and a preset pick (handleSelectPreset) writing
// detectModel/summaryModel straight into state regardless of what the
// model <select> shows. Reusing this one function at both points keeps
// the allowlist check itself defined exactly once.
function coercePreviewModels(draft: Settings): Settings {
  if (!PREVIEW_TIER || resolveProviderApiKey(draft)) return draft;
  const patch: Partial<Settings> = {};
  if (!(PREVIEW_LIVE_MODELS as readonly string[]).includes(draft.detectModel)) {
    patch.detectModel = PREVIEW_LIVE_MODELS[0];
  }
  if (!(PREVIEW_SUMMARY_MODELS as readonly string[]).includes(draft.summaryModel)) {
    patch.summaryModel = PREVIEW_SUMMARY_MODELS[0];
  }
  return Object.keys(patch).length > 0 ? { ...draft, ...patch } : draft;
}

// #58 fix round FIX 2 (Sol LOW): JSON.stringify with object keys sorted
// recursively (arrays keep their own order — only object KEYS are
// unordered in JS, so only those need normalizing) before comparing.
// Used ONLY by the iOS draftDirty check below — plain JSON.stringify(a)
// !== JSON.stringify(b) reads two deeply-equal objects as different the
// moment either one's keys were built in a different order (e.g.
// TaskDomainBlock reconstructing a taskLlm override object), producing
// a phantom "unsaved edit" the sticky save bar then wrongly shows.
function stableStringify(value: unknown): string {
  const sortKeys = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input && typeof input === "object") {
      return Object.keys(input as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = sortKeys((input as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return input;
  };
  return JSON.stringify(sortKeys(value));
}

// F5 fix (v0.5.1 appearance sprint, GPT-5.6 Sol adversarial review): the
// 自定义 font text inputs below store the RAW typed text (`custom:<raw>`)
// straight into the draft — sanitizeFontFamily previously only ever ran
// at CSS-application time (store.ts's applyFontVar/fonts.ts's own
// resolveFontStack), so a quoted/`;`-laced/overlong payload round-
// tripped through Settings/export completely unsanitized while only
// ever RENDERING the sanitized form, and an empty `custom:` persisted
// forever instead of visually falling back. Normalized here, at the one
// persistence boundary every save must cross (handleSave below), rather
// than on every keystroke — the raw text field itself keeps echoing
// exactly what was typed, never fighting the user mid-edit (same
// "text input is honest, sanitizing happens at the boundary" posture as
// ThemeEditor's own rawInputs/draftTokens split).
function sanitizeDraftFontValue(value: string): string {
  if (!value.startsWith(CUSTOM_FONT_PREFIX)) return value;
  const sanitized = sanitizeFontFamily(value.slice(CUSTOM_FONT_PREFIX.length));
  return sanitized ? `${CUSTOM_FONT_PREFIX}${sanitized}` : "default";
}

// FIX 2 (field-debugging postmortem, v0.5.1 fieldtest B): baseUrl
// hygiene at the SAME kind of save boundary as sanitizeDraftFontValue
// above — users paste base URLs from docs, sometimes through a Chinese
// IME that silently swaps ASCII punctuation for full-width lookalikes
// (：／．～) or leaves a stray trailing space/newline. Cleans exactly
// that; never guesses at a path (no scheme insertion, no /v1
// appending, no rewriting beyond these normalizations). The single
// trailing-slash strip mirrors providerCore.ts's own
// buildOpenAiCompatRequestInit (`baseUrl.replace(/\/$/, "")`) — kept
// as a separate copy rather than an import since that module is
// isomorphic/provider-side and has no reason to be pulled into this
// dialog for one regex.
//
// F5 (Sol hunt-note g, fix round): this used to strip ALL whitespace,
// including INTERNAL whitespace — `https://host/my endpoint/v1` was
// silently mangled to `.../myendpoint/v1` with no error, no trace of
// what happened. Only leading/trailing whitespace is a paste artifact
// worth auto-cleaning; internal whitespace means the pasted value
// itself is malformed and the user needs to see that (isValidBaseUrl
// below now explicitly rejects it pre-parse instead).
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  const asciiPunctuation = trimmed
    .replace(/：/g, ":")
    .replace(/／/g, "/")
    .replace(/．/g, ".")
    .replace(/～/g, "~");
  return asciiPunctuation.replace(/\/$/, "");
}

/** Empty stays allowed — the existing "缺少 Base URL" runtime handling
 *  already covers a blank baseUrl downstream (providerCore.ts's
 *  callJsonOpenAiCompat) — only a NON-empty value must actually parse
 *  as a URL.
 *
 *  F3 (Sol MEDIUM #15, fix round): bare `new URL()` success was too
 *  permissive for "is this usable as a provider base" — it happily
 *  accepted `file:`/`mailto:`/`ftp:` schemes, and a query string/
 *  fragment/userinfo all silently rode along into
 *  buildOpenAiCompatRequestInit's string-concatenated `/chat/
 *  completions` path (a query-bearing base puts the real path INSIDE
 *  the query string). Now requires http:/https: and rejects any
 *  search/hash/username/password component.
 *
 *  F5 (Sol hunt-note g, fix round): `new URL()` doesn't throw on
 *  internal whitespace — it silently percent-encodes a space (or
 *  drops a tab/newline outright) — so normalizeBaseUrl above no longer
 *  strips it for the user; this explicitly rejects it pre-parse so a
 *  malformed paste surfaces the existing error toast instead of
 *  silently mangling the URL. */
function isValidBaseUrl(value: string): boolean {
  if (!value) return true;
  if (/\s/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.search || url.hash || url.username || url.password) return false;
  return true;
}

/** v0.6 T3: normalize + validate a pack-install URL — shared by every
 *  entry point that hands a URL to addPackSource (词典源's manual
 *  paste, and 词典库's own 安装/更新 button below). First silently
 *  rewrites a pasted GitHub blob URL to its raw.githubusercontent.com
 *  equivalent (toRawGithubUrl, lib/detect/githubUrl.ts — users paste
 *  blob URLs constantly), THEN requires https (addPackSource itself
 *  has no protocol opinion — this is the one gate, T3(c)). Returns the
 *  resolved URL to install, or null — the caller shows its own zh
 *  message via packInstallError. */
function resolvePackInstallUrl(rawUrl: string): string | null {
  const url = toRawGithubUrl(rawUrl.trim());
  try {
    if (new URL(url).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return url;
}

/** Round-2 dict-pack auto-update — relative "last checked" label for
 *  the 自动更新词典 row below (词典源 section); pure so it needs no
 *  render-triggering state of its own. `now` defaults to Date.now(),
 *  overridable only by a test. Bucketed 刚刚 / N 分钟前 / N 小时前 / N
 *  天前; `checkedAt` undefined (auto-update never ran) renders as a
 *  bare "尚未检查" — the one case with no "上次检查：" prefix. */
function formatLastPackCheck(checkedAt: number | undefined, now: number = Date.now()): string {
  if (checkedAt === undefined) return "尚未检查";
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000);
  if (minutes < 1) return "上次检查：刚刚";
  if (minutes < 60) return `上次检查：${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `上次检查：${hours} 小时前`;
  return `上次检查：${Math.floor(hours / 24)} 天前`;
}

// S12b fix round FB7-settings (§F) — pyannote (speaker diarization)
// lives only in the shared BASE venv; parakeet rides a fully separate,
// airtight-isolated MLX venv (§C R1) that never has pyannote installed,
// so 实时说话人分离/说话人分离扩展 are structurally dead for it, not just
// unconfigured. Reuses modelCatalog.ts's own `mlxOnly` discriminator
// (the same one ModelPicker.tsx/DesktopWizard.tsx already gate on)
// rather than a hardcoded id string, so a future second mlx-family model
// is covered automatically. `null`/an id absent from the catalog (a
// manually-dropped-in model, provisionMachine.ts's own escape hatch)
// reads as NOT mlx-only — never false-positively blocks diarization for
// a model this function doesn't recognize.
function isMlxOnlyModel(model: string | null): boolean {
  if (!model) return false;
  return MODEL_CATALOG.find((entry) => entry.id === model)?.mlxOnly === true;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs uppercase tracking-wide text-mut">{children}</div>
  );
}

/** Restored-backup honesty notice (Sol review 2026-07-20, L finding;
 *  extended to the tab-cloud card too — M2 fix, v0.5 closeout): a
 *  backup restored WITH keys can leave a real sonioxKey in preview
 *  storage, and BYOK-wins routing (stt/soniox.ts / tabAudioCloud.ts's
 *  own effectiveProvider) will then bill the USER's account on either
 *  the Soniox OR the 标签页音频·云端 card while that card's own hint
 *  above still advertises the server-funded trial. The input itself
 *  stays disabled on preview (posture: preview never COLLECTS keys),
 *  so this notice + explicit clear is the only exit — a shared
 *  component so the copy/behavior can never drift between the two
 *  cards. */
function SonioxKeyRestoredNotice({ onClear }: { onClear: () => void }) {
  return (
    <div className="mt-1 text-xs leading-[1.7] text-warn-soft">
      检测到已保存的 Soniox Key：会话将直接使用你自己的 Key 并按你的账户计费，而非上方的预览体验。
      <button
        type="button"
        onClick={onClear}
        className="ml-1 underline decoration-[rgb(var(--warn-soft-rgb)/0.4)]"
      >
        清除已保存的 Key（改用预览体验）
      </button>
    </div>
  );
}

// #56 分任务模型（高级）: display metadata for the three domain blocks,
// in the design's exact order/labels (Q5). "detect" covers define too
// (LlmTaskDomain deliberately excludes a separate "define" domain —
// see types.ts's own comment — define always rides detect's
// resolution), hence the hint text below.
const TASK_DOMAIN_META: { domain: LlmTaskDomain; label: string; hint?: string; staticModelOptions: string[] }[] = [
  { domain: "translate", label: "选区翻译 / 双语转录", staticModelOptions: TRANSLATE_MODEL_OPTIONS },
  { domain: "detect", label: "检测与解释", hint: "选中文字解释也用这份配置", staticModelOptions: DETECT_MODEL_OPTIONS },
  { domain: "summary", label: "会议报告", staticModelOptions: SUMMARY_MODEL_OPTIONS },
];

/** Human-readable provider label for the muted "跟随上方主配置" line —
 *  Anthropic has no user-facing baseUrl (see types.ts), so it's named
 *  directly; openai-compat shows its actual endpoint (the thing that
 *  actually varies and matters to the reader). */
function providerLabel(resolved: ResolvedTaskCreds): string {
  return resolved.provider === "anthropic" ? "Anthropic" : resolved.baseUrl || "自定义端点";
}

/** One 分任务模型（高级） domain block: 使用独立配置 toggle + either a
 *  muted "inherits primary" line (off) or a full <CredentialFields>
 *  (on) — design Q5. Local component so useProviderModels' lazy-on-
 *  mount fetch only ever fires once THIS domain's toggle is actually
 *  on (never for the other two, and never just because the outer
 *  分任务模型 disclosure itself is open). */
function TaskDomainBlock({
  domain,
  label,
  hint,
  staticModelOptions,
  config,
  primary,
  onChange,
  disabled,
  apiKeyStatus,
}: {
  domain: LlmTaskDomain;
  label: string;
  hint?: string;
  staticModelOptions: string[];
  config: TaskLlmConfig | undefined;
  primary: Settings;
  onChange: (next: TaskLlmConfig | undefined) => void;
  disabled: boolean;
  /** S14 credential-health chip for this override's own API Key row —
   *  see CredentialFields' identical prop doc comment. */
  apiKeyStatus?: KeyStatus;
}) {
  const enabled = !!config?.enabled;
  const resolved = resolveTaskCreds(primary, domain);

  const patchConfig = (p: Partial<TaskLlmConfig>) => {
    onChange({ enabled, provider: config?.provider, baseUrl: config?.baseUrl, apiKey: config?.apiKey, model: config?.model, ...p });
  };

  // FINDING 11 (escalated HIGH, second review): a per-task override has
  // exactly ONE apiKey field — unlike the primary block, which stores a
  // separate field per provider (providerKeys.ts) plus a host binding
  // for the custom-endpoint case — so switching THIS domain's provider/
  // Base URL used to silently carry the OLD key forward into
  // resolveTaskCreds' NEW provider/baseUrl (taskConfig.ts:65 `t.apiKey
  // || resolveProviderApiKey(...)` sends whatever's in `t.apiKey`
  // as-is). That's the exact FT-2 cross-host-leak class v0.7.3
  // reshaped the flat keys to stop, reopened here. Per-provider storage
  // for task overrides would be its own reshape (out of this fix's
  // scope), so the safe minimum every host change gets is: drop the
  // stale key and fall back to "留空则用主配置的 Key" (resolveTaskCreds'
  // own inherit rule) — exactly what a freshly-enabled override already
  // does with an empty apiKey.
  const patchConfigForHost = (p: Partial<TaskLlmConfig> & { provider?: LlmProvider; baseUrl?: string }) => {
    const currentProvider = config?.provider ?? primary.provider;
    const currentBaseUrl = config?.baseUrl ?? primary.baseUrl;
    const nextProvider = p.provider ?? currentProvider;
    const nextBaseUrl = p.baseUrl ?? currentBaseUrl;
    // baseUrl is inert for "anthropic" (presetIdFor short-circuits on
    // provider alone — providerKeys.ts) and CredentialFields never even
    // renders a Base URL input for it, so only compare hosts once both
    // sides are openai-compat; a bare provider flip already counts as a
    // host change on its own.
    const hostChanged =
      nextProvider !== currentProvider ||
      (nextProvider === "openai-compat" && providerHostFor(nextBaseUrl) !== providerHostFor(currentBaseUrl));
    patchConfig(hostChanged ? { ...p, apiKey: "" } : p);
  };

  return (
    <div className="space-y-2 border border-edge bg-panel2 p-3">
      <label className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm text-fg">{label}</div>
          {hint && <div className="text-xs text-mut2">{hint}</div>}
        </div>
        <ToggleSwitch
          checked={enabled}
          disabled={disabled}
          onChange={(checked) => patchConfig({ enabled: checked })}
        />
      </label>

      {enabled ? (
        <div className="space-y-3 border-t border-edge pt-3">
          <CredentialFields
            idPrefix={`task-${domain}`}
            provider={config?.provider ?? primary.provider}
            baseUrl={config?.baseUrl ?? primary.baseUrl}
            apiKey={config?.apiKey ?? ""}
            onSelectPreset={(id) => {
              const preset = PROVIDER_PRESETS.find((p) => p.id === id);
              if (!preset) return;
              patchConfigForHost({ provider: preset.provider, baseUrl: preset.baseUrl });
            }}
            onBaseUrlChange={(baseUrl) => patchConfigForHost({ baseUrl })}
            onApiKeyChange={(apiKey) => patchConfig({ apiKey })}
            apiKeyPlaceholder="留空则用主配置的 Key"
            apiKeyStatus={apiKeyStatus}
            presets={PROVIDER_PRESETS}
            disabled={disabled}
            models={[
              {
                key: domain,
                label: "模型",
                value: config?.model ?? "",
                onChange: (v) => patchConfig({ model: v }),
                staticOptions: staticModelOptions,
                // Sol #3 fix (BYOK preview sprint, 2026-07-21): this
                // free-text field let a keyless preview visitor type ANY
                // model id into a per-task override — the server still
                // only ever honors the same JARGONSLAYER_MODEL_ALLOWLIST
                // env pickModel checks for the primary block (anthropic.
                // ts), so the request silently substituted the forced
                // model while this field claimed otherwise. Locked to
                // the same allowlist the primary block's own
                // previewOptions uses, gated on THIS domain's resolved
                // key (own key, or inherited from primary via
                // resolveTaskCreds) rather than the primary's key alone
                // — an own/inherited key means this domain routes
                // browser-direct (D1) and keeps full-tier free-text,
                // exactly like the primary field once it has a key.
                previewOptions:
                  PREVIEW_TIER && !resolved.apiKey
                    ? domain === "summary"
                      ? PREVIEW_SUMMARY_MODELS
                      : PREVIEW_LIVE_MODELS
                    : undefined,
                hint: (
                  <div className="mt-1 text-xs text-mut2">
                    留空则用主配置的模型（{resolved.model || "服务端默认"}）
                  </div>
                ),
              },
            ]}
          />
        </div>
      ) : (
        <div className="border-t border-edge pt-2 text-xs leading-[1.7] text-mut2">
          跟随上方主配置（{providerLabel(resolved)} · {resolved.model || "服务端默认"}）
        </div>
      )}
    </div>
  );
}

export default function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const showToast = useApp((s) => s.showToast);
  // ITEM 2 fix (fix round, Sol#4 + Lane C flag): the D7 webspeech
  // on-device runtime overlay resolveEngineRetentionClass reads —
  // exactly the same store field Header/StatusLine already read, so the
  // 转录引擎 ENGINE_CARDS retention badge below can never disagree with
  // what those surfaces show for the live engine.
  const sttEngineMode = useApp((s) => s.sttEngineMode);
  // #62/tag-blocker 1: SettingsDialog is mounted unconditionally from
  // page.tsx, before store.hydrate() (async) resolves — so `settings`
  // starts out as DEFAULT_SETTINGS. Read `hydrated` so the auto-promote
  // effect below can wait for the real persisted settings instead of
  // evaluating (and never re-evaluating) DEFAULT_SETTINGS.
  const hydrated = useApp((s) => s.hydrated);
  // v0.4 S4 chunk 4 (risk 2 — "disable/confirm the switch while a
  // meeting is listening", the model-switch flow stops+relaunches the
  // sidecar): the SAME meetingActive signal Header.tsx's HamburgerMenu
  // already gates 学习中心/演示 on (that file's own comment on why
  // "paused" counts too — starting something new while paused would
  // silently clobber a meeting the user intends to resume). No shared
  // export exists for this predicate (it's local to that component), so
  // this mirrors the exact same three-status rule rather than importing
  // one — same "mirror, don't hand-duplicate a DIFFERENT rule" posture
  // provisionMachine.ts's own ALLOWED_MARKER_MODELS doc comment already
  // uses for server.rs's ALLOWED_MODELS.
  const meetingStatus = useApp((s) => s.status);
  const meetingActive =
    meetingStatus === "connecting" || meetingStatus === "listening" || meetingStatus === "paused";
  // Field-test fix: the bottom bar (StatusLine) already disables engine
  // switching the moment a meeting is connecting/listening via
  // isEngineControlBusy (Header.tsx) — a mid-session engine change is
  // silently ignored, not applied (useMeeting.ts's attachEngine only
  // snapshots settings.engine at Start), so this dialog's own engine
  // cards need the same gate. Deliberately isEngineControlBusy, not
  // meetingActive above: "paused" must stay unlocked, since resuming
  // from pause genuinely reconciles an engine change (useMeeting.ts:586).
  const engineLockedByMeeting = isEngineControlBusy(meetingStatus);

  const [draft, setDraft] = useState<Settings>(() => coercePreviewModels(settings));
  // Sol r5 (v0.7 train): session-scoped edit-intent flag for
  // translateEngine. A draft==savedSnapshot equality check loses the
  // ABA case (user picks system, then deliberately returns to llm →
  // equals snapshot again → their pick would be dropped in favor of
  // the live value). Set by the engine row's onChange only; reset on
  // every dialog open and on full-backup restore.
  const [engineTouched, setEngineTouched] = useState(false);
  // S13 iOS mobile-UX round (Part B #4): frozen baseline for the iOS
  // sticky-save-bar dirty check below — re-seeded alongside `draft` in
  // the SAME open effect (never independently), so a background
  // settings mutation unrelated to the user's own draft edits (the
  // uiMode auto-promote effect, a live ThemeEditor write) can never
  // make `draftDirty` false-positive by drifting `settings` itself
  // instead of anything the user actually typed.
  const [savedSnapshot, setSavedSnapshot] = useState<Settings>(() => coercePreviewModels(settings));
  // v0.5.1 appearance sprint (D4): non-null while the 显示 section shows
  // the ThemeEditor sub-panel instead of its normal grid. customThemes
  // CRUD (save/delete/import below) always reads/writes `settings.
  // customThemes` (the LIVE store value), never `draft.customThemes` —
  // draft is a one-time snapshot taken at mount (coercePreviewModels
  // above) and is never updated again by these write-through actions,
  // so it would go stale the moment any one of them fires.
  const [themeEditor, setThemeEditor] = useState<{
    sourceThemeId: string;
    editingThemeId?: string;
  } | null>(null);
  const [themeImportOpen, setThemeImportOpen] = useState(false);
  const [themeImportText, setThemeImportText] = useState("");
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([]);
  const [testingConnection, setTestingConnection] = useState(false);
  // S14 credential-health chips: live telemetry read (same "must
  // re-render the moment a call resolves, not just at open time"
  // justification as AiStatusPanel's own useLlmTelemetry() call) +
  // the last 测试连接 outcome, which can UPGRADE a chip to 正常 even when
  // the matching telemetry entry alone would read 异常 — see
  // keyStatus.ts's llmKeyEvidence doc comment for why (RateLimitApiError
  // is "key's fine" to testConnection but a recorded failure to
  // telemetry). undefined = never run this dialog-open.
  const telemetry = useLlmTelemetry();
  const [testConnectionOk, setTestConnectionOk] = useState<boolean | undefined>(undefined);
  // Desktop OAuth branch (S10 field-fix, Chunk A wave-2 wiring): mirrors
  // OnboardingByokStep.tsx's own connecting/oauthHint pair — this
  // dialog's OAuth button lives inside the shared CredentialFields
  // component (primary AI 检测 block only, see that component's own
  // onConnectOpenRouter/connectingOpenRouter doc), so the state is
  // lifted here rather than local to a component that owns none of its
  // own otherwise.
  const [connectingOpenRouter, setConnectingOpenRouter] = useState(false);
  const [openRouterOauthHint, setOpenRouterOauthHint] = useState<string | null>(null);
  const [exportFolderName, setExportFolderName] = useState<string | null>(null);
  // Storage durability + visibility (v0.5 closeout item 4): read-only,
  // feature-detected navigator.storage.estimate() snapshot — re-read on
  // every dialog open (see the `open`-gated effect below), same "snapshot
  // on open" posture as exportFolderName/diagEntries. null covers both
  // "not resolved yet" and "unsupported" alike — no separate loading
  // state; the line below simply doesn't render until this resolves.
  const [storageEstimate, setStorageEstimate] = useState<{ usageMb: number; quotaGb: number } | null>(
    null,
  );
  // 全量备份/恢复 (#57): 「不包含 API Key」defaults to CHECKED (safe
  // default — a backup file is meant to be shareable/storable without
  // automatically also being a key leak). restorePreview holds the
  // picked file's raw text + previewBackup() counts while the user
  // reviews the confirmation step; null = no pending import.
  const [exportStripKeys, setExportStripKeys] = useState(true);
  const [restorePreview, setRestorePreview] = useState<{
    text: string;
    sessions: number;
    entries: number;
    learnset: number;
    // M3 fix (adversarial review): so the confirm step can disclose
    // that the file contains packs at all — restoring makes the
    // browser fetch every url-backed row.
    packSources: number;
    hasSettings: boolean;
    hasApiKey: boolean;
  } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  // 说话人分离 (speaker diarization, HF token) section.
  const [showHfToken, setShowHfToken] = useState(false);
  const [checkingDiarization, setCheckingDiarization] = useState(false);
  // 说话人分离 安装扩展 (v0.4 S5 chunk 3, desktop-managed only): the
  // install-state row's own truth, sourced from fetchSidecarHealth's
  // new diarization_installed field (decision C) — `undefined` renders
  // 未知 (risk 5: legacy/external sidecars omit the field; also true
  // before this dialog's own probe effect below first resolves), never
  // 未安装.
  const [diarizationInstalled, setDiarizationInstalled] = useState<boolean | undefined>(undefined);
  // S10 field-fix #6 jobsBridge swap (wave 2): handleInstallDiarization
  // below now DISPATCHES a "diar-install" registry task
  // (jobsBridge.trackInstallDiar) instead of awaiting handle.
  // installDiarization() inline — the task (and its progress) now
  // outlives this dialog closing; TaskCenterDrawer/TaskTray own it from
  // here on. installingDiarization is therefore DERIVED from the
  // registry (this dialog's own last-dispatched task id's "running"
  // status) rather than a separately-maintained local flag — the
  // registry is the single source of truth, so there is no local
  // progress/log state to duplicate it (no more diarizationInstallLog
  // tail; see handleInstallDiarization's own doc comment below).
  const [diarInstallTaskId, setDiarInstallTaskId] = useState<string | null>(null);
  const installingDiarization = useTasks(
    (s) => diarInstallTaskId !== null && s.tasks[diarInstallTaskId]?.status === "running",
  );
  // F7 (MEDIUM, adversarial review): trackInstallDiar's own success
  // handler (jobsBridge.ts) only mirrors sidecarUp into the STORE —
  // this dialog's OWN diarizationInstalled below comes from a SEPARATE
  // fetchSidecarHealth probe, which never re-ran on task completion, so
  // an open dialog kept showing 需先安装 until reopened. Read by the
  // diarization-probe effect below, which re-runs once this flips true.
  const diarInstallDone = useTasks(
    (s) => diarInstallTaskId !== null && s.tasks[diarInstallTaskId]?.status === "done",
  );
  // 转录引擎 sidecar status line (owner ask 2026-07-11: "I cannot see in
  // the GUI if the local side got set up at all") — a lightweight GET
  // /health readout shown directly under the engine picker whenever the
  // draft engine is whisper/tabaudio/appaudio, separate from 说话人分离's
  // own fetchSidecarHealth probe below (that one is diarization-specific,
  // toast-only). null = not probed yet this dialog-open/engine
  // selection — rendered the same as a confirmed-down result (mirrors
  // 订阅直连's agentHealthState `!agentHealthState` idiom below).
  const [sidecarStatus, setSidecarStatus] = useState<SidecarProbeResult | null>(null);
  const [checkingSidecarStatus, setCheckingSidecarStatus] = useState(false);
  // 转录引擎 系统/App 音频 macOS-floor gating (S9.4, D6; centralized onto
  // lib/desktop/audiocapCaps.ts by adversarial review finding F9 — that
  // module is now the ONE place probing/caching audiocap_capabilities(),
  // shared with Header.tsx's ENGINE_OPTIONS) — probed once per
  // dialog-open (see the IS_DESKTOP-gated effect below), cached for the
  // rest of that open same as sidecarStatus/installedModel/
  // diarizationInstalled above. null = not probed yet this open; the
  // ENGINE_CARDS render below treats null the same as "supported" (see
  // isAppAudioFloorLocked's own POLICY doc — fails open, since D6 says
  // "runtime commands re-check support, UI gating is not a boundary", so
  // an optimistic default here is only ever a brief cosmetic gap, never
  // a real safety hole).
  const [audiocapCaps, setAudiocapCaps] = useState<AudiocapCapabilities | null>(null);
  // S11 osspeech blueprint (§3 Worker D) — 系统识别's own macOS-26 floor
  // gate, same "shown-but-disabled below floor" policy as 系统/App 音频
  // just above, just via Worker C's own hook (osspeechCaps.ts owns its
  // probe/subscribe lifecycle internally, unlike audiocapCaps above
  // which this file still hand-rolls its own useState/useEffect for —
  // no need to duplicate that here).
  const osSpeechCaps = useOsSpeechCaps();
  // 预下载模型 button (blueprint §Q5): a simple local busy/done pair, the
  // same "immediate action, local busy state" shape
  // handleCheckDiarizationStatus/checkingDiarization above already uses
  // — preinstallOsSpeech itself also drives an "os-speech-asset" 后台任务
  // row (Worker C's own osspeechCaps.ts), so this is purely this
  // button's OWN visual feedback, not a duplicate of that tracking.
  // S11 fix-round J5: "done" is keyed by the LANGUAGE it was preinstalled
  // for (not a bare boolean) — switching draft.language afterward (the
  // 识别语言 picker below) must not keep showing 已下载 for a language
  // that was never actually preinstalled; osSpeechPreinstallDone derives
  // straight off this so every existing read of it below stays untouched.
  const [preinstallingOsSpeech, setPreinstallingOsSpeech] = useState(false);
  const [osSpeechPreinstallDoneLanguage, setOsSpeechPreinstallDoneLanguage] = useState<string | null>(null);
  const osSpeechPreinstallDone = osSpeechPreinstallDoneLanguage === draft.language;
  // Soniox API Key masked-input toggle (v0.4 S4 chunk 6) — same
  // show/hide idiom as showHfToken above, scoped to 转录引擎 since the
  // field itself only renders when draft.engine === "soniox".
  const [showSonioxKey, setShowSonioxKey] = useState(false);
  // Deepgram API Key masked-input toggle (v0.4.7 Lane D) — same idiom,
  // scoped to 转录引擎 since the field itself only renders when
  // draft.engine === "deepgram".
  const [showDeepgramKey, setShowDeepgramKey] = useState(false);
  // ElevenLabs API Key masked-input toggle (v0.6 round 2) — same idiom,
  // scoped to 转录引擎 since the field itself only renders when
  // draft.engine === "elevenlabs".
  const [showElevenLabsKey, setShowElevenLabsKey] = useState(false);
  // DeepL API Key masked-input toggle (translation-rework wave 2) — same
  // idiom, scoped to AI 检测's 翻译引擎 row since the field itself only
  // renders when draft.translateEngine === "deepl".
  const [showDeeplKey, setShowDeeplKey] = useState(false);
  // 有道应用密钥 masked-input toggle (v0.7.1 translation train-2) — same
  // idiom as showDeeplKey immediately above; 应用ID (youdaoAppKey) is a
  // plain-text identifier, not masked (mirrors DeepL's own single-field
  // precedent — only the actual secret gets a show/hide toggle).
  const [showYoudaoAppSecret, setShowYoudaoAppSecret] = useState(false);
  // Draft checked-set for non-core theme packs; reconciled back into
  // draft.enabledPacks (string[] | null) on save. "core" is always on
  // and isn't part of this set — it renders as a disabled row instead.
  const [checkedPacks, setCheckedPacks] = useState<Set<string>>(
    new Set(settings.enabledPacks ?? getAllPacks().filter((p) => p.id !== "core").map((p) => p.id)),
  );
  // v0.6 field-fix (item 1): which built-in pack GROUPS (通用表达/职场与
  // 会议/专业领域/其他) are expanded — plain local view state, collapsed
  // by default, never persisted (mirrors LogPane's own expanded state in
  // DesktopWizard.tsx). Never touches checkedPacks/enabledPacks — purely
  // which rows are currently visible.
  const [expandedPackGroups, setExpandedPackGroups] = useState<Set<BuiltinPackGroup>>(new Set());
  // 词典源 (remote dictionary packs, #20).
  const [packSources, setPackSources] = useState<RemotePackSource[]>([]);
  const [packSourceUrl, setPackSourceUrl] = useState("");
  const [addingPackSource, setAddingPackSource] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  // Renamed from confirmRemoveUrl (v0.6 T5/GOTCHA): a file-imported
  // source's own url is "" (see RemotePackSource.url's own doc), so
  // every per-row identifier below is `s.url || s.pack.id`, never
  // `s.url` alone — this now holds either shape.
  const [confirmRemovePackId, setConfirmRemovePackId] = useState<string | null>(null);
  // v0.6 T2: import a pack from a local file / pasted JSON — same
  // collapsed-panel shape as the theme importer's own themeImportOpen/
  // themeImportText (see handleImportThemeJson/handleImportThemeFile
  // above, and the JSX at :4556-4599 this mirrors).
  const [packImportOpen, setPackImportOpen] = useState(false);
  const [packImportText, setPackImportText] = useState("");
  // v0.6 T2/T3(b): shared inline error slot for every pack-install path
  // below (URL/file/paste/catalog) — mirrors restoreError's own
  // "persistent inline line, not just an ephemeral toast" idiom
  // (:4187-4189) rather than losing a possibly-multi-sentence
  // validation error (size caps, minAppVersion, quota, …) to a toast
  // that's already gone by the time it's worth re-reading. Cleared at
  // the start of every new attempt and on success.
  const [packInstallError, setPackInstallError] = useState<string | null>(null);
  // v0.6 T5: which installed sources currently have their 来源与许可
  // disclosure open — keyed the same `s.url || s.pack.id` way as
  // confirmRemovePackId above.
  const [expandedPackNotices, setExpandedPackNotices] = useState<Set<string>>(new Set());
  // v0.6 T6: 词典库 catalog browse — lazy-fetched (see the effect
  // below), never on dialog mount. catalogStatus doubles as the
  // fetch-once guard (only "idle" ever triggers a fetch).
  const [catalogPacks, setCatalogPacks] = useState<CatalogPackEntry[] | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [installingCatalogId, setInstallingCatalogId] = useState<string | null>(null);
  // 分任务模型（高级）(#56): collapsed by default — the per-domain
  // blocks below only mount (and only start fetching model lists) once
  // this is open, see TaskDomainBlock's own doc comment.
  const [taskLlmExpanded, setTaskLlmExpanded] = useState(false);
  // 订阅直连（实验性，v0.2.2）: kill-switch layer 2 — this whole section
  // renders nothing when the build didn't set
  // NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT (see SUBSCRIPTION_DIRECT_
  // BUILT), so the experience-tier build never shows it at all, not
  // even disabled.
  const [agentHealthState, setAgentHealthState] = useState<AgentHealth | null>(null);
  const [checkingAgentHealth, setCheckingAgentHealth] = useState(false);
  // 诊断信息 (owner ask: "用户需要能看到错误信息和编号方便反馈") — snapshot
  // of the diag ring buffer (lib/diag/log.ts), re-read on every dialog
  // open (see the `open`-gated effect below); not live-subscribed
  // while open, same "snapshot on open" posture as exportFolderName/
  // packSources above.
  const [diagEntries, setDiagEntries] = useState<DiagEntry[]>([]);
  // v0.4 S3 chunk 7, generalized by the beta-phase diagnostics audit
  // item 1: desktop-only 「查看本地日志」 (read_app_log) — logSource picks
  // which of the three allowlisted files (DesktopLogSource) the select
  // below is currently showing; appLogText is null = not fetched yet
  // this dialog-open/source, "" = fetched but empty (that file doesn't
  // exist yet, e.g. never provisioned, or that engine never ran).
  const [logSource, setLogSource] = useState<DesktopLogSource>("whisper_server.log");
  const [appLogText, setAppLogText] = useState<string | null>(null);
  const [loadingAppLog, setLoadingAppLog] = useState(false);
  // F6 fix (adjudicated review): ref-mirror of logSource, same
  // stale-guard shape as this file's other async effects (`let
  // cancelled` closures above) — but this read is fired from a button
  // click, not a mount effect, and the source can change out from under
  // an in-flight request via the <select>'s own onChange (a plain state
  // read can't see that; a ref can, since it's read AFTER the await).
  const logSourceRef = useRef(logSource);
  useEffect(() => {
    logSourceRef.current = logSource;
  }, [logSource]);
  // 转录引擎 category, desktop-only: 「重新运行安装向导」busy flag — see
  // handleReprovisionDesktop below.
  const [reprovisioningDesktop, setReprovisioningDesktop] = useState(false);
  // 转录引擎 category, desktop-managed only (v0.4 S4 chunk 4, blueprint
  // decision C's switch flow): 当前模型 line + 更换模型 flow state.
  // installedModel is the TRUTHFUL installed model (read from the
  // provision marker via handle.installedModel(), see that method's own
  // doc comment) — null renders as an em-dash, both while still loading
  // (the effect below hasn't resolved yet) and if the marker genuinely
  // can't be read; deliberately NOT settings.whisperModel, which is
  // only the user's target/preference and can briefly diverge from
  // what's actually running (decision C).
  const [installedModel, setInstalledModel] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [pickedModel, setPickedModel] = useState<string>("");
  // S10 field-fix #6 jobsBridge swap (wave 2): handleSwitchModel below
  // now DISPATCHES a "model-download" registry task (jobsBridge.
  // trackSwitchModel) instead of awaiting handle.switchModel() inline
  // — the task (and its own progress phases, "下载中 {pct}%" → "启动中")
  // now outlives this dialog closing; TaskCenterDrawer/TaskTray own it
  // from here on. switchingModel is therefore DERIVED from the
  // registry (this dialog's own last-dispatched task id's "running"
  // status), same posture as installingDiarization above — no more
  // local switchModelStatusText/switchModelError (that would be double
  // progress tracking of the exact same job).
  const [switchModelTaskId, setSwitchModelTaskId] = useState<string | null>(null);
  const switchingModel = useTasks(
    (s) => switchModelTaskId !== null && s.tasks[switchModelTaskId]?.status === "running",
  );
  // S12b fix round FB8-refresh (§F): mirrors diarInstallDone's own
  // "read a specific dispatched task id's own terminal status" shape
  // exactly (see that field's own doc comment a few lines up) —
  // installedModel below is a ONE-SHOT snapshot read at effect-mount
  // time, so a switch that completes while this dialog stays open
  // otherwise leaves 当前模型/实时说话人分离's own gating stale until the
  // dialog is closed and reopened. Read by the 当前模型 effect below,
  // which re-runs once this flips true.
  const switchModelDone = useTasks(
    (s) => switchModelTaskId !== null && s.tasks[switchModelTaskId]?.status === "done",
  );
  // S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
  // Provision state machine, worker A3) — display-only wiring for the
  // "mlx-install" task kind (A2's provisionMachine.ts/bootstrap.ts own
  // its actual emission, as part of picking a parakeet-family model's
  // two-phase provision; see modelCatalog.ts's own mlxOnly doc). Unlike
  // switchingModel/installingDiarization above, this dialog never
  // dispatches an mlx-install task itself (there is no local
  // "mlxInstallTaskId" to key off, and no call site to attach one to —
  // handleSwitchModel just calls trackSwitchModel and moves on, same
  // "TaskCenterDrawer/TaskTray own progress from here on" posture that
  // function's own doc comment already states), so this reads the
  // registry by KIND instead of a specific id — true whenever ANY
  // mlx-install task is running, regardless of which call site started
  // it. A primitive-returning selector (registry.ts's own INVARIANT
  // doc), so no useShallow wrapping is needed here.
  const installingMlx = useTasks((s) => Object.values(s.tasks).some((t) => t.kind === "mlx-install" && t.status === "running"));

  // Settings redesign: which nav-rail category the content pane shows.
  // Local-only (NOT the zustand store, not part of draft) — pure
  // navigation state; draft itself already lives at this same dialog
  // level regardless of which category is active, so switching
  // categories can never lose an unsaved edit. Default "engine": the
  // first entry in SETTINGS_CATEGORIES, always visible (its own
  // section level is "simple").
  //
  // S13 iOS mobile-UX round (Part B #1/#2): `null` is the iOS-only
  // ROOT LIST state (no such state exists on desktop/web — this widens
  // the TYPE for both platforms, since the two must share one state
  // slot, but the VALUE is null-initialized only on IS_IOS; desktop
  // keeps today's "engine" initial and this never becomes null there —
  // desktop's own nav rail has no root-list concept to return to).
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId | null>(
    IS_IOS ? null : "engine",
  );

  // S13 iOS mobile-UX round (Part B #3): no 简单/高级 control exists on
  // iOS (a completely different navigation shell, see the IS_IOS return
  // branch far below) — every uiMode-gated category/row must still be
  // reachable there, so this pins the EFFECTIVE level read by
  // categoryVisible below (and by `level` further down, reused as-is)
  // to "advanced" on iOS, without touching the persisted
  // settings.uiMode value itself (the header toggle / auto-promote
  // effect elsewhere still read/write the real value; only VISIBILITY
  // decisions route through this).
  const uiVisibilityLevel: Settings["uiMode"] = IS_IOS ? "advanced" : settings.uiMode;

  // Nav-rail visibility per category — reuses isSectionVisible/
  // SETTINGS_UI_LEVELS exactly as every row below already does (never
  // forked). engine/display's own section level is "simple" (so these
  // evaluate true regardless of uiMode); aiDetect has no single
  // matching key (the one mixed section) so it's visible whenever ANY
  // of its own rows would be, mirroring the general "a category whose
  // every row is advanced-only disappears from the nav" rule.
  //
  // S13 (Part A #1): diarization is pyannote+sidecar-only — genuinely
  // impossible on iOS (no Python sidecar there at all, v1 mic-only
  // osspeech) — force-excluded regardless of uiVisibilityLevel above
  // pinning everything ELSE to advanced. subscriptionDirect is likewise
  // hidden below because its localhost desktop agent cannot exist on
  // iPhone; all other advanced categories remain reachable.
  const categoryVisible: Record<SettingsCategoryId, boolean> = {
    engine: isSectionVisible(uiVisibilityLevel, SETTINGS_UI_LEVELS.engine),
    diarization: !IS_IOS && isSectionVisible(uiVisibilityLevel, SETTINGS_UI_LEVELS.diarization),
    aiDetect: AI_DETECT_ROW_LEVELS.some((l) => isSectionVisible(uiVisibilityLevel, l)),
    keys: isSectionVisible(uiVisibilityLevel, SETTINGS_UI_LEVELS.keys),
    taskLlm: isSectionVisible(uiVisibilityLevel, SETTINGS_UI_LEVELS.taskLlm),
    dataIntegration: isSectionVisible(uiVisibilityLevel, SETTINGS_UI_LEVELS.dataIntegration),
    subscriptionDirect:
      !IS_IOS &&
      process.env.NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT === "1" &&
      isSectionVisible(uiVisibilityLevel, SETTINGS_UI_LEVELS.subscriptionDirect),
    display: isSectionVisible(uiVisibilityLevel, SETTINGS_UI_LEVELS.display),
  };
  const visibleCategories = SETTINGS_CATEGORIES.filter((c) => categoryVisible[c.id]);

  // Keeps the active nav selection valid if uiMode flips live (header
  // 简单/高级 toggle, immediate-apply — see that control below) while
  // the dialog is open and hides whatever category the user was on;
  // falls back to the first still-visible category instead of leaving
  // the content pane blank. settings.uiMode is the only thing that can
  // ever change categoryVisible/visibleCategories at runtime (the
  // category list and the build-time env flag never do), so that's the
  // only real dependency.
  //
  // S13 iOS mobile-UX round: null-guarded — activeCategory===null is
  // iOS's own ROOT LIST state (Part B #1), never itself an "invisible
  // category" to redirect away from; without this guard,
  // categoryVisible[null] reads `undefined` (a Record has no entry for
  // it), and `!undefined` is true, which would immediately kick the
  // user out of the root list back into whatever visibleCategories[0]
  // is the instant this effect's dependency changed.
  useEffect(() => {
    if (activeCategory !== null && !categoryVisible[activeCategory]) {
      setActiveCategory(visibleCategories[0]?.id ?? "engine");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.uiMode]);

  // #62 progressive disclosure: auto-promote simple → advanced if the
  // user already relies on an advanced-only setting (BYOK key, task
  // overrides, webhook, filtered packs, subscription-direct,
  // diarization, custom confidence, …) — pure, deterministic, re-
  // derived every time hydration settles (see shouldAutoPromoteToAdvanced's
  // own doc comment). Persisted immediately via updateSettings, same as
  // the header toggle itself — uiMode is a view preference, kept OUT of
  // the draft/保存 flow (see the toggle's own comment below).
  //
  // Gated on `hydrated` (tag-blocker 1), not an empty dep array: this
  // dialog is mounted unconditionally from page.tsx while store.
  // hydrate() is still async, so `settings` starts out as
  // DEFAULT_SETTINGS — an empty-dep effect would evaluate that default
  // (never promoting) and then never fire again once the real
  // persisted settings arrive, silently dropping an upgrading power
  // user into simple mode with their BYOK key field hidden. Depending
  // on `hydrated` re-runs this exactly once more, right when hydrate()
  // publishes the real settings.
  useEffect(() => {
    if (!hydrated) return;
    if (settings.uiMode === "simple" && shouldAutoPromoteToAdvanced(settings)) {
      updateSettings({ uiMode: "advanced" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  // App-mount-once (not open-gated): SettingsDialog is always mounted
  // by page.tsx, so this applies the persisted pack selection to the
  // live scanDictionary() registry as soon as the app loads, even if
  // the user never opens this dialog. Mirrors the dictionary.ts
  // registry-pattern comment (see setEnabledPacks there).
  //
  // SEPARATE bug fix (adversarial review, v0.6 dictpacks fix round):
  // this used to run with `[]` deps, i.e. exactly once, using whatever
  // `settings.enabledPacks` was in the closure at THAT render. But this
  // dialog is mounted by page.tsx BEFORE store.hydrate() (async)
  // resolves (#62/tag-blocker 1's own well-documented hazard), so the
  // very first run always saw DEFAULT_SETTINGS.enabledPacks — and with
  // an empty deps array never re-ran once hydrate() published the REAL
  // persisted selection. The detector registry (setEnabledPacks here)
  // and the ASR bias hint (buildMeetingLexicon, which reads the live
  // store directly) would then permanently disagree about which packs
  // are on for the whole session. `hydrated`/`settings.enabledPacks` in
  // the deps array make this re-run once hydration actually publishes
  // the persisted value (and again on any later change, e.g. 保存 or a
  // backup restore) — loadRemotePacksIntoRegistry/listPackSources
  // re-running alongside it is a harmless no-op/re-fetch, not a new
  // side effect (see their own docs).
  useEffect(() => {
    setEnabledPacks(settings.enabledPacks);
    // Remote packs (#20): bootstrapped here, unconditionally on app
    // mount (this component always mounts — see above), fire-and-
    // forget. #53 core extraction moved dictionary.ts into
    // @jargonslayer/core, which can no longer trigger this fetch/idb-
    // keyval load itself (core has no browser/network access) — this
    // mount effect is now the sole trigger, which is fine: it already
    // ran before dictionary.ts's old internal trigger ever could in
    // practice (mount effects fire before any user action could call
    // scanDictionary). Idempotent no-op on repeat calls (see
    // loadRemotePacksIntoRegistry's early-return).
    void loadRemotePacksIntoRegistry().then(() => {
      setCheckedPacks((prev) => {
        // Newly-loaded remote packs default to enabled, same as any
        // other non-core pack, unless the user already has an
        // explicit enabledPacks selection that excludes them.
        if (settings.enabledPacks !== null) return prev;
        return new Set(getAllPacks().filter((p) => p.id !== "core").map((p) => p.id));
      });
    });
    void listPackSources().then(setPackSources);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, settings.enabledPacks]);

  // v0.6 T6: 词典库 catalog browse — lazy-fetched only once the AI 检测
  // category is actually visible (never on dialog mount, unlike the
  // packSources bootstrap above), and only once per dialog lifetime —
  // catalogStatus's own "idle" gate makes this fire exactly once even
  // though switching tabs back and forth re-runs the effect.
  useEffect(() => {
    if (!open || activeCategory !== "aiDetect" || catalogStatus !== "idle") return;
    setCatalogStatus("loading");
    void fetchDictCatalog()
      .then((catalog) => {
        setCatalogPacks(catalog.packs);
        setCatalogStatus("loaded");
      })
      .catch(() => {
        setCatalogStatus("error");
      });
  }, [open, activeCategory, catalogStatus]);

  useEffect(() => {
    if (open) {
      // Preview tier (#61): coerce an off-list persisted detectModel/
      // summaryModel to the first allowed option as soon as the dialog
      // (re)opens — see coercePreviewModels' own doc comment.
      // savedSnapshot (Part B #4): re-seeded from the SAME computed
      // value, every time draft itself re-seeds — see that state's own
      // doc comment above for why this must never drift independently.
      const seededDraft = coercePreviewModels(settings);
      setDraft(seededDraft);
      setSavedSnapshot(seededDraft);
      setEngineTouched(false);
      // v0.5.1: SettingsDialog is mounted unconditionally by page.tsx
      // (this whole component instance survives an open/close cycle —
      // `if (!open) return null` above is only a render-output guard,
      // not an unmount), so ThemeEditor's own local state resets for
      // free on every fresh mount, but THIS state doesn't — without an
      // explicit reset here, closing the dialog while the theme editor
      // sub-panel is open (e.g. via 取消/backdrop, never touching its
      // own 返回 button) would leave `themeEditor` non-null, so the NEXT
      // open would jump straight back into the editor instead of the
      // normal 显示 grid.
      setThemeEditor(null);
      // #58 fix round FIX 4: activeCategory is iOS's own root/detail nav
      // state (Part B #1) and, like themeEditor just above, survives a
      // close because this whole component instance never unmounts —
      // without this reset, closing from a detail page and reopening
      // landed back on that same stale detail instead of the root list.
      if (IS_IOS) setActiveCategory(null);
      setThemeImportOpen(false);
      setThemeImportText("");
      // L1 fix (adversarial review): exactly the same "don't leak a
      // previous open's transient panel state into a fresh one" reason
      // as the theme importer three lines above.
      setPackInstallError(null);
      setPackImportOpen(false);
      setPackImportText("");
      // FINDING 5 (S14 fix round): a 测试连接 result from a PREVIOUS
      // dialog-open must never survive into a fresh one — the freshly
      // re-seeded draft above may no longer be what was last tested.
      // The detect-creds effect just below additionally covers the
      // WITHIN-this-open case (editing the key while the dialog stays
      // open).
      setTestConnectionOk(undefined);
      setCheckedPacks(
        new Set(settings.enabledPacks ?? getAllPacks().filter((p) => p.id !== "core").map((p) => p.id)),
      );
      void listAudioInputs().then(setMics);
      // #62 auto-promote, async-plumbing follow-up (tag-blocker
      // BEST-EFFORT 6): shouldAutoPromoteToAdvanced (settingsSections.ts)
      // is a PURE function over `Settings` alone, so it can't see either
      // of these two IndexedDB-backed facts — a stored export-directory
      // handle or an installed remote dictionary pack source. Both are
      // already fetched here on every dialog open regardless (for
      // exportFolderName/packSources' own UI), so promoting off their
      // resolved values is just piggy-backing on an existing round-trip,
      // not new async plumbing. Reads `settings.uiMode` off the closure
      // at effect-run time (mirrors the sync auto-promote effect above);
      // an open dialog's `settings` only ever changes via a hydrate that
      // itself re-opens this same check next time, so this is not
      // expected to race the way tag-blocker 1 did.
      void getExportFolderName().then((name) => {
        setExportFolderName(name);
        if (settings.uiMode === "simple" && name) {
          updateSettings({ uiMode: "advanced" });
        }
      });
      void listPackSources().then((sources) => {
        setPackSources(sources);
        if (settings.uiMode === "simple" && sources.length > 0) {
          updateSettings({ uiMode: "advanced" });
        }
      });
      setDiagEntries(getDiagEntries());
      // Storage durability + visibility (v0.5 closeout item 4) — reset
      // then re-fetch, same shape as sidecarStatus's own open-gated probe
      // just below (a stale PREVIOUS open's numbers must not flash
      // before the fresh estimate resolves).
      setStorageEstimate(null);
      if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
        void navigator.storage.estimate().then((est) => {
          if (est.usage == null || est.quota == null) return;
          setStorageEstimate({ usageMb: est.usage / 1024 ** 2, quotaGb: est.quota / 1024 ** 3 });
        });
      }
      // 订阅直连（实验性）: kill-switch layer 2 — never even probes when
      // this build didn't set NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT
      // (the section itself doesn't render either — see below). Reads
      // process.env.NEXT_PUBLIC_X directly rather than the
      // SUBSCRIPTION_DIRECT_BUILT const re-exported from localHost.ts
      // — verified empirically 2026-07-06 that webpack's getter-based
      // re-export for a cross-module const defeats Terser's ability
      // to constant-fold the USAGE site (even though the const's own
      // definition correctly folds to a literal `false`), leaving this
      // branch — and more importantly the JSX section below — reachable
      // in an unflagged `npm run build` despite always evaluating to
      // false at runtime. A direct inline reference has no such
      // cross-module indirection and reliably eliminates both.
      if (process.env.NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT === "1") {
        void agentHealth(settings).then(setAgentHealthState);
      }
    }
    // Settings save/hydrate debt-ledger class (same ledger tag-blocker 1
    // opened for the auto-promote effect above): this dialog is mounted
    // unconditionally by page.tsx BEFORE store.hydrate() resolves, so an
    // open that happens pre-hydration seeds `draft` from DEFAULT_SETTINGS
    // — hydrate() then publishes the real `settings`, but without
    // `hydrated` in this deps array the draft never re-seeds, and a
    // later 保存 spreads those stale defaults straight over the user's
    // real apiKey/engine/themeId/etc. `hydrated` re-runs this WHOLE
    // effect (draft reset + the themeEditor/import-UI resets right
    // below it) on the false→true flip while open — pre-hydration edits
    // made in that sub-second window are an acceptable loss; re-seeding
    // is the data-preserving choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hydrated]);

  // FINDING 5 (S14 fix round): 测试连接 (handleTestConnection below)
  // always probes resolveTaskCreds(draft, "detect")'s CURRENT
  // credential (client.ts's testConnection -> detectApi ->
  // resolveTaskCreds(settings, "detect")) — its cached ok/fail result
  // must not keep describing a credential the draft has since moved
  // away from. Keyed on the resolved TRIPLE's own primitive fields,
  // not the object reference resolveTaskCreds returns fresh every
  // render, so this only fires when provider/baseUrl/apiKey actually
  // change — covers a direct edit to the primary fields AND an edit to
  // an enabled detect taskLlm override (both feed resolveTaskCreds).
  const detectCredsForTestReset = resolveTaskCreds(draft, "detect");
  useEffect(() => {
    setTestConnectionOk(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    detectCredsForTestReset.provider,
    detectCredsForTestReset.baseUrl,
    detectCredsForTestReset.apiKey,
  ]);

  // 转录引擎 sidecar status line: probes GET /health whenever this
  // section becomes relevant — the dialog opens with the draft engine
  // already whisper/tabaudio/appaudio, or the user switches an engine
  // card to one of those while the dialog stays open — and again
  // whenever draft.engine changes among the three (cheap: same sidecar
  // either way — appaudio joins here too, S9/D7: its helper still
  // streams into the SAME local Whisper sidecar over WsTransport, not a
  // separate service). Preview tier (#61) never probes, matching every
  // other sidecar-dependent affordance's showroom posture (no probing
  // to unlock). Cancellation-guarded like ImportHub's own open-gated
  // probe (its own doc explains why) — this one can additionally be
  // interrupted by an engine switch, not just a close.
  useEffect(() => {
    if (!open || PREVIEW_TIER) return;
    if (draft.engine !== "whisper" && draft.engine !== "tabaudio" && draft.engine !== "appaudio") return;
    setSidecarStatus(null);
    setCheckingSidecarStatus(true);
    let cancelled = false;
    void probeSidecar(draft).then((result) => {
      if (cancelled) return;
      setSidecarStatus(result);
      setCheckingSidecarStatus(false);
      // Mirrored into the store so StatusLine's privacy-segment tooltip
      // (main screen) can reflect the same last-known result — see
      // AppState.sidecarUp's own doc.
      useApp.getState().setSidecarUp(result.up);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft.engine]);

  // 转录引擎 当前模型 line (v0.4 S4 chunk 4): fetches the TRUTHFUL
  // installed model via the SAME module-level bootstrap handle
  // DesktopBootstrap.tsx already drives (initDesktop() is idempotent —
  // see bootstrap.ts's own doc comment, and handleReprovisionDesktop/
  // handleViewAppLog's own identical rationale for reusing it
  // rather than calling getInvoke() a second, independent time).
  // Re-runs whenever the section becomes relevant (dialog opens with
  // 由应用管理 already selected, or the user flips 托管模式 into it while
  // the dialog stays open) — mirrors the 本地服务 status effect just
  // above. IS_DESKTOP is a build-time const (see platform/desktop.ts),
  // so this is inert on a web build.
  //
  // S12b fix round FB8-refresh (§F): `switchModelDone` in the deps array
  // — mirrors F7's own diarInstallDone fix for the exact same class of
  // staleness (see that field's own doc comment): jobsBridge.
  // trackSwitchModel's own success handler settles the TASK registry
  // entry, never this dialog's own `installedModel` state, so without
  // this the 当前模型 line (and, since S12b FB7, 实时说话人分离's own
  // isParakeetSelectedOrInstalled gate) kept showing the PRE-switch
  // model until the dialog was closed and reopened.
  useEffect(() => {
    if (!open || !IS_DESKTOP || draft.sidecarMode !== "managed") return;
    let cancelled = false;
    void initDesktop()
      .then((handle) => handle.installedModel())
      .then((model) => {
        if (!cancelled) setInstalledModel(model);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft.sidecarMode, switchModelDone]);

  // 说话人分离 安装扩展 install-state row (v0.4 S5 chunk 3): probes GET
  // /health via fetchSidecarHealth (decision C's diarization_installed)
  // whenever the section becomes relevant — same "dialog opens with it
  // already selected, or the user flips 托管模式 into it while the
  // dialog stays open" cadence as the 当前模型 effect just above, not
  // the 本地服务 status row's probe (that one also drives a manual
  // 重新检测 button this row doesn't have). fetchSidecarHealth returning
  // null (sidecar unreachable) collapses to the exact same `undefined`
  // -> 未知 render as a legacy sidecar that never sent the field at all
  // — this effect deliberately never tries to tell those two apart
  // (risk 5).
  //
  // F7 (MEDIUM, adversarial review): diarInstallDone in the deps array
  // is this row's OTHER update trigger — jobsBridge.trackInstallDiar's
  // own success handler only mirrors sidecarUp into the STORE, never
  // this dialog's OWN diarizationInstalled, so without this the row
  // kept showing 需先安装 until the dialog was closed and reopened. Kept
  // dialog-side (re-running the SAME probe this effect already owns)
  // rather than duplicating diarization_installed into global state.
  useEffect(() => {
    if (!open || !IS_DESKTOP || draft.sidecarMode !== "managed") return;
    let cancelled = false;
    void fetchSidecarHealth(draft).then((health) => {
      if (!cancelled) setDiarizationInstalled(health?.diarization_installed);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft.sidecarMode, diarInstallDone]);

  // 转录引擎 系统/App 音频 macOS-floor gating (S9.4, D6; F9): audiocap_
  // capabilities() is a synchronous OS-version check on the Rust side
  // (NSProcessInfo, no I/O) — probed once per dialog-open via the
  // shared lib/desktop/audiocapCaps.ts module (also Header.tsx's own
  // ENGINE_OPTIONS gate — see that module's POLICY doc), cached for the
  // rest of that open (see audiocapCaps' own doc comment above).
  // probeAudiocapCaps() is IS_DESKTOP-guarded internally (never reaches
  // getInvoke() outside a desktop build) AND never rejects (an error
  // resolves its own fail-open shape — see that module's own doc), so
  // this effect needs no separate .catch() of its own anymore. Unlike
  // the 本地服务/diarization effects just above, deliberately NOT keyed
  // on draft.engine/draft.sidecarMode — floor support depends only on
  // which macOS this machine runs, not on which engine happens to be
  // drafted, so ENGINE_CARDS can render the right disabled/enabled
  // state for 系统/App 音频 even before it's ever been selected this open.
  useEffect(() => {
    if (!open || !IS_DESKTOP) return;
    let cancelled = false;
    void probeAudiocapCaps().then((caps) => {
      if (!cancelled) setAudiocapCaps(caps);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const patch = (p: Partial<Settings>) => setDraft((d) => ({ ...d, ...p }));

  // v0.5.1 appearance sprint (D1/D4): customThemes CRUD writes THROUGH
  // updateSettings immediately (never staged in `draft` — see the
  // themeEditor state's own doc comment above), then patches ONLY
  // draft.themeId so the outer dialog's normal 保存 flow is what
  // actually SELECTS the theme (creating/editing a theme is not the
  // same action as activating it — see ThemeEditor.tsx's own props doc
  // for why 保存主题 alone doesn't need to touch live CSS itself:
  // updateSettings's own side effect (store.ts) already re-resolves +
  // re-applies whenever "customThemes" is in the patch).
  const handleSaveCustomTheme = (theme: ThemeDefinition) => {
    const exists = settings.customThemes.some((t) => t.id === theme.id);
    const next = exists
      ? settings.customThemes.map((t) => (t.id === theme.id ? theme : t))
      : [...settings.customThemes, theme];
    updateSettings({ customThemes: next });
    patch({ themeId: theme.id });
  };

  const handleDeleteCustomTheme = (id: string) => {
    const next = settings.customThemes.filter((t) => t.id !== id);
    // F2 fix (v0.5.1 appearance sprint, GPT-5.6 Sol adversarial review):
    // updateSettings's own customThemes branch (store.ts) only
    // re-resolves+re-applies the VISUAL CSS when the resolve fails
    // (falls back to terminal on screen) — it deliberately leaves
    // settings.themeId itself untouched (see that branch's own doc
    // comment), so deleting the LIVE SAVED active theme without also
    // patching themeId here left it a dangling reference forever (no
    // tile shows selected after reload, the FOUC mirror can't resolve
    // it either). One atomic write-through when the deleted id IS the
    // live active theme.
    if (useApp.getState().settings.themeId === id) {
      updateSettings({ customThemes: next, themeId: "terminal" });
    } else {
      updateSettings({ customThemes: next });
    }
    // The DIALOG's own staged draft.themeId is a separate piece of
    // state updateSettings never touches, so it needs its own explicit
    // fallback when it was pointing at the theme just deleted (D4:
    // "deleting the ACTIVE theme falls back to terminal in both").
    if (draft.themeId === id) patch({ themeId: "terminal" });
  };

  // 导入 (picker-area import, D4): parse -> validate -> ALWAYS re-mint a
  // fresh id (unconditionally, unlike sanitizeRestoredSettings's
  // conditional re-mint on full-backup restore — this is an APPEND into
  // an existing list, so trusting the file's own id even when it
  // already looks like "custom-…" could still collide with something
  // already present) -> append, write-through immediately (same posture
  // as handleSaveCustomTheme above).
  const handleImportThemeJson = (raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      showToast("主题文件不是有效的 JSON");
      return;
    }
    const result = parseTheme(parsed);
    if (!result.ok) {
      showToast(`主题格式不正确：${result.error}`);
      return;
    }
    // F3 fix (v0.5.1 appearance sprint, GPT-5.6 Sol adversarial review):
    // read the LIVE store array here, at commit time, rather than the
    // `settings` hook closure — handleImportThemeFile below awaits
    // file.text() before reaching this point, so two files picked in
    // quick succession (re-picking via the same <input>, see its own
    // onChange) both start from the SAME pre-await closure. Committing
    // against the live array here means whichever completion runs
    // second sees the FIRST one's already-appended theme (single-
    // threaded JS — the commit itself is synchronous once the await
    // resolves), instead of silently overwriting it with a last-write-
    // wins array while both still toast 已导入.
    const liveCustomThemes = useApp.getState().settings.customThemes;
    if (liveCustomThemes.length >= CUSTOM_THEME_CAP) {
      showToast(`最多保存 ${CUSTOM_THEME_CAP} 个自定义主题，请先删除一些`);
      return;
    }
    const id = mintCustomThemeId(
      result.theme.label,
      liveCustomThemes.map((t) => t.id),
    );
    const theme: ThemeDefinition = { ...result.theme, id };
    updateSettings({ customThemes: [...liveCustomThemes, theme] });
    setThemeImportOpen(false);
    setThemeImportText("");
    showToast(`已导入主题「${theme.label}」`);
  };

  const handleImportThemeFile = async (file: File) => {
    const text = await file.text();
    handleImportThemeJson(text);
  };

  // Whole-dialog close (取消 button + backdrop click, wrapped below):
  // ALWAYS re-activate the SAVED settings.themeId — never draft.themeId.
  // Tile clicks only patch the draft (nothing applies until 保存), so on
  // a cancel path the applied visual must land back on the saved theme.
  // Unconditional (not gated on the editor being open) because preview
  // pixels can outlive the editor: 保存主题 leaves the new theme's live
  // preview on screen with only draft.themeId pointing at it — a
  // subsequent 取消 must clean that up too, and re-activating an
  // already-correct theme is an idempotent no-op (17 setProperty calls).
  const handleDialogClose = () => {
    const live = useApp.getState().settings;
    const target = resolveThemeById(live.themeId, live.customThemes);
    if (target) {
      activateTheme(target.id, target.tokens, target.scheme);
    } else {
      resetToDefaultTheme();
    }
    onClose();
  };

  const togglePack = (id: string, checked: boolean) => {
    setCheckedPacks((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const allPacks = getAllPacks();
  const nonCorePackIds = allPacks.filter((p) => p.id !== "core").map((p) => p.id);
  const allPacksChecked = nonCorePackIds.every((id) => checkedPacks.has(id));
  const packEntryCounts = packCounts();
  // v0.6 field-fix (item 1): built-in (non-remote) packs, bucketed by
  // BUILTIN_PACK_GROUP into the 3 collapsible groups + a catch-all 其他
  // — computed once here, rendered far below in 词典主题包. Remote packs
  // are read straight off `allPacks` at that same render site, unchanged.
  const builtinPacks = allPacks.filter((p) => p.id !== "core" && !p.remote);
  const remotePacksList = allPacks.filter((p) => p.remote);
  const packGroups = BUILTIN_PACK_GROUP_ORDER.map((group) => ({
    group,
    packs: builtinPacks.filter((p) => (BUILTIN_PACK_GROUP[p.id] ?? "其他") === group),
  })).filter((g) => g.packs.length > 0);
  // v0.6 field-fix (item 3): 检测模式 segmented control's own derived
  // value — off/dictionary/llm computed straight off the draft state
  // this control edits (draft.autoDetect/aiDetect), matching the SAME
  // vocabulary the store's separate RUNTIME detectMode field uses
  // (store.ts: `state.settings.aiDetect ? "llm" : "dictionary"`, gated
  // off entirely when !autoDetect — see scheduler.ts's own `if
  // (!settings.autoDetect)` early-out).
  const detectModeValue: "off" | "dictionary" | "llm" = !draft.autoDetect
    ? "off"
    : draft.aiDetect
      ? "llm"
      : "dictionary";

  // v0.6 field-fix (item 1): single row renderer shared by every group's
  // expanded body AND the remote-pack flat list below it — "expanding
  // reveals the existing per-pack rows unchanged", byte-identical to the
  // pre-regroup markup either way.
  const renderPackRow = (p: DictPack) => {
    // v0.6 T1: replaces the old blanket "社区" badge — every remote pack
    // now shows whether it's an official jargonslayer-dicts release or
    // something the user pointed at/imported themselves. Recomputed on
    // every render via classifyPackOrigin (never a stored flag — see
    // that function's own doc comment on why). Matched against
    // packSources by pack id since DictPack itself carries no url; a
    // remote pack missing its own source (should never happen — every
    // registry entry came from one) falls back to "" ->
    // classifyPackOrigin's own "imported" default.
    const origin = p.remote
      ? classifyPackOrigin(packSources.find((s) => s.pack.id === p.id)?.url ?? "")
      : null;
    return (
      <label key={p.id} className="flex items-center justify-between gap-3 py-1">
        <div>
          <div className="text-sm text-fg">
            {/* N5 fix (adversarial review): an imported pack's name is
               untrusted remote content — <bdi> isolates it from bidi
               reordering so it can't visually swallow/reorder the
               官方/已导入 badge, which stays in its OWN sibling element
               either way (validateManifest also strips bidi/zero-width
               control chars at the source — this is a second,
               independent layer). */}
            <bdi>{p.name}</bdi>
            {origin && (
              <span
                className="ml-1.5 border border-edge2 px-1.5 py-0 text-[10px] font-normal text-mut"
                title={
                  origin === "official"
                    ? "来自 JargonSlayer 官方词典库"
                    : "由你从外部链接或文件导入，内容未经官方审核"
                }
              >
                {origin === "official" ? "官方" : "已导入"}
              </span>
            )}
          </div>
          <div className="text-xs text-mut2">
            {/* H3(b) fix (adversarial review): a plain
               packEntryCounts[p.id] read turns an id of "__proto__"
               into an Object.prototype access ("Objects are not valid
               as a React child") instead of a real miss —
               validateManifest now rejects that id at install time
               (H3(a)), but this read-side hardening is defense in
               depth. */}
            {p.description}（{Object.hasOwn(packEntryCounts, p.id) ? packEntryCounts[p.id] : 0} 条）
          </div>
        </div>
        <ToggleSwitch checked={checkedPacks.has(p.id)} onChange={(checked) => togglePack(p.id, checked)} />
      </label>
    );
  };

  const handleAddPackSource = async () => {
    const rawUrl = packSourceUrl.trim();
    if (!rawUrl) return;
    setPackInstallError(null);
    const url = resolvePackInstallUrl(rawUrl);
    if (!url) {
      setPackInstallError("请输入有效的 https 链接");
      return;
    }
    setAddingPackSource(true);
    try {
      const { pack } = await addPackSource(url);
      setPackSources(await listPackSources());
      setPackSourceUrl("");
      showToast(`已添加词典包「${pack.name}」`);
    } catch (err) {
      setPackInstallError(err instanceof Error ? err.message : "添加词典包失败");
    } finally {
      setAddingPackSource(false);
    }
  };

  // v0.6 T2: shared parse+install tail for both the file picker and the
  // paste-JSON textarea below — mirrors handleImportThemeJson's own
  // JSON.parse-then-validate split, but addPackFromManifest (unlike
  // parseTheme) never throws — it always resolves {ok, ...}, so there's
  // no separate try/catch needed for the install half itself.
  // N4(b) fix (adversarial review): the raw string's UTF-8 byte length
  // is checked BEFORE JSON.parse — addPackFromManifest itself already
  // enforces MAX_PACK_BYTES, but only after parsing an oversized paste.
  const handleImportPackJson = async (raw: string) => {
    if (new TextEncoder().encode(raw).length > MAX_PACK_BYTES) {
      setPackInstallError("词典包过大：单个词典包不能超过 2 MB");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setPackInstallError("词典包不是有效的 JSON");
      return;
    }
    setPackInstallError(null);
    const result = await addPackFromManifest(parsed);
    if (!result.ok) {
      setPackInstallError(result.error);
      return;
    }
    setPackSources(await listPackSources());
    setPackImportOpen(false);
    setPackImportText("");
    showToast(`已导入词典「${result.pack.name}」`);
  };

  // N4(a) fix (adversarial review): File.size is checked BEFORE
  // file.text() — buffering an oversized file into memory first, cap or
  // not, is the exact thing this is meant to avoid.
  const handleImportPackFile = async (file: File) => {
    if (file.size > MAX_PACK_BYTES) {
      setPackInstallError("词典包过大：单个词典包不能超过 2 MB");
      return;
    }
    const text = await file.text();
    await handleImportPackJson(text);
  };

  // v0.6 T6: 词典库 row action (安装/更新 both funnel through this — an
  // addPackSource on an id that's already installed replaces it, same
  // "last install wins" precedent as a manual URL re-add).
  const handleInstallCatalogPack = async (row: CatalogPackEntry) => {
    setPackInstallError(null);
    const url = resolvePackInstallUrl(row.url);
    if (!url) {
      setPackInstallError("词典目录中的链接无效");
      return;
    }
    setInstallingCatalogId(row.id);
    try {
      const { pack } = await addPackSource(url);
      setPackSources(await listPackSources());
      showToast(`已安装词典「${pack.name}」`);
    } catch (err) {
      setPackInstallError(err instanceof Error ? err.message : "安装词典包失败");
    } finally {
      setInstallingCatalogId(null);
    }
  };

  // N7(d) fix (adversarial review): removePackSource itself now takes a
  // DISCRIMINATED (url, packId) pair instead of one overloaded string —
  // see that function's own doc (remotePacks.ts) for why a merged
  // "s.url || s.pack.id" string can ambiguously match two different
  // sources. This handler takes the whole source so both fields are
  // always available; `identifier` (still `s.url || s.pack.id`) is kept
  // ONLY for the confirm-then-click UI state / React key, which doesn't
  // need to be collision-proof the way the actual delete call does.
  const handleRemovePackSource = async (source: RemotePackSource) => {
    const identifier = source.url || source.pack.id;
    if (confirmRemovePackId !== identifier) {
      setConfirmRemovePackId(identifier);
      setTimeout(() => {
        setConfirmRemovePackId((cur) => (cur === identifier ? null : cur));
      }, 3000);
      return;
    }
    const removed = await removePackSource(source.url, source.pack.id);
    setPackSources(await listPackSources());
    setConfirmRemovePackId(null);
    // N7(b) fix: report success/failure honestly instead of always
    // toasting success regardless of whether the write actually landed.
    if (!removed) {
      showToast("移除词典包失败，请重试");
      return;
    }
    const packId = source.pack.id;
    // Drop the removed pack id from the LIVE draft checkbox state so it
    // can't linger — a stale checked id would silently apply to some
    // future pack that happens to reuse this id.
    setCheckedPacks((prev) => {
      if (!prev.has(packId)) return prev;
      const next = new Set(prev);
      next.delete(packId);
      return next;
    });
    // ...and from the PERSISTED selection too, but only when it's
    // already an explicit list — `enabledPacks: null` has nothing to
    // clean up, and turning it explicit here would resurrect the exact
    // commonWord-suppression bug the materializeEnabledPacks revert
    // (H1/H2) just fixed.
    const persisted = useApp.getState().settings.enabledPacks;
    if (persisted !== null && persisted.includes(packId)) {
      updateSettings({ enabledPacks: persisted.filter((pid) => pid !== packId) });
    }
    showToast("已移除词典包");
  };

  const handleCheckUpdates = async (url?: string) => {
    setCheckingUpdates(true);
    try {
      const updatedIds = await checkUpdates();
      // L5 fix (adversarial review): read the REFRESHED list for the
      // per-source report — the old code read the pre-refresh
      // `packSources` closure, so a toast right after updating could
      // still say "已是最新版本" for the pack it just updated.
      const freshSources = await listPackSources();
      setPackSources(freshSources);
      if (url) {
        // Per-source button: only report on whether this one source
        // changed, even though checkUpdates() refreshes every source.
        const source = freshSources.find((s) => s.url === url);
        const changed = source ? updatedIds.includes(source.pack.id) : false;
        showToast(changed ? "已更新到最新版本" : "已是最新版本");
      } else {
        showToast(updatedIds.length > 0 ? `已更新 ${updatedIds.length} 个词典包` : "全部已是最新版本");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "检查更新失败");
    } finally {
      setCheckingUpdates(false);
    }
  };

  const handleSave = async () => {
    // FIX 2 (field-debugging postmortem, v0.5.1 fieldtest B): baseUrl
    // hygiene at the save boundary — normalize the primary field AND
    // every configured per-task override (see normalizeBaseUrl's own
    // doc comment), then block the save entirely on anything that
    // still doesn't parse as a URL. Runs FIRST, before any other save
    // side effect. No inline-field-error pattern exists anywhere in
    // this dialog (checked every other field's validation — it's
    // always a toast + early return, e.g. the flushSettings failure
    // branch further down), so this follows that same convention
    // rather than inventing a new UI pattern for one field.
    //
    // F4 (Sol MEDIUM #16, fix round): anthropic hides the Base URL
    // field entirely (CredentialFields.tsx's own `provider ===
    // "openai-compat"` gate), and resolveTaskCreds/providerCore.ts
    // never read `baseUrl` for that provider either — normalizing or
    // validating a stale value the user can't even see would block
    // 保存 over an invisible field. Only openai-compat actually uses
    // this field; a non-openai-compat provider's stale baseUrl is left
    // completely as-is (neither normalized nor validated) below.
    const providerUsesBaseUrl = draft.provider === "openai-compat";
    const normalizedBaseUrl = providerUsesBaseUrl ? normalizeBaseUrl(draft.baseUrl) : draft.baseUrl;
    if (providerUsesBaseUrl && !isValidBaseUrl(normalizedBaseUrl)) {
      showToast("Base URL 无效，请检查格式（例如 https://openrouter.ai/api/v1）");
      return;
    }
    // W2 desktop proxy support — same save-boundary hygiene as baseUrl
    // above; desktop-only field, but validated unconditionally here
    // (cheap, and IS_DESKTOP already gates the field OUT of the draft
    // on web/iOS since nothing ever renders it there to set a non-empty
    // value in the first place).
    const normalizedProxyUrl = normalizeProxyUrl(draft.proxyUrl);
    if (!isValidProxyUrl(normalizedProxyUrl)) {
      showToast("代理地址无效，请检查格式（例如 http://127.0.0.1:7890）");
      return;
    }
    let normalizedTaskLlm = draft.taskLlm;
    for (const { domain } of TASK_DOMAIN_META) {
      const override = normalizedTaskLlm?.[domain];
      // enabled:false is runtime-inert — resolveTaskCreds ignores a
      // disabled override's baseUrl/provider/model entirely and falls
      // back to the primary (taskConfig.ts; see its own SECURITY test
      // in taskConfig.test.ts). Validating a value nothing will ever
      // send would block 保存 over a stale field the user already
      // toggled off, e.g. typed-then-abandoned while trying a preset.
      if (!override?.enabled || !override.baseUrl) continue;
      // F4: same provider-awareness as the primary field above — the
      // override's EFFECTIVE provider is `t.provider ?? settings.
      // provider` (resolveTaskCreds.ts's exact fallback — see that
      // function), never `override.provider` alone, since an override
      // that only sets baseUrl/model and leaves provider unset still
      // inherits the primary's provider at runtime.
      if ((override.provider ?? draft.provider) !== "openai-compat") continue;
      const normalized = normalizeBaseUrl(override.baseUrl);
      if (!isValidBaseUrl(normalized)) {
        showToast("Base URL 无效，请检查格式（例如 https://openrouter.ai/api/v1）");
        return;
      }
      normalizedTaskLlm = { ...normalizedTaskLlm, [domain]: { ...override, baseUrl: normalized } };
    }
    // FINDING 11 fix: taskLlm.*.apiKey is the one credential `toSave`
    // below never ran through sanitizeSecretValue — every top-level
    // SECRET_NAMES field gets the zero-width/whitespace self-heal (see
    // that block's own comment), but a per-task override key never did,
    // even though the 密钥 hub's 分任务覆盖 rows now offer it as a
    // first-class paste target. Deliberately its OWN unconditional pass,
    // not folded into the loop above: that loop skips any override that
    // is disabled or missing baseUrl, but the hub's SecretKeyRow onChange
    // can leave an override sitting `enabled:false` with only `apiKey`
    // set (it preserves whatever `enabled` already was), so a dirty
    // paste there must still self-heal regardless.
    for (const { domain } of TASK_DOMAIN_META) {
      const override = normalizedTaskLlm?.[domain];
      if (!override?.apiKey) continue;
      const sanitizedApiKey = sanitizeSecretValue(override.apiKey);
      if (sanitizedApiKey !== override.apiKey) {
        normalizedTaskLlm = {
          ...normalizedTaskLlm,
          [domain]: { ...override, apiKey: sanitizedApiKey },
        };
      }
    }

    const enabledPacks = allPacksChecked ? null : nonCorePackIds.filter((id) => checkedPacks.has(id));
    // uiMode is deliberately excluded from `draft` — the header toggle
    // above writes it straight through updateSettings the moment it's
    // clicked (a view preference, not part of 保存's flow). `draft`
    // still carries whatever uiMode was LIVE when the dialog opened, so
    // spreading it wholesale here would revert a toggle click made
    // while the dialog was open (tag-blocker HIGH 3) — always take the
    // live value instead. customThemes has the SAME staleness problem
    // (v0.5.1): ThemeEditor's save/delete/import all write straight
    // through updateSettings (D1), never touching `draft`, so
    // draft.customThemes is frozen at whatever it was when this dialog
    // opened — spreading it here would silently undo any theme
    // created/edited/deleted during this session the moment 保存 is
    // clicked for ANY reason, same class of bug uiMode already had.
    const toSave: Settings = {
      ...draft,
      enabledPacks,
      uiMode: useApp.getState().settings.uiMode,
      customThemes: useApp.getState().settings.customThemes,
      // Round-2 dict-pack auto-update: same class of staleness bug
      // uiMode/customThemes already had (see this object's own leading
      // comment above) — packAutoUpdateCheckedAt is written by
      // background code (app/dictPackAutoUpdateTrigger.ts) any time
      // while this dialog happens to be open, never through `draft`;
      // spreading draft's dialog-open-time snapshot here would silently
      // roll back a fresher background-recorded timestamp on ANY 保存.
      packAutoUpdateCheckedAt: useApp.getState().settings.packAutoUpdateCheckedAt,
      // Sol r4+r5 (v0.7 translation train): translateEngine is ALSO
      // written by background code while this dialog sits open
      // (hydrate()'s one-shot llm→system migration) — same staleness
      // class as packAutoUpdateCheckedAt above, EXCEPT this field is
      // editable in the dialog too. Resolution rides the engineTouched
      // edit-intent flag (NOT draft-vs-snapshot equality, which loses
      // the ABA pick-and-return case): untouched this session → live
      // value wins, so a stale draft can't roll a migrated user back
      // to llm with the marker already true (permanent, silent); any
      // touched draft wins as the user's explicit pick. Marker rides
      // the same rule; updateSettings' monotonic latch belts it.
      translateEngine: engineTouched
        ? draft.translateEngine
        : useApp.getState().settings.translateEngine,
      // Sol r6 (BLOCKER): a touched save stages the marker TRUE itself,
      // not the draft's stale copy — an ABA pick (llm→system→llm) saved
      // while the migration probe is still in flight produces no engine
      // value change for updateSettings to stamp, and the resolving
      // probe would otherwise overwrite the explicit choice.
      translateEngineMigrated: engineTouched
        ? true
        : useApp.getState().settings.translateEngineMigrated,
      // F5 fix: sanitize custom: font values at this same persistence
      // boundary — see sanitizeDraftFontValue's own doc comment.
      uiFont: sanitizeDraftFontValue(draft.uiFont),
      monoFont: sanitizeDraftFontValue(draft.monoFont),
      // FIX 2: the normalized (trimmed/ASCII-punctuation/no-trailing-
      // slash) forms computed above — validated already, so these are
      // always well-formed (or empty) by this point.
      baseUrl: normalizedBaseUrl,
      taskLlm: normalizedTaskLlm,
      // W2: same "normalized + already validated above" guarantee.
      proxyUrl: normalizedProxyUrl,
      // Field bug fix (iOS TestFlight, sanitizeSecret.ts's own doc):
      // strip pasted zero-width chars + trim whitespace from every
      // SECRET_NAMES field at this same save boundary — mirrors
      // normalizeBaseUrl above, just for each allowed secret-shaped field
      // instead of baseUrl.
      apiKeyAnthropic: sanitizeSecretValue(draft.apiKeyAnthropic ?? ""),
      apiKeyOpenai: sanitizeSecretValue(draft.apiKeyOpenai ?? ""),
      apiKeyDeepseek: sanitizeSecretValue(draft.apiKeyDeepseek ?? ""),
      apiKeyQwen: sanitizeSecretValue(draft.apiKeyQwen ?? ""),
      apiKeyOpenrouter: sanitizeSecretValue(draft.apiKeyOpenrouter ?? ""),
      apiKeyPoe: sanitizeSecretValue(draft.apiKeyPoe ?? ""),
      apiKeyOllama: sanitizeSecretValue(draft.apiKeyOllama ?? ""),
      apiKeyCustom: sanitizeSecretValue(draft.apiKeyCustom ?? ""),
      hfToken: sanitizeSecretValue(draft.hfToken),
      sonioxKey: sanitizeSecretValue(draft.sonioxKey),
      deepgramKey: sanitizeSecretValue(draft.deepgramKey),
      elevenLabsKey: sanitizeSecretValue(draft.elevenLabsKey),
      deeplKey: sanitizeSecretValue(draft.deeplKey),
      youdaoAppKey: sanitizeSecretValue(draft.youdaoAppKey),
      youdaoAppSecret: sanitizeSecretValue(draft.youdaoAppSecret),
      agentToken: sanitizeSecretValue(draft.agentToken),
    };
    // Finding 2d: sidecarMode is a LAUNCH-TIME decision — bootstrap.ts's
    // getSidecarMode is only ever read once, at app start (Finding 2c)
    // — so switching it here can't take effect live; tell the user a
    // restart is needed instead of silently saving a toggle that won't
    // do anything until then. No live engine switching.
    const sidecarModeChanged = IS_DESKTOP && draft.sidecarMode !== settings.sidecarMode;
    // Sol #3 fix (BYOK preview sprint, 2026-07-21): coercePreviewModels
    // above only ran ONCE, at draft-seed time (dialog open) — clearing
    // the primary Key field mid-dialog, or picking a preset that force-
    // fills detectModel/summaryModel (handleSelectPreset below), can
    // leave `toSave` keyless with an off-allowlist model that never
    // passed through it. Re-running the SAME function at this, the
    // actual persistence boundary, closes both holes with the one
    // allowlist source of truth instead of re-deriving the check here.
    updateSettings(coercePreviewModels(toSave));
    // Desktop keychain custody (v0.5.1 desktop keychain migration):
    // updateSettings above already enqueued a Keychain write for any
    // changed SECRET_NAMES field (store.ts's syncSecretCustody) — await
    // those settling BEFORE flushSettings below, so custody is fully up
    // to date before settingsForPersist decides what to strip from the
    // IDB blob it's about to write. A write failure surfaces its own
    // non-blocking warning toast from the store (never thrown here); the
    // blocking catch further down stays reserved for genuine IDB
    // failures. No-op on web.
    if (IS_DESKTOP) {
      await useApp.getState().flushSecrets();
    }
    // Field-test fix: updateSettings' own persist above is fire-and-
    // forget (store.ts) — a key saved right before quit could still lose
    // the race against app teardown. Await the write actually committing
    // before this dialog closes/toasts "已保存".
    //
    // F2 fix (Sol MEDIUM review): flushSettings can now reject (storage.
    // saveSettings propagates IndexedDB failures instead of always
    // resolving — see both functions' own docs) — on failure, show an
    // explicit error toast and KEEP the dialog open instead of falling
    // through to the success toast + onClose, so the user isn't told
    // "已保存" (and the dialog doesn't vanish) over a write that didn't
    // actually land. Only the parts that CLAIM success — enabling the
    // just-checked packs, the success toast, closing — are gated; the
    // live in-memory settings update above already happened regardless
    // (matches updateSettings' own fire-and-forget persist, unaffected
    // by this).
    try {
      await useApp.getState().flushSettings();
    } catch {
      showToast("设置保存失败，请重试（存储不可用或空间不足）");
      return;
    }
    setEnabledPacks(enabledPacks);
    showToast(sidecarModeChanged ? "已保存，重启应用后生效" : "设置已保存");
    onClose();
  };

  const handleSelectPreset = (id: ProviderPresetId) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const patchValues: Partial<Settings> = {
      provider: preset.provider,
      baseUrl: preset.baseUrl,
    };
    if (preset.suggestedModels) {
      patchValues.detectModel = preset.suggestedModels.detectModel;
      if (preset.suggestedModels.summaryModel) {
        patchValues.summaryModel = preset.suggestedModels.summaryModel;
      }
    }
    patch(patchValues);
  };

  // #56 分任务模型（高级）: one domain's TaskLlmConfig changed — fold it
  // into draft.taskLlm, preserving the other two domains untouched.
  const handleTaskLlmChange = (domain: LlmTaskDomain, next: TaskLlmConfig | undefined) => {
    patch({ taskLlm: { ...draft.taskLlm, [domain]: next } });
  };

  // "Connect with OpenRouter" — OAuth PKCE one-click key provisioning
  // (https://openrouter.ai/docs/use-cases/oauth-pkce).
  //
  // Desktop (S10 field-fix, Chunk A, Q1 verdict): RFC-8252 loopback via
  // the system browser — WKWebView can't usefully navigate to an
  // arbitrary https:// URL (blueprint triage table item 2), so this
  // branch never falls through to the web tab-redirect flow below.
  // Mirrors OnboardingByokStep.tsx's own connectWithOAuth exactly (same
  // helper, same describeOAuthFailure hint copy — no duplicated failure
  // labels).
  //
  // Web: BYTE-IDENTICAL to before this sprint — generates a fresh
  // code_verifier + a random state, stashes both in sessionStorage
  // (must survive the full-page redirect — see openrouterPkce.ts's
  // module comment), then navigates the whole tab to OpenRouter's
  // /auth. NOTE: the verified spec's /auth query params are only
  // callback_url/code_challenge/code_challenge_method — no `state`
  // param is documented, so it is NOT sent to OpenRouter (an
  // undocumented param could be silently dropped or rejected). The
  // stored state is still checked by the callback page IF OpenRouter
  // happens to echo one back; the real replay protection here is PKCE
  // itself — the code alone is useless without this verifier.
  const handleConnectOpenRouter = async () => {
    if (IS_DESKTOP) {
      setConnectingOpenRouter(true);
      setOpenRouterOauthHint(null);
      // Field-test-fix follow-up: snapshotted BEFORE the call, so the
      // post-connect merge below can tell whether connectOpenRouterDesktop's
      // own conditional detectModel/summaryModel remap
      // (openrouterModelDefaults.ts) actually fired THIS time — see
      // that merge's own comment for why a plain "always pull live
      // model into draft" would reintroduce the exact clobber this
      // whole block exists to prevent.
      const beforeSettings = useApp.getState().settings;
      try {
        const result = await connectOpenRouterDesktop();
        if (result.ok) {
          // connectOpenRouterDesktop() already wrote provider/baseUrl/
          // apiKey straight to the LIVE store (pinned contract — the
          // exact same write the web callback page does, see that
          // module's own doc comment) — this dialog's own `draft` is a
          // snapshot taken at open time, so it must be resynced here or
          // 保存 would silently clobber the just-connected key with the
          // stale draft. F5 (adversarial review, MEDIUM): unlike
          // handleConfirmRestore's own post-restore resync just below
          // (a full backup replace is meant to overwrite everything),
          // an OAuth connect touches ONLY these three fields — a
          // wholesale setDraft(liveSettings) here was clobbering any
          // OTHER unsaved draft edit (a language pick, a model field, …)
          // made earlier in the SAME dialog session. Functional update,
          // merging just provider/baseUrl/apiKey into the EXISTING
          // draft instead.
          //
          // Field-test fix (real user report): connectOpenRouterDesktop
          // may ALSO have remapped detectModel/summaryModel (a bare
          // Anthropic id 400s on OpenRouter) — that write landed on the
          // LIVE store same as provider/baseUrl/apiKey above, so it
          // needs the identical resync or a later 保存 would silently
          // revert it back to the stale pre-connect draft value (the
          // exact bug: OAuth "fixes" the model, then 保存 undoes the
          // fix). remapOpenRouterModelDefaults is CONDITIONAL (only
          // overwrites a bare id), so an unconditional pull-into-draft
          // here would clobber an unrelated, still-unsaved 检测模型/
          // 会议报告模型 edit the user typed in THIS dialog session.
          //
          // R3 (adversarial review, HIGH): the gate below must check
          // whether the DRAFT itself is dirty (`draft[field] ===
          // beforeSettings[field]`), NOT whether `live` changed —the
          // ORIGINAL gate (`live[field] !== beforeSettings[field]`)
          // pulled the live value into the draft whenever the remap
          // fired on the LIVE store, with zero regard for whether the
          // user had ALREADY typed a different, still-unsaved model
          // into the draft in this same session — clobbering that
          // unsaved edit the instant OAuth's own conditional remap
          // happened to also touch the live model. Checking the draft's
          // own dirtiness instead preserves any unsaved edit
          // unconditionally, while still resyncing an untouched draft
          // field to whatever the live remap decided.
          {
            // #58 fix round FIX 3 note: savedSnapshot is deliberately NOT
            // resynced here, unlike handleConfirmRestore's own full
            // resync above — this is a partial field merge (provider/
            // baseUrl/apiKey/±model only) that must still read as dirty
            // until 保存, not a wholesale replace. This whole branch is
            // also IS_DESKTOP-only (unreachable on iOS) besides. Don't
            // "fix" this symmetrically with the restore path.
            const live = useApp.getState().settings;
            setDraft((d) => ({
              ...d,
              provider: live.provider,
              baseUrl: live.baseUrl,
              ...providerApiKeyPatch(
                live.provider,
                live.baseUrl,
                resolveProviderApiKey(live),
              ),
              ...(d.detectModel === beforeSettings.detectModel
                ? { detectModel: live.detectModel }
                : {}),
              ...(d.summaryModel === beforeSettings.summaryModel
                ? { summaryModel: live.summaryModel }
                : {}),
            }));
          }
          showToast("已成功连接 OpenRouter");
        } else {
          setOpenRouterOauthHint(describeOAuthFailure(result.reason, result.message));
        }
      } finally {
        setConnectingOpenRouter(false);
      }
      return;
    }

    const verifier = generateCodeVerifier();
    const state = generateCodeVerifier(43);
    sessionStorage.setItem(OAUTH_VERIFIER_STORAGE_KEY, verifier);
    sessionStorage.setItem(OAUTH_STATE_STORAGE_KEY, state);
    const codeChallenge = await codeChallengeS256(verifier);
    const callbackUrl = `${window.location.origin}${withBase("/oauth/openrouter")}`;
    window.location.href = buildAuthUrl({ callbackUrl, codeChallenge });
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    try {
      const res = await testConnection(draft);
      setTestConnectionOk(res.ok);
      showToast(res.message);
    } finally {
      setTestingConnection(false);
    }
  };

  // 转录引擎 sidecar status line: manual 重新检测 — same probe the
  // open/engine-switch effect above already ran once; useful after
  // editing Whisper 地址 or actually starting the sidecar process
  // without re-selecting the engine card (which is the effect's only
  // other trigger).
  const handleCheckSidecarStatus = async () => {
    setCheckingSidecarStatus(true);
    try {
      const result = await probeSidecar(draft);
      setSidecarStatus(result);
      useApp.getState().setSidecarUp(result.up);
    } finally {
      setCheckingSidecarStatus(false);
    }
  };

  // 转录引擎 系统/App 音频 permission-denied CTA (S9.4, D6): fires the
  // Rust-side open_privacy_settings() command (audiocap.rs) — best-
  // effort/uncontracted on ITS OWN side (tries the direct 屏幕与系统音频
  // 录制 deep link, falls back to the bare 隐私与安全性 pane, never
  // reports which leg actually worked back to us), so this handler
  // itself only guards against invoke() throwing outright (e.g. a
  // structurally missing command) — the always-visible manual-path text
  // beside this button is the real fallback for "neither deep link
  // actually opened anything", not a toast here.
  const handleOpenPrivacySettings = async () => {
    try {
      const invoke = await getInvoke();
      await invoke("open_privacy_settings");
    } catch (err) {
      showToast(err instanceof Error ? `无法打开系统设置：${err.message}` : "无法打开系统设置");
    }
  };

  // v0.4 S3 chunk 6: managed-mode 「重新运行安装向导」 — reuses the SAME
  // module-level bootstrap handle DesktopBootstrap.tsx already drives
  // (initDesktop() is idempotent, see bootstrap.ts's own doc comment),
  // so this dialog needs no lib/desktop/* wiring of its own beyond this
  // one call.
  const handleReprovisionDesktop = async () => {
    setReprovisioningDesktop(true);
    try {
      const handle = await initDesktop();
      await handle.reprovision();
      showToast("已清空本地安装记录，正在重新打开安装向导…");
    } catch (err) {
      showToast(err instanceof Error ? `重新运行安装向导失败：${err.message}` : "重新运行安装向导失败");
    } finally {
      setReprovisioningDesktop(false);
    }
  };

  // v0.4 S4 chunk 4 (blueprint decision C): 转录引擎 更换模型 — opens the
  // inline <ModelPicker>, preselected to the truthful installed model
  // (falling back to the user's own persisted preference,
  // draft.whisperModel, while that's still loading/unknown — decision
  // C's own "target vs truth" distinction).
  const handleOpenModelPicker = () => {
    setPickedModel(installedModel ?? draft.whisperModel);
    setModelPickerOpen(true);
  };

  // v0.4 S4 chunk 4 (blueprint decision C's switch flow), S10 field-fix
  // #6 jobsBridge swap (wave 2): 下载并切换 — an IMMEDIATE action (like
  // 重新运行安装向导 above), not a draft-saved setting — settings.
  // whisperModel is written by handle.switchModel() itself on success
  // (inside jobsBridge.trackSwitchModel), so this deliberately never
  // runs through patch()/handleSave's draft flow. DISPATCHES the switch
  // as a "model-download" registry task and returns immediately —
  // TaskCenterDrawer/TaskTray own its progress/success/failure from
  // here on (switchingModel above already derives from this same task
  // id), so this dialog closes the picker right away rather than
  // showing its own now-redundant "处理中…" wait.
  const handleSwitchModel = async () => {
    const model = pickedModel;
    const handle = await initDesktop();
    const id = trackSwitchModel(handle, model);
    setSwitchModelTaskId(id);
    setModelPickerOpen(false);
    showToast("已开始下载并切换模型，进度见右下角「后台任务」");
  };

  // v0.4 S3 chunk 7, generalized by the beta-phase diagnostics audit
  // item 1: 诊断信息 面板的 「查看本地日志」 — desktop-only, reads whichever
  // of the three allowlisted log files `logSource` currently names via
  // Rust's read_app_log (provision.rs). Routed through the SAME
  // module-level bootstrap handle DesktopBootstrap.tsx already drives
  // (initDesktop() is idempotent) rather than calling tauriApi.ts's
  // getInvoke() directly a second time — see bootstrap.ts's readAppLog
  // doc comment for why a second independent caller of that exported
  // function would reopen the exact web-bundle tree-shake leak this
  // task's own gate caught and fixed.
  const handleViewAppLog = async () => {
    // F6 fix (adjudicated review): capture the source THIS read is for
    // before the await — if the user switches the <select> while the
    // read is in flight, logSourceRef.current has already moved on by
    // the time the response lands, so the stale response is discarded
    // instead of painting under the now-selected (different) source.
    const requestedSource = logSource;
    setLoadingAppLog(true);
    try {
      const handle = await initDesktop();
      const text = await handle.readAppLog(requestedSource, 200);
      if (logSourceRef.current !== requestedSource) return; // stale — source changed while in flight
      setAppLogText(text);
    } catch (err) {
      showToast(err instanceof Error ? `读取本地日志失败：${err.message}` : "读取本地日志失败");
    } finally {
      setLoadingAppLog(false);
    }
  };

  // v0.4 S5 chunk 3 (blueprint decisions A/B), S10 field-fix #6
  // jobsBridge swap (wave 2): 说话人分离 安装扩展 — an IMMEDIATE action
  // (like 重新运行安装向导/下载并切换 above), never routed through
  // patch()/draft/保存. DISPATCHES the install as a "diar-install"
  // registry task and returns immediately — TaskCenterDrawer/TaskTray
  // own its progress/success/failure from here on (installingDiarization
  // above already derives from this same task id; jobsBridge.
  // trackInstallDiar's own success handler re-probes the sidecar and
  // mirrors sidecarUp into the store, decision C's "the running server
  // is the truth" posture). F7 (adversarial review): that store mirror
  // alone left THIS dialog's own diarizationInstalled/需先安装 HF-token
  // gating stale — the probe effect above now also re-runs live once
  // this task reaches "done" (diarInstallDone), while the dialog stays
  // open — not just on reopen. installedModel above is unaffected
  // (still only refreshes on reopen).
  const handleInstallDiarization = async () => {
    const handle = await initDesktop();
    const id = trackInstallDiar(handle);
    setDiarInstallTaskId(id);
    showToast("已开始安装说话人分离扩展，进度见右下角「后台任务」");
  };

  const handleCheckDiarizationStatus = async () => {
    setCheckingDiarization(true);
    try {
      const health = await fetchSidecarHealth(draft);
      if (!health) {
        showToast("无法连接本地 Whisper，请先启动（README）");
        return;
      }
      if (health.diarization_ready) {
        showToast("说话人分离已就绪");
      } else {
        showToast(
          health.diarization_error
            ? `说话人分离暂不可用：${health.diarization_error}`
            : "说话人分离未就绪",
        );
      }
    } finally {
      setCheckingDiarization(false);
    }
  };

  // S11 osspeech blueprint (§3 Worker D, §Q5) — 系统识别 卡片's own 预下载
  // 模型 button: an immediate action (like handleCheckDiarizationStatus
  // above), calling Worker C's preinstallOsSpeech(locale) directly.
  // draft.language is this dialog's own in-progress pick (mirrors every
  // other 转录引擎-scoped read in this section reading `draft`, not the
  // committed `settings`) — preinstallOsSpeech itself resolves once the
  // model finishes installing (or rejects on failure/a busy single-flight
  // guard), which is exactly this button's own busy -> done/failed
  // window. S11 fix-round J5: records WHICH language just finished (not
  // a bare boolean) — see osSpeechPreinstallDone's own derivation above.
  const handlePreinstallOsSpeech = async () => {
    setPreinstallingOsSpeech(true);
    try {
      await preinstallOsSpeech(draft.language);
      setOsSpeechPreinstallDoneLanguage(draft.language);
    } catch (err) {
      showToast(err instanceof Error ? `预下载失败：${err.message}` : "预下载失败");
    } finally {
      setPreinstallingOsSpeech(false);
    }
  };

  // 订阅直连（实验性）: probes GET /agent/health, mirroring
  // handleCheckDiarizationStatus's "no toast on open, explicit button
  // for a manual re-check" UX — but ALSO run once automatically when
  // the dialog opens (see the useEffect above) so the status dot
  // reflects reality without the user having to click anything first,
  // same as how the diarization section itself doesn't auto-probe but
  // this newer section's state-machine design (Q6) calls for an
  // upfront read.
  const handleCheckAgentHealth = async () => {
    setCheckingAgentHealth(true);
    try {
      const health = await agentHealth(draft);
      setAgentHealthState(health);
    } finally {
      setCheckingAgentHealth(false);
    }
  };

  const handleChooseExportFolder = async () => {
    const name = await chooseExportFolder();
    if (name) {
      setExportFolderName(name);
      showToast(`已选择导出文件夹：${name}`);
    }
  };

  const handleClearExportFolder = async () => {
    await clearExportFolder();
    setExportFolderName(null);
    showToast("已清除导出文件夹");
  };

  // 全量备份 (#57): downloads sessions + 词典 + settings as one JSON via
  // export.ts's downloadFile (share-sheet on iOS, throwaway <a download>
  // blob link elsewhere) — no server round-trip, matches this app's
  // local-first storage model. exportStripKeys (default checked) strips
  // key material before it ever leaves buildFullBackup.
  const handleExportBackup = async () => {
    const json = await buildFullBackup({ includeKeys: !exportStripKeys });
    const date = new Date().toISOString().slice(0, 10);
    void downloadFile(`jargonslayer-backup-${date}.json`, json, "application/json");
    showToast(exportStripKeys ? "已导出备份（不含 API Key）" : "已导出备份（含 API Key，请妥善保管）");
  };

  // 导入备份 step 1: read the picked file and show a confirmation step
  // (counts + what will be merged/overwritten) BEFORE writing anything —
  // restore is destructive-ish (settings are replaced wholesale, see
  // restoreFullBackup's own doc comment), so nothing happens on file
  // pick alone.
  const handlePickBackupFile = async (file: File) => {
    setRestoreError(null);
    const text = await file.text();
    try {
      const { sessions, entries, learnset, packSources, hasSettings, hasApiKey } = previewBackup(text);
      setRestorePreview({ text, sessions, entries, learnset, packSources, hasSettings, hasApiKey });
    } catch (err) {
      setRestorePreview(null);
      setRestoreError(err instanceof Error ? err.message : "备份文件解析失败");
    }
  };

  // 导入备份 step 2: user confirmed — actually merge sessions/词典
  // (upsert by id) and replace settings wholesale (if present), then
  // re-hydrate the live store from storage (mirrors HistoryDrawer's
  // post-import pattern) so the rest of the app reflects the restored
  // data without a full page reload.
  const handleConfirmRestore = async () => {
    if (!restorePreview) return;
    setRestoring(true);
    try {
      const { sessions, entries, learnset, settingsRestored } = await restoreFullBackup(
        restorePreview.text,
      );
      await useApp.getState().hydrate();
      setRestorePreview(null);
      showToast(
        `已恢复 ${sessions} 场会议、${entries} 条词典、${learnset} 条学习记录` +
          (settingsRestored ? "，设置已替换为备份版本" : ""),
      );
      // draft is a local snapshot taken when the dialog opened — resync
      // it to the just-restored (and now re-hydrated) live settings so
      // 保存 doesn't stomp the restore with the stale pre-restore draft.
      //
      // #58 fix round FIX 3 (both reviewers): savedSnapshot must resync
      // from this SAME value too, or the iOS sticky-save-bar's draftDirty
      // check permanently reads this as an unsaved edit after a restore
      // that actually already landed. checkedPacks must resync as well
      // (same seeding expression the dialog-open effect above uses) — 保存
      // otherwise derives enabledPacks from the PRE-restore pack
      // selection still sitting in that Set, silently undoing the
      // restored one the next time the user clicks 保存.
      const resynced = coercePreviewModels(useApp.getState().settings);
      setDraft(resynced);
      setSavedSnapshot(resynced);
      // Full restore replaced the draft wholesale — any pre-restore
      // engine edit intent is void (Sol r5 engineTouched contract).
      setEngineTouched(false);
      setCheckedPacks(
        new Set(resynced.enabledPacks ?? getAllPacks().filter((p) => p.id !== "core").map((p) => p.id)),
      );
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "恢复失败");
    } finally {
      setRestoring(false);
    }
  };

  // 诊断信息: 复制诊断信息 copies the same bundle a ref-carrying toast's
  // 复制诊断 action does (see Toast.tsx) — buildDiagnosticReport already
  // strips key material, see report.ts's own doc comment.
  const handleCopyDiagnostics = async () => {
    const ok = await copyDiagnosticReport(useApp.getState().settings);
    showToast(ok ? "诊断信息已复制到剪贴板" : "复制失败，请检查浏览器剪贴板权限");
  };

  // 诊断信息: 导出诊断文件 saves the SAME bundle 复制诊断信息 copies
  // (buildFullDiagnosticReport — desktop builds also get the three
  // app-log tails, see report.ts's own doc comment) as a .md file via
  // export.ts's downloadFile, which already routes iOS through the
  // system share sheet — never reimplemented here.
  const handleExportDiagnostics = async () => {
    const text = await buildFullDiagnosticReport(useApp.getState().settings);
    const date = new Date().toISOString().slice(0, 10);
    await downloadFile(`jargonslayer-diagnostics-${date}.md`, text, "text/markdown");
  };

  const handleClearDiagnostics = () => {
    clearDiag();
    setDiagEntries([]);
    showToast("诊断记录已清空");
  };

  const activePreset = presetIdFor(PROVIDER_PRESETS, draft);
  const draftApiKey = resolveProviderApiKey(draft);
  const savedApiKey = resolveProviderApiKey(settings);
  // 实时说话人分离（beta）: only meaningful for the local-audio engines
  // that go through wsTransport.ts (whisper/tabaudio, and appaudio —
  // S9/D7 — since AppAudioEngine drives the SAME WsTransport seam via
  // attachPcmFeed()), and only runnable once a token is configured
  // (mirrors the sidecar's own arming gate: config.diarize truthy AND a
  // token available). Preview tier (#61): always unavailable — the
  // whole 说话人分离 section's inputs are disabled there, but this also
  // guards against a persisted hfToken + whisper/tabaudio/appaudio
  // engine surviving into a preview build (e.g. an imported full-tier
  // settings export) from evaluating true and enabling the checkbox
  // despite the section's greyed-out fields.
  //
  // S12b fix round FB7-settings (§F): parakeet rides the SAME `whisper`
  // STTEngineKind (blueprint Q1 — it's a MODEL under `whisper`, not a
  // new engine), so `draft.engine === "whisper"` alone can't tell
  // parakeet apart from faster-whisper here — isMlxOnlyModel does. Both
  // the SELECTED preference (draft.whisperModel — what 保存 would make
  // live) and the truthful INSTALLED model (installedModel — what's
  // actually running right now) gate this: either one being parakeet
  // means diarization can't actually run (pyannote isn't in the mlx
  // venv at all), so the toggle must not arm on the strength of the
  // other alone.
  const isParakeetSelectedOrInstalled = isMlxOnlyModel(draft.whisperModel) || isMlxOnlyModel(installedModel);
  const realtimeDiarizeAvailable =
    !PREVIEW_TIER &&
    (draft.engine === "whisper" || draft.engine === "tabaudio" || draft.engine === "appaudio") &&
    !isParakeetSelectedOrInstalled &&
    !!draft.hfToken;
  // 双语转录 (#42): the translation target IS explainLanguage — "en"
  // would mean translating English into English, so the toggle is
  // disabled (zh-only for now; more languages later, see Settings.
  // explainLanguage).
  const bilingualTranscriptAvailable = draft.explainLanguage !== "en";
  // #62 progressive disclosure: the dialog's current level. Read from
  // the LIVE settings (not draft) — the header toggle below writes
  // straight through updateSettings, outside the draft/保存 flow (a
  // pure view preference, same posture as themeId's live-apply-on-
  // write, see updateSettings' own side effects). S13: reuses
  // uiVisibilityLevel (pinned to "advanced" on iOS, see that const's
  // own doc comment above) rather than settings.uiMode directly, so
  // every isSectionVisible(level, ...) row-level check below this point
  // (and the segmented control's own `level === opt.value` highlight,
  // desktop-only) inherits the iOS pin automatically — identical to
  // settings.uiMode on desktop/web, where uiVisibilityLevel is just an
  // alias for it.
  const level = uiVisibilityLevel;

  // Sol #7 fix (BYOK preview sprint, 2026-07-21): the AI 检测 banner
  // below (aiDetectPreviewBanner) states ONE posture off draft.apiKey
  // alone — accurate for the primary domain, but a mixed taskLlm setup
  // can route a single task on a genuinely different key than the
  // primary. resolveTaskCreds' own `||` inheritance means an ENABLED
  // override with a blank Key of its own always resolves to the SAME
  // keyed-ness as the primary (never a mismatch) — the only real
  // divergence is an override that supplies (or the primary supplies,
  // and the override explicitly doesn't) its OWN key, so this only
  // fires when at least one enabled override's resolved keyed-ness
  // actually differs from the primary's.
  const taskLlmRoutingDiverges = TASK_DOMAIN_META.some((meta) => {
    if (!draft.taskLlm?.[meta.domain]?.enabled) return false;
    return !!resolveTaskCreds(draft, meta.domain).apiKey !== !!draftApiKey;
  });

  // F4 fix (field-test batch C, Sol M3): the desktop transport wrapper
  // reads the SAVED settings.proxyUrl, not this draft — an unsaved
  // proxy edit would otherwise be silently ignored by exactly the two
  // actions (测试连接 / OpenRouter connect below) whose entire point is
  // to verify connectivity through it. Desktop-only, same IS_DESKTOP
  // gate the proxy field itself renders under.
  const proxyDraftDirty =
    IS_DESKTOP && normalizeProxyUrl(draft.proxyUrl) !== normalizeProxyUrl(settings.proxyUrl);
  const proxyDraftDirtyHint = "代理设置已修改，保存后再测试/连接";

  // S13 iOS mobile-UX round (Part B #2): root-list grouping — desktop/
  // web never read these (the nav rail below stays a flat
  // visibleCategories.map, unchanged). #58 FIX 5: 常用 is derived by
  // EXCLUSION (everything not tagged advanced) — see
  // IOS_ADVANCED_CATEGORY_IDS's own doc comment above.
  const iosCommonCategories = visibleCategories.filter((c) => !IOS_ADVANCED_CATEGORY_IDS.includes(c.id));
  const iosAdvancedCategories = visibleCategories.filter((c) => IOS_ADVANCED_CATEGORY_IDS.includes(c.id));
  // Part B: detail view's own header label — desktop/web never read this.
  const activeCategoryLabel = SETTINGS_CATEGORIES.find((c) => c.id === activeCategory)?.label ?? "";
  // Part B #4: drives the iOS sticky save bar's visibility only —
  // desktop/web keep today's always-visible footer, unaffected by this.
  //
  // #58 fix round FIX 1 (BLOCKER, both reviewers, repro-confirmed):
  // enabledPacks is derived from `checkedPacks`, a Set kept OUTSIDE
  // `draft` (see that state's own doc comment above) — handleSave below
  // only folds it into Settings at save time, so a plain draft/
  // savedSnapshot stringify-compare could never see a pack toggle: the
  // sticky bar never showed, and the toggle silently reverted on close.
  // Compared set-wise (checkedPacks/enabledPacks order is not canonical),
  // not via the stringify below. enabledPacks is the ONE thing handleSave
  // persists that does not live in draft — any future non-draft field
  // handleSave writes must join this signal too.
  const nextEnabledPacks = allPacksChecked ? null : nonCorePackIds.filter((id) => checkedPacks.has(id));
  const savedEnabledPacks = savedSnapshot.enabledPacks;
  const packsDirty =
    (savedEnabledPacks === null) !== (nextEnabledPacks === null) ||
    (savedEnabledPacks !== null &&
      nextEnabledPacks !== null &&
      (savedEnabledPacks.length !== nextEnabledPacks.length ||
        nextEnabledPacks.some((id) => !savedEnabledPacks.includes(id))));
  // FIX 2 (Sol LOW, folded in here): stableStringify (module scope,
  // recursively sorted object keys) instead of a raw JSON.stringify —
  // TaskDomainBlock reconstructs a taskLlm override object in a
  // different key order than the one this dialog last saved, which a
  // plain stringify compare reads as a phantom edit despite being the
  // same value.
  // engineTouched joins the dirty check (Sol r5): an ABA engine edit
  // leaves draft equal to the snapshot but must still offer 保存.
  const draftDirty =
    IS_IOS && (packsDirty || engineTouched || stableStringify(draft) !== stableStringify(savedSnapshot));

  return (
    <div
      // S13 iOS mobile-UX round (Part B #1): iOS replaces the floating-
      // dialog-over-backdrop shell with a full-screen page — fixed
      // inset-0 either way, but no centering/dimming, and its own
      // safe-area-aware top padding. onMouseDown click-outside-to-close
      // is a desktop/web-only affordance (there is no visible backdrop
      // on iOS to click outside of).
      className={
        IS_IOS
          ? "fixed inset-0 z-50 flex flex-col bg-ink pt-[env(safe-area-inset-top)]"
          : "fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      }
      // Click-outside-to-close (E2E feedback 2026-07-11): mousedown
      // (not click) + target===currentTarget, so a drag that starts
      // inside the panel and ends on the backdrop (text selection,
      // slider drag) doesn't close it, and a click on an inner popover
      // (which portals onto this same backdrop) doesn't bubble up as
      // "the backdrop itself was clicked". handleDialogClose is the
      // existing discard-draft cancel path (same handler the footer's
      // 取消 uses) — no confirmation, matches that button's behavior
      // exactly — wrapped (v0.5.1) to also revert a ThemeEditor preview
      // in flight (see that handler's own doc comment).
      onMouseDown={
        IS_IOS
          ? undefined
          : (e) => {
              if (e.target === e.currentTarget) handleDialogClose();
            }
      }
    >
      <div
        className={
          IS_IOS
            ? "flex min-h-0 w-full flex-1 flex-col"
            : "flex max-h-[85vh] w-[700px] max-w-[92vw] flex-col rounded-none border border-edge2 bg-panel glassable-panel"
        }
      >
        {IS_IOS ? (
          activeCategory === null ? (
            // ROOT LIST header (Part B #2): title top-left + close ✕
            // top-right — ✕ is the SAME discard-draft close path the
            // desktop/web footer's own 取消 button below uses (no
            // confirmation), matching that button's existing behavior.
            <div className="flex shrink-0 items-center justify-between border-b border-edge p-4">
              <div className="text-lg font-semibold text-fg">设置</div>
              <button
                type="button"
                onClick={handleDialogClose}
                aria-label="关闭"
                className="btn-tactile flex h-10 w-10 items-center justify-center text-mut hover:bg-panel3 hover:text-fg"
              >
                <X size={18} weight="regular" />
              </button>
            </div>
          ) : (
            // DETAIL header (Part B #2): ‹ 设置 back button navigates to
            // the root list (activeCategory=null) — a pure navigation
            // action, never a save/discard (mirrors the desktop nav
            // rail's own "switching categories never loses a draft
            // edit" contract) — plus the active category's own label.
            <div className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-2">
              <button
                type="button"
                onClick={() => setActiveCategory(null)}
                className="btn-tactile flex items-center gap-0.5 px-2 py-2 text-sm text-fg hover:bg-panel3"
              >
                <span aria-hidden>‹</span>设置
              </button>
              <div className="truncate px-2 text-sm font-semibold text-fg">{activeCategoryLabel}</div>
            </div>
          )
        ) : (
          <div className="flex shrink-0 items-center justify-between border-b border-edge p-5">
            <div className="text-lg font-semibold text-fg">设置</div>
            {/* 简单/高级 segmented control (#62): applied + persisted
               immediately via updateSettings, deliberately OUT of the
               draft/保存 flow — this toggles what's currently RENDERED in
               this already-open dialog, so it can't wait for 保存 the way
               every other field here does; it behaves like a pure view
               preference (same immediate-apply posture Header.tsx's own
               direct updateSettings calls already use for engine). */}
            <div className="flex items-center gap-0.5 border border-edge bg-panel2 p-0.5">
              {UI_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => updateSettings({ uiMode: opt.value })}
                  className={`px-2.5 py-1 text-xs transition-colors ${
                    level === opt.value ? "bg-panel3 text-fg" : "text-mut hover:text-fg"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* S13 iOS mobile-UX round (Part B #2): iOS's ROOT LIST replaces
           the nav-rail + content-pane row entirely while
           activeCategory===null — grouped 常用/高级 rows instead of the
           desktop nav rail's flat strip. Detail view (activeCategory
           set) falls through to the SAME nav-rail+content-pane row
           desktop/web always used (with the nav itself hidden on iOS,
           see !IS_IOS below) — the huge per-category panel sequence
           inside is completely unchanged either way (Part B #5). */}
        {IS_IOS && activeCategory === null ? (
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-xl pb-4">
              <div className="px-4 pb-1 pt-4 text-xs uppercase tracking-wide text-mut">常用</div>
              <div className="border-t border-edge" aria-hidden />
              {iosCommonCategories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setActiveCategory(c.id)}
                  className="btn-tactile flex min-h-[52px] w-full items-center justify-between gap-3 border-b border-edge px-4 text-left font-mono text-sm text-fg hover:bg-panel3"
                >
                  <span>{c.label.replace("（高级）", "")}</span>
                  <span className="text-mut2" aria-hidden>
                    ›
                  </span>
                </button>
              ))}
              {iosAdvancedCategories.length > 0 && (
                <>
                  <div className="px-4 pb-1 pt-4 text-xs uppercase tracking-wide text-mut">高级</div>
                  <div className="border-t border-edge" aria-hidden />
                  {iosAdvancedCategories.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setActiveCategory(c.id)}
                      className="btn-tactile flex min-h-[52px] w-full items-center justify-between gap-3 border-b border-edge px-4 text-left text-sm text-fg hover:bg-panel3"
                    >
                      <span>{c.label.replace("（高级）", "")}</span>
                      <span className="text-mut2" aria-hidden>
                        ›
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        ) : (
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* Nav rail (owner ask 2026-07-11: "side navbar for each
             category") — one entry per category, each mapping to the
             dialog's own existing <section> blocks below, filtered to
             whichever are visible at the current uiMode (categoryVisible
             above, reusing SETTINGS_UI_LEVELS/isSectionVisible exactly
             as every row already did — never forked). Narrow/mobile: a
             horizontal scrollable strip above the content pane; sm: and
             up: a fixed-width vertical rail to its left. The content
             pane below is the ONLY scrolling region either way — 保存/
             取消 in the footer stay pinned outside of it. S13: hidden on
             iOS entirely — Part B #2's own detail-header back button is
             the iOS equivalent of this rail's own tab-switching. */}
          {!IS_IOS && (
          <nav
            aria-label="设置分类"
            className="flex shrink-0 flex-row gap-0.5 overflow-x-auto border-b border-edge p-2 sm:w-[168px] sm:flex-col sm:overflow-x-visible sm:border-b-0 sm:border-r"
          >
            {visibleCategories.map((c) => {
              const isActive = activeCategory === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setActiveCategory(c.id)}
                  aria-current={isActive ? "page" : undefined}
                  className={`btn-tactile shrink-0 whitespace-nowrap border-b-2 px-2.5 py-1.5 text-left text-sm transition-colors sm:w-full sm:whitespace-normal sm:border-b-0 sm:border-l-2 ${
                    isActive
                      ? "border-act bg-panel3 text-fg"
                      : "border-transparent text-mut hover:bg-panel3 hover:text-fg"
                  }`}
                >
                  {c.label}
                </button>
              );
            })}
          </nav>
          )}

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5">
        <div className={IS_IOS ? "mx-auto max-w-xl space-y-6" : "space-y-6"}>
          {activeCategory === "engine" && (
          <>
          {/* 转录引擎 — simple */}
          <section className="space-y-3" data-ui-level="engine">
            <SectionHeading>转录引擎</SectionHeading>
            <div className="grid grid-cols-2 gap-2">
              {ENGINE_CARDS.map((opt) => {
                // v0.4 S4 (blueprint decision E, risk 4) originally
                // joined byokOnly to sidecarOnly in the preview lock —
                // the BYOK preview sprint (2026-07-21, blueprint D3)
                // drops that arm: a byokOnly card (soniox/deepgram/
                // tabaudio-cloud) is selectable on preview exactly like
                // full tier now, since its own Key row below is no
                // longer greyed either — keyless, it's still selectable
                // and fails honestly at start, same as a full-tier user
                // who never pasted a key (full-tier parity). Only
                // sidecarOnly cards (whisper/tabaudio/appaudio —
                // genuinely absent on hosted web, no local sidecar to
                // talk to) stay locked. sonioxPreviewUnlocked below is
                // now used ONLY for the trial-vs-BYOK-bills-you hint
                // distinction (sonioxKeyBillsUser) — it no longer gates
                // selectability, that's opt.sidecarOnly's job alone.
                //
                // Sol #4 fix (BYOK preview sprint, 2026-07-21): the
                // tabaudio-cloud card used to unlock here off
                // SONIOX_PREVIEW_LANE alone — but that card's own
                // runtime (tabAudioCloud.ts's effectiveProvider) only
                // ever mints/bills through Soniox when the draft's own
                // 转录服务商 select resolves to "soniox"; a Deepgram
                // selection makes a residual sonioxKey irrelevant to
                // THIS card's session (it spends deepgramKey instead).
                // The "soniox" card has no such branch — it IS the
                // Soniox engine — so it stays gated on the lane alone.
                const tabCloudResolvesToSoniox = draft.tabAudioCloudProvider === "soniox";
                const sonioxPreviewUnlocked =
                  SONIOX_PREVIEW_LANE &&
                  (opt.value === "soniox" ||
                    (opt.value === "tabaudio-cloud" && tabCloudResolvesToSoniox));
                const previewLocked = PREVIEW_TIER && opt.sidecarOnly;
                // M2 fix (Sol review 2026-07-20, v0.5 closeout): both
                // cards' own `hint` above promises the shared trial
                // UNCONDITIONALLY on this lane — a restored/typed
                // sonioxKey means BYOK-wins routing (stt/soniox.ts /
                // tabAudioCloud.ts's effectiveProvider) actually bills
                // the user's own account instead, so the card must say
                // that plainly rather than keep advertising the
                // keyless trial once a real key is present.
                const sonioxKeyBillsUser = sonioxPreviewUnlocked && !!draft.sonioxKey;
                // Sol #4 fix: the tabaudio-cloud card's own static
                // `hint` (ALL_ENGINE_CARDS above) can't see the draft —
                // its SONIOX_PREVIEW_LANE branch is only correct while
                // this card actually resolves to Soniox. A Deepgram
                // selection falls back to the SAME provider-neutral
                // copy full tier (and a lane-off preview) already show,
                // so this card never claims a Soniox trial or names
                // Soniox at all for a Deepgram session.
                const cardHint =
                  opt.value === "tabaudio-cloud" && SONIOX_PREVIEW_LANE && !tabCloudResolvesToSoniox
                    ? TABAUDIO_CLOUD_NEUTRAL_HINT
                    : opt.hint;
                // S9.4, D6 (F9): 系统/App 音频's own macOS-floor gate —
                // "shown-but-disabled below floor", never hidden (see
                // ENGINE_CARDS' own appaudio doc comment above for why
                // this is computed here instead of a static `disabled`
                // on the card itself). isAppAudioFloorLocked is the SAME
                // shared policy function Header.tsx's ENGINE_OPTIONS now
                // consumes too (lib/desktop/audiocapCaps.ts) — audiocapCaps
                // null (not probed yet this open, or this isn't even the
                // appaudio card) never locks — only an EXPLICIT
                // appAudioSupported:false does (see that module's own
                // POLICY doc). S11 osspeech blueprint (§3 Worker D): joins
                // the SAME "shown-but-disabled below floor" gate via
                // isOsSpeechFloorLocked/osSpeechLockReason — a structural
                // no-op for every card besides osspeech, same as
                // isAppAudioFloorLocked is for every card besides appaudio,
                // so the two OR together safely.
                const appAudioLocked = isAppAudioFloorLocked(opt.value, audiocapCaps);
                const osSpeechLocked = isOsSpeechFloorLocked(opt.value, osSpeechCaps);
                const floorLocked = appAudioLocked || osSpeechLocked;
                // ITEM 2 fix: tri-state retention badge, sourced from the
                // SAME resolver/copy table Header/StatusLine already use
                // (lib/stt/engineOptions.ts) — replaces the old hand-rolled
                // `posture`/POSTURE_LABEL pair this array used to carry.
                const retention = RETENTION_COPY[resolveEngineRetentionClass(opt.value, sttEngineMode)];
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={opt.disabled || previewLocked || floorLocked || engineLockedByMeeting}
                    onClick={() => {
                      // v0.7.4 osspeech-silence round, last writer:
                      // every {engine, mode} write site stores the pair
                      // together (StatusLine's two dropdowns,
                      // ModeSelector, TutorialOverlay) — this card used
                      // to write engine alone, leaving a stale mode
                      // claiming 麦克风 over the system tap until the
                      // next launch's migrateSettings heal. import/url
                      // are standalone intent, never clobbered by an
                      // engine pick (store.ts isModeLegalForPlatform's
                      // "always fine to keep" ruling).
                      const keepMode = draft.mode === "import" || draft.mode === "url";
                      patch({
                        engine: opt.value,
                        ...(keepMode
                          ? null
                          : { mode: modeForPersistedEngine(opt.value, opt.value, MODE_PLATFORM) }),
                      });
                    }}
                    title={
                      previewLocked
                        ? "本地版功能：体验版暂未开放"
                        : appAudioLocked
                          ? appAudioLockReason(audiocapCaps)
                          : osSpeechLocked
                            ? osSpeechLockReason(osSpeechCaps)
                            : undefined
                    }
                    className={`border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      draft.engine === opt.value
                        ? "border-act bg-panel3 text-fg"
                        : "border-edge text-fg hover:bg-panel3"
                    }`}
                  >
                    {/* S14.1 field fix (item 5): at 375-390px this row
                       had no wrap/shrink escape hatch — a long label
                       (Soniox 云端识别, 系统识别) plus a
                       shrink-0 badge cluster (up to 2 — 本地版功能 + 实验
                       can no longer co-occur on one card since the BYOK
                       preview sprint, see previewLocked's own doc above —
                       plus 本地/云端) simply overflowed the card's own
                       border ("本地 box outside the bigger box").
                       flex-wrap lets the badge cluster drop to
                       its own line INSIDE the card instead of spilling
                       past it; min-w-0 on the label lets IT shrink/wrap
                       too rather than forcing the row wider than the
                       card. gap-y-1 only matters once wrapped. */}
                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                      <span className="min-w-0 font-medium">{opt.label}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        {previewLocked && <PreviewLockedBadge />}
                        {/* 实验 tag (v0.4 S4): every byokOnly engine is,
                           by definition, opt-in experimental until its
                           own benchmark gate clears — reuses this same
                           card's posture-chip idiom (bordered, 10px),
                           just a different color so it doesn't blend
                           with 云端/本地 next to it. */}
                        {opt.byokOnly && (
                          <span className="shrink-0 border border-lab-purple/30 px-1.5 py-0 text-[10px] text-lab-purple">
                            实验
                          </span>
                        )}
                        <span
                          title={retention.hint}
                          className={`shrink-0 border px-1.5 py-0 text-[10px] ${retention.borderClass} ${retention.textClass}`}
                        >
                          {retention.label}
                        </span>
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs leading-[1.7] text-mut">
                      {sonioxKeyBillsUser ? "已检测到你的 Soniox Key，将按你的账户计费" : cardHint}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Field-test fix: standing (not hover-only) explanation for
               why every card above just went disabled/dim —
               engineLockedByMeeting's own doc comment has the why. */}
            {engineLockedByMeeting && (
              <div className="text-xs text-mut2">会议进行中，无法切换引擎；暂停或结束会议后可切换</div>
            )}

            {/* S11 osspeech blueprint (§3 Worker D, §Q5): 预下载模型 —
               background-preinstalls the SpeechAnalyzer asset for
               draft.language so it's warm before the first real meeting,
               same rationale as EngineChoiceScreen's own background
               preinstall on the osspeech wizard choice. Engine-conditional
               like 系统/App 音频's permission CTA below (only meaningful
               once 系统识别 is the drafted engine) — disabled while
               floor-locked (macOS <26): preinstalling something this
               machine can't run makes no sense. */}
            {draft.engine === "osspeech" && (
              <div className="space-y-2 border border-edge bg-panel2 p-3">
                {/* v0.6 field-fix (item 4): "系统识别模型" read as "the
                   app downloads its own model" — this is Apple's own
                   per-language speech asset, OS-managed. */}
                <div className="text-sm text-fg">系统语音资源</div>
                <div className="text-xs leading-[1.7] text-mut2">
                  首次监听时会自动下载所需的系统模型；也可以提前在这里预下载，避免第一次会议时等待。
                </div>
                <button
                  type="button"
                  data-testid="btn-preinstall-osspeech"
                  disabled={preinstallingOsSpeech || osSpeechPreinstallDone || isOsSpeechFloorLocked("osspeech", osSpeechCaps)}
                  onClick={() => void handlePreinstallOsSpeech()}
                  className="btn-tactile shrink-0 border border-edge px-3 py-1.5 text-xs text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {preinstallingOsSpeech
                    ? OSSPEECH_PREINSTALL_BUSY_LABEL
                    : osSpeechPreinstallDone
                      ? OSSPEECH_PREINSTALL_DONE_LABEL
                      : OSSPEECH_PREINSTALL_IDLE_LABEL}
                </button>
              </div>
            )}

            {/* 本地服务 status line (owner ask 2026-07-11): only for the
               sidecar-backed engines (whisper/tabaudio, and appaudio —
               S9/D7) — probed by the useEffect/handleCheckSidecarStatus
               above. sidecarStatus === null (not probed yet) renders
               identically to a confirmed-down result, mirroring 订阅直连's
               own agentHealthState `!agentHealthState` idiom below
               rather than adding a third "checking" visual state. */}
            {!PREVIEW_TIER &&
              (draft.engine === "whisper" || draft.engine === "tabaudio" || draft.engine === "appaudio") && (
              <div className="space-y-2 border border-edge bg-panel2 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-sm text-fg">
                    本地服务：
                    {sidecarStatus?.up ? (
                      <span className="text-lab-green">
                        ● 已连接{sidecarStatus.model ? ` · 模型 ${sidecarStatus.model}` : ""}
                        {sidecarStatus.diarize !== undefined && (
                          <span className={sidecarStatus.diarize ? "text-lab-cyan" : "text-mut2"}>
                            {" "}
                            · {sidecarStatus.diarize ? "说话人分离已就绪" : "说话人分离未启用"}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-lab-orange">○ 未检测到本地服务</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCheckSidecarStatus()}
                    disabled={checkingSidecarStatus}
                    className="btn-tactile shrink-0 border border-edge px-2 py-1 text-xs text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {checkingSidecarStatus ? "检测中…" : "重新检测"}
                  </button>
                </div>
                {!sidecarStatus?.up && (
                  <div className="text-xs leading-[1.7] text-mut2">
                    需要本地 Whisper——见{" "}
                    <button
                      type="button"
                      onClick={() => void openExternal("https://github.com/mianaz/jargonslayer#readme")}
                      className="text-lab-cyan underline decoration-lab-cyan/40"
                    >
                      README「本地版安装」
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 系统/App 音频 permission-denied CTA (S9.4, D6): AppAudioEngine
               (lib/stt/appAudio.ts) already surfaces the zh
               permission-denied error via onStatus/showToast the moment
               a real start() hits it — this dialog has no live signal
               for that (no private TCC preflight API, per D6), so
               instead of reacting to a "denied" event this is an
               always-present affordance once 系统/App 音频 is the drafted
               engine: a deep-link button (open_privacy_settings, best-
               effort/uncontracted — see that Rust command's own doc
               comment) plus an ALWAYS-visible manual path, so the fix is
               already in view before the user ever has to hit the
               error once. */}
            {draft.engine === "appaudio" && (
              <div className="space-y-2 border border-edge bg-panel2 p-3">
                <div className="text-sm text-fg">系统音频录制权限</div>
                <div className="text-xs leading-[1.7] text-mut2">
                  首次开始监听时 macOS 会弹出授权提示；如果已拒绝或没看到提示，可前往系统设置手动开启后重试——重试会重新触发系统权限提示。
                </div>
                <button
                  type="button"
                  onClick={() => void handleOpenPrivacySettings()}
                  className="btn-tactile shrink-0 border border-edge px-2 py-1 text-xs text-fg hover:bg-panel3"
                >
                  打开系统设置
                </button>
                <div className="text-xs leading-[1.7] text-mut2">
                  手动路径：系统设置 → 隐私与安全性 → 屏幕与系统音频录制
                </div>
              </div>
            )}

            {/* Soniox API Key (v0.4 S4 chunk 6, blueprint decision E):
               engine-conditional like 本地服务 above — unlike 麦克风/识别
               语言/Whisper 地址 below (always shown, scope explained by
               their own hint text), this field is meaningless for any
               engine but soniox, so it only mounts once picked. Same
               hand-rolled masked-input pattern as HF Token (说话人分离
               section below): showSonioxKey toggle. BYOK preview sprint
               (2026-07-21): unlocked on preview — this is browser→
               Soniox direct WS either way (see the hint below), no
               server involvement to gate. */}
            {draft.engine === "soniox" && (
              <div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs text-mut">Soniox API Key</label>
                  {/* S14: no probe exists for Soniox (no telemetry, no
                     health check) — deriveKeyStatus with no evidence arg
                     can only ever resolve 未配置/已配置, never 正常/异常,
                     so this never fakes a status the app can't back up. */}
                  <KeyStatusChip status={deriveKeyStatus(draft.sonioxKey)} />
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type={showSonioxKey ? "text" : "password"}
                    value={draft.sonioxKey}
                    onChange={(e) => patch({ sonioxKey: e.target.value })}
                    placeholder="粘贴你的 Soniox API Key"
                    className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSonioxKey((v) => !v)}
                    aria-label={showSonioxKey ? "隐藏" : "显示"}
                    className="flex h-8 w-8 shrink-0 items-center justify-center text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {showSonioxKey ? (
                      <EyeSlash size={18} weight="regular" />
                    ) : (
                      <Eye size={18} weight="regular" />
                    )}
                  </button>
                </div>
                <div className="mt-1 text-xs text-mut2">
                  按量计费；Key 随会话直接发给 Soniox 云端（wss://stt-rt.soniox.com），不经我们的服务器
                </div>
                {/* Restored-backup honesty — see SonioxKeyRestoredNotice's
                   own doc comment above for the scenario. */}
                {PREVIEW_TIER && SONIOX_PREVIEW_LANE && !!draft.sonioxKey && (
                  <SonioxKeyRestoredNotice onClear={() => patch({ sonioxKey: "" })} />
                )}
                {!draft.sonioxKey && (
                  <div className="mt-1 text-xs leading-[1.7] text-mut2">
                    前往{" "}
                    <button
                      type="button"
                      onClick={() => void openExternal("https://console.soniox.com")}
                      className="text-lab-cyan underline decoration-lab-cyan/40"
                    >
                      console.soniox.com
                    </button>{" "}
                    控制台创建 API Key
                  </div>
                )}
              </div>
            )}

            {/* Deepgram API Key (v0.4.7 Lane D, docs/design-explorations/
               stt-provider-wiring-2026-07.md §5/§9): engine-conditional,
               mirrors the Soniox API Key block immediately above field-
               for-field (same hand-rolled masked-input pattern, same S14
               no-probe KeyStatusChip honesty, same BYOK-preview-sprint
               unlock — see that block's own doc comment). The key never
               rides a URL param or a JSON message body — it rides the
               WebSocket handshake's Sec-WebSocket-Protocol (see
               deepgramTransport.ts's own header for the verified wire
               shape). */}
            {draft.engine === "deepgram" && (
              <div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs text-mut">Deepgram API Key</label>
                  {/* S14: no probe exists for Deepgram either (same
                     no-telemetry posture as Soniox above) — deriveKeyStatus
                     with no evidence arg can only ever resolve 未配置/已配置,
                     never 正常/异常. */}
                  <KeyStatusChip status={deriveKeyStatus(draft.deepgramKey)} />
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type={showDeepgramKey ? "text" : "password"}
                    value={draft.deepgramKey}
                    onChange={(e) => patch({ deepgramKey: e.target.value })}
                    placeholder="粘贴你的 Deepgram API Key"
                    className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowDeepgramKey((v) => !v)}
                    aria-label={showDeepgramKey ? "隐藏" : "显示"}
                    className="flex h-8 w-8 shrink-0 items-center justify-center text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {showDeepgramKey ? (
                      <EyeSlash size={18} weight="regular" />
                    ) : (
                      <Eye size={18} weight="regular" />
                    )}
                  </button>
                </div>
                <div className="mt-1 text-xs text-mut2">
                  按量计费；Key 随 WebSocket 握手直接发给 Deepgram 云端（wss://api.deepgram.com），不经我们的服务器；仅英文，中英混说请用 Soniox
                </div>
                {!draft.deepgramKey && (
                  <div className="mt-1 text-xs leading-[1.7] text-mut2">
                    前往{" "}
                    <button
                      type="button"
                      onClick={() => void openExternal("https://console.deepgram.com")}
                      className="text-lab-cyan underline decoration-lab-cyan/40"
                    >
                      console.deepgram.com
                    </button>{" "}
                    控制台创建 API Key
                  </div>
                )}
              </div>
            )}

            {/* ElevenLabs API Key (v0.6 round 2): engine-conditional,
               mirrors the Soniox/Deepgram API Key blocks above field-for-
               field (same hand-rolled masked-input pattern, same S14
               no-probe KeyStatusChip honesty). The key never rides the
               websocket at all — it's used ONLY to mint a short-lived,
               single-use token client-side (POST api.elevenlabs.io/v1/
               single-use-token/realtime_scribe), and that derived token
               is what actually authenticates the connection (see
               elevenLabsTransport.ts's own header for the verified wire
               shape). */}
            {draft.engine === "elevenlabs" && (
              <div>
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs text-mut">ElevenLabs API Key</label>
                  {/* S14: no probe exists for ElevenLabs either (same
                     no-telemetry posture as Soniox/Deepgram above). */}
                  <KeyStatusChip status={deriveKeyStatus(draft.elevenLabsKey)} />
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type={showElevenLabsKey ? "text" : "password"}
                    value={draft.elevenLabsKey}
                    onChange={(e) => patch({ elevenLabsKey: e.target.value })}
                    placeholder="粘贴你的 ElevenLabs API Key"
                    className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowElevenLabsKey((v) => !v)}
                    aria-label={showElevenLabsKey ? "隐藏" : "显示"}
                    className="flex h-8 w-8 shrink-0 items-center justify-center text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {showElevenLabsKey ? (
                      <EyeSlash size={18} weight="regular" />
                    ) : (
                      <Eye size={18} weight="regular" />
                    )}
                  </button>
                </div>
                <div className="mt-1 text-xs text-mut2">
                  按量计费；Key 仅在浏览器本地用于向 ElevenLabs 换取一次性 Token（api.elevenlabs.io），识别连接只携带该 Token，Key 本身不经我们的服务器
                </div>
                {!draft.elevenLabsKey && (
                  <div className="mt-1 text-xs leading-[1.7] text-mut2">
                    前往{" "}
                    <button
                      type="button"
                      onClick={() => void openExternal("https://elevenlabs.io/app/developers/api-keys")}
                      className="text-lab-cyan underline decoration-lab-cyan/40"
                    >
                      elevenlabs.io
                    </button>{" "}
                    创建 API Key
                  </div>
                )}
              </div>
            )}

            {/* 标签页音频·云端 provider picker (v0.5 Wave-1 Feature 4, §5
               A4; ITEM 3 fix, fix round Opus#1): unlike Soniox/Deepgram
               above, this card has no key input of its own — it rides
               whichever provider Settings.tabAudioCloudProvider resolves
               to. That field previously had NO UI writer anywhere in the
               app (Deepgram tab-cloud was unreachable) and the old copy
               ("点击上方对应卡片临时切换以填写") pointed at an inert
               action — clicking the Soniox/Deepgram card switches
               draft.engine AWAY from tabaudio-cloud, it doesn't "temporarily"
               do anything. This select is the actual writer; the key
               itself still lives on the matching Soniox/Deepgram card
               above (this card intentionally has none of its own), so the
               rewritten copy says that plainly instead of implying a
               round-trip that isn't real. */}
            {draft.engine === "tabaudio-cloud" && (
              <div className="space-y-2">
                <div>
                  <label className="text-xs text-mut">转录服务商</label>
                  {/* BYOK preview sprint (2026-07-21): un-gated — the
                     runtime (lib/stt/tabAudioCloud.ts's own
                     effectiveProvider) honors this selection directly on
                     every tier now; the Soniox trial mint only ever
                     applies when SONIOX_PREVIEW_LANE is on AND this
                     resolves to soniox AND no sonioxKey is set
                     (cross-lane contract, Lane A/C's runtime side), so
                     the select shows the REAL draft value with both
                     options selectable, same as full tier always had. */}
                  <select
                    value={draft.tabAudioCloudProvider}
                    onChange={(e) =>
                      patch({
                        tabAudioCloudProvider: e.target.value as Settings["tabAudioCloudProvider"],
                      })
                    }
                    className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="soniox">Soniox</option>
                    <option value="deepgram">Deepgram（仅英文）</option>
                  </select>
                </div>
                <div className="text-xs leading-[1.7] text-mut2">
                  {PREVIEW_TIER && SONIOX_PREVIEW_LANE && draft.tabAudioCloudProvider === "soniox" ? (
                    // M2 fix (Sol review, v0.5 closeout) folded into the
                    // BYOK preview sprint's rewrite: one line now covers
                    // both states instead of branching on sonioxKey —
                    // "填入自己的 Key 后…" stays true and accurate whether
                    // or not a key is present yet, so it can't drift out
                    // of sync with the restored-backup notice just below.
                    "未填 Key 时（体验版试用）走 Soniox 限时试用；填入自己的 Key 后使用你的账户、浏览器直连"
                  ) : (
                    <>
                      选择转录服务商；需在对应引擎卡片填写该服务商的 API Key——
                      {draft.tabAudioCloudProvider === "deepgram"
                        ? draft.deepgramKey
                          ? "Deepgram Key 已配置"
                          : "尚未配置 Deepgram API Key"
                        : draft.sonioxKey
                          ? "Soniox Key 已配置"
                          : "尚未配置 Soniox API Key"}
                    </>
                  )}
                </div>
                {/* Restored-backup honesty — same notice as the Soniox
                   card above, but ONLY while this card actually rides
                   sonioxKey. Sol #4 fix (BYOK preview sprint,
                   2026-07-21): this used to fire off draft.sonioxKey
                   alone — a Deepgram selection spends deepgramKey
                   instead (tabAudioCloud.ts's effectiveProvider), so a
                   residual sonioxKey has no bearing on THIS card's
                   session and must not trigger a notice implying it
                   does. Same draft.tabAudioCloudProvider === "soniox"
                   condition the detail hint right above already uses. */}
                {PREVIEW_TIER && SONIOX_PREVIEW_LANE && !!draft.sonioxKey && draft.tabAudioCloudProvider === "soniox" && (
                  <SonioxKeyRestoredNotice onClear={() => patch({ sonioxKey: "" })} />
                )}
              </div>
            )}

            {/* S13 iOS mobile-UX round (Part A #2): device-picker only
               ever affects the local Whisper sidecar capture path (hint
               below says so verbatim) — there is no sidecar on iOS v1
               (osspeech captures straight off the OS), so this whole
               row is dead UI there. */}
            {!IS_IOS && (
            <div>
              <label className="text-xs text-mut">麦克风</label>
              <select
                value={draft.micId ?? ""}
                onChange={(e) => patch({ micId: e.target.value || undefined })}
                className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
              >
                <option value="">系统默认</option>
                {mics.map((m) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label}
                  </option>
                ))}
              </select>
              <div className="mt-1 text-xs text-mut2">仅本地 Whisper 生效</div>
            </div>
            )}

            <div>
              <label className="text-xs text-mut">识别语言</label>
              {/* S3 fix (v0.6 round-2 review): locked while a meeting is
                 active (listening OR paused — same meetingActive signal
                 the model-switch controls above already gate on, reused
                 here rather than engineLockedByMeeting's narrower
                 "paused stays unlocked" carve-out, since THAT carve-out
                 only holds for the STT engine — resume() reconciles an
                 engine change but never re-primes the translate
                 provider's own lastPair, see providers.ts's own
                 translate() doc). Changing the source language mid-
                 meeting used to silently corrupt translation: a hard
                 resume reattaches STT with the NEW source language, but
                 DesktopSystemTranslationProvider.translate() only
                 compares the TARGET against lastPair, so text kept
                 flowing through the OLD source-language session. */}
              <select
                value={draft.language}
                onChange={(e) => patch({ language: e.target.value })}
                disabled={meetingActive}
                title={meetingActive ? "会议进行中，结束会议后可修改识别语言" : undefined}
                className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                {LANGUAGE_OPTIONS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
              {meetingActive && (
                <div className="mt-1 text-xs text-mut2">会议进行中，结束会议后可修改识别语言</div>
              )}
            </div>

            {/* 托管模式 (v0.4 S3 chunk 6, desktop build only, blueprint
               architecture decision 6): managed = the app itself
               provisions+spawns the local sidecar (lib/desktop/
               bootstrap.ts) and Whisper 地址 below is fixed/greyed
               (reuses the SAME PREVIEW_TIER disabled/opacity idiom, not
               PreviewLockedBadge's copy — this isn't a preview-tier
               lock, it's "the app already knows the address"); external
               = today's manual-install behavior, Whisper 地址 stays
               editable. Meaningless on a web build (IS_DESKTOP false),
               so the whole block — and its only effect on whisperUrl's
               `disabled` below — compiles away to nothing there. */}
            {IS_DESKTOP && (
              <div className="space-y-2 border-t border-edge pt-3">
                <div className="text-xs text-mut">托管模式</div>
                <div className="flex items-center gap-0.5 border border-edge bg-panel2 p-0.5">
                  <button
                    type="button"
                    onClick={() => patch({ sidecarMode: "managed" })}
                    className={`flex-1 px-2 py-1.5 text-sm transition-colors ${
                      draft.sidecarMode === "managed" ? "bg-panel3 text-fg" : "text-mut hover:text-fg"
                    }`}
                  >
                    由应用管理（推荐）
                  </button>
                  <button
                    type="button"
                    onClick={() => patch({ sidecarMode: "external" })}
                    className={`flex-1 px-2 py-1.5 text-sm transition-colors ${
                      draft.sidecarMode === "external" ? "bg-panel3 text-fg" : "text-mut hover:text-fg"
                    }`}
                  >
                    外部（自己启动）
                  </button>
                </div>
                <div className="text-xs leading-[1.7] text-mut2">
                  {draft.sidecarMode === "managed"
                    ? "由应用管理本地识别服务：自动安装、启动，异常退出会自动重启；下方 Whisper 地址由应用固定，无需手动填写。"
                    : "连接我自己启动的服务：按 README「本地版安装」手动跑 whisper_server.py，下方 Whisper 地址可以编辑。"}
                </div>
                {draft.sidecarMode === "managed" && (
                  <>
                    {/* 当前模型 + 更换模型 (v0.4 S4 chunk 4, blueprint
                       decision C's switch flow) — an IMMEDIATE action,
                       deliberately laid out beside 重新运行安装向导 below
                       (same "act now, not on 保存" posture) rather than
                       going through patch()/draft/保存: switchModel()
                       itself writes settings.whisperModel on success, so
                       routing this through the draft flow too would let
                       an unrelated 保存 click accidentally fire a SECOND
                       write of a stale value. installedModel is null
                       both while still loading and if the marker
                       genuinely can't be read — em-dash either way (see
                       that state's own doc comment above).

                       S4 review pair Finding 1c: 更换模型/下载并切换 and
                       重新运行安装向导 below now disable EACH OTHER too
                       (not just themselves) — bootstrap.ts's own shared
                       sidecar-lifecycle latch (Finding 1a) already
                       rejects an overlapping call either way, but UI
                       mutual exclusion means the user never has to hit
                       that rejection at all; both also gate on
                       meetingActive (Finding 2), since a switch/reset
                       mid-meeting kills the very sidecar transcription
                       depends on. */}
                    <div className="flex items-center justify-between gap-3 border-t border-edge pt-3">
                      <div className="text-sm text-fg">
                        当前模型：
                        <span className="font-mono text-mut">{installedModel ?? "—"}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => (modelPickerOpen ? setModelPickerOpen(false) : handleOpenModelPicker())}
                        disabled={meetingActive || switchingModel || reprovisioningDesktop || installingDiarization || installingMlx}
                        title={meetingActive ? "会议进行中，结束后可切换模型" : undefined}
                        className="btn-tactile shrink-0 border border-edge px-2 py-1 text-xs text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        更换模型
                      </button>
                    </div>

                    {/* S12a (§C Provision state machine) — mlx-install's
                       own progress lives in TaskCenterDrawer/TaskTray
                       exactly like model-download/diar-install's does
                       (see installingMlx's own doc comment above); this
                       is only the same "安装中，进度见右下角「后台任务」"
                       pointer 安装扩展 already shows below, so a parakeet
                       pick's Phase 1 (MLX venv) isn't silently invisible
                       right here while it blocks 更换模型/下载并切换/
                       重新运行安装向导/安装扩展 above via the SAME mutual-
                       exclusion set (S4 review pair Finding 1c). zh copy
                       new to this sprint — 4.6 pass, not polished here
                       (see modelCatalog.ts's own doc on the same
                       convention). */}
                    {installingMlx && (
                      <div className="text-xs leading-[1.7] text-mut2">正在安装 MLX 运行环境，进度见右下角「后台任务」</div>
                    )}

                    {modelPickerOpen && (
                      <div className="space-y-2 border border-edge bg-panel2 p-3">
                        <ModelPicker value={pickedModel} onChange={setPickedModel} />
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleSwitchModel()}
                            disabled={switchingModel || pickedModel === installedModel || reprovisioningDesktop || meetingActive || installingDiarization || installingMlx}
                            className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {switchingModel ? "处理中…" : "下载并切换"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setModelPickerOpen(false)}
                            disabled={switchingModel}
                            className="btn-tactile px-3 py-1.5 text-sm text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => void handleReprovisionDesktop()}
                      disabled={reprovisioningDesktop || switchingModel || meetingActive || installingDiarization || installingMlx}
                      title={meetingActive ? "会议进行中，结束后可重新运行安装向导" : undefined}
                      className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {reprovisioningDesktop ? "处理中…" : "重新运行安装向导"}
                    </button>
                  </>
                )}
              </div>
            )}

            {/* S13 iOS mobile-UX round (Part A #2): whisper_server.py's
               own ws:// address — meaningless without a local sidecar,
               which doesn't exist on iOS (no Python sidecar there). */}
            {!IS_IOS && (
            <div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-mut">Whisper 地址</label>
                {PREVIEW_TIER && <PreviewLockedBadge />}
              </div>
              <input
                type="text"
                value={draft.whisperUrl}
                disabled={PREVIEW_TIER || (IS_DESKTOP && draft.sidecarMode === "managed")}
                onChange={(e) => patch({ whisperUrl: e.target.value })}
                placeholder="ws://localhost:8765"
                className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
            )}

            {/* 实时转录预览 (STT protocol v2): app-controlled per-session
               override of the sidecar's --partials CLI default — see
               wsTransport.ts's config.partials + whisper_server.py's
               _partials_enabled. Same row pattern as 实时说话人分离
               below, but unconditionally enabled (no engine/token gate)
               — mirrors 麦克风/识别语言's own "always shown, hint
               explains scope" posture in this same section.
               S13 iOS mobile-UX round (Part A #2): own copy says "仅本地
               Whisper 引擎生效" — genuinely inert on iOS's osspeech-only
               engine, so hidden there like the two rows just above. */}
            {!IS_IOS && (
            <label className="flex items-center justify-between gap-3 border-t border-edge pt-3 py-1">
              <div>
                <div className="text-sm text-fg">实时转录预览</div>
                <div className="mt-0.5 text-xs leading-[26px] text-mut2">
                  转录过程中先显示灰色临时文字（打字机效果），句子完成后落定。仅本地 Whisper 引擎生效。
                </div>
              </div>
              <ToggleSwitch checked={draft.partials} onChange={(checked) => patch({ partials: checked })} />
            </label>
            )}

            {/* 设备端识别 (docs/research/stt-live-engines-2026-07.md
               item #1): Chrome 139+ processLocally — recognition runs
               on this machine instead of the browser vendor's cloud
               STT whenever the browser reports a local model available
               for 识别语言; automatic cloud fallback otherwise. Same row
               pattern as 实时转录预览 above, webspeech's own engine-scope
               toggle. */}
            {/* v0.4.4 field ruling (finding round 2, item 1): the row only
               governs the webspeech engine, which desktop builds filter out
               entirely (ENGINE_CARDS above) — rendering a 「仅浏览器识别引擎
               生效」 toggle in an app with no such engine was pure noise. S13
               (§6 Sol F5): !IS_TAURI, not !IS_DESKTOP — webspeech doesn't
               exist on iOS either (ENGINE_CARDS above drops it there too,
               same as desktop). */}
            {!IS_TAURI && (
              <label className="flex items-center justify-between gap-3 py-1">
                <div>
                  <div className="text-sm text-fg">设备端识别（推荐）</div>
                  <div className="mt-0.5 text-xs leading-[1.7] text-mut2">
                    浏览器支持时在本机识别语音，音频不再发送到浏览器厂商云端；不支持时自动回退云端识别。仅浏览器识别引擎生效。
                  </div>
                </div>
                <ToggleSwitch
                  checked={draft.preferOnDeviceSpeech}
                  onChange={(checked) => patch({ preferOnDeviceSpeech: checked })}
                />
              </label>
            )}
          </section>
          </>
          )}

          {/* 说话人分离 — advanced. preview tier (#61): the entire
             section needs the local sidecar (HF Token pairs with
             sidecar-side pyannote, 检测状态 probes the sidecar, 实时说话人
             分离 only runs through the sidecar's ws pass), so it's
             disabled as ONE group with a single badge on the heading
             rather than per-field. */}
          {activeCategory === "diarization" && isSectionVisible(level, SETTINGS_UI_LEVELS.diarization) && (
          <section
            className="space-y-3 border-t border-edge pt-5"
            data-ui-level="diarization"
          >
            <div className="flex items-center gap-2">
              <SectionHeading>说话人分离</SectionHeading>
              {PREVIEW_TIER && <PreviewLockedBadge />}
            </div>

            {/* 安装扩展 (v0.4 S5 chunk 3, blueprint decision A: a
               Settings-only affordance, never a first-run wizard step —
               desktop-managed only, mirroring the SAME IS_DESKTOP &&
               sidecarMode==="managed" gate the 转录引擎 托管模式 block
               above uses). diarizationInstalled/installingDiarization are
               this dialog's own state (see their declarations above);
               handleInstallDiarization DISPATCHES handle.
               installDiarization() as a registry task (S10 field-fix #6
               jobsBridge swap) — TaskCenterDrawer/TaskTray own its
               progress from here on. Deliberately placed ahead of the
               pre-existing HF Token field below (kept EXACTLY as-is,
               decision E) — installing the runtime is the precondition
               token/license setup is otherwise meaningless without. */}
            {IS_DESKTOP && draft.sidecarMode === "managed" && (
              <div className="space-y-2 border border-edge bg-panel2 p-3">
                <div className="text-sm text-fg">
                  说话人分离扩展：
                  {diarizationInstalled === true ? (
                    <span className="text-lab-green">已安装</span>
                  ) : diarizationInstalled === false ? (
                    <span className="text-lab-orange">未安装</span>
                  ) : (
                    // undefined: not yet probed OR a legacy/external
                    // sidecar that never sends diarization_installed —
                    // risk 5 forbids ever rendering either as 未安装.
                    <span className="text-mut2">未知</span>
                  )}
                </div>

                {/* S12b fix round FB7-settings (§F) — "the 安装扩展
                   action for diarization should communicate the same"
                   (parakeet incompatibility): informational only, NOT a
                   disable — installing the extension into the shared
                   base venv is still a legitimate, useful action (e.g.
                   prepping ahead of switching back to a faster-whisper
                   model), it just won't help THIS SESSION while parakeet
                   is the selected/installed model. Same idiom as the
                   sibling 需先安装说话人分离扩展 line below the toggle.
                   NEW string — 4.6 pass. */}
                {isParakeetSelectedOrInstalled && (
                  <div className="text-xs leading-[1.7] text-mut2">
                    parakeet 本地转录暂不支持实时说话人分离，安装扩展不会让当前会话生效
                  </div>
                )}

                {diarizationInstalled === false && (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleInstallDiarization()}
                      disabled={
                        installingDiarization || reprovisioningDesktop || switchingModel || meetingActive || installingMlx
                      }
                      title={meetingActive ? "会议进行中，结束后可安装说话人分离扩展" : undefined}
                      className="btn-tactile w-full border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {installingDiarization ? "安装中…" : "安装扩展（约 1–1.5 GB · 需几分钟）"}
                    </button>
                    {installingDiarization && (
                      <div className="text-xs leading-[1.7] text-mut2">
                        安装中，进度见右下角「后台任务」
                      </div>
                    )}
                  </>
                )}

                {/* Uninstall documentation (decision F, VETO ITEM 2):
                   no in-place uninstall button — run_uv's validator has
                   no pip-uninstall shape, and reprovision() already
                   recreates the venv cleanly without pyannote. */}
                <div className="text-xs leading-[1.7] text-mut2">
                  移除扩展：重新运行安装向导（会重建本地环境）
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs text-mut">HF Token</label>
                {/* S14: reuses 转录引擎's own sidecarStatus probe
                   (handleCheckSidecarStatus, set on dialog-open for a
                   sidecar-backed engine and by its own 重新检测 button) —
                   diarize:true only once the sidecar has confirmed
                   pyannote import + token presence; no separate probe of
                   our own. FINDING 5 (S14 fix round): diarize:false is
                   NOT treated as failure evidence — it's equally what a
                   sidecar with pyannote simply not installed reports,
                   not proof the TOKEN is bad, so only hasSuccess is ever
                   passed. diarize stays undefined until that OTHER
                   section's probe has actually run this dialog-open, so
                   this reads 已配置 (never 异常) until diarize:true is
                   actually observed. */}
                {!PREVIEW_TIER && (
                  <KeyStatusChip
                    status={deriveKeyStatus(draft.hfToken, {
                      hasSuccess: sidecarStatus?.diarize === true,
                    })}
                  />
                )}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type={showHfToken ? "text" : "password"}
                  value={draft.hfToken}
                  disabled={PREVIEW_TIER}
                  onChange={(e) => patch({ hfToken: e.target.value })}
                  placeholder="hf_…"
                  className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={PREVIEW_TIER}
                  onClick={() => setShowHfToken((v) => !v)}
                  aria-label={showHfToken ? "隐藏" : "显示"}
                  className="flex h-8 w-8 shrink-0 items-center justify-center text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {showHfToken ? (
                    <EyeSlash size={18} weight="regular" />
                  ) : (
                    <Eye size={18} weight="regular" />
                  )}
                </button>
              </div>
              <div className="mt-1 text-xs text-mut2">
                仅存本机，随任务经 localhost 传给本地服务，不经任何云端
              </div>
            </div>

            {!PREVIEW_TIER && !draft.hfToken && (
              <div className="space-y-2 border border-edge bg-panel2 p-3">
                <ol className="space-y-2 text-xs leading-[1.7] text-mut">
                  <li>
                    <span className="font-mono text-fg">①</span> 注册{" "}
                    <button
                      type="button"
                      onClick={() => void openExternal("https://huggingface.co/settings/tokens")}
                      className="text-lab-cyan underline decoration-lab-cyan/40"
                    >
                      huggingface.co
                    </button>{" "}
                    并在 Settings → Access Tokens 创建一个 Read token
                  </li>
                  <li>
                    <span className="font-mono text-fg">②</span> 分别打开并接受两个模型的使用条款：
                    <button
                      type="button"
                      onClick={() => void openExternal("https://huggingface.co/pyannote/segmentation-3.0")}
                      className="text-lab-cyan underline decoration-lab-cyan/40"
                    >
                      pyannote/segmentation-3.0
                    </button>{" "}
                    与{" "}
                    <button
                      type="button"
                      onClick={() => void openExternal("https://huggingface.co/pyannote/speaker-diarization-3.1")}
                      className="text-lab-cyan underline decoration-lab-cyan/40"
                    >
                      pyannote/speaker-diarization-3.1
                    </button>
                    （不接受会得到 403）
                  </li>
                  <li>
                    <span className="font-mono text-fg">③</span> 粘贴 token 并保存；上传录音时选择「本地 Whisper」即可自动分离说话人
                  </li>
                </ol>
              </div>
            )}

            <button
              type="button"
              onClick={() => void handleCheckDiarizationStatus()}
              disabled={PREVIEW_TIER || checkingDiarization}
              className="btn-tactile w-full border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {checkingDiarization ? "检测中…" : "检测状态"}
            </button>

            <label className="flex items-center justify-between gap-3 border-t border-edge pt-3 py-1">
              <div>
                <div className={`text-sm ${realtimeDiarizeAvailable ? "text-fg" : "text-mut2"}`}>
                  实时说话人分离（beta）
                </div>
                <div className="mt-0.5 text-xs leading-[26px] text-mut2">
                  {PREVIEW_TIER
                    ? "需要本地版 + 本地 Whisper"
                    : realtimeDiarizeAvailable
                      ? "为本地实时转录标注说话人（SPEAKER_1/2…），可随时在转录里重命名。分离过程在本机完成，音频不离开设备。beta：标签会延迟几秒出现，随会议推进逐步修正，可能增加 CPU 占用；转录本身不受影响。"
                      : draft.engine === "osspeech"
                        ? "该引擎不支持说话人分离"
                        : // S12b fix round FB7-settings (§F) — NEW string,
                          // 4.6 pass (house convention, not polished here):
                          // parakeet's own MLX venv never has pyannote, a
                          // structural limitation, not a missing-token one
                          // — checked ahead of the generic fallback so it
                          // always wins when both would otherwise apply.
                          isParakeetSelectedOrInstalled
                          ? "parakeet 本地转录暂不支持实时说话人分离"
                          : "需先配置 HF Token"}
                </div>
              </div>
              <ToggleSwitch
                checked={draft.realtimeDiarize}
                disabled={!realtimeDiarizeAvailable}
                onChange={(checked) => patch({ realtimeDiarize: checked })}
              />
            </label>

            {/* v0.4 S5 chunk 3 (blueprint chunk 3, minor-taste call): an
               INLINE warning, not a hard gate — realtimeDiarizeAvailable
               above is untouched by diarizationInstalled, so the toggle
               itself stays exactly as governed by the HF Token check it
               already had. */}
            {IS_DESKTOP && draft.sidecarMode === "managed" && diarizationInstalled === false && (
              <div className="text-xs leading-[1.7] text-mut2">需先安装说话人分离扩展</div>
            )}
          </section>
          )}

          {/* AI 检测 — mixed section, tagged row-by-row below */}
          {activeCategory === "aiDetect" && (
          <section className="space-y-3 border-t border-edge pt-5">
            <SectionHeading>AI 检测</SectionHeading>

            {/* Preview tier (#61): a permanent AI data-path disclosure,
               not a lock notice — BYOK preview sprint (2026-07-21)
               un-gated every credential-related field below (provider/
               Poe preset, Base URL, OpenRouter OAuth connect, API Key),
               so this no longer marks anything as disabled; it just
               tells the visitor which of the two data paths their
               current draft is on. No PreviewLockedBadge (removed —
               nothing here is locked anymore). */}
            {PREVIEW_TIER && (
              <div className="space-y-1" data-ui-level="aiDetectPreviewBanner">
                {draftApiKey ? (
                  <div className="text-xs leading-[1.7] text-mut2">
                    自带 Key 由浏览器直连你的模型服务商，Key 与会议内容不经过本站服务器
                  </div>
                ) : (
                  <>
                    <div className="text-xs leading-[1.7] text-mut2">
                      体验版由内置演示 Key 提供 AI，本地版可接入自己的 Key
                    </div>
                    {/* #63 privacy disclosure at the point of use: the
                       preview's AI text path differs materially from BYOK
                       (transits our proxy in memory, and the demo key's
                       OpenRouter routing carries data_collection=allow). */}
                    <div className="text-xs leading-[1.7] text-mut2">
                      数据路径：体验版的 AI 文本经我们的服务器内存中转（不存储）后转发
                      OpenRouter，带 data_collection=allow 标志（可能被模型提供方留存）；本地版
                      BYOK 直连你自己的端点、不带该标志。音频永远不经过我们的服务器。启用下方「背景画像」后，
                      画像内容同样经此路径中转。
                    </div>
                  </>
                )}
                {/* Sol #7 fix (BYOK preview sprint, 2026-07-21): the two
                   branches above describe the PRIMARY domain only — a
                   分任务模型（高级） override can route one task on a
                   different key than the primary (taskLlmRoutingDiverges
                   above), which the primary-only sentence doesn't
                   cover. One terse line, appended rather than branched
                   into the two cases above, since it's true regardless
                   of which primary posture is showing. */}
                {taskLlmRoutingDiverges && (
                  <div className="text-xs leading-[1.7] text-mut2">
                    分任务配置按各自 Key 路由：有 Key 的任务浏览器直连，无 Key 的任务走体验版代理
                  </div>
                )}
              </div>
            )}

            {/* LLM/BYOK — advanced (provider/baseUrl/apiKey + detect/
               summary model pickers + 测试连接). */}
            {isSectionVisible(level, SETTINGS_UI_LEVELS.aiDetectCredentials) && (
              <div
                className="space-y-3"
                data-ui-level="aiDetectCredentials"
              >
                <CredentialFields
                  idPrefix="primary"
                  provider={draft.provider}
                  baseUrl={draft.baseUrl}
                  apiKey={draftApiKey}
                  onSelectPreset={handleSelectPreset}
                  onBaseUrlChange={(baseUrl) => patch({ baseUrl })}
                  onApiKeyChange={(apiKey) =>
                    patch(providerApiKeyPatch(draft.provider, draft.baseUrl, apiKey))
                  }
                  apiKeyPlaceholder="sk-…"
                  // Desktop keychain custody (v0.5.1 desktop keychain
                  // migration): honest per the actual threat model — the
                  // Keychain does not make the key unreadable to this
                  // app itself (it's how the app reads it back), only to
                  // OTHER apps/processes without permission, so this
                  // deliberately does NOT say "加密无法读取". Web keeps
                  // the byte-identical prior copy — the key still lives
                  // in browser storage there, nothing changed for it.
                  // S13 iOS mobile-UX round (Part A #4): iOS gets its own
                  // hint instead — onConnectOpenRouter is omitted below
                  // (no OAuth loopback possible in a WKWebView, see that
                  // prop's own doc comment for why), so this is the ONE
                  // caller-owned slot under the Key field where the
                  // paste-first replacement instruction can go.
                  apiKeyHint={
                    IS_DESKTOP
                      ? "Key 存入 macOS 系统钥匙串，不再明文保存在应用存储中；其他 App 未经许可无法读取"
                      : IS_IOS
                        ? "在电脑浏览器完成 OpenRouter 授权后，把 API Key 粘贴到这里；仅存本机，不上传"
                        : "仅存于本机浏览器；调用时经应用接口内存转发，不落盘（env-first 见 README）"
                  }
                  // BYOK preview sprint (2026-07-21): the chip used to be
                  // suppressed wholesale under PREVIEW_TIER (a key field
                  // that couldn't be set had nothing honest to report) —
                  // now that the field is live there too, this reads the
                  // same evidence full tier always has, unconditionally.
                  apiKeyStatus={deriveKeyStatus(
                    draftApiKey,
                    // FINDING 5 (S14 fix round): telemetry/
                    // testConnection describe calls made against
                    // the SAVED settings' primary credential —
                    // gate evidence on the draft's own primary
                    // provider/baseUrl/apiKey still matching what's
                    // actually saved (credsMatch), so editing away
                    // from a tested/saved key caps this chip at
                    // 已配置 instead of keeping the OLD key's 正常/
                    // 异常.
                    credsMatch(
                      { provider: draft.provider, baseUrl: draft.baseUrl, apiKey: draftApiKey },
                      { provider: settings.provider, baseUrl: settings.baseUrl, apiKey: savedApiKey },
                    )
                      ? llmKeyEvidence(
                          primaryTelemetryDomains(draft).map((d) => telemetry[d]),
                          domainUsesOwnKey(draft, "detect") ? undefined : testConnectionOk,
                        )
                      : undefined,
                  )}
                  // BYOK preview sprint: a custom openai-compat endpoint
                  // on preview now actually gets called browser-direct
                  // (D1) — CORS, not our server, decides whether it
                  // works, so a visitor picking "自定义…" needs the heads-
                  // up before they hit a silent network failure. Only
                  // once a key is drafted (matches previewOptions below —
                  // keyless still rides the locked <select>, no Base URL
                  // typing to warn about yet).
                  baseUrlHint={
                    PREVIEW_TIER && draftApiKey ? (
                      <>自定义端点需支持浏览器跨域（CORS）；不支持时请使用本地版</>
                    ) : undefined
                  }
                  presets={PROVIDER_PRESETS}
                  // S13 iOS mobile-UX round (Part A #4): the web-redirect
                  // OAuth flow (handleConnectOpenRouter's own non-desktop
                  // branch) navigates the WHOLE WKWebView to
                  // openrouter.ai, stranding the user on the hosted web
                  // app — desktop's native loopback is also unreachable
                  // (the Rust oauth module is #[cfg(desktop)]-only).
                  // Omitting this prop entirely (rather than passing a
                  // no-op) hides both the button AND its explainer line —
                  // CredentialFields' own `{onConnectOpenRouter && (...)}"
                  // gate already does that with zero changes there; the
                  // apiKeyHint above carries the paste-first instruction
                  // instead.
                  onConnectOpenRouter={IS_IOS ? undefined : () => void handleConnectOpenRouter()}
                  connectingOpenRouter={connectingOpenRouter}
                  connectDisabledHint={proxyDraftDirty ? proxyDraftDirtyHint : undefined}
                  models={[
                    {
                      key: "detect",
                      label: "检测模型",
                      value: draft.detectModel,
                      onChange: (v) => patch({ detectModel: v }),
                      staticOptions: DETECT_MODEL_OPTIONS,
                      // BYOK preview sprint: the locked <select> is now
                      // keyed off the draft's OWN key, not the tier alone
                      // — a drafted key means this domain is about to
                      // route browser-direct to whatever model the user
                      // types, so the preview allowlist no longer applies
                      // (same free-text+datalist UI full tier always
                      // had); keyless preview keeps riding the allowlist
                      // exactly as before. The hint follows the same
                      // split: the "下拉所选" copy only makes sense while
                      // this is actually a <select> — a drafted key falls
                      // through to the SAME ollama-preset hint (or none)
                      // full tier already shows for this now-identical
                      // free-text field, rather than repeating the
                      // banner's data-path line a second time on screen.
                      previewOptions: PREVIEW_TIER && !draftApiKey ? PREVIEW_LIVE_MODELS : undefined,
                      hint:
                        PREVIEW_TIER && !draftApiKey ? (
                          <div className="mt-1 text-xs leading-[1.7] text-mut2">
                            体验版由服务端在预置模型内代理调用，下拉所选即实际使用的模型；检测用轻量模型（更快），报告可用更强模型
                          </div>
                        ) : (
                          activePreset === "ollama" && (
                            <div className="mt-1 text-xs text-mut2">Ollama 常用模型：qwen3:8b</div>
                          )
                        ),
                    },
                    {
                      key: "summary",
                      label: "报告模型",
                      value: draft.summaryModel,
                      onChange: (v) => patch({ summaryModel: v }),
                      staticOptions: SUMMARY_MODEL_OPTIONS,
                      previewOptions: PREVIEW_TIER && !draftApiKey ? PREVIEW_SUMMARY_MODELS : undefined,
                    },
                  ]}
                />

                {/* Desktop OAuth failure hint (S10 field-fix, Chunk A
                   wave-2 wiring): mirrors OnboardingByokStep.tsx's own
                   oauthHint block verbatim — one-line zh reason
                   (describeOAuthFailure, components/desktop/
                   onboardingSettings.ts, no duplicated failure labels)
                   plus a link pointing at the API Key field right below
                   this. Web build never sets this (handleConnectOpenRouter
                   full-page-redirects there instead — see that
                   handler's own doc comment), so this renders nothing
                   on web regardless of PREVIEW_TIER/disabled state. */}
                {openRouterOauthHint && (
                  <div className="space-y-1.5 border border-warn-soft/40 bg-panel2 p-2.5 text-xs leading-[1.7] text-warn-soft">
                    <div>{openRouterOauthHint}</div>
                    <button
                      type="button"
                      onClick={() => void openExternal("https://openrouter.ai/keys")}
                      className="btn-tactile text-lab-cyan underline decoration-lab-cyan/40"
                    >
                      前往 openrouter.ai/keys 创建 Key
                    </button>
                  </div>
                )}

                {/* W2 desktop proxy support — desktop-only (meaningless
                   on web/iOS, same IS_DESKTOP gate CredentialFields'
                   own 钥匙串 apiKeyHint above uses): tauri-plugin-http
                   already auto-detects the macOS system proxy with no
                   configuration at all, so this is purely the escape
                   hatch for what that can't see (env-var-only setups a
                   Finder-launched app never inherits, or a PAC-only
                   network the app can't execute). */}
                {IS_DESKTOP && (
                  <div>
                    <label className="text-xs text-mut">网络代理（可选）</label>
                    <input
                      type="text"
                      value={draft.proxyUrl}
                      onChange={(e) => {
                        patch({ proxyUrl: e.target.value });
                        // F4 fix (field-test batch C, Sol M3): a stale
                        // 测试连接 result must not keep reading as
                        // authoritative once the proxy it was run
                        // against no longer matches this draft.
                        setTestConnectionOk(undefined);
                      }}
                      placeholder="http://127.0.0.1:7890"
                      className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                    />
                    <div className="mt-1 text-xs leading-[1.7] text-mut2">
                      留空则自动跟随系统代理。支持 http:// 与 socks5:// （如 Clash 混合端口 7890）
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => void handleTestConnection()}
                  disabled={testingConnection || proxyDraftDirty}
                  className="btn-tactile w-full border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {testingConnection ? "测试中…" : "测试连接"}
                </button>
                {proxyDraftDirty && (
                  <div className="text-xs leading-[1.7] text-warn-soft">{proxyDraftDirtyHint}</div>
                )}

                {/* v0.4.5 ambient AI-status mirror (design doc
                   v045-ai-transparency-qc.md Part A) — the same
                   4-row AiStatusPanel StatusLine's popover shows,
                   right here as the config-moment host. */}
                <AiStatusPanel />
              </div>
            )}

            {/* v0.6 field-fix (item 3): merges the old 实时检测/AI 检测
               toggle pair into one 检测模式 segmented control — same
               button-row pattern as 全局字号 (FONT_SIZE_OPTIONS) below.
               data-ui-level stays "aiDetectCore" (both old rows were
               "simple" anyway); aiDetectAutoDetect is retired from
               settingsSections.ts since there's no longer a second row
               to tag. */}
            <div data-ui-level="aiDetectCore">
              <label className="text-xs text-mut">检测模式</label>
              <div className="mt-1 flex items-center gap-0.5 border border-edge bg-panel2 p-0.5">
                {DETECT_MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      // 关闭 clears BOTH flags (Sol HIGH, fix round):
                      // leaving aiDetect=true made desktop text-selection
                      // still fire an AI lookup while the UI promised
                      // no detection at all. Modes are explicit — no
                      // remembered aiDetect preference across 关闭.
                      if (opt.value === "off") patch({ autoDetect: false, aiDetect: false });
                      else if (opt.value === "dictionary") patch({ autoDetect: true, aiDetect: false });
                      else patch({ autoDetect: true, aiDetect: true });
                    }}
                    className={`flex-1 px-2 py-1.5 text-sm transition-colors ${
                      detectModeValue === opt.value ? "bg-panel3 text-fg" : "text-mut hover:text-fg"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-xs leading-[1.7] text-mut2">
                词典模式内置离线即时生效；AI 模式为灰度/Beta 功能（检测质量仍在调优，需要 API
                Key），额外并行调用 AI 就地升级词典结果；关闭后不再自动检测、划词只查离线词典
              </div>
            </div>

            {isSectionVisible(level, SETTINGS_UI_LEVELS.aiDetectConfidence) && (
              <div data-ui-level="aiDetectConfidence">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-mut">AI 检测置信度阈值</label>
                  <span className="font-mono text-xs tabular-nums text-fg">
                    {draft.minConfidence.toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0.3}
                  max={0.9}
                  step={0.05}
                  value={draft.minConfidence}
                  onChange={(e) =>
                    patch({ minConfidence: Number(e.target.value) })
                  }
                  className="mt-1 w-full accent-act"
                />
                {/* E2E feedback 2026-07-11 ("opaque setting") — copy
                    verified against dedupe.ts's mergeExpressions (drops
                    expressions with confidence < minConfidence, whatever
                    the source) and its actual inputs: dictionary hits
                    are hardcoded to confidence 0.9 (dictionary-data.ts)
                    and custom/我的词典 hits to 1 (types.ts's
                    customEntryToExpression) — both always at or above
                    this slider's 0.9 ceiling, so they never actually get
                    dropped; only the model-assigned confidence on real
                    AI detections varies enough to be filtered. mergeTerms
                    has no confidence check at all — 术语卡片 are never
                    filtered by this control, from any source. */}
                <div className="mt-1 text-xs text-mut2">
                  低于该置信度的 AI 检测结果不会生成表达卡片——调高更准但更少，调低更多但可能误报；词典、我的词典命中不受影响；此项不影响术语卡片。
                </div>

                {/* v0.4.5 detect-span QC (design doc v045-ai-
                   transparency-qc.md Part B, owner ruling: 「行话最大词数/
                   字符数」are configurable, not a hardcoded constant) —
                   settings.detectIdiomMaxWords/detectIdiomMaxChars,
                   consumed by lib/detect/spanQc.ts's category-aware cap
                   (idiom/slang only; other categories keep a fixed
                   tighter cap this control doesn't touch). Reuses the
                   aiDetectConfidence section's own "advanced" gate above
                   (no new SETTINGS_UI_LEVELS key — settingsSections.ts
                   is outside this worker's file set) since it's the same
                   "AI 检测 tuning knob, rarely touched" shelf. */}
                <div className="mt-3 grid grid-cols-2 gap-3 border-t border-edge pt-3">
                  <div>
                    <label className="text-xs text-mut">行话最大词数</label>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={draft.detectIdiomMaxWords}
                      onChange={(e) => {
                        // F5 (Sol+Opus review, MAJOR/silent-failure): a
                        // blank/0/negative value here silently drops
                        // EVERY idiom/slang span app-wide (spanQc.ts's
                        // category-aware cap) until the user notices — an
                        // unenforced `min` attribute is only a spinner
                        // hint, not validation. Only patch on a finite
                        // integer >= 1; anything else leaves the last-
                        // good draft value in place instead of saving
                        // Number("")===0.
                        const n = Math.trunc(Number(e.target.value));
                        if (Number.isFinite(n) && n >= 1) patch({ detectIdiomMaxWords: n });
                      }}
                      className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-mut">行话最大字符数</label>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={draft.detectIdiomMaxChars}
                      onChange={(e) => {
                        // Same guard as 行话最大词数 above.
                        const n = Math.trunc(Number(e.target.value));
                        if (Number.isFinite(n) && n >= 1) patch({ detectIdiomMaxChars: n });
                      }}
                      className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
                    />
                  </div>
                </div>
                <div className="mt-1 text-xs text-mut2">
                  AI 判定为「习语/俗语」的检测结果，超过这里设置的词数或字符数上限会被当作整句误标而丢弃，而不是保留为一个真正的长行话；其他类别的检测结果不受此项影响。
                </div>
              </div>
            )}

            <div data-ui-level="aiDetectExplainLanguage">
              <label className="text-xs text-mut">解释语言</label>
              {/* S3 fix (v0.6 round-2 review): this IS the translation
                 target — locked while a meeting is active for the same
                 reason 识别语言 above is (see that field's own comment).
                 Changing it mid-meeting makes queue.ts pass a NEW target
                 to a provider still holding the OLD pair, which rejects
                 every batch until the provider is re-primed (never
                 happens mid-meeting), silently dropping pending
                 translations. */}
              <select
                value={draft.explainLanguage}
                onChange={(e) =>
                  patch({ explainLanguage: e.target.value as ExplainLanguage })
                }
                disabled={meetingActive}
                title={meetingActive ? "会议进行中，结束会议后可修改解释语言" : undefined}
                className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                {EXPLAIN_LANGUAGE_OPTIONS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
              <div className="mt-1 text-xs leading-[1.7] text-mut2">
                卡片解释的语言；English 模式给不需要中文的用户，界面文字仍为中文
                {meetingActive && "；会议进行中，结束会议后可修改"}
              </div>
            </div>

            <label
              className="flex items-center justify-between gap-3 py-1"
              data-ui-level="aiDetectBilingual"
            >
              <div>
                <div className={`text-sm ${bilingualTranscriptAvailable ? "text-fg" : "text-mut2"}`}>
                  双语转录
                </div>
                <div className="mt-0.5 text-xs leading-[1.7] text-mut2">
                  {bilingualTranscriptAvailable
                    ? "每段转录实时翻译为中文，显示在原文下方"
                    : "解释语言为 English 时不可用"}
                </div>
              </div>
              <ToggleSwitch
                checked={draft.bilingualTranscript}
                disabled={!bilingualTranscriptAvailable}
                onChange={(checked) => patch({ bilingualTranscript: checked })}
              />
            </label>

            {/* v0.5 F6 (L4 lane subcomponent, lead-inserted per blueprint
               §2's SettingsDialog serialization rule): 翻译引擎 selector —
               LLM (default) vs Chrome 内置系统翻译 (web-only, on-device). */}
            <div data-ui-level="aiDetectTranslateEngine">
              <TranslationEngineRow
                value={draft.translateEngine}
                onChange={(v) => {
                  setEngineTouched(true);
                  patch({ translateEngine: v });
                }}
                langPair={langPairFromSettings(draft)}
              />
              {/* DeepL API Key (translation-rework wave 2): engine-
                 conditional, mirrors the Soniox/Deepgram/ElevenLabs API
                 Key blocks above field-for-field (same hand-rolled
                 masked-input pattern, same S14 no-probe KeyStatusChip
                 honesty — no telemetry/health probe exists for DeepL
                 either). deeplKey already rides toSave's sanitize list
                 (wave 1). */}
              {draft.translateEngine === "deepl" && (
                <div className="mt-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs text-mut">DeepL API Key</label>
                    <KeyStatusChip status={deriveKeyStatus(draft.deeplKey)} />
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type={showDeeplKey ? "text" : "password"}
                      value={draft.deeplKey}
                      onChange={(e) => patch({ deeplKey: e.target.value })}
                      placeholder="粘贴你的 DeepL API Key"
                      className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() => setShowDeeplKey((v) => !v)}
                      aria-label={showDeeplKey ? "隐藏" : "显示"}
                      className="flex h-8 w-8 shrink-0 items-center justify-center text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {showDeeplKey ? (
                        <EyeSlash size={18} weight="regular" />
                      ) : (
                        <Eye size={18} weight="regular" />
                      )}
                    </button>
                  </div>
                  <div className="mt-1 text-xs leading-[1.7] text-mut2">
                    免费版 Key 以 :fx 结尾，每月 50 万字符；在{" "}
                    <button
                      type="button"
                      onClick={() => void openExternal("https://www.deepl.com/pro-api")}
                      className="text-lab-cyan underline decoration-lab-cyan/40"
                    >
                      deepl.com/pro-api
                    </button>{" "}
                    注册
                  </div>
                </div>
              )}
              {/* 有道 API Key (v0.7.1 translation train-2): engine-
                 conditional, mirrors the DeepL block immediately above —
                 same hand-rolled masked-input pattern, same S14 no-probe
                 KeyStatusChip honesty (no telemetry/health probe exists
                 for 有道 either). Two credentials instead of one — the
                 chip reads BOTH (a lone appKey or appSecret still isn't
                 usable). youdaoAppKey/youdaoAppSecret already ride
                 toSave's sanitize list. */}
              {draft.translateEngine === "youdao" && (
                <div className="mt-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs text-mut">有道 应用ID / 应用密钥</label>
                    <KeyStatusChip
                      status={deriveKeyStatus(draft.youdaoAppKey && draft.youdaoAppSecret ? draft.youdaoAppKey : "")}
                    />
                  </div>
                  <div className="mt-1">
                    <input
                      type="text"
                      value={draft.youdaoAppKey}
                      onChange={(e) => patch({ youdaoAppKey: e.target.value })}
                      placeholder="应用ID"
                      className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <input
                      type={showYoudaoAppSecret ? "text" : "password"}
                      value={draft.youdaoAppSecret}
                      onChange={(e) => patch({ youdaoAppSecret: e.target.value })}
                      placeholder="应用密钥"
                      className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() => setShowYoudaoAppSecret((v) => !v)}
                      aria-label={showYoudaoAppSecret ? "隐藏" : "显示"}
                      className="flex h-8 w-8 shrink-0 items-center justify-center text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {showYoudaoAppSecret ? (
                        <EyeSlash size={18} weight="regular" />
                      ) : (
                        <Eye size={18} weight="regular" />
                      )}
                    </button>
                  </div>
                  <div className="mt-1 text-xs leading-[1.7] text-mut2">
                    ① 在{" "}
                    <button
                      type="button"
                      onClick={() => void openExternal("https://ai.youdao.com")}
                      className="text-lab-cyan underline decoration-lab-cyan/40"
                    >
                      ai.youdao.com
                    </button>{" "}
                    注册并登录控制台 ② 创建应用：服务选「文本翻译」、接入方式选「API」 ③
                    在应用总览复制「应用ID」和「应用密钥」填入。英译中约 ¥48/百万字符，新用户体验金即可试用。
                  </div>
                </div>
              )}
            </div>

            {/* 背景画像 (#48 step 3, design Q5): opt-in — default off.
               The rendered hint (llm/profileHint.ts) is spliced into the
               USER message only, never the cached SYSTEM prompt (see
               prompts.ts's AUDIENCE splice); works in preview too (no
               PreviewLockedBadge — it's prompt text on the server-key
               path, not a credential). */}
            <div
              className="space-y-2 border-t border-edge pt-3"
              data-ui-level="aiDetectProfile"
            >
              <label className="flex items-center justify-between gap-3 py-1">
                <div>
                  <div className="text-sm text-fg">背景画像</div>
                  <div className="mt-0.5 text-xs leading-[1.7] text-mut2">
                    把行业/角色/英语水平等信息带入检测与解释请求，帮助 AI 判断哪些内容对你陌生；
                    默认关闭，内容随请求发送到你配置的端点
                  </div>
                </div>
                <ToggleSwitch
                  checked={draft.profile?.enabled ?? false}
                  onChange={(checked) =>
                    patch({ profile: { ...draft.profile, enabled: checked } })
                  }
                />
              </label>

              {draft.profile?.enabled && (
                <div className="space-y-2 pt-1">
                  <div>
                    <label className="text-xs text-mut">行业</label>
                    <input
                      type="text"
                      value={draft.profile.industry ?? ""}
                      onChange={(e) =>
                        patch({ profile: { ...draft.profile!, industry: e.target.value } })
                      }
                      maxLength={40}
                      placeholder="如：金融 / SaaS / 生物医药"
                      className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-mut">角色</label>
                    <input
                      type="text"
                      value={draft.profile.role ?? ""}
                      onChange={(e) =>
                        patch({ profile: { ...draft.profile!, role: e.target.value } })
                      }
                      maxLength={40}
                      placeholder="如：产品经理 / 后端工程师"
                      className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-mut">英语水平</label>
                    <select
                      value={draft.profile.englishLevel ?? ""}
                      onChange={(e) =>
                        patch({
                          profile: {
                            ...draft.profile!,
                            englishLevel: (e.target.value || undefined) as
                              | EnglishLevel
                              | undefined,
                          },
                        })
                      }
                      className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
                    >
                      <option value="">未设置</option>
                      {ENGLISH_LEVEL_OPTIONS.map((l) => (
                        <option key={l.value} value={l.value}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs text-mut">熟悉领域</label>
                    <input
                      type="text"
                      value={draft.profile.familiarDomains ?? ""}
                      onChange={(e) =>
                        patch({
                          profile: { ...draft.profile!, familiarDomains: e.target.value },
                        })
                      }
                      maxLength={40}
                      placeholder="如：云基础设施, 数据管道"
                      className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-mut">薄弱领域</label>
                    <input
                      type="text"
                      value={draft.profile.weakDomains ?? ""}
                      onChange={(e) =>
                        patch({ profile: { ...draft.profile!, weakDomains: e.target.value } })
                      }
                      maxLength={40}
                      placeholder="如：财务术语, 法务合同"
                      className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                    />
                  </div>
                </div>
              )}
            </div>

            {isSectionVisible(level, SETTINGS_UI_LEVELS.aiDetectPacks) && (
            <div
              className="space-y-2 border-t border-edge pt-3"
              data-ui-level="aiDetectPacks"
            >
              <div className="text-xs text-mut">词典主题包</div>
              <label className="flex items-center justify-between gap-3 py-1">
                <div>
                  <div className="text-sm text-mut2">基础包·始终启用</div>
                  <div className="text-xs text-mut2">
                    内置必备表达与商务黑话（{packEntryCounts.core ?? 0} 条）
                  </div>
                </div>
                <ToggleSwitch checked disabled />
              </label>
              {/* v0.6 field-fix (item 1): the 16 built-in packs, bucketed
                 into 3 collapsible groups (+ 其他 catch-all) instead of
                 one flat 16-row list — UI-only, packGroups/renderPackRow
                 both computed above. Collapsed by default; expanding a
                 group reveals its packs via the SAME renderPackRow every
                 remote pack below also uses. */}
              {packGroups.map(({ group, packs }) => {
                const entryTotal = packs.reduce(
                  (sum, p) => sum + (Object.hasOwn(packEntryCounts, p.id) ? packEntryCounts[p.id] : 0),
                  0,
                );
                const onCount = packs.filter((p) => checkedPacks.has(p.id)).length;
                const groupAllOn = onCount === packs.length;
                const isExpanded = expandedPackGroups.has(group);
                return (
                  <div key={group} className="border-t border-edge pt-2 first:border-t-0 first:pt-0">
                    <div className="flex items-center justify-between gap-3 py-1">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedPackGroups((prev) => {
                            const next = new Set(prev);
                            if (next.has(group)) next.delete(group);
                            else next.add(group);
                            return next;
                          })
                        }
                        className="btn-tactile flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm text-fg"
                      >
                        {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                        <span className="truncate">{group}</span>
                        <span className="shrink-0 text-xs text-mut2">
                          {packs.length} 包 · {entryTotal} 条 · {onCount}/{packs.length} 开启
                        </span>
                      </button>
                      <ToggleSwitch
                        checked={groupAllOn}
                        ariaLabel={`${group}：全部启用`}
                        onChange={(checked) =>
                          setCheckedPacks((prev) => {
                            const next = new Set(prev);
                            for (const p of packs) {
                              if (checked) next.add(p.id);
                              else next.delete(p.id);
                            }
                            return next;
                          })
                        }
                      />
                    </div>
                    {isExpanded && <div className="space-y-2 pl-4">{packs.map(renderPackRow)}</div>}
                  </div>
                );
              })}
              {/* Remote/imported packs — stay outside the groups above,
                 unchanged flat list. */}
              {remotePacksList.map(renderPackRow)}
            </div>
            )}

            {/* 词典库 (#20 v0.6 T6): browse/install packs from the
               community catalog jargonslayer-dicts publishes — installs
               go through the exact same addPackSource() as a manual URL
               paste below, just pre-filled from the index instead of
               requiring the user to hunt down a raw link themselves.
               Lazy-fetched (see the effect above) only once this
               category is actually visible, never on dialog mount. */}
            {isSectionVisible(level, SETTINGS_UI_LEVELS.aiDetectPackCatalog) && (
            <div
              className="space-y-2 border-t border-edge pt-3"
              data-ui-level="aiDetectPackCatalog"
            >
              <div className="text-xs text-mut">词典库</div>
              {catalogStatus === "loading" && (
                <div className="text-xs text-mut2">加载词典目录中…</div>
              )}
              {catalogStatus === "error" && (
                <div className="flex items-center justify-between gap-2 text-xs leading-[1.7] text-mut2">
                  <span>暂时无法加载词典目录，可稍后重试或用下方链接手动添加</span>
                  {/* L2 fix (adversarial review): catalogStatus never
                     returned to "idle" on its own, so "可稍后重试" was
                     unkeepable — resetting to "idle" re-arms the fetch
                     effect's own "idle" gate above. */}
                  <button
                    type="button"
                    onClick={() => setCatalogStatus("idle")}
                    className="btn-tactile shrink-0 border border-edge px-2 py-1 text-xs text-fg hover:bg-panel3"
                  >
                    重试
                  </button>
                </div>
              )}
              {catalogStatus === "loaded" && catalogPacks && catalogPacks.length === 0 && (
                <div className="text-xs leading-[1.7] text-mut2">词典目录暂时是空的</div>
              )}
              {catalogStatus === "loaded" && catalogPacks && catalogPacks.length > 0 && (
                <div className="space-y-1.5">
                  {catalogPacks.map((row) => {
                    const installedSource = packSources.find((s) => s.pack.id === row.id);
                    // L3/N6 fix (adversarial review): id-only + String()
                    // equality used to (a) render 更新 pointing at the
                    // catalog's official url even when the installed
                    // pack under this id came from a DIFFERENT source
                    // (e.g. the user's own fork), and (b) present a
                    // semver-OLDER catalog entry as an "update" (a stale
                    // catalog serving a downgrade). `upToDate` is
                    // version-only (>=, real semver ordering — never
                    // offer anything once the installed version already
                    // meets or exceeds the catalog's); 更新 additionally
                    // requires the installed SOURCE to be this same
                    // catalog url — otherwise it's an honest fresh 安装
                    // of the official pack, not a same-lineage update.
                    const versionCmp = installedSource
                      ? compareSemver(String(installedSource.pack.version), String(row.version))
                      : null;
                    const sameSource = !!installedSource && installedSource.url === row.url;
                    const upToDate = versionCmp !== null && versionCmp >= 0;
                    const offersUpdate = !upToDate && sameSource;
                    return (
                      <div
                        key={row.id}
                        className="flex items-center justify-between gap-2 border border-edge bg-panel2 px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-fg">{row.name}</div>
                          {row.description && (
                            <div className="truncate text-xs text-mut2">{row.description}</div>
                          )}
                          <div className="text-xs text-mut2">
                            {row.entryCount ?? "?"} 条{row.license ? ` · ${row.license}` : ""}
                            {row.tags && row.tags.length > 0 ? ` · ${row.tags.join(" ")}` : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleInstallCatalogPack(row)}
                          disabled={installingCatalogId === row.id || upToDate}
                          className="btn-tactile shrink-0 border border-edge px-2 py-1 text-xs text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {installingCatalogId === row.id
                            ? "安装中…"
                            : upToDate
                              ? "已安装"
                              : offersUpdate
                                ? "更新"
                                : "安装"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            )}

            {/* 词典源 (#20): install community dictionary packs from a
               URL, a local file, or pasted JSON. getAllPacks() above
               already folds loaded remote packs into the checkbox
               list; this subsection manages the underlying sources
               (add/import/remove/update-check). */}
            {isSectionVisible(level, SETTINGS_UI_LEVELS.aiDetectPackSources) && (
            <div
              className="space-y-2 border-t border-edge pt-3"
              data-ui-level="aiDetectPackSources"
            >
              <div className="text-xs text-mut">词典源</div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={packSourceUrl}
                  onChange={(e) => setPackSourceUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAddPackSource();
                  }}
                  placeholder="https://raw.githubusercontent.com/…/pack.json"
                  className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleAddPackSource()}
                  disabled={addingPackSource || !packSourceUrl.trim()}
                  className="btn-tactile shrink-0 border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {addingPackSource ? "添加中…" : "添加"}
                </button>
              </div>

              {/* v0.6 T2: mirrors the 显示 section's own 导入主题文件
                 block exactly (:4965-5008's own shape) — a collapsed
                 file-picker + paste-JSON panel sharing one parse+install
                 tail (handleImportPackJson above). */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs text-mut">从文件导入 / 粘贴 JSON</label>
                  <button
                    type="button"
                    onClick={() => setPackImportOpen((v) => !v)}
                    className="text-xs text-act hover:underline"
                  >
                    {packImportOpen ? "收起" : "展开"}
                  </button>
                </div>
                {packImportOpen && (
                  <div className="mt-1 space-y-2 border border-edge bg-panel2 p-3">
                    <label className="btn-tactile inline-block cursor-pointer border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3">
                      选择文件
                      <input
                        type="file"
                        accept="application/json,.json"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = ""; // allow re-picking the same file
                          if (file) void handleImportPackFile(file);
                        }}
                      />
                    </label>
                    <textarea
                      value={packImportText}
                      onChange={(e) => setPackImportText(e.target.value)}
                      placeholder="或粘贴词典包 JSON…"
                      rows={3}
                      className="w-full resize-none border border-edge bg-panel px-2.5 py-1.5 font-mono text-xs leading-[1.7] text-fg placeholder:text-mut2 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void handleImportPackJson(packImportText)}
                      disabled={!packImportText.trim()}
                      className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      解析并导入
                    </button>
                  </div>
                )}
              </div>

              {/* v0.6 T2/T3(b): persistent inline error for EVERY
                 install path above (URL/file/paste) and the 词典库 row
                 buttons above that — mirrors restoreError's own idiom
                 (:4596-4598) rather than losing a validation error to a
                 toast that's already gone. */}
              {packInstallError && (
                <div className="text-xs leading-[1.7] text-warn-soft">{packInstallError}</div>
              )}

              {packSources.length > 0 && (
                <div className="space-y-1.5">
                  {packSources.map((s) => {
                    // v0.6 T5/GOTCHA: s.url is "" (not undefined) for a
                    // file-imported pack — every identifier/key below
                    // is `s.url || s.pack.id`, never `s.url` alone.
                    const id = s.url || s.pack.id;
                    const hasNotice = !!(
                      s.pack.source ||
                      s.pack.license ||
                      s.pack.sourceVersion ||
                      s.pack.citation ||
                      s.pack.notice
                    );
                    const noticeOpen = expandedPackNotices.has(id);
                    return (
                      <div key={id} className="border border-edge bg-panel2 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-fg">{s.pack.name}</div>
                            <div className="font-mono text-xs tabular-nums text-mut2">
                              v{s.pack.version} ·{" "}
                              {s.pack.expressions.length + s.pack.terms.length} 条
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {/* v0.6 T5: NOTICE/attribution disclosure —
                               only rendered when there's actually
                               something to show (a v1 pack with no
                               attribution metadata renders no trigger
                               at all, never an empty expanded block). */}
                            {hasNotice && (
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedPackNotices((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(id)) next.delete(id);
                                    else next.add(id);
                                    return next;
                                  })
                                }
                                className="btn-tactile px-2 py-1 text-xs text-mut hover:bg-panel3 hover:text-fg"
                              >
                                {noticeOpen ? "收起来源" : "来源与许可"}
                              </button>
                            )}
                            {/* checkUpdates() itself skips file-imported
                               sources outright (nothing to refetch) —
                               hide the button rather than show one that
                               always no-ops. */}
                            {s.url && (
                              <button
                                type="button"
                                onClick={() => void handleCheckUpdates(s.url)}
                                disabled={checkingUpdates}
                                className="btn-tactile px-2 py-1 text-xs text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                检查更新
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleRemovePackSource(s)}
                              className={`btn-tactile px-2 py-1 text-xs hover:bg-panel3 ${
                                confirmRemovePackId === id ? "text-warn-soft" : "text-mut hover:text-warn-soft"
                              }`}
                            >
                              {confirmRemovePackId === id ? "确认移除?" : "移除"}
                            </button>
                          </div>
                        </div>
                        {hasNotice && noticeOpen && (
                          <div className="mt-2 space-y-1 border-t border-edge pt-2 text-xs leading-[1.7] text-mut2">
                            {/* External pack-metadata URLs (source/
                               license) are rendered as selectable TEXT,
                               never a clickable link: the desktop
                               opener plugin's own allowlist (apps/
                               desktop/src-tauri/capabilities/
                               default.json) only covers openrouter.ai/
                               github.com/huggingface.co, and a pack's
                               sourceUrl/licenseUrl can point at
                               literally anything (raw.githubusercontent.
                               com, choosealicense.com, an arbitrary
                               journal/agency site, …) — see this
                               worker's own task doc for the ruling. */}
                            {s.pack.source && (
                              <div>
                                来源：{s.pack.source}
                                {s.pack.sourceUrl && s.pack.sourceUrl.startsWith("https://") && (
                                  <span className="ml-1 break-all">({s.pack.sourceUrl})</span>
                                )}
                              </div>
                            )}
                            {s.pack.license && (
                              <div>
                                许可：{s.pack.license}
                                {s.pack.licenseUrl && s.pack.licenseUrl.startsWith("https://") && (
                                  <span className="ml-1 break-all">({s.pack.licenseUrl})</span>
                                )}
                              </div>
                            )}
                            {s.pack.sourceVersion && <div>原始版本：{s.pack.sourceVersion}</div>}
                            {s.pack.citation && <div>引用：{s.pack.citation}</div>}
                            {/* notice is rendered VERBATIM as plain text
                               (pre-clamped to 600 chars upstream,
                               remotePacks.ts) — a plain React text child
                               is never interpreted as HTML, so this is
                               safe even though the string itself is
                               untrusted remote content. */}
                            {s.pack.notice && (
                              <div className="whitespace-pre-wrap break-words">{s.pack.notice}</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => void handleCheckUpdates()}
                    disabled={checkingUpdates}
                    className="btn-tactile w-full border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {checkingUpdates ? "检查中…" : "检查全部更新"}
                  </button>
                </div>
              )}

              {/* Round-2: quiet daily auto-refresh — supplements 检查全部
                 更新 above, never replaces it (that button still runs the
                 SAME checkUpdates() on demand, see lib/detect/
                 packAutoUpdate.ts). packAutoUpdateCheckedAt is written by
                 background code outside this dialog's draft/保存 flow
                 (app/dictPackAutoUpdateTrigger.ts), so this reads the
                 LIVE `settings` value, never `draft`'s dialog-open-time
                 snapshot — see handleSave's own
                 toSave.packAutoUpdateCheckedAt for the matching "always
                 take the live value" fix on the save side. */}
              <label className="flex items-center justify-between gap-3 py-1">
                <div className="text-sm text-fg">自动更新词典（联网时每天检查一次）</div>
                <ToggleSwitch
                  checked={draft.packAutoUpdate}
                  onChange={(checked) => patch({ packAutoUpdate: checked })}
                />
              </label>
              <div className="text-xs text-mut2">{formatLastPackCheck(settings.packAutoUpdateCheckedAt)}</div>

              <div className="text-xs leading-[1.7] text-mut2">
                从 GitHub raw / jsDelivr 链接安装社区词典包（支持粘贴 GitHub 网页链接，自动转换为 raw 链接），JSON 格式见文档
              </div>
            </div>
            )}
          </section>
          )}

          {/* 密钥 (ft6): dedicated credential hub — one field per provider/
             service, each labelled with what it backs and a configured/
             unconfigured (or healthier) chip via keyStatus.ts. Canonical
             editor for every credential; contextual engine/translate/AI/
             task/subscription rows below keep writing the SAME draft
             fields (never a second copy of state). Presentation only —
             storage shape, resolve-time routing, and keychain custody
             are unchanged. */}
          {activeCategory === "keys" && isSectionVisible(level, SETTINGS_UI_LEVELS.keys) && (
          <section
            className="space-y-4 border-t border-edge pt-5"
            data-ui-level="keys"
          >
            <SectionHeading>密钥</SectionHeading>
            <div className="text-xs leading-[1.7] text-mut2">
              所有凭据集中在此：每个提供方一个字段，状态显示是否已配置。引擎/翻译旁的入口写入同一字段，不会另存一份。
            </div>

            <div className="space-y-3">
              <div className="text-xs font-medium text-mut">LLM 提供方</div>
              {PROVIDER_KEY_CATALOG.map((entry) => {
                const value = draft[entry.field] ?? "";
                const activeProviderKeyName = providerApiKeyNameFor(draft.provider, draft.baseUrl);
                // Evidence only describes the SAVED primary credential —
                // gate on this row still being the draft's resolved
                // provider key AND matching what's saved (same FINDING 5
                // rule as the AI 检测 CredentialFields chip).
                const isActiveProviderKey =
                  activeProviderKeyName === entry.field &&
                  (entry.field !== "apiKeyCustom" ||
                    (draft.llmCustomHost ?? "") === providerHostFor(draft.baseUrl));
                const status = deriveKeyStatus(
                  value,
                  isActiveProviderKey &&
                    credsMatch(
                      { provider: draft.provider, baseUrl: draft.baseUrl, apiKey: draftApiKey },
                      { provider: settings.provider, baseUrl: settings.baseUrl, apiKey: savedApiKey },
                    )
                    ? llmKeyEvidence(
                        primaryTelemetryDomains(draft).map((d) => telemetry[d]),
                        domainUsesOwnKey(draft, "detect") ? undefined : testConnectionOk,
                      )
                    : undefined,
                );
                // FINDING 2 fix: apiKeyCustom is host-bound
                // (resolveProviderApiKey returns "" unless
                // llmCustomHost === providerHostFor(baseUrl), see
                // providerKeys.ts). Writing it with a bare
                // `patch({ apiKeyCustom })` — as every OTHER row here
                // safely does — left the host binding stale, so the
                // key this row just saved either never resolved (dead
                // key on 自定义端点) or, worse, resolved against
                // whatever custom host the draft used to be bound to
                // (the FT-2 cross-host leak class). Route through the
                // same providerApiKeyPatch contract the primary "AI
                // 检测" editor uses instead of inventing a second
                // write path, and only when the draft's OWN provider/
                // baseUrl actually resolves to apiKeyCustom — while
                // the draft sits on a named preset there is no
                // meaningful host to bind, so disable the row rather
                // than silently writing a binding that doesn't apply
                // to what's currently selected.
                const isCustomKeyField = entry.field === "apiKeyCustom";
                const customKeyBindable =
                  !isCustomKeyField || activeProviderKeyName === "apiKeyCustom";
                return (
                  <SecretKeyRow
                    key={entry.field}
                    fieldId={keysCatalogFieldId(entry)}
                    label={entry.label}
                    purpose={entry.purpose}
                    value={value}
                    onChange={(apiKey) =>
                      patch(
                        isCustomKeyField
                          ? providerApiKeyPatch(draft.provider, draft.baseUrl, apiKey)
                          : { [entry.field]: apiKey },
                      )
                    }
                    placeholder={entry.placeholder}
                    status={status}
                    inputType={entry.inputType}
                    disabled={!customKeyBindable}
                    hint={
                      customKeyBindable
                        ? undefined
                        : "当前「提供方」不是自定义端点，此处无法绑定 Host；先在「AI 检测」将提供方切换为自定义端点后再填写"
                    }
                  />
                );
              })}
            </div>

            <div className="space-y-3 border-t border-edge pt-3">
              <div className="text-xs font-medium text-mut">分任务覆盖（可选）</div>
              {/* FINDING 11 custody-copy decision: keep these rows.
                 Escalated review's actual blocking concern — a provider/
                 host switch silently carrying the old key to the new
                 host (the FT-2 class) — is now closed at the source
                 (patchConfigForHost above), so what's left is a genuine
                 custody gap, not a leak: store.ts's settingsForPersist
                 only ever strips secretCustody fields, and
                 taskLlm.*.apiKey deliberately never joins SECRET_NAMES
                 (see that file's own NOTE on settingsForPersist) — so on
                 desktop these three fields are the one exception to
                 "已配置 == 存于系统钥匙串". Pulling the rows back out of
                 the hub would hide that gap, not close it (the
                 pre-existing 分任务模型（高级） editor could still write
                 the same plaintext field); saying so plainly here is the
                 honest fix. */}
              {IS_DESKTOP && (
                <div className="text-xs leading-[1.7] text-mut2">
                  与上方不同：分任务 Key 不进入 macOS 系统钥匙串，仍以明文存于本机应用数据中
                </div>
              )}
              {TASK_KEY_CATALOG.map((entry) => {
                const value = draft.taskLlm?.[entry.domain]?.apiKey ?? "";
                const status = deriveKeyStatus(
                  value,
                  credsMatch(
                    resolveTaskCreds(draft, entry.domain),
                    resolveTaskCreds(settings, entry.domain),
                  )
                    ? llmKeyEvidence(
                        TASK_DOMAIN_TELEMETRY[entry.domain].map((d) => telemetry[d]),
                        entry.domain === "detect" && domainUsesOwnKey(draft, "detect")
                          ? testConnectionOk
                          : undefined,
                      )
                    : undefined,
                );
                return (
                  <SecretKeyRow
                    key={entry.domain}
                    fieldId={keysCatalogFieldId(entry)}
                    label={entry.label}
                    purpose={entry.purpose}
                    value={value}
                    onChange={(apiKey) => {
                      const prev = draft.taskLlm?.[entry.domain];
                      handleTaskLlmChange(entry.domain, {
                        enabled: prev?.enabled ?? false,
                        provider: prev?.provider,
                        baseUrl: prev?.baseUrl,
                        apiKey,
                        model: prev?.model,
                      });
                    }}
                    placeholder={entry.placeholder}
                    status={status}
                    inputType={entry.inputType}
                  />
                );
              })}
            </div>

            <div className="space-y-3 border-t border-edge pt-3">
              <div className="text-xs font-medium text-mut">转录 / 分离 / 翻译 / 订阅</div>
              {SERVICE_KEY_CATALOG.filter(
                (entry) =>
                  !entry.subscriptionDirectOnly ||
                  process.env.NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT === "1",
              ).map((entry) => {
                const value = draft[entry.field] ?? "";
                // youdao status historically requires BOTH id+secret —
                // keep that honesty for the pair while still editing
                // one field per row.
                const statusValue =
                  entry.field === "youdaoAppKey" || entry.field === "youdaoAppSecret"
                    ? draft.youdaoAppKey && draft.youdaoAppSecret
                      ? value
                      : ""
                    : value;
                const status = deriveKeyStatus(
                  statusValue,
                  entry.field === "hfToken" && !PREVIEW_TIER
                    ? { hasSuccess: sidecarStatus?.diarize === true }
                    : undefined,
                );
                return (
                  <SecretKeyRow
                    key={entry.field}
                    fieldId={keysCatalogFieldId(entry)}
                    label={entry.label}
                    purpose={entry.purpose}
                    value={value}
                    onChange={(next) => patch({ [entry.field]: next })}
                    placeholder={entry.placeholder}
                    status={status}
                    inputType={entry.inputType}
                    disabled={entry.field === "hfToken" && PREVIEW_TIER}
                  />
                );
              })}
            </div>
          </section>
          )}

          {/* 分任务模型（高级）(#56, BYOK-only): a self-contained section
             (design Q5's #62 fit note — advanced-mode visibility gating
             later is a one-line change here) so translate/detect/
             summary can each optionally point at a different provider/
             model, inheriting the primary "AI 检测" credential above by
             default. BYOK preview sprint (2026-07-21): un-gated — full-
             tier behavior on preview, same as the primary credential
             block above (no more PreviewLockedBadge/disabled-as-ONE-
             group; the whole point of BYOK is meaningless on the OLD
             preview where calls ran on our own server key, but that's no
             longer this build's posture). #62: advanced-only, per the
             fit note above. */}
          {activeCategory === "taskLlm" && isSectionVisible(level, SETTINGS_UI_LEVELS.taskLlm) && (
          <section
            className="space-y-3 border-t border-edge pt-5"
            data-ui-level="taskLlm"
          >
            <button
              type="button"
              onClick={() => setTaskLlmExpanded((v) => !v)}
              className="flex w-full items-center justify-between gap-2"
            >
              <span className="flex items-center gap-2">
                <SectionHeading>分任务模型（高级）</SectionHeading>
              </span>
              <span className="text-xs text-mut2">{taskLlmExpanded ? "收起" : "展开"}</span>
            </button>

            <div className="text-xs leading-[1.7] text-mut2">
              为翻译 / 检测与解释 / 会议报告分别指定不同的提供方或模型；未单独配置的场景使用上方主配置
            </div>

            {taskLlmExpanded && (
              <div className="space-y-2">
                {TASK_DOMAIN_META.map((meta) => (
                  <TaskDomainBlock
                    key={meta.domain}
                    domain={meta.domain}
                    label={meta.label}
                    hint={meta.hint}
                    staticModelOptions={meta.staticModelOptions}
                    config={draft.taskLlm?.[meta.domain]}
                    primary={draft}
                    onChange={(next) => handleTaskLlmChange(meta.domain, next)}
                    disabled={false}
                    // S14: only "detect" is ever what 测试连接 actually
                    // probes (client.ts's testConnection always resolves
                    // the "detect" domain's CURRENT credentials) — so its
                    // testConnectionOk only feeds THIS chip when detect
                    // currently owns its own key, never translate/summary.
                    // FINDING 5 (S14 fix round): evidence is additionally
                    // gated on the draft's resolveTaskCreds-resolved
                    // triple for this domain still matching the SAVED
                    // settings' own resolveTaskCreds resolution — same
                    // "telemetry can only describe what's saved" rule as
                    // the primary chip above, folded through the same
                    // inheritance resolveTaskCreds already applies (so a
                    // domain that currently inherits the primary key is
                    // compared on the primary triple too, not just an
                    // own-key edit).
                    apiKeyStatus={deriveKeyStatus(
                      draft.taskLlm?.[meta.domain]?.apiKey ?? "",
                      credsMatch(
                        resolveTaskCreds(draft, meta.domain),
                        resolveTaskCreds(settings, meta.domain),
                      )
                        ? llmKeyEvidence(
                            TASK_DOMAIN_TELEMETRY[meta.domain].map((d) => telemetry[d]),
                            meta.domain === "detect" && domainUsesOwnKey(draft, "detect")
                              ? testConnectionOk
                              : undefined,
                          )
                        : undefined,
                    )}
                  />
                ))}
              </div>
            )}
          </section>
          )}

          {/* 数据与联动 — advanced */}
          {activeCategory === "dataIntegration" && isSectionVisible(level, SETTINGS_UI_LEVELS.dataIntegration) && (
          <section
            className="space-y-3 border-t border-edge pt-5"
            data-ui-level="dataIntegration"
          >
            <SectionHeading>数据与联动</SectionHeading>

            {/* S13 iOS mobile-UX round (Part A #5): 选择导出文件夹 rides
               window.showDirectoryPicker — the File System Access API,
               which WebKit has never implemented on ANY platform
               (verified against caniuse: Safari desktop AND iOS Safari
               both read "not supported", every version) — not a
               Tauri-plugin gap, a WKWebView/WebKit gap, so chooseExportFolder
               (lib/history/autoExport.ts) can never actually resolve a
               folder there; the 自动导出 toggle alone is then a no-op
               (exportSessionToFolder silently skips with no folder
               configured). Whole block hidden rather than left as a
               dead toggle + a button that can never succeed. */}
            {!IS_IOS && (
            <>
            <label className="flex items-center justify-between gap-3 py-1">
              <span className="text-sm text-fg">自动导出</span>
              <ToggleSwitch checked={draft.autoExport} onChange={(checked) => patch({ autoExport: checked })} />
            </label>

            <div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleChooseExportFolder()}
                  className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
                >
                  选择导出文件夹
                </button>
                {exportFolderName && (
                  <>
                    <span className="text-xs text-mut">{exportFolderName}</span>
                    <button
                      type="button"
                      onClick={() => void handleClearExportFolder()}
                      className="btn-tactile text-xs text-mut hover:text-warn-soft"
                    >
                      清除
                    </button>
                  </>
                )}
              </div>
              <div className="mt-1 text-xs leading-[1.7] text-mut2">
                每场会议结束后自动写入 .md + .json，适合 Obsidian vault / git
                仓库 / 任意目录
              </div>
            </div>
            </>
            )}

            <div>
              <label className="text-xs text-mut">Webhook URL</label>
              <input
                type="text"
                value={draft.webhookUrl}
                onChange={(e) => patch({ webhookUrl: e.target.value })}
                placeholder="https://…"
                className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
              />
              <div className="mt-1 text-xs leading-[1.7] text-mut2">
                会后 POST 会议 JSON 到该地址（n8n/飞书机器人等），导入任务的开始/完成/失败也会推送
                task.* 事件
              </div>
            </div>

            {/* v0.5 F9 (L7 lane subcomponent, lead-inserted per blueprint
               §2's SettingsDialog serialization rule): AnkiConnect —
               module-only for now; the post-save delivery hook lands in
               F0b (store wiring), so 测试并授权 works but auto-delivery
               starts once that hook merges. Hidden on iOS inside the
               component itself. */}
            <AnkiConnectSection
              value={draft.ankiConnect}
              onChange={(ankiPatch) =>
                patch({ ankiConnect: { ...draft.ankiConnect, ...ankiPatch } })
              }
            />

            {/* v0.6: local usage ledger for BYOK users — what your own
               keys are being spent on. Local-only by construction (idb,
               nothing leaves the device); the panel owns its own on/off
               toggle, same self-contained shape as AnkiConnectSection. */}
            <UsagePanel
              value={draft.usageTracking}
              onChange={(usageTracking) => patch({ usageTracking })}
            />

            <label className="flex items-center justify-between gap-3 py-1">
              <div>
                <div className="text-sm text-fg">Frontmatter</div>
                <div className="text-xs text-mut2">
                  导出的 Markdown 带 YAML frontmatter
                </div>
              </div>
              <ToggleSwitch
                checked={draft.exportFrontmatter}
                onChange={(checked) => patch({ exportFrontmatter: checked })}
              />
            </label>

            {/* 全量备份/恢复 (#57): sessions + 词典 + settings as one JSON
               file — download/upload, no server round-trip (matches the
               app's local-first IndexedDB storage). Not "一键" in the
               strict sense (import needs an explicit confirm step,
               deliberately — restore replaces settings wholesale), so
               the copy below and the README describe it as two buttons,
               not a single click. */}
            <div className="space-y-2 border-t border-edge pt-3">
              <div className="text-xs text-mut">全量备份</div>

              {/* Storage durability + visibility (v0.5 closeout item 4):
                 read-only navigator.storage.estimate() line — feature-
                 detected, no loading state (renders nothing until the
                 effect above resolves). Sits next to 全量备份 since both
                 are "how much of my meeting history/data is here" data
                 concerns. */}
              {storageEstimate && (
                <div className="text-xs text-mut2">
                  本地存储：已用 {storageEstimate.usageMb.toFixed(1)} MB / 配额约{" "}
                  {storageEstimate.quotaGb.toFixed(1)} GB
                </div>
              )}

              <label className="flex items-center justify-between gap-3 py-1">
                <div>
                  <div className="text-sm text-fg">不包含 API Key</div>
                  <div className="text-xs text-mut2">
                    取消勾选后，备份将包含你的 API Key（AI 检测 / 分任务模型 / HF Token / Soniox Key /
                    Deepgram Key / ElevenLabs Key / Webhook / 连接码），请妥善保管
                  </div>
                </div>
                <ToggleSwitch
                  checked={exportStripKeys}
                  onChange={(checked) => setExportStripKeys(checked)}
                />
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleExportBackup()}
                  className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
                >
                  导出全量备份
                </button>
                <label className="btn-tactile cursor-pointer border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3">
                  导入备份
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = ""; // allow re-picking the same file
                      if (file) void handlePickBackupFile(file);
                    }}
                  />
                </label>
              </div>

              {restoreError && (
                <div className="text-xs leading-[1.7] text-warn-soft">{restoreError}</div>
              )}

              {restorePreview && (
                <div className="space-y-2 border border-warn-soft/40 bg-panel2 p-3">
                  <div className="text-sm text-fg">确认恢复备份？</div>
                  <ul className="space-y-0.5 text-xs leading-[1.7] text-mut2">
                    <li>会议历史：{restorePreview.sessions} 场（按 ID 合并，同 ID 的已有会议将被覆盖）</li>
                    <li>个人词典：{restorePreview.entries} 条（按 ID 合并，规则同上）</li>
                    <li>学习记录：{restorePreview.learnset} 条（按记录合并，规则同上；备份不含此项时当前记录保持不变）</li>
                    {/* M3 fix (adversarial review): disclose that the
                       file contains dictionary packs at all — restoring
                       makes the browser fetch every url-backed row. */}
                    {restorePreview.packSources > 0 && (
                      <li>词典包：{restorePreview.packSources} 个（url 来源将重新联网获取，请确认文件来源可信）</li>
                    )}
                    <li>
                      设置：
                      {restorePreview.hasSettings
                        ? restorePreview.hasApiKey
                          ? "备份中包含设置（含 API Key），将完全覆盖当前设置"
                          : "备份中包含设置（不含 API Key），将完全覆盖当前设置"
                        : "备份中不含设置，当前设置保持不变"}
                    </li>
                  </ul>
                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setRestorePreview(null)}
                      disabled={restoring}
                      className="btn-tactile px-3 py-1.5 text-sm text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleConfirmRestore()}
                      disabled={restoring}
                      className="btn-tactile border border-warn-soft/50 px-3 py-1.5 text-sm text-warn-soft hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {restoring ? "恢复中…" : "确认恢复"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 诊断信息 (owner ask: "用户需要能看到错误信息和编号方便反馈") — a
               small viewer over the diag ring buffer (lib/diag/log.ts) +
               a copyable, secret-stripped bundle (buildDiagnosticReport,
               lib/diag/report.ts). This block is advanced-only (数据与联
               动's own section tag, above) — simple-mode users don't see
               it, but they still get a `[JS-xxxx]` ref + 复制诊断 action
               straight off any error toast (Toast.tsx), so a bug report
               is possible without ever opening 高级 settings; this panel
               is the deeper "browse everything" view for people who
               already have advanced open. */}
            <div className="space-y-2 border-t border-edge pt-3">
              <div className="flex items-center justify-between">
                <div className="text-xs text-mut">诊断信息 · 共 {diagEntries.length} 条</div>
                <button
                  type="button"
                  onClick={() => void openExternal("https://github.com/mianaz/jargonslayer/issues")}
                  className="text-xs text-act hover:underline"
                >
                  提交 Issue ↗
                </button>
              </div>

              <div className="max-h-40 space-y-1 overflow-y-auto border border-edge bg-panel2 p-2 font-mono text-xs">
                {diagEntries.length === 0 ? (
                  <div className="text-mut2">暂无诊断记录</div>
                ) : (
                  diagEntries
                    .slice(-50)
                    .reverse()
                    .map((entry, i) => (
                      <div
                        key={i}
                        className={
                          entry.level === "error"
                            ? "text-warn-soft"
                            : entry.level === "warn"
                              ? "text-lab-orange"
                              : "text-mut2"
                        }
                      >
                        {new Date(entry.ts).toLocaleTimeString()} [{entry.tag}] {entry.message}
                        {entry.ref ? ` (${entry.ref})` : ""}
                      </div>
                    ))
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopyDiagnostics()}
                  className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
                >
                  复制诊断信息
                </button>
                <button
                  type="button"
                  onClick={() => void handleExportDiagnostics()}
                  className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
                >
                  导出诊断文件
                </button>
                <button
                  type="button"
                  onClick={handleClearDiagnostics}
                  className="btn-tactile text-xs text-mut hover:text-warn-soft"
                >
                  清空
                </button>
                {/* v0.4 S3 chunk 7, generalized by the beta-phase
                   diagnostics audit item 1: desktop-only — tails
                   whichever of the three allowlisted log files the
                   select below names, via Rust's read_app_log
                   (provision.rs), shown below in the same monospace box
                   style as the diag entries list above. */}
                {IS_DESKTOP && (
                  <>
                    <select
                      value={logSource}
                      onChange={(e) => {
                        setLogSource(e.target.value as DesktopLogSource);
                        setAppLogText(null);
                      }}
                      className="border border-edge bg-panel2 px-2 py-1.5 text-sm text-fg focus:outline-none"
                    >
                      <option value="whisper_server.log">Whisper 服务</option>
                      <option value="audiocap.log">系统/App 音频</option>
                      <option value="osspeech.log">系统识别</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => void handleViewAppLog()}
                      disabled={loadingAppLog}
                      className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {loadingAppLog ? "读取中…" : "查看本地日志"}
                    </button>
                  </>
                )}
              </div>

              {IS_DESKTOP && appLogText !== null && (
                <div className="max-h-40 overflow-y-auto border border-edge bg-panel2 p-2 font-mono text-xs text-mut2">
                  {appLogText === "" ? (
                    <div className="text-mut2">暂无日志（该服务还没启动过）</div>
                  ) : (
                    <pre className="whitespace-pre-wrap break-all">{appLogText}</pre>
                  )}
                </div>
              )}
            </div>

            {/* S14: understated cross-platform availability note — no
               button, no emphasis. This dialog has no dedicated 关于/
               版本 area today, so it sits beside 诊断信息 (the closest
               existing "about this build" cluster). S13 iOS mobile-UX
               round (Part A #3): aimed at web/desktop users who don't
               yet have the iOS app — noise inside the iOS app itself. */}
            {!IS_IOS && (
            <div className="border-t border-edge pt-3 text-xs leading-[1.7] text-mut2">
              iOS 测试版已上线 TestFlight（受邀测试，联系作者获取邀请）；手机浏览器也可直接使用网页版。
            </div>
            )}
          </section>
          )}

          {/* 订阅直连（实验性，v0.2.2）— kill-switch layer 2: this whole
             section (markup, state, calls) is compiled out of the
             bundle entirely when NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT
             is unset (verified via `npm run build` — see task report),
             not merely hidden by a runtime check. It is DELIBERATELY
             its own independent block, NOT a PROVIDER_PRESETS entry —
             it doesn't route through Next's provider/baseUrl header
             model at all (a separate local sidecar port instead), and
             folding it into that dropdown would blur resolveLlmConfig's
             BYOK-vs-shared-key architecture (see anthropic.ts's own
             comment on that boundary). #62: advanced-only, AND-ed with
             the build flag above. */}
          {activeCategory === "subscriptionDirect" &&
            !IS_IOS &&
            process.env.NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT === "1" &&
            isSectionVisible(level, SETTINGS_UI_LEVELS.subscriptionDirect) && (
            <section
              className="space-y-3 border-t border-edge pt-5"
              data-ui-level="subscriptionDirect"
            >
              <SectionHeading>订阅直连（实验性）</SectionHeading>
              <div className="text-xs leading-[1.7] text-mut2">
                用你自己机器上已登录的 Claude / ChatGPT，通过本机 sidecar 直接调用
                ——凭据不经过任何服务器，仅 detect / define 两个场景生效；依官方政策可能变化，随时可关闭。
              </div>

              <label className="flex items-center justify-between gap-3 py-1">
                <span className="text-sm text-fg">启用订阅直连（仅 detect/define，限本地版）</span>
                <ToggleSwitch
                  checked={draft.subscriptionDirect}
                  onChange={(checked) => patch({ subscriptionDirect: checked })}
                />
              </label>

              {draft.subscriptionDirect && (
                <>
                  <div className="flex items-center justify-between gap-3 border border-edge bg-panel2 px-3 py-2">
                    <div className="text-sm text-fg">
                      宿主状态：
                      {agentHealthState ? (
                        <span className="text-lab-green">● 已连接（{draft.agentUrl}）</span>
                      ) : (
                        <span className="text-mut2">○ 未检测到</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleCheckAgentHealth()}
                      disabled={checkingAgentHealth}
                      className="btn-tactile shrink-0 border border-edge px-2 py-1 text-xs text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {checkingAgentHealth ? "检测中…" : "重新检测"}
                    </button>
                  </div>

                  {!agentHealthState && (
                    <div className="text-xs leading-[1.7] text-mut2">
                      未检测到宿主，请先启动 sidecar（
                      <code className="bg-panel2 px-1 font-mono">
                        python -m sidecar.agent_server --port 8767
                      </code>
                      ），详见 README「订阅直连」章节
                    </div>
                  )}

                  <div>
                    <label className="text-xs text-mut">宿主地址</label>
                    <input
                      type="text"
                      value={draft.agentUrl}
                      onChange={(e) => patch({ agentUrl: e.target.value })}
                      placeholder="http://127.0.0.1:8767"
                      className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-mut">Provider</label>
                    <div className="mt-1 flex items-center gap-0.5 border border-edge bg-panel2 p-0.5">
                      <button
                        type="button"
                        onClick={() => patch({ subscriptionProvider: "claude-sub" })}
                        className={`flex-1 px-2 py-1.5 text-sm transition-colors ${
                          draft.subscriptionProvider === "claude-sub"
                            ? "bg-panel3 text-fg"
                            : "text-mut hover:text-fg"
                        }`}
                      >
                        Claude 订阅
                      </button>
                      <button
                        type="button"
                        onClick={() => patch({ subscriptionProvider: "chatgpt-sub" })}
                        className={`flex-1 px-2 py-1.5 text-sm transition-colors ${
                          draft.subscriptionProvider === "chatgpt-sub"
                            ? "bg-panel3 text-fg"
                            : "text-mut hover:text-fg"
                        }`}
                      >
                        ChatGPT 订阅
                      </button>
                    </div>
                    {agentHealthState && (
                      <div className="mt-1.5 space-y-1 text-xs leading-[1.7] text-mut2">
                        <div>
                          Claude：
                          {agentHealthState.claude_logged_in ? (
                            <span className="text-lab-green">● 已登录</span>
                          ) : (
                            <span className="text-warn-soft">
                              ⚠ 未登录 → 请在终端运行 <code className="font-mono">claude</code>
                            </span>
                          )}
                        </div>
                        <div>
                          ChatGPT：
                          {agentHealthState.codex_logged_in ? (
                            <span className="text-lab-green">● 已登录</span>
                          ) : (
                            <span className="text-warn-soft">
                              ⚠ 未登录 → 请在终端运行{" "}
                              <code className="font-mono">codex login</code>
                            </span>
                          )}
                        </div>
                        {agentHealthState.warns.length > 0 &&
                          agentHealthState.warns.map((w) => (
                            <div key={w} className="text-warn-soft">
                              ⚠ {w}
                            </div>
                          ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-xs text-mut">连接码</label>
                    <input
                      type="text"
                      value={draft.agentToken}
                      onChange={(e) => patch({ agentToken: e.target.value })}
                      placeholder="从 sidecar 启动日志复制粘贴"
                      className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                    />
                    <div className="mt-1 text-xs leading-[1.7] text-mut2">
                      仅存本机浏览器；sidecar 每次启动会打印一个新连接码，粘贴到这里才能调用
                    </div>
                  </div>
                </>
              )}
            </section>
          )}

          {/* 显示 (v0.2.1: 主题 + 字号/行距，独立于其他设置，切主题不丢;
             v0.5.1: 自定义主题编辑器 + 字体 + 毛玻璃 — 主题的新建/编辑/删除/
             导入全部走 updateSettings 直接写入，不经过 draft/保存，见
             handleSaveCustomTheme 等的注释) — simple */}
          {activeCategory === "display" && (
          <section
            className="space-y-3 border-t border-edge pt-5"
            data-ui-level="display"
          >
            <SectionHeading>显示</SectionHeading>

            {themeEditor ? (
              <ThemeEditor
                customThemes={settings.customThemes}
                sourceThemeId={themeEditor.sourceThemeId}
                editingThemeId={themeEditor.editingThemeId}
                activeThemeId={settings.themeId}
                onSave={handleSaveCustomTheme}
                onDelete={handleDeleteCustomTheme}
                onBack={() => setThemeEditor(null)}
                showToast={showToast}
              />
            ) : (
              <>
                <div>
                  <label className="text-xs text-mut">主题</label>
                  <div className="mt-1 grid grid-cols-2 gap-2">
                    {BUILTIN_THEMES.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => patch({ themeId: t.id })}
                        className={`border p-3 text-left text-sm transition-colors ${
                          draft.themeId === t.id
                            ? "border-act bg-panel3 text-fg"
                            : "border-edge text-fg hover:bg-panel3"
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                    {settings.customThemes.map((t) => (
                      <div key={t.id} className="relative">
                        <button
                          type="button"
                          onClick={() => patch({ themeId: t.id })}
                          className={`w-full border p-3 pr-14 text-left text-sm transition-colors ${
                            draft.themeId === t.id
                              ? "border-act bg-panel3 text-fg"
                              : "border-edge text-fg hover:bg-panel3"
                          }`}
                        >
                          {t.label}
                        </button>
                        <button
                          type="button"
                          onClick={() => setThemeEditor({ sourceThemeId: t.id, editingThemeId: t.id })}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-mut hover:text-fg"
                        >
                          编辑
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setThemeEditor({ sourceThemeId: draft.themeId })}
                      className="border border-dashed border-edge2 p-3 text-left text-sm text-mut hover:bg-panel3 hover:text-fg"
                    >
                      ＋ 新建主题
                    </button>
                  </div>
                  <div className="mt-1 text-xs leading-[1.7] text-mut2">
                    自定义主题可复制任意已有主题的取值后调整颜色，也可导出分享或导入他人的主题文件
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-mut">导入主题文件</label>
                    <button
                      type="button"
                      onClick={() => setThemeImportOpen((v) => !v)}
                      className="text-xs text-act hover:underline"
                    >
                      {themeImportOpen ? "收起" : "展开"}
                    </button>
                  </div>
                  {themeImportOpen && (
                    <div className="mt-1 space-y-2 border border-edge bg-panel2 p-3">
                      <label className="btn-tactile inline-block cursor-pointer border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3">
                        选择文件
                        <input
                          type="file"
                          accept="application/json,.json"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = ""; // allow re-picking the same file
                            if (file) void handleImportThemeFile(file);
                          }}
                        />
                      </label>
                      <textarea
                        value={themeImportText}
                        onChange={(e) => setThemeImportText(e.target.value)}
                        placeholder="或粘贴主题 JSON…"
                        rows={3}
                        className="w-full resize-none border border-edge bg-panel px-2.5 py-1.5 font-mono text-xs leading-[1.7] text-fg placeholder:text-mut2 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleImportThemeJson(themeImportText)}
                        disabled={!themeImportText.trim()}
                        className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        解析并导入
                      </button>
                    </div>
                  )}
                </div>

                <div>
                  <label className="text-xs text-mut">全局字号</label>
                  <div className="mt-1 flex items-center gap-0.5 border border-edge bg-panel2 p-0.5">
                    {FONT_SIZE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => patch({ fontSize: opt.value })}
                        className={`flex-1 px-2 py-1.5 text-sm transition-colors ${
                          draft.fontSize === opt.value
                            ? "bg-panel3 text-fg"
                            : "text-mut hover:text-fg"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1 text-xs leading-[1.7] text-mut2">
                    整体文字大小，类似浏览器缩放
                  </div>
                </div>

                <div>
                  <label className="text-xs text-mut">转录字号</label>
                  <div className="mt-1 flex items-center gap-0.5 border border-edge bg-panel2 p-0.5">
                    {TRANSCRIPT_SCALE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => patch({ transcriptScale: opt.value })}
                        className={`flex-1 px-2 py-1.5 text-sm transition-colors ${
                          draft.transcriptScale === opt.value
                            ? "bg-panel3 text-fg"
                            : "text-mut hover:text-fg"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1 text-xs leading-[1.7] text-mut2">
                    只放大转录区文字，独立于全局字号
                  </div>
                </div>

                <div>
                  <label className="text-xs text-mut">转录行距</label>
                  <div className="mt-1 flex items-center gap-0.5 border border-edge bg-panel2 p-0.5">
                    {TRANSCRIPT_LEADING_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => patch({ transcriptLeading: opt.value })}
                        className={`flex-1 px-2 py-1.5 text-sm transition-colors ${
                          draft.transcriptLeading === opt.value
                            ? "bg-panel3 text-fg"
                            : "text-mut hover:text-fg"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-xs text-mut">界面字体</label>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {UI_FONT_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => patch({ uiFont: p.id })}
                        className={`border px-3 py-1.5 text-sm transition-colors ${
                          draft.uiFont === p.id
                            ? "border-act bg-panel3 text-fg"
                            : "border-edge text-fg hover:bg-panel3"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        patch({
                          uiFont: draft.uiFont.startsWith(CUSTOM_FONT_PREFIX)
                            ? draft.uiFont
                            : CUSTOM_FONT_PREFIX,
                        })
                      }
                      className={`border px-3 py-1.5 text-sm transition-colors ${
                        draft.uiFont.startsWith(CUSTOM_FONT_PREFIX)
                          ? "border-act bg-panel3 text-fg"
                          : "border-edge text-fg hover:bg-panel3"
                      }`}
                    >
                      自定义
                    </button>
                  </div>
                  {draft.uiFont.startsWith(CUSTOM_FONT_PREFIX) && (
                    <input
                      type="text"
                      value={draft.uiFont.slice(CUSTOM_FONT_PREFIX.length)}
                      onChange={(e) => patch({ uiFont: `${CUSTOM_FONT_PREFIX}${e.target.value}` })}
                      placeholder="字体名称，如 Fira Code"
                      className="mt-2 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                    />
                  )}
                </div>

                <div>
                  <label className="text-xs text-mut">等宽字体</label>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {MONO_FONT_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => patch({ monoFont: p.id })}
                        className={`border px-3 py-1.5 text-sm transition-colors ${
                          draft.monoFont === p.id
                            ? "border-act bg-panel3 text-fg"
                            : "border-edge text-fg hover:bg-panel3"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        patch({
                          monoFont: draft.monoFont.startsWith(CUSTOM_FONT_PREFIX)
                            ? draft.monoFont
                            : CUSTOM_FONT_PREFIX,
                        })
                      }
                      className={`border px-3 py-1.5 text-sm transition-colors ${
                        draft.monoFont.startsWith(CUSTOM_FONT_PREFIX)
                          ? "border-act bg-panel3 text-fg"
                          : "border-edge text-fg hover:bg-panel3"
                      }`}
                    >
                      自定义
                    </button>
                  </div>
                  {draft.monoFont.startsWith(CUSTOM_FONT_PREFIX) && (
                    <input
                      type="text"
                      value={draft.monoFont.slice(CUSTOM_FONT_PREFIX.length)}
                      onChange={(e) => patch({ monoFont: `${CUSTOM_FONT_PREFIX}${e.target.value}` })}
                      placeholder="字体名称，如 Fira Code"
                      className="mt-2 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                    />
                  )}
                </div>

                <div>
                  <label className="flex items-center justify-between gap-3 py-1">
                    <span className="text-sm text-fg">毛玻璃效果</span>
                    <ToggleSwitch
                      checked={draft.overlayGlass}
                      onChange={(checked) => patch({ overlayGlass: checked })}
                    />
                  </label>
                  <div className="text-xs leading-[1.7] text-mut2">覆盖层半透明模糊背景</div>
                </div>

                <div>
                  <label className="text-xs text-mut">Bit 装扮</label>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => patch({ bitCostume: "auto" })}
                      className={`border px-3 py-1.5 text-sm transition-colors ${
                        draft.bitCostume === "auto"
                          ? "border-act bg-panel3 text-fg"
                          : "border-edge text-fg hover:bg-panel3"
                      }`}
                    >
                      跟随主题
                    </button>
                    <button
                      type="button"
                      onClick={() => patch({ bitCostume: "none" })}
                      className={`border px-3 py-1.5 text-sm transition-colors ${
                        draft.bitCostume === "none"
                          ? "border-act bg-panel3 text-fg"
                          : "border-edge text-fg hover:bg-panel3"
                      }`}
                    >
                      原装
                    </button>
                    {Object.entries(BIT_COSTUME_LABELS).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => patch({ bitCostume: id })}
                        className={`border px-3 py-1.5 text-sm transition-colors ${
                          draft.bitCostume === id
                            ? "border-act bg-panel3 text-fg"
                            : "border-edge text-fg hover:bg-panel3"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1 text-xs leading-[1.7] text-mut2">
                    状态栏的像素龙 Bit 的穿搭；跟随主题时每套内置主题各有一件
                  </div>
                </div>
              </>
            )}
          </section>
          )}
        </div>
          </div>
        </div>
        )}

        {/* Sticky footer (owner ask 2026-07-11: "freeze 保存/取消 so the
           user can click anytime") — a normal flex-col sibling OUTSIDE
           the scrolling content pane above, so it's always visible
           regardless of scroll position or which category is active.
           Exact same handlers/semantics as before.
           S13 iOS mobile-UX round (Part B #4): on iOS this bar is
           conditional on draftDirty instead of always-rendered — shows
           on BOTH the root list and the detail view whenever there's an
           actual unsaved edit (root's own ✕ / detail's own ‹ 设置 back
           button above are the "nothing to save" affordances the rest
           of the time) — desktop/web keep the unconditional bar. Same
           handleDialogClose/handleSave handlers either way (semantics
           unchanged); only the wrapper/button classNames differ
           (full-width flex-1 buttons + safe-area-inset-bottom padding
           on iOS vs the existing right-aligned/auto-width pair). */}
        {(!IS_IOS || draftDirty) && (
        <div
          className={
            IS_IOS
              ? "flex shrink-0 gap-2 border-t border-edge p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
              : "flex shrink-0 justify-end gap-2 border-t border-edge p-4"
          }
        >
          <button
            type="button"
            onClick={handleDialogClose}
            className={
              IS_IOS
                ? "btn-tactile flex-1 border border-edge px-4 py-2.5 text-sm text-mut hover:bg-panel3 hover:text-fg"
                : "btn-tactile px-4 py-2 text-sm text-mut hover:bg-panel3 hover:text-fg"
            }
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            className={
              IS_IOS
                ? "btn-terminal flex-1 rounded-none bg-act px-4 py-2.5 font-mono text-sm font-semibold text-ink hover:bg-act/85"
                : "btn-terminal rounded-none bg-act px-4 py-2 font-mono text-sm font-semibold text-ink hover:bg-act/85"
            }
          >
            保存
          </button>
        </div>
        )}
      </div>
    </div>
  );
}
