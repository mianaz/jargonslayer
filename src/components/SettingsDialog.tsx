"use client";

// Settings modal: transcription engine + AI detection configuration.
// Edits a local draft; only committed to the store on 保存.

import { useEffect, useState } from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { listAudioInputs } from "@/lib/audio/devices";
import { testConnection } from "@/lib/llm/client";
import { resolveTaskCreds, type ResolvedTaskCreds } from "@/lib/llm/taskConfig";
import { packCounts, setEnabledPacks } from "@/lib/detect/dictionary";
import { getAllPacks } from "@/lib/detect/packs";
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
import type {
  ExplainLanguage,
  LlmTaskDomain,
  STTEngineKind,
  Settings,
  TaskLlmConfig,
} from "@/lib/types";
import { withBase } from "@/lib/basePath";
import { agentHealth, type AgentHealth } from "@/lib/agent/localHost";
import { BUILTIN_THEMES } from "@/lib/theme/themes";
import { PREVIEW_LIVE_MODELS, PREVIEW_SUMMARY_MODELS, PREVIEW_TIER } from "@/lib/deployTier";
import PreviewLockedBadge from "@/components/PreviewLockedBadge";
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
const ENGINE_CARDS: {
  value: Exclude<STTEngineKind, "demo">;
  label: string;
  hint: string;
  posture: "local" | "cloud";
  disabled?: boolean;
  // #61 preview tier: needs the local sidecar — greyed there (same
  // lock as Header.tsx's ENGINE_OPTIONS.sidecarOnly; without it a
  // preview user could still save engine:"whisper" from THIS dialog
  // and dead-end on ws://localhost until the next reload's
  // applyTierDefaults coercion).
  sidecarOnly?: boolean;
}[] = [
  {
    value: "webspeech",
    label: "浏览器识别",
    // The Web Speech capture chain (echo cancellation etc.) is fixed
    // by the browser and tuned for near-field voice — speaker-played
    // meeting audio comes through weak, and that is not fixable from
    // our side (the local engines are: whisperSocket.ts acquires its
    // own stream with raw-capture constraints).
    hint: "由浏览器厂商云端识别（音频会离开设备）；拾取扬声器外放较弱，线上会议建议标签页音频或本地 Whisper",
    posture: "cloud",
  },
  {
    value: "whisper",
    label: "本地 Whisper",
    hint: "音频只在本机处理，不出设备",
    posture: "local",
    sidecarOnly: true,
  },
  {
    value: "tabaudio",
    label: "标签页音频",
    hint: "在本机转录标签页音频",
    posture: "local",
    disabled: true,
    sidecarOnly: true,
  },
];

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
    <div className="space-y-2 rounded-sm border border-edge bg-panel2 p-3">
      <label className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm text-fg">{label}</div>
          {hint && <div className="text-xs text-mut2">{hint}</div>}
        </div>
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => patchConfig({ enabled: e.target.checked })}
          className="h-4 w-4 shrink-0 accent-act disabled:opacity-50"
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

  const [draft, setDraft] = useState<Settings>(() => coercePreviewModels(settings));
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([]);
  const [testingConnection, setTestingConnection] = useState(false);
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
    hasSettings: boolean;
    hasApiKey: boolean;
  } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  // 说话人分离 (speaker diarization, HF token) section.
  const [showHfToken, setShowHfToken] = useState(false);
  const [checkingDiarization, setCheckingDiarization] = useState(false);
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

  // App-mount-once (not open-gated): SettingsDialog is always mounted
  // by page.tsx, so this applies the persisted pack selection to the
  // live scanDictionary() registry as soon as the app loads, even if
  // the user never opens this dialog. Mirrors the dictionary.ts
  // registry-pattern comment (see setEnabledPacks there).
  useEffect(() => {
    setEnabledPacks(settings.enabledPacks);
    // Remote packs (#20) have no store.hydrate() hook (this worker
    // doesn't own store.ts), so they're bootstrapped here — and again,
    // fire-and-forget, inside dictionary.ts's first scanDictionary()
    // call — whichever happens first wins; both are idempotent no-ops
    // once loaded (see loadRemotePacksIntoRegistry's early-return).
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
      void getExportFolderName().then(setExportFolderName);
      void listPackSources().then(setPackSources);
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
    const toSave: Settings = { ...draft, enabledPacks };
    updateSettings(toSave);
    setEnabledPacks(enabledPacks);
    showToast("设置已保存");
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
  // (https://openrouter.ai/docs/use-cases/oauth-pkce). Generates a
  // fresh code_verifier + a random state, stashes both in
  // sessionStorage (must survive the full-page redirect — see
  // openrouterPkce.ts's module comment), then navigates the whole tab
  // to OpenRouter's /auth. NOTE: the verified spec's /auth query params
  // are only callback_url/code_challenge/code_challenge_method — no
  // `state` param is documented, so it is NOT sent to OpenRouter (an
  // undocumented param could be silently dropped or rejected). The
  // stored state is still checked by the callback page IF OpenRouter
  // happens to echo one back; the real replay protection here is PKCE
  // itself — the code alone is useless without this verifier.
  const handleConnectOpenRouter = async () => {
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
      const { sessions, entries, hasSettings, hasApiKey } = previewBackup(text);
      setRestorePreview({ text, sessions, entries, hasSettings, hasApiKey });
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
      const { sessions, entries, settingsRestored } = await restoreFullBackup(restorePreview.text);
      await useApp.getState().hydrate();
      setRestorePreview(null);
      showToast(
        `已恢复 ${sessions} 场会议、${entries} 条词典` +
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

  const activePreset = presetIdFor(PROVIDER_PRESETS, draft);
  // 实时说话人分离（beta）: only meaningful for the two local-audio
  // engines that go through wsTransport.ts, and only runnable once a
  // token is configured (mirrors the sidecar's own arming gate: config.
  // diarize truthy AND a token available). Preview tier (#61): always
  // unavailable — the whole 说话人分离 section's inputs are disabled
  // there, but this also guards against a persisted hfToken +
  // whisper/tabaudio engine surviving into a preview build (e.g. an
  // imported full-tier settings export) from evaluating true and
  // enabling the checkbox despite the section's greyed-out fields.
  const realtimeDiarizeAvailable =
    !PREVIEW_TIER &&
    (draft.engine === "whisper" || draft.engine === "tabaudio") &&
    !!draft.hfToken;
  // 双语转录 (#42): the translation target IS explainLanguage — "en"
  // would mean translating English into English, so the toggle is
  // disabled (zh-only for now; more languages later, see Settings.
  // explainLanguage).
  const bilingualTranscriptAvailable = draft.explainLanguage !== "en";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="scroll-thin max-h-[85vh] w-[540px] max-w-[92vw] overflow-y-auto rounded-none border border-edge2 bg-panel p-5">
        <div className="mb-4 text-lg font-semibold text-fg">设置</div>

        <div className="space-y-6">
          {/* 转录引擎 */}
          <section className="space-y-3">
            <SectionHeading>转录引擎</SectionHeading>
            <div className="grid grid-cols-2 gap-2">
              {ENGINE_CARDS.map((opt) => {
                const previewLocked = PREVIEW_TIER && opt.sidecarOnly;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={opt.disabled || previewLocked}
                    onClick={() => patch({ engine: opt.value })}
                    title={previewLocked ? "本地版功能：需要本地 sidecar" : undefined}
                    className={`rounded-sm border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      draft.engine === opt.value
                        ? "border-act bg-panel3 text-fg"
                        : "border-edge text-fg hover:bg-panel3"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{opt.label}</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {previewLocked && <PreviewLockedBadge />}
                        <span
                          className={`shrink-0 rounded-sm border px-1.5 py-0 text-[10px] ${
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

            <div>
              <label className="text-xs text-mut">麦克风</label>
              <select
                value={draft.micId ?? ""}
                onChange={(e) => patch({ micId: e.target.value || undefined })}
                className="mt-1 w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
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
                className="mt-1 w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
              >
                {LANGUAGE_OPTIONS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-mut">Whisper 地址</label>
                {PREVIEW_TIER && <PreviewLockedBadge />}
              </div>
              <input
                type="text"
                value={draft.whisperUrl}
                disabled={PREVIEW_TIER}
                onChange={(e) => patch({ whisperUrl: e.target.value })}
                placeholder="ws://localhost:8765"
                className="mt-1 w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          </section>

          {/* 说话人分离 — preview tier (#61): the entire section needs
             the local sidecar (HF Token pairs with sidecar-side
             pyannote, 检测状态 probes the sidecar, 实时说话人分离 only runs
             through the sidecar's ws pass), so it's disabled as ONE
             group with a single badge on the heading rather than
             per-field. */}
          <section className="space-y-3 border-t border-edge pt-5">
            <div className="flex items-center gap-2">
              <SectionHeading>说话人分离</SectionHeading>
              {PREVIEW_TIER && <PreviewLockedBadge />}
            </div>

            <div>
              <label className="text-xs text-mut">HF Token</label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type={showHfToken ? "text" : "password"}
                  value={draft.hfToken}
                  disabled={PREVIEW_TIER}
                  onChange={(e) => patch({ hfToken: e.target.value })}
                  placeholder="hf_…"
                  className="w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={PREVIEW_TIER}
                  onClick={() => setShowHfToken((v) => !v)}
                  aria-label={showHfToken ? "隐藏" : "显示"}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
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
              <div className="space-y-2 rounded-sm border border-edge bg-panel2 p-3">
                <ol className="space-y-2 text-xs leading-[1.7] text-mut">
                  <li>
                    <span className="font-mono text-fg">①</span> 注册{" "}
                    <a
                      href="https://huggingface.co/settings/tokens"
                      target="_blank"
                      rel="noreferrer"
                      className="text-lab-cyan underline decoration-lab-cyan/40"
                    >
                      huggingface.co
                    </a>{" "}
                    并在 Settings → Access Tokens 创建一个 Read token
                  </li>
                  <li>
                    <span className="font-mono text-fg">②</span> 分别打开并接受两个模型的使用条款：
                    <a
                      href="https://huggingface.co/pyannote/segmentation-3.0"
                      target="_blank"
                      rel="noreferrer"
                      className="text-lab-cyan underline decoration-lab-cyan/40"
                    >
                      pyannote/segmentation-3.0
                    </a>{" "}
                    与{" "}
                    <a
                      href="https://huggingface.co/pyannote/speaker-diarization-3.1"
                      target="_blank"
                      rel="noreferrer"
                      className="text-lab-cyan underline decoration-lab-cyan/40"
                    >
                      pyannote/speaker-diarization-3.1
                    </a>
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
              className="btn-tactile w-full rounded-sm border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
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
                      : "需先配置 HF Token"}
                </div>
              </div>
              <input
                type="checkbox"
                checked={draft.realtimeDiarize}
                disabled={!realtimeDiarizeAvailable}
                onChange={(e) => patch({ realtimeDiarize: e.target.checked })}
                className="h-4 w-4 shrink-0 accent-act disabled:opacity-50"
              />
            </label>
          </section>

          {/* AI 检测 */}
          <section className="space-y-3 border-t border-edge pt-5">
            <SectionHeading>AI 检测</SectionHeading>

            {/* Preview tier (#61): every credential-related field below
               (provider/Poe preset, Base URL, OpenRouter OAuth connect,
               API Key) renders disabled — greyed showroom, never
               unmounted — because the hosted build's detect/summarize
               calls run on OUR server key, not the visitor's own. */}
            {PREVIEW_TIER && (
              <div className="space-y-1">
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
                  BYOK 直连你自己的端点、不带该标志。音频永远不经过我们的服务器。
                </div>
              </div>
            )}

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
                      检测用轻量模型（更快），报告可用更强模型
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

            <button
              type="button"
              onClick={() => void handleTestConnection()}
              disabled={testingConnection}
              className="btn-tactile w-full rounded-sm border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {testingConnection ? "测试中…" : "测试连接"}
            </button>

            <label className="flex items-center justify-between gap-3 py-1">
              <span className="text-sm text-fg">实时检测</span>
              <input
                type="checkbox"
                checked={draft.autoDetect}
                onChange={(e) => patch({ autoDetect: e.target.checked })}
                className="h-4 w-4 accent-act"
              />
            </label>

            <label className="flex items-center justify-between gap-3 py-1">
              <div>
                <div className="text-sm text-fg">AI 检测</div>
                <div className="text-xs text-mut2">
                  内置词典始终即时检测；开启后 AI 并行分析并就地升级词典结果。关闭则完全离线，不调用任何 API
                </div>
              </div>
              <input
                type="checkbox"
                checked={draft.aiDetect}
                onChange={(e) => patch({ aiDetect: e.target.checked })}
                className="h-4 w-4 accent-act"
              />
            </label>

            <div>
              <div className="flex items-center justify-between">
                <label className="text-xs text-mut">置信度阈值</label>
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
            </div>

            <div>
              <label className="text-xs text-mut">解释语言</label>
              <select
                value={draft.explainLanguage}
                onChange={(e) =>
                  patch({ explainLanguage: e.target.value as ExplainLanguage })
                }
                className="mt-1 w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
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

            <label className="flex items-center justify-between gap-3 py-1">
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
              <input
                type="checkbox"
                checked={draft.bilingualTranscript}
                disabled={!bilingualTranscriptAvailable}
                onChange={(e) => patch({ bilingualTranscript: e.target.checked })}
                className="h-4 w-4 shrink-0 accent-act disabled:opacity-50"
              />
            </label>

            <div className="space-y-2 border-t border-edge pt-3">
              <div className="text-xs text-mut">词典主题包</div>
              <label className="flex items-center justify-between gap-3 py-1">
                <div>
                  <div className="text-sm text-mut2">基础包·始终启用</div>
                  <div className="text-xs text-mut2">
                    内置必备表达与商务黑话（{packEntryCounts.core ?? 0} 条）
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked
                  disabled
                  className="h-4 w-4 accent-act disabled:opacity-50"
                />
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
                        <span className="ml-1.5 rounded-sm border border-edge2 px-1.5 py-0 text-[10px] font-normal text-mut">
                          社区
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-mut2">
                      {p.description}（{packEntryCounts[p.id] ?? 0} 条）
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={checkedPacks.has(p.id)}
                    onChange={(e) => togglePack(p.id, e.target.checked)}
                    className="h-4 w-4 accent-act"
                  />
                </label>
              ))}
            </div>

            {/* 词典源 (#20): install community dictionary packs from a
               URL. getAllPacks() above already folds loaded remote
               packs into the checkbox list; this subsection manages
               the underlying sources (add/remove/update-check). */}
            <div className="space-y-2 border-t border-edge pt-3">
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
                  className="w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleAddPackSource()}
                  disabled={addingPackSource || !packSourceUrl.trim()}
                  className="btn-tactile shrink-0 rounded-sm border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {addingPackSource ? "添加中…" : "添加"}
                </button>
              </div>

              {packSources.length > 0 && (
                <div className="space-y-1.5">
                  {packSources.map((s) => (
                    <div
                      key={s.url}
                      className="flex items-center justify-between gap-2 rounded-sm border border-edge bg-panel2 px-3 py-2"
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
                          className="btn-tactile rounded-sm px-2 py-1 text-xs text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          检查更新
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemovePackSource(s.url)}
                          className={`btn-tactile rounded-sm px-2 py-1 text-xs hover:bg-panel3 ${
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
                    className="btn-tactile w-full rounded-sm border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {checkingUpdates ? "检查中…" : "检查全部更新"}
                  </button>
                </div>
              )}

              <div className="text-xs leading-[1.7] text-mut2">
                从 GitHub raw / jsDelivr 链接安装社区词典包，JSON 格式见文档
              </div>
            </div>
          </section>

          {/* 分任务模型（高级）(#56, BYOK-only): a self-contained section
             (design Q5's #62 fit note — advanced-mode visibility gating
             later is a one-line change here) so translate/detect/
             summary can each optionally point at a different provider/
             model, inheriting the primary "AI 检测" credential above by
             default. Preview tier: disabled as ONE group + one
             PreviewLockedBadge, same grouping pattern as 说话人分离
             above — BYOK has no meaning when the hosted build's calls
             run on our own server key. */}
          <section className="space-y-3 border-t border-edge pt-5">
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

          {/* 数据与联动 */}
          <section className="space-y-3 border-t border-edge pt-5">
            <SectionHeading>数据与联动</SectionHeading>

            <label className="flex items-center justify-between gap-3 py-1">
              <span className="text-sm text-fg">自动导出</span>
              <input
                type="checkbox"
                checked={draft.autoExport}
                onChange={(e) => patch({ autoExport: e.target.checked })}
                className="h-4 w-4 accent-act"
              />
            </label>

            <div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleChooseExportFolder()}
                  className="btn-tactile rounded-sm border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
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
                className="mt-1 w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
              />
              <div className="mt-1 text-xs leading-[1.7] text-mut2">
                会后 POST 会议 JSON 到该地址（n8n/飞书机器人等）
              </div>
            </div>

            <label className="flex items-center justify-between gap-3 py-1">
              <div>
                <div className="text-sm text-fg">Frontmatter</div>
                <div className="text-xs text-mut2">
                  导出的 Markdown 带 YAML frontmatter
                </div>
              </div>
              <input
                type="checkbox"
                checked={draft.exportFrontmatter}
                onChange={(e) => patch({ exportFrontmatter: e.target.checked })}
                className="h-4 w-4 accent-act"
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
                    取消勾选后，备份将包含你的 API Key（AI 检测 / 分任务模型 / HF Token / Webhook /
                    连接码），请妥善保管
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={exportStripKeys}
                  onChange={(e) => setExportStripKeys(e.target.checked)}
                  className="h-4 w-4 shrink-0 accent-act"
                />
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleExportBackup()}
                  className="btn-tactile rounded-sm border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
                >
                  导出全量备份
                </button>
                <label className="btn-tactile cursor-pointer rounded-sm border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3">
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
                <div className="space-y-2 rounded-sm border border-warn-soft/40 bg-panel2 p-3">
                  <div className="text-sm text-fg">确认恢复备份？</div>
                  <ul className="space-y-0.5 text-xs leading-[1.7] text-mut2">
                    <li>会议历史：{restorePreview.sessions} 场（按 ID 合并，同 ID 的已有会议将被覆盖）</li>
                    <li>个人词典：{restorePreview.entries} 条（按 ID 合并，规则同上）</li>
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
                      className="btn-tactile rounded-sm px-3 py-1.5 text-sm text-mut hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleConfirmRestore()}
                      disabled={restoring}
                      className="btn-tactile rounded-sm border border-warn-soft/50 px-3 py-1.5 text-sm text-warn-soft hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {restoring ? "恢复中…" : "确认恢复"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

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
             comment on that boundary). */}
          {process.env.NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT === "1" && (
            <section className="space-y-3 border-t border-edge pt-5">
              <SectionHeading>订阅直连（实验性）</SectionHeading>
              <div className="text-xs leading-[1.7] text-mut2">
                用你自己机器上已登录的 Claude / ChatGPT，通过本机 sidecar 直接调用
                ——凭据不经过任何服务器，仅 detect / define 两个场景生效；依官方政策可能变化，随时可关闭。
              </div>

              <label className="flex items-center justify-between gap-3 py-1">
                <span className="text-sm text-fg">启用订阅直连（仅 detect/define，限本地版）</span>
                <input
                  type="checkbox"
                  checked={draft.subscriptionDirect}
                  onChange={(e) => patch({ subscriptionDirect: e.target.checked })}
                  className="h-4 w-4 accent-act"
                />
              </label>

              {draft.subscriptionDirect && (
                <>
                  <div className="flex items-center justify-between gap-3 rounded-sm border border-edge bg-panel2 px-3 py-2">
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
                      className="btn-tactile shrink-0 rounded-sm border border-edge px-2 py-1 text-xs text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {checkingAgentHealth ? "检测中…" : "重新检测"}
                    </button>
                  </div>

                  {!agentHealthState && (
                    <div className="text-xs leading-[1.7] text-mut2">
                      未检测到宿主，请先启动 sidecar（
                      <code className="rounded-sm bg-panel2 px-1 font-mono">
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
                      className="mt-1 w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-mut">Provider</label>
                    <div className="mt-1 flex items-center gap-0.5 rounded border border-edge bg-panel2 p-0.5">
                      <button
                        type="button"
                        onClick={() => patch({ subscriptionProvider: "claude-sub" })}
                        className={`flex-1 rounded-sm px-2 py-1.5 text-sm transition-colors ${
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
                        className={`flex-1 rounded-sm px-2 py-1.5 text-sm transition-colors ${
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
                      className="mt-1 w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                    />
                    <div className="mt-1 text-xs leading-[1.7] text-mut2">
                      仅存本机浏览器；sidecar 每次启动会打印一个新连接码，粘贴到这里才能调用
                    </div>
                  </div>
                </>
              )}
            </section>
          )}

          {/* 显示 (v0.2.1: 主题 + 字号/行距，独立于其他设置，切主题不丢) */}
          <section className="space-y-3 border-t border-edge pt-5">
            <SectionHeading>显示</SectionHeading>

            <div>
              <label className="text-xs text-mut">主题</label>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {BUILTIN_THEMES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => patch({ themeId: t.id })}
                    className={`rounded-sm border p-3 text-left text-sm transition-colors ${
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
              <div className="mt-1 flex items-center gap-0.5 rounded border border-edge bg-panel2 p-0.5">
                {FONT_SIZE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => patch({ fontSize: opt.value })}
                    className={`flex-1 rounded-sm px-2 py-1.5 text-sm transition-colors ${
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
              <div className="mt-1 flex items-center gap-0.5 rounded border border-edge bg-panel2 p-0.5">
                {TRANSCRIPT_SCALE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => patch({ transcriptScale: opt.value })}
                    className={`flex-1 rounded-sm px-2 py-1.5 text-sm transition-colors ${
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
              <div className="mt-1 flex items-center gap-0.5 rounded border border-edge bg-panel2 p-0.5">
                {TRANSCRIPT_LEADING_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => patch({ transcriptLeading: opt.value })}
                    className={`flex-1 rounded-sm px-2 py-1.5 text-sm transition-colors ${
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
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t border-edge pt-4">
          <button
            type="button"
            onClick={onClose}
            className="btn-tactile rounded-sm px-4 py-2 text-sm text-mut hover:bg-panel3 hover:text-fg"
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
