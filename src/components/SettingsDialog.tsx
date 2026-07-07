"use client";

// Settings modal: transcription engine + AI detection configuration.
// Edits a local draft; only committed to the store on 保存.

import { useEffect, useState } from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { listAudioInputs } from "@/lib/audio/devices";
import { testConnection } from "@/lib/llm/client";
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
  chooseExportFolder,
  clearExportFolder,
  getExportFolderName,
} from "@/lib/history/autoExport";
import { fetchSidecarHealth } from "@/lib/stt/upload";
import type { ExplainLanguage, LlmProvider, STTEngineKind, Settings } from "@/lib/types";
import { withBase } from "@/lib/basePath";
import { BUILTIN_THEMES } from "@/lib/theme/themes";
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
}[] = [
  {
    value: "webspeech",
    label: "浏览器识别",
    hint: "由浏览器厂商云端识别（音频会离开设备）",
    posture: "cloud",
  },
  {
    value: "whisper",
    label: "本地 Whisper",
    hint: "音频只在本机处理，不出设备",
    posture: "local",
  },
  {
    value: "tabaudio",
    label: "标签页音频",
    hint: "在本机转录标签页音频",
    posture: "local",
    disabled: true,
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

type ProviderPresetId =
  | "anthropic"
  | "deepseek"
  | "qwen"
  | "openrouter"
  | "poe"
  | "ollama"
  | "custom";

interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  provider: LlmProvider;
  baseUrl: string; // "" for custom — user fills it in
  /** Applied to draft.detectModel/summaryModel when selected. */
  suggestedModels?: { detectModel: string; summaryModel?: string };
  /** Shown as a hint near the model inputs, not force-applied. */
  modelHint?: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
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

/** Reverse-match the current draft to a preset id for the select's
 *  displayed value (falls back to "custom" for any openai-compat
 *  baseUrl that doesn't match a known preset). */
function presetIdFor(draft: Settings): ProviderPresetId {
  if (draft.provider === "anthropic") return "anthropic";
  const hit = PROVIDER_PRESETS.find(
    (p) => p.provider === "openai-compat" && p.baseUrl && p.baseUrl === draft.baseUrl,
  );
  return hit?.id ?? "custom";
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs uppercase tracking-wide text-mut">{children}</div>
  );
}

export default function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const showToast = useApp((s) => s.showToast);

  const [draft, setDraft] = useState<Settings>(settings);
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([]);
  const [showKey, setShowKey] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [exportFolderName, setExportFolderName] = useState<string | null>(null);
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
      setDraft(settings);
      setCheckedPacks(
        new Set(settings.enabledPacks ?? getAllPacks().filter((p) => p.id !== "core").map((p) => p.id)),
      );
      void listAudioInputs().then(setMics);
      void getExportFolderName().then(setExportFolderName);
      void listPackSources().then(setPackSources);
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

  const activePreset = presetIdFor(draft);
  // 实时说话人分离（beta）: only meaningful for the two local-audio
  // engines that go through wsTransport.ts, and only runnable once a
  // token is configured (mirrors the sidecar's own arming gate: config.
  // diarize truthy AND a token available).
  const realtimeDiarizeAvailable =
    (draft.engine === "whisper" || draft.engine === "tabaudio") && !!draft.hfToken;
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
              {ENGINE_CARDS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={opt.disabled}
                  onClick={() => patch({ engine: opt.value })}
                  className={`rounded-sm border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    draft.engine === opt.value
                      ? "border-act bg-panel3 text-fg"
                      : "border-edge text-fg hover:bg-panel3"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{opt.label}</span>
                    <span
                      className={`shrink-0 rounded-sm border px-1.5 py-0 text-[10px] ${
                        opt.posture === "local"
                          ? "border-lab-green/30 text-lab-green"
                          : "border-warn-soft/30 text-warn-soft"
                      }`}
                    >
                      {POSTURE_LABEL[opt.posture]}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs leading-[1.7] text-mut">
                    {opt.hint}
                  </div>
                </button>
              ))}
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
              <label className="text-xs text-mut">Whisper 地址</label>
              <input
                type="text"
                value={draft.whisperUrl}
                onChange={(e) => patch({ whisperUrl: e.target.value })}
                placeholder="ws://localhost:8765"
                className="mt-1 w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
              />
            </div>
          </section>

          {/* 说话人分离 */}
          <section className="space-y-3 border-t border-edge pt-5">
            <SectionHeading>说话人分离</SectionHeading>

            <div>
              <label className="text-xs text-mut">HF Token</label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type={showHfToken ? "text" : "password"}
                  value={draft.hfToken}
                  onChange={(e) => patch({ hfToken: e.target.value })}
                  placeholder="hf_…"
                  className="w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowHfToken((v) => !v)}
                  aria-label={showHfToken ? "隐藏" : "显示"}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-mut hover:bg-panel3 hover:text-fg"
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

            {!draft.hfToken && (
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
              disabled={checkingDiarization}
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
                  {realtimeDiarizeAvailable
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

            <div>
              <label className="text-xs text-mut">提供方</label>
              <select
                value={activePreset}
                onChange={(e) => handleSelectPreset(e.target.value as ProviderPresetId)}
                className="mt-1 w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
              >
                {PROVIDER_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            {draft.provider === "openai-compat" && (
              <div>
                <label className="text-xs text-mut">Base URL</label>
                <input
                  type="text"
                  value={draft.baseUrl}
                  onChange={(e) => patch({ baseUrl: e.target.value })}
                  placeholder="https://api.deepseek.com"
                  className="mt-1 w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                />
              </div>
            )}

            {activePreset === "openrouter" && (
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => void handleConnectOpenRouter()}
                  className="btn-tactile w-full rounded-sm border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
                >
                  一键连接 OpenRouter 账号
                </button>
                <div className="text-xs leading-[1.7] text-mut2">
                  跳转 OpenRouter 完成授权，自动生成并填入 API Key；也可在下方手动粘贴已有 Key
                </div>
              </div>
            )}

            <div>
              <label className="text-xs text-mut">API Key</label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type={showKey ? "text" : "password"}
                  value={draft.apiKey}
                  onChange={(e) => patch({ apiKey: e.target.value })}
                  placeholder="sk-…"
                  className="w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "隐藏" : "显示"}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-mut hover:bg-panel3 hover:text-fg"
                >
                  {showKey ? (
                    <EyeSlash size={18} weight="regular" />
                  ) : (
                    <Eye size={18} weight="regular" />
                  )}
                </button>
              </div>
              <div className="mt-1 text-xs text-mut2">
                仅存本机浏览器，随请求直发
              </div>
            </div>

            <button
              type="button"
              onClick={() => void handleTestConnection()}
              disabled={testingConnection}
              className="btn-tactile w-full rounded-sm border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {testingConnection ? "测试中…" : "测试连接"}
            </button>

            <div>
              <label className="text-xs text-mut">检测模型</label>
              <input
                list="detect-model-options"
                type="text"
                value={draft.detectModel}
                onChange={(e) => patch({ detectModel: e.target.value })}
                className="mt-1 w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
              />
              <datalist id="detect-model-options">
                {DETECT_MODEL_OPTIONS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {activePreset === "ollama" && (
                <div className="mt-1 text-xs text-mut2">
                  Ollama 常用模型：qwen3:8b
                </div>
              )}
            </div>

            <div>
              <label className="text-xs text-mut">报告模型</label>
              <input
                list="summary-model-options"
                type="text"
                value={draft.summaryModel}
                onChange={(e) => patch({ summaryModel: e.target.value })}
                className="mt-1 w-full rounded-sm border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
              />
              <datalist id="summary-model-options">
                {SUMMARY_MODEL_OPTIONS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>

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
                <div className="text-sm text-fg">仅词典模式</div>
                <div className="text-xs text-mut2">完全离线，不调用任何 API</div>
              </div>
              <input
                type="checkbox"
                checked={draft.dictionaryOnly}
                onChange={(e) => patch({ dictionaryOnly: e.target.checked })}
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
          </section>

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
                整个界面的文字大小，效果类似浏览器缩放
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
            className="btn-terminal rounded-none bg-act px-4 py-2 font-mono text-sm font-semibold text-ink hover:bg-[#E8E8E8]"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
