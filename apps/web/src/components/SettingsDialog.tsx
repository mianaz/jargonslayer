"use client";

// Settings modal: transcription engine + AI detection configuration.
// Edits a local draft; only committed to the store on 保存.

import { useEffect, useState } from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { listAudioInputs } from "@/lib/audio/devices";
import { testConnection } from "@/lib/llm/client";
import { resolveTaskCreds, type ResolvedTaskCreds } from "@/lib/llm/taskConfig";
import { packCounts, setEnabledPacks } from "@jargonslayer/core/detect/dictionary";
import { getAllPacks } from "@jargonslayer/core/detect/packs";
import {
  addPackSource,
  checkUpdates,
  listPackSources,
  loadRemotePacksIntoRegistry,
  removePackSource,
  type RemotePackSource,
} from "@/lib/detect/remotePacks";
import {
  buildFullBackup,
  chooseExportFolder,
  clearExportFolder,
  getExportFolderName,
  previewBackup,
  restoreFullBackup,
} from "@/lib/history/autoExport";
import { fetchSidecarHealth } from "@/lib/stt/upload";
import { probeSidecar, type SidecarProbeResult } from "@/lib/stt/sidecarHealth";
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
  LlmTaskDomain,
  STTEngineKind,
  Settings,
  TaskLlmConfig,
} from "@jargonslayer/core/types";
import { withBase } from "@/lib/basePath";
import { IS_DESKTOP } from "@/lib/platform/desktop";
import { openExternal } from "@/lib/platform/openExternal";
import { getInvoke } from "@/lib/desktop/tauriApi";
import { initDesktop } from "@/lib/desktop/bootstrap";
import { trackInstallDiar, trackSwitchModel } from "@/lib/desktop/jobsBridge";
import { useTasks } from "@/lib/tasks/registry";
import { connectOpenRouterDesktop } from "@/lib/oauth/openrouterDesktop";
import { describeOAuthFailure } from "@/components/desktop/onboardingSettings";
import { agentHealth, type AgentHealth } from "@/lib/agent/localHost";
import {
  isSectionVisible,
  SETTINGS_UI_LEVELS,
  shouldAutoPromoteToAdvanced,
} from "@/lib/settingsSections";
import { BUILTIN_THEMES } from "@/lib/theme/themes";
import { PREVIEW_LIVE_MODELS, PREVIEW_SUMMARY_MODELS, PREVIEW_TIER } from "@/lib/deployTier";
import { clearDiag, getDiagEntries, type DiagEntry } from "@/lib/diag/log";
import { copyDiagnosticReport } from "@/lib/diag/report";
import PreviewLockedBadge from "@/components/PreviewLockedBadge";
import ToggleSwitch from "@/components/ToggleSwitch";
import ModelPicker from "@/components/desktop/ModelPicker";
import CredentialFields, {
  presetIdFor,
  type ProviderPreset,
  type ProviderPresetId,
} from "@/components/CredentialFields";
import {
  buildAuthUrl,
  codeChallengeS256,
  generateCodeVerifier,
  OAUTH_STATE_STORAGE_KEY,
  OAUTH_VERIFIER_STORAGE_KEY,
} from "@/lib/oauth/openrouterPkce";

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

// Real capture engines only — demo is a scripted preview, not a peer
// engine (see Header.tsx's 演示 button, the app's single demo entry
// point). posture drives the 本地/云端 chip: local engines never send
// audio off this machine; cloud engines do.
const ALL_ENGINE_CARDS: {
  value: Exclude<STTEngineKind, "demo">;
  label: string;
  hint: string;
  posture: "local" | "cloud";
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
    posture: "cloud",
  },
  {
    value: "whisper",
    label: "本地 Whisper",
    hint: "音频只在本机处理，不出设备",
    posture: "local",
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
        hint: "会议中对方的声音，也含 Mac 播放的其他声音，不含你的麦克风",
        posture: "local",
        sidecarOnly: true,
      }
    : {
        value: "tabaudio",
        label: "标签页音频",
        hint: "在本机转录标签页音频",
        posture: "local",
        disabled: true,
        sidecarOnly: true,
      },
  // S11 (v0.4.3, docs/design-explorations/s11-osspeech-blueprint.md) —
  // Zero-Install 系统识别 (SpeechAnalyzer): desktop-only, NOT sidecarOnly
  // (needs no local Whisper sidecar at all — that's the whole point),
  // so it's structurally unaffected by the #61 preview-tier lock. Label
  // matches lib/stt/engineOptions.ts's own ENGINE_OPTIONS entry verbatim
  // (Miana-veto #2) — the two surfaces must never say this engine's name
  // differently. Floor-gated below like appaudio's own macOS-14.4 floor
  // (isOsSpeechFloorLocked/osSpeechLockReason, macOS 26 via
  // os_speech_capabilities) — shown-but-disabled below the floor, never
  // hidden.
  ...(IS_DESKTOP
    ? [
        {
          value: "osspeech" as const,
          label: "系统识别 · 开箱即用",
          hint: "无需下载模型、无需 Python，音频不离开本机；不支持说话人分离，需要 macOS 26 或更高版本",
          posture: "local" as const,
        },
      ]
    : []),
  {
    value: "soniox",
    label: "Soniox 云端识别",
    // Honest per the blueprint's benchmark gate (decision E) — BYOK,
    // opt-in, NOT claimed to beat local Whisper until Miana's zh-en
    // clip benchmark clears it.
    hint: "BYOK 按量计费、音频经 Soniox 云端、中英混说场景的候选引擎（尚未通过本地对照测试）",
    posture: "cloud",
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
const ENGINE_CARDS = IS_DESKTOP
  ? ALL_ENGINE_CARDS.filter((c) => c.value !== "webspeech")
  : ALL_ENGINE_CARDS;

const POSTURE_LABEL: Record<"local" | "cloud", string> = {
  local: "本地",
  cloud: "云端",
};

const LANGUAGE_OPTIONS = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "en-AU", label: "English (Australia)" },
  { value: "en-IN", label: "English (India)" },
];

const DETECT_MODEL_OPTIONS = [
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "deepseek-chat",
  "qwen-plus",
];

const SUMMARY_MODEL_OPTIONS = [
  "claude-sonnet-5",
  "claude-opus-4-8",
  "deepseek-chat",
];

// #56: translate has no PRIMARY top-level model field (see
// resolveTaskCreds — inherited default is the server's own
// pickModel fallback, "claude-haiku-4-5"), so this list — unlike
// DETECT_MODEL_OPTIONS/SUMMARY_MODEL_OPTIONS above — only exists for
// the 分任务模型（高级） translate block's datalist seed.
const TRANSLATE_MODEL_OPTIONS = [
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

// Settings redesign (owner ask 2026-07-11: "side navbar for each
// category"): one nav entry per existing <section> — id per category,
// label copied verbatim from that section's own <SectionHeading>. Order
// matches the dialog's previous top-to-bottom section order exactly.
type SettingsCategoryId =
  | "engine"
  | "diarization"
  | "aiDetect"
  | "taskLlm"
  | "dataIntegration"
  | "subscriptionDirect"
  | "display";

const SETTINGS_CATEGORIES: { id: SettingsCategoryId; label: string }[] = [
  { id: "engine", label: "转录引擎" },
  { id: "diarization", label: "说话人分离" },
  { id: "aiDetect", label: "AI 检测" },
  { id: "taskLlm", label: "分任务模型（高级）" },
  { id: "dataIntegration", label: "数据与联动" },
  { id: "subscriptionDirect", label: "订阅直连（实验性）" },
  { id: "display", label: "显示" },
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
  SETTINGS_UI_LEVELS.aiDetectAutoDetect,
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
// Coerced to the list's first entry once, when the draft is seeded
// (dialog open) — never overwrites a value the user picks from the
// select afterward.
function coercePreviewModels(draft: Settings): Settings {
  if (!PREVIEW_TIER) return draft;
  const patch: Partial<Settings> = {};
  if (!(PREVIEW_LIVE_MODELS as readonly string[]).includes(draft.detectModel)) {
    patch.detectModel = PREVIEW_LIVE_MODELS[0];
  }
  if (!(PREVIEW_SUMMARY_MODELS as readonly string[]).includes(draft.summaryModel)) {
    patch.summaryModel = PREVIEW_SUMMARY_MODELS[0];
  }
  return Object.keys(patch).length > 0 ? { ...draft, ...patch } : draft;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs uppercase tracking-wide text-mut">{children}</div>
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
}: {
  domain: LlmTaskDomain;
  label: string;
  hint?: string;
  staticModelOptions: string[];
  config: TaskLlmConfig | undefined;
  primary: Settings;
  onChange: (next: TaskLlmConfig | undefined) => void;
  disabled: boolean;
}) {
  const enabled = !!config?.enabled;
  const resolved = resolveTaskCreds(primary, domain);

  const patchConfig = (p: Partial<TaskLlmConfig>) => {
    onChange({ enabled, provider: config?.provider, baseUrl: config?.baseUrl, apiKey: config?.apiKey, model: config?.model, ...p });
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
              patchConfig({ provider: preset.provider, baseUrl: preset.baseUrl });
            }}
            onBaseUrlChange={(baseUrl) => patchConfig({ baseUrl })}
            onApiKeyChange={(apiKey) => patchConfig({ apiKey })}
            apiKeyPlaceholder="留空则用主配置的 Key"
            presets={PROVIDER_PRESETS}
            disabled={disabled}
            models={[
              {
                key: domain,
                label: "模型",
                value: config?.model ?? "",
                onChange: (v) => patchConfig({ model: v }),
                staticOptions: staticModelOptions,
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

  const [draft, setDraft] = useState<Settings>(() => coercePreviewModels(settings));
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([]);
  const [testingConnection, setTestingConnection] = useState(false);
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
  // Draft checked-set for non-core theme packs; reconciled back into
  // draft.enabledPacks (string[] | null) on save. "core" is always on
  // and isn't part of this set — it renders as a disabled row instead.
  const [checkedPacks, setCheckedPacks] = useState<Set<string>>(
    new Set(settings.enabledPacks ?? getAllPacks().filter((p) => p.id !== "core").map((p) => p.id)),
  );
  // 词典源 (remote dictionary packs, #20).
  const [packSources, setPackSources] = useState<RemotePackSource[]>([]);
  const [packSourceUrl, setPackSourceUrl] = useState("");
  const [addingPackSource, setAddingPackSource] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [confirmRemoveUrl, setConfirmRemoveUrl] = useState<string | null>(null);
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
  // v0.4 S3 chunk 7: desktop-only 「查看本地服务日志」 (read_sidecar_log)
  // — null = not fetched yet this dialog-open, "" = fetched but empty
  // (whisper_server.log doesn't exist yet, e.g. never provisioned).
  const [sidecarLog, setSidecarLog] = useState<string | null>(null);
  const [loadingSidecarLog, setLoadingSidecarLog] = useState(false);
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
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>("engine");

  // Nav-rail visibility per category — reuses isSectionVisible/
  // SETTINGS_UI_LEVELS exactly as every row below already does (never
  // forked). engine/display's own section level is "simple" (so these
  // evaluate true regardless of uiMode); aiDetect has no single
  // matching key (the one mixed section) so it's visible whenever ANY
  // of its own rows would be, mirroring the general "a category whose
  // every row is advanced-only disappears from the nav" rule.
  const categoryVisible: Record<SettingsCategoryId, boolean> = {
    engine: isSectionVisible(settings.uiMode, SETTINGS_UI_LEVELS.engine),
    diarization: isSectionVisible(settings.uiMode, SETTINGS_UI_LEVELS.diarization),
    aiDetect: AI_DETECT_ROW_LEVELS.some((l) => isSectionVisible(settings.uiMode, l)),
    taskLlm: isSectionVisible(settings.uiMode, SETTINGS_UI_LEVELS.taskLlm),
    dataIntegration: isSectionVisible(settings.uiMode, SETTINGS_UI_LEVELS.dataIntegration),
    subscriptionDirect:
      process.env.NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT === "1" &&
      isSectionVisible(settings.uiMode, SETTINGS_UI_LEVELS.subscriptionDirect),
    display: isSectionVisible(settings.uiMode, SETTINGS_UI_LEVELS.display),
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
  useEffect(() => {
    if (!categoryVisible[activeCategory]) {
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
  }, []);

  useEffect(() => {
    if (open) {
      // Preview tier (#61): coerce an off-list persisted detectModel/
      // summaryModel to the first allowed option as soon as the dialog
      // (re)opens — see coercePreviewModels' own doc comment.
      setDraft(coercePreviewModels(settings));
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
    // Only reset the draft when the dialog is (re)opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
  // handleViewSidecarLog's own identical rationale for reusing it
  // rather than calling getInvoke() a second, independent time).
  // Re-runs whenever the section becomes relevant (dialog opens with
  // 由应用管理 already selected, or the user flips 托管模式 into it while
  // the dialog stays open) — mirrors the 本地服务 status effect just
  // above. IS_DESKTOP is a build-time const (see platform/desktop.ts),
  // so this is inert on a web build.
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
  }, [open, draft.sidecarMode]);

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

  const handleAddPackSource = async () => {
    const url = packSourceUrl.trim();
    if (!url) return;
    setAddingPackSource(true);
    try {
      const { pack } = await addPackSource(url);
      setPackSources(await listPackSources());
      setPackSourceUrl("");
      showToast(`已添加词典包「${pack.name}」`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "添加词典包失败");
    } finally {
      setAddingPackSource(false);
    }
  };

  const handleRemovePackSource = async (url: string) => {
    if (confirmRemoveUrl !== url) {
      setConfirmRemoveUrl(url);
      setTimeout(() => {
        setConfirmRemoveUrl((cur) => (cur === url ? null : cur));
      }, 3000);
      return;
    }
    await removePackSource(url);
    setPackSources(await listPackSources());
    setConfirmRemoveUrl(null);
    showToast("已移除词典包");
  };

  const handleCheckUpdates = async (url?: string) => {
    setCheckingUpdates(true);
    try {
      const updatedIds = await checkUpdates();
      setPackSources(await listPackSources());
      if (url) {
        // Per-source button: only report on whether this one source
        // changed, even though checkUpdates() refreshes every source.
        const source = packSources.find((s) => s.url === url);
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

  const handleSave = () => {
    const enabledPacks = allPacksChecked ? null : nonCorePackIds.filter((id) => checkedPacks.has(id));
    // uiMode is deliberately excluded from `draft` — the header toggle
    // above writes it straight through updateSettings the moment it's
    // clicked (a view preference, not part of 保存's flow). `draft`
    // still carries whatever uiMode was LIVE when the dialog opened, so
    // spreading it wholesale here would revert a toggle click made
    // while the dialog was open (tag-blocker HIGH 3) — always take the
    // live value instead.
    const toSave: Settings = { ...draft, enabledPacks, uiMode: useApp.getState().settings.uiMode };
    // Finding 2d: sidecarMode is a LAUNCH-TIME decision — bootstrap.ts's
    // getSidecarMode is only ever read once, at app start (Finding 2c)
    // — so switching it here can't take effect live; tell the user a
    // restart is needed instead of silently saving a toggle that won't
    // do anything until then. No live engine switching.
    const sidecarModeChanged = IS_DESKTOP && draft.sidecarMode !== settings.sidecarMode;
    updateSettings(toSave);
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
          {
            const live = useApp.getState().settings;
            setDraft((d) => ({ ...d, provider: live.provider, baseUrl: live.baseUrl, apiKey: live.apiKey }));
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

  // v0.4 S3 chunk 7: 诊断信息 面板的 「查看本地服务日志」 — desktop-only,
  // reads whisper_server.log's tail via Rust's read_sidecar_log
  // (provision.rs). Routed through the SAME module-level bootstrap
  // handle DesktopBootstrap.tsx already drives (initDesktop() is
  // idempotent) rather than calling tauriApi.ts's getInvoke() directly
  // a second time — see bootstrap.ts's readSidecarLog doc comment for
  // why a second independent caller of that exported function would
  // reopen the exact web-bundle tree-shake leak this task's own gate
  // caught and fixed.
  const handleViewSidecarLog = async () => {
    setLoadingSidecarLog(true);
    try {
      const handle = await initDesktop();
      const text = await handle.readSidecarLog(200);
      setSidecarLog(text);
    } catch (err) {
      showToast(err instanceof Error ? `读取本地服务日志失败：${err.message}` : "读取本地服务日志失败");
    } finally {
      setLoadingSidecarLog(false);
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
        showToast("无法连接 sidecar，请先启动（README）");
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
  // a throwaway <a download> blob link — no server round-trip, matches
  // this app's local-first storage model. exportStripKeys (default
  // checked) strips key material before it ever leaves buildFullBackup.
  const handleExportBackup = async () => {
    const json = await buildFullBackup({ includeKeys: !exportStripKeys });
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jargonslayer-backup-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
      const { sessions, entries, learnset, hasSettings, hasApiKey } = previewBackup(text);
      setRestorePreview({ text, sessions, entries, learnset, hasSettings, hasApiKey });
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
      setDraft(coercePreviewModels(useApp.getState().settings));
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

  const handleClearDiagnostics = () => {
    clearDiag();
    setDiagEntries([]);
    showToast("诊断记录已清空");
  };

  const activePreset = presetIdFor(PROVIDER_PRESETS, draft);
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
  const realtimeDiarizeAvailable =
    !PREVIEW_TIER &&
    (draft.engine === "whisper" || draft.engine === "tabaudio" || draft.engine === "appaudio") &&
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
  // write, see updateSettings' own side effects).
  const level = settings.uiMode;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      // Click-outside-to-close (E2E feedback 2026-07-11): mousedown
      // (not click) + target===currentTarget, so a drag that starts
      // inside the panel and ends on the backdrop (text selection,
      // slider drag) doesn't close it, and a click on an inner popover
      // (which portals onto this same backdrop) doesn't bubble up as
      // "the backdrop itself was clicked". onClose is the existing
      // discard-draft cancel path (same handler the footer's 取消 uses)
      // — no confirmation, matches that button's behavior exactly.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-[700px] max-w-[92vw] flex-col rounded-none border border-edge2 bg-panel">
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
             取消 in the footer stay pinned outside of it. */}
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

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5">
        <div className="space-y-6">
          {activeCategory === "engine" && (
          <>
          {/* 转录引擎 — simple */}
          <section className="space-y-3" data-ui-level="engine">
            <SectionHeading>转录引擎</SectionHeading>
            <div className="grid grid-cols-2 gap-2">
              {ENGINE_CARDS.map((opt) => {
                // v0.4 S4 (blueprint decision E, risk 4): byokOnly
                // joins sidecarOnly in the preview lock — see
                // ENGINE_CARDS' own byokOnly doc comment above.
                const previewLocked = PREVIEW_TIER && (opt.sidecarOnly || opt.byokOnly);
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
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={opt.disabled || previewLocked || floorLocked}
                    onClick={() => patch({ engine: opt.value })}
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
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{opt.label}</span>
                      <span className="flex shrink-0 items-center gap-1.5">
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
                          className={`shrink-0 border px-1.5 py-0 text-[10px] ${
                            opt.posture === "local"
                              ? "border-lab-green/30 text-lab-green"
                              : "border-warn-soft/30 text-warn-soft"
                          }`}
                        >
                          {POSTURE_LABEL[opt.posture]}
                        </span>
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs leading-[1.7] text-mut">
                      {opt.hint}
                    </div>
                  </button>
                );
              })}
            </div>

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
                <div className="text-sm text-fg">系统识别模型</div>
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
                  {preinstallingOsSpeech ? "下载中…" : osSpeechPreinstallDone ? "已下载" : "预下载模型"}
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
                    需要本地 Whisper sidecar——见{" "}
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
               section below): showSonioxKey toggle, disabled={PREVIEW_
               TIER} — preview-tier gate 3 of 3, alongside ENGINE_CARDS'
               byokOnly lock above and store.ts applyTierDefaults'
               coercion. */}
            {draft.engine === "soniox" && (
              <div>
                <label className="text-xs text-mut">Soniox API Key</label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type={showSonioxKey ? "text" : "password"}
                    value={draft.sonioxKey}
                    disabled={PREVIEW_TIER}
                    onChange={(e) => patch({ sonioxKey: e.target.value })}
                    placeholder="粘贴你的 Soniox API Key"
                    className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <button
                    type="button"
                    disabled={PREVIEW_TIER}
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
              </div>
            )}

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

            <div>
              <label className="text-xs text-mut">识别语言</label>
              <select
                value={draft.language}
                onChange={(e) => patch({ language: e.target.value })}
                className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
              >
                {LANGUAGE_OPTIONS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
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

            {/* 实时转录预览 (STT protocol v2): app-controlled per-session
               override of the sidecar's --partials CLI default — see
               wsTransport.ts's config.partials + whisper_server.py's
               _partials_enabled. Same row pattern as 实时说话人分离
               below, but unconditionally enabled (no engine/token gate)
               — mirrors 麦克风/识别语言's own "always shown, hint
               explains scope" posture in this same section. */}
            <label className="flex items-center justify-between gap-3 border-t border-edge pt-3 py-1">
              <div>
                <div className="text-sm text-fg">实时转录预览</div>
                <div className="mt-0.5 text-xs leading-[26px] text-mut2">
                  转录过程中先显示灰色临时文字（打字机效果），句子完成后落定。仅本地 Whisper 引擎生效。
                </div>
              </div>
              <ToggleSwitch checked={draft.partials} onChange={(checked) => patch({ partials: checked })} />
            </label>

            {/* 设备端识别 (docs/research/stt-live-engines-2026-07.md
               item #1): Chrome 139+ processLocally — recognition runs
               on this machine instead of the browser vendor's cloud
               STT whenever the browser reports a local model available
               for 识别语言; automatic cloud fallback otherwise. Same row
               pattern as 实时转录预览 above, webspeech's own engine-scope
               toggle. */}
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
              <label className="text-xs text-mut">HF Token</label>
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
                仅存本机，随任务经 localhost 传给 sidecar，不经任何云端
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
                    ? "需要本地版 + 本地 sidecar"
                    : realtimeDiarizeAvailable
                      ? "为本地实时转录标注说话人（SPEAKER_1/2…），可随时在转录里重命名。分离过程在本机完成，音频不离开设备。beta：标签会延迟几秒出现，随会议推进逐步修正，可能增加 CPU 占用；转录本身不受影响。"
                      : draft.engine === "osspeech"
                        ? "该引擎不支持说话人分离"
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

            {/* Preview tier (#61): every credential-related field below
               (provider/Poe preset, Base URL, OpenRouter OAuth connect,
               API Key) renders disabled — greyed showroom, never
               unmounted — because the hosted build's detect/summarize
               calls run on OUR server key, not the visitor's own. */}
            {PREVIEW_TIER && (
              <div className="space-y-1" data-ui-level="aiDetectPreviewBanner">
                <div className="flex items-center gap-2">
                  <PreviewLockedBadge />
                  <span className="text-xs leading-[1.7] text-mut2">
                    体验版由内置演示 Key 提供 AI，本地版可接入自己的 Key
                  </span>
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
                  apiKey={draft.apiKey}
                  onSelectPreset={handleSelectPreset}
                  onBaseUrlChange={(baseUrl) => patch({ baseUrl })}
                  onApiKeyChange={(apiKey) => patch({ apiKey })}
                  apiKeyPlaceholder="sk-…"
                  apiKeyHint="仅存于本机浏览器；调用时经应用接口内存转发，不落盘（env-first 见 README）"
                  presets={PROVIDER_PRESETS}
                  disabled={PREVIEW_TIER}
                  onConnectOpenRouter={() => void handleConnectOpenRouter()}
                  connectingOpenRouter={connectingOpenRouter}
                  models={[
                    {
                      key: "detect",
                      label: "检测模型",
                      value: draft.detectModel,
                      onChange: (v) => patch({ detectModel: v }),
                      staticOptions: DETECT_MODEL_OPTIONS,
                      previewOptions: PREVIEW_TIER ? PREVIEW_LIVE_MODELS : undefined,
                      hint: PREVIEW_TIER ? (
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
                      previewOptions: PREVIEW_TIER ? PREVIEW_SUMMARY_MODELS : undefined,
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

                <button
                  type="button"
                  onClick={() => void handleTestConnection()}
                  disabled={testingConnection}
                  className="btn-tactile w-full border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {testingConnection ? "测试中…" : "测试连接"}
                </button>
              </div>
            )}

            <label
              className="flex items-center justify-between gap-3 py-1"
              data-ui-level="aiDetectAutoDetect"
            >
              <span className="text-sm text-fg">实时检测</span>
              <ToggleSwitch checked={draft.autoDetect} onChange={(checked) => patch({ autoDetect: checked })} />
            </label>

            <label
              className="flex items-center justify-between gap-3 py-1"
              data-ui-level="aiDetectCore"
            >
              <div>
                <div className="text-sm text-fg">AI 检测</div>
                <div className="text-xs text-mut2">
                  内置词典始终即时检测；开启后 AI 并行分析并就地升级词典结果。关闭则完全离线，不调用任何 API
                </div>
              </div>
              <ToggleSwitch checked={draft.aiDetect} onChange={(checked) => patch({ aiDetect: checked })} />
            </label>

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
              </div>
            )}

            <div data-ui-level="aiDetectExplainLanguage">
              <label className="text-xs text-mut">解释语言</label>
              <select
                value={draft.explainLanguage}
                onChange={(e) =>
                  patch({ explainLanguage: e.target.value as ExplainLanguage })
                }
                className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
              >
                {EXPLAIN_LANGUAGE_OPTIONS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
              <div className="mt-1 text-xs leading-[1.7] text-mut2">
                卡片解释的语言；English 模式给不需要中文的用户，界面文字仍为中文
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
              {allPacks.filter((p) => p.id !== "core").map((p) => (
                <label
                  key={p.id}
                  className="flex items-center justify-between gap-3 py-1"
                >
                  <div>
                    <div className="text-sm text-fg">
                      {p.name}
                      {p.remote && (
                        <span className="ml-1.5 border border-edge2 px-1.5 py-0 text-[10px] font-normal text-mut">
                          社区
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-mut2">
                      {p.description}（{packEntryCounts[p.id] ?? 0} 条）
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={checkedPacks.has(p.id)}
                    onChange={(checked) => togglePack(p.id, checked)}
                  />
                </label>
              ))}
            </div>
            )}

            {/* 词典源 (#20): install community dictionary packs from a
               URL. getAllPacks() above already folds loaded remote
               packs into the checkbox list; this subsection manages
               the underlying sources (add/remove/update-check). */}
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

              {packSources.length > 0 && (
                <div className="space-y-1.5">
                  {packSources.map((s) => (
                    <div
                      key={s.url}
                      className="flex items-center justify-between gap-2 border border-edge bg-panel2 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-fg">{s.pack.name}</div>
                        <div className="font-mono text-xs tabular-nums text-mut2">
                          v{s.pack.version} ·{" "}
                          {s.pack.expressions.length + s.pack.terms.length} 条
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void handleCheckUpdates(s.url)}
                          disabled={checkingUpdates}
                          className="btn-tactile px-2 py-1 text-xs text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          检查更新
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemovePackSource(s.url)}
                          className={`btn-tactile px-2 py-1 text-xs hover:bg-panel3 ${
                            confirmRemoveUrl === s.url ? "text-warn-soft" : "text-mut hover:text-warn-soft"
                          }`}
                        >
                          {confirmRemoveUrl === s.url ? "确认移除?" : "移除"}
                        </button>
                      </div>
                    </div>
                  ))}
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

              <div className="text-xs leading-[1.7] text-mut2">
                从 GitHub raw / jsDelivr 链接安装社区词典包，JSON 格式见文档
              </div>
            </div>
            )}
          </section>
          )}

          {/* 分任务模型（高级）(#56, BYOK-only): a self-contained section
             (design Q5's #62 fit note — advanced-mode visibility gating
             later is a one-line change here) so translate/detect/
             summary can each optionally point at a different provider/
             model, inheriting the primary "AI 检测" credential above by
             default. Preview tier: disabled as ONE group + one
             PreviewLockedBadge, same grouping pattern as 说话人分离
             above — BYOK has no meaning when the hosted build's calls
             run on our own server key. #62: advanced-only, per the fit
             note above. */}
          {activeCategory === "taskLlm" && isSectionVisible(level, SETTINGS_UI_LEVELS.taskLlm) && (
          <section
            className="space-y-3 border-t border-edge pt-5"
            data-ui-level="taskLlm"
          >
            <button
              type="button"
              onClick={() => setTaskLlmExpanded((v) => !v)}
              disabled={PREVIEW_TIER}
              className="flex w-full items-center justify-between gap-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="flex items-center gap-2">
                <SectionHeading>分任务模型（高级）</SectionHeading>
                {PREVIEW_TIER && <PreviewLockedBadge />}
              </span>
              <span className="text-xs text-mut2">{taskLlmExpanded ? "收起" : "展开"}</span>
            </button>

            {!PREVIEW_TIER && (
              <div className="text-xs leading-[1.7] text-mut2">
                为翻译 / 检测与解释 / 会议报告分别指定不同的提供方或模型；未单独配置的场景使用上方主配置
              </div>
            )}

            {!PREVIEW_TIER && taskLlmExpanded && (
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
                    disabled={PREVIEW_TIER}
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

              <label className="flex items-center justify-between gap-3 py-1">
                <div>
                  <div className="text-sm text-fg">不包含 API Key</div>
                  <div className="text-xs text-mut2">
                    取消勾选后，备份将包含你的 API Key（AI 检测 / 分任务模型 / HF Token / Soniox Key /
                    Webhook / 连接码），请妥善保管
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
                  onClick={handleClearDiagnostics}
                  className="btn-tactile text-xs text-mut hover:text-warn-soft"
                >
                  清空
                </button>
                {/* v0.4 S3 chunk 7: desktop-only — tails whisper_server.log
                   via Rust's read_sidecar_log (provision.rs), shown
                   below in the same monospace box style as the diag
                   entries list above. */}
                {IS_DESKTOP && (
                  <button
                    type="button"
                    onClick={() => void handleViewSidecarLog()}
                    disabled={loadingSidecarLog}
                    className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loadingSidecarLog ? "读取中…" : "查看本地服务日志"}
                  </button>
                )}
              </div>

              {IS_DESKTOP && sidecarLog !== null && (
                <div className="max-h-40 overflow-y-auto border border-edge bg-panel2 p-2 font-mono text-xs text-mut2">
                  {sidecarLog === "" ? (
                    <div className="text-mut2">暂无日志（本地服务还没启动过）</div>
                  ) : (
                    <pre className="whitespace-pre-wrap break-all">{sidecarLog}</pre>
                  )}
                </div>
              )}
            </div>
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

          {/* 显示 (v0.2.1: 主题 + 字号/行距，独立于其他设置，切主题不丢) — simple */}
          {activeCategory === "display" && (
          <section
            className="space-y-3 border-t border-edge pt-5"
            data-ui-level="display"
          >
            <SectionHeading>显示</SectionHeading>

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
              </div>
              <div className="mt-1 text-xs text-mut2">
                更多主题（社区包）将在后续版本开放
              </div>
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
          </section>
          )}
        </div>
          </div>
        </div>

        {/* Sticky footer (owner ask 2026-07-11: "freeze 保存/取消 so the
           user can click anytime") — a normal flex-col sibling OUTSIDE
           the scrolling content pane above, so it's always visible
           regardless of scroll position or which category is active.
           Exact same handlers/semantics as before. */}
        <div className="flex shrink-0 justify-end gap-2 border-t border-edge p-4">
          <button
            type="button"
            onClick={onClose}
            className="btn-tactile px-4 py-2 text-sm text-mut hover:bg-panel3 hover:text-fg"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="btn-terminal rounded-none bg-act px-4 py-2 font-mono text-sm font-semibold text-ink hover:bg-act/85"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
