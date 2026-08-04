// Catalog of every credential the Settings「密钥」section lists —
// presentation only. Field names are the existing Settings / taskLlm
// keys; storage shape, resolve-time wiring, and keychain custody are
// unchanged. SettingsDialog renders one editor row per entry and the
// contextual engine/translate/AI rows keep writing the same fields.
import type { LlmTaskDomain, Settings } from "@jargonslayer/core/types";
import {
  PROVIDER_API_KEY_NAMES,
  type ProviderApiKeyName,
} from "@/lib/llm/providerKeys";

export type KeysCatalogInputType = "password" | "text";

export interface ProviderKeyCatalogEntry {
  kind: "provider";
  field: ProviderApiKeyName;
  label: string;
  purpose: string;
  placeholder: string;
  inputType: KeysCatalogInputType;
}

export interface TaskKeyCatalogEntry {
  kind: "task";
  domain: LlmTaskDomain;
  label: string;
  purpose: string;
  placeholder: string;
  inputType: KeysCatalogInputType;
}

export interface SettingsKeyCatalogEntry {
  kind: "settings";
  field:
    | "sonioxKey"
    | "deepgramKey"
    | "elevenLabsKey"
    | "hfToken"
    | "deeplKey"
    | "youdaoAppKey"
    | "youdaoAppSecret"
    | "agentToken";
  label: string;
  purpose: string;
  placeholder: string;
  inputType: KeysCatalogInputType;
  /** When true, only render under NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT. */
  subscriptionDirectOnly?: boolean;
}

export type KeysCatalogEntry =
  | ProviderKeyCatalogEntry
  | TaskKeyCatalogEntry
  | SettingsKeyCatalogEntry;

const PROVIDER_KEY_META: Record<
  ProviderApiKeyName,
  { label: string; purpose: string; placeholder: string }
> = {
  apiKeyAnthropic: {
    label: "Anthropic API Key",
    purpose: "AI 检测主配置 · Anthropic",
    placeholder: "sk-ant-…",
  },
  apiKeyOpenai: {
    label: "OpenAI API Key",
    purpose: "AI 检测主配置 · OpenAI",
    placeholder: "sk-…",
  },
  apiKeyDeepseek: {
    label: "DeepSeek API Key",
    purpose: "AI 检测主配置 · DeepSeek",
    placeholder: "sk-…",
  },
  apiKeyQwen: {
    label: "通义千问 API Key",
    purpose: "AI 检测主配置 · 通义千问",
    placeholder: "sk-…",
  },
  apiKeyOpenrouter: {
    label: "OpenRouter API Key",
    purpose: "AI 检测主配置 · OpenRouter",
    placeholder: "sk-or-…",
  },
  apiKeyPoe: {
    label: "Poe API Key",
    purpose: "AI 检测主配置 · Poe",
    placeholder: "…",
  },
  apiKeyOllama: {
    label: "Ollama API Key",
    purpose: "AI 检测主配置 · Ollama（通常可留空）",
    placeholder: "可选",
  },
  apiKeyCustom: {
    label: "自定义端点 API Key",
    purpose: "AI 检测主配置 · 自定义 OpenAI 兼容端点",
    placeholder: "sk-…",
  },
};

/** Every top-level per-provider LLM key, one row each. */
export const PROVIDER_KEY_CATALOG: ProviderKeyCatalogEntry[] = PROVIDER_API_KEY_NAMES.map(
  (field) => ({
    kind: "provider" as const,
    field,
    ...PROVIDER_KEY_META[field],
    inputType: "password" as const,
  }),
);

/** Per-task LLM key overrides (taskLlm[domain].apiKey). */
export const TASK_KEY_CATALOG: TaskKeyCatalogEntry[] = [
  {
    kind: "task",
    domain: "translate",
    label: "翻译任务 API Key",
    purpose: "分任务模型 · 选区翻译 / 双语转录（留空则用主配置）",
    placeholder: "留空则用主配置的 Key",
    inputType: "password",
  },
  {
    kind: "task",
    domain: "detect",
    label: "检测任务 API Key",
    purpose: "分任务模型 · 检测与解释（留空则用主配置）",
    placeholder: "留空则用主配置的 Key",
    inputType: "password",
  },
  {
    kind: "task",
    domain: "summary",
    label: "报告任务 API Key",
    purpose: "分任务模型 · 会议报告（留空则用主配置）",
    placeholder: "留空则用主配置的 Key",
    inputType: "password",
  },
];

/** Non-LLM service credentials (transcription, diarization, translate, agent). */
export const SERVICE_KEY_CATALOG: SettingsKeyCatalogEntry[] = [
  {
    kind: "settings",
    field: "sonioxKey",
    label: "Soniox API Key",
    purpose: "转录引擎 · Soniox 云端识别 / 标签页音频（Soniox）",
    placeholder: "粘贴你的 Soniox API Key",
    inputType: "password",
  },
  {
    kind: "settings",
    field: "deepgramKey",
    label: "Deepgram API Key",
    purpose: "转录引擎 · Deepgram 云端识别 / 标签页音频（Deepgram）",
    placeholder: "粘贴你的 Deepgram API Key",
    inputType: "password",
  },
  {
    kind: "settings",
    field: "elevenLabsKey",
    label: "ElevenLabs API Key",
    purpose: "转录引擎 · ElevenLabs 云端识别",
    placeholder: "粘贴你的 ElevenLabs API Key",
    inputType: "password",
  },
  {
    kind: "settings",
    field: "hfToken",
    label: "HF Token",
    purpose: "说话人分离 · pyannote（Hugging Face）",
    placeholder: "hf_…",
    inputType: "password",
  },
  {
    kind: "settings",
    field: "deeplKey",
    label: "DeepL API Key",
    purpose: "翻译引擎 · DeepL",
    placeholder: "粘贴你的 DeepL API Key",
    inputType: "password",
  },
  {
    kind: "settings",
    field: "youdaoAppKey",
    label: "有道 应用ID",
    purpose: "翻译引擎 · 有道文本翻译",
    placeholder: "应用ID",
    inputType: "text",
  },
  {
    kind: "settings",
    field: "youdaoAppSecret",
    label: "有道 应用密钥",
    purpose: "翻译引擎 · 有道文本翻译",
    placeholder: "应用密钥",
    inputType: "password",
  },
  {
    kind: "settings",
    field: "agentToken",
    label: "连接码",
    purpose: "订阅直连 · 本机代理服务",
    placeholder: "从代理服务启动日志复制粘贴",
    inputType: "text",
    subscriptionDirectOnly: true,
  },
];

/** The three standalone STT providers exposed by the engine picker. Kept as
 * a projection of the credential catalog so a picker never owns a second
 * provider-to-key list or status rule. */
export type SttProviderKeyField = "sonioxKey" | "deepgramKey" | "elevenLabsKey";

export const STT_PROVIDER_KEY_CATALOG: readonly SettingsKeyCatalogEntry[] = SERVICE_KEY_CATALOG.filter(
  (entry): entry is SettingsKeyCatalogEntry & { field: SttProviderKeyField } =>
    entry.field === "sonioxKey" || entry.field === "deepgramKey" || entry.field === "elevenLabsKey",
);

export function sttProviderKeyCatalogEntry(field: SttProviderKeyField): SettingsKeyCatalogEntry {
  const entry = STT_PROVIDER_KEY_CATALOG.find((candidate) => candidate.field === field);
  if (!entry) {
    throw new Error(`Missing STT provider key catalog entry for ${field}`);
  }
  return entry;
}

/** Reads an STT credential through its catalog field, rather than letting a
 * picker duplicate a direct settings-field lookup. */
export function sttProviderKeyValue(settings: Settings, field: SttProviderKeyField): string {
  return settings[sttProviderKeyCatalogEntry(field).field];
}

/** Flat list used by completeness tests — every credential the Keys section must reach. */
export const ALL_KEYS_CATALOG: KeysCatalogEntry[] = [
  ...PROVIDER_KEY_CATALOG,
  ...TASK_KEY_CATALOG,
  ...SERVICE_KEY_CATALOG,
];

/** Stable id for data-settings-key / test hooks. */
export function keysCatalogFieldId(entry: KeysCatalogEntry): string {
  if (entry.kind === "task") return `taskLlm.${entry.domain}.apiKey`;
  return entry.field;
}
