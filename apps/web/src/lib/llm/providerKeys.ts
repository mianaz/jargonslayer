import type { LlmProvider, Settings } from "@jargonslayer/core/types";

export type ProviderPresetId =
  | "anthropic"
  | "openai"
  | "deepseek"
  | "qwen"
  | "openrouter"
  | "poe"
  | "ollama"
  | "custom";

export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  provider: LlmProvider;
  baseUrl: string;
  modelHint?: string;
}

export const PROVIDER_API_KEY_NAMES = [
  "apiKeyAnthropic",
  "apiKeyOpenai",
  "apiKeyDeepseek",
  "apiKeyQwen",
  "apiKeyOpenrouter",
  "apiKeyPoe",
  "apiKeyOllama",
  "apiKeyCustom",
] as const;

export type ProviderApiKeyName = (typeof PROVIDER_API_KEY_NAMES)[number];

const API_KEY_NAME_BY_PRESET: Record<ProviderPresetId, ProviderApiKeyName> = {
  anthropic: "apiKeyAnthropic",
  openai: "apiKeyOpenai",
  deepseek: "apiKeyDeepseek",
  qwen: "apiKeyQwen",
  openrouter: "apiKeyOpenrouter",
  poe: "apiKeyPoe",
  ollama: "apiKeyOllama",
  custom: "apiKeyCustom",
};

const KEY_PRESETS: ProviderPreset[] = [
  { id: "anthropic", label: "Anthropic", provider: "anthropic", baseUrl: "" },
  { id: "openai", label: "OpenAI", provider: "openai-compat", baseUrl: "https://api.openai.com/v1" },
  { id: "deepseek", label: "DeepSeek", provider: "openai-compat", baseUrl: "https://api.deepseek.com" },
  {
    id: "qwen",
    label: "Qwen",
    provider: "openai-compat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    provider: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  { id: "poe", label: "Poe", provider: "openai-compat", baseUrl: "https://api.poe.com/v1" },
  {
    id: "ollama",
    label: "Ollama",
    provider: "openai-compat",
    baseUrl: "http://localhost:11434/v1",
  },
  { id: "custom", label: "Custom", provider: "openai-compat", baseUrl: "" },
];

/** Stable host identity used for preset matching and the custom-key
 *  binding. Invalid/incomplete URLs fall back to their trimmed literal
 *  so editing a custom endpoint can never make an unrelated key match. */
export function providerHostFor(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return baseUrl.trim().toLowerCase();
  }
}

/** Reverse-match a provider/baseUrl pair to a preset. Host matching is
 *  deliberate: legacy OpenRouter URLs with a different path/trailing
 *  slash still belong to OpenRouter, while an unrelated host cannot. */
export function presetIdFor(
  presets: ProviderPreset[],
  creds: { provider: LlmProvider; baseUrl: string },
): ProviderPresetId {
  if (creds.provider === "anthropic") return "anthropic";
  const host = providerHostFor(creds.baseUrl);
  const hit = presets.find(
    (p) =>
      p.provider === "openai-compat" &&
      p.baseUrl &&
      (p.baseUrl === creds.baseUrl || providerHostFor(p.baseUrl) === host),
  );
  return hit?.id ?? "custom";
}

export function providerApiKeyNameFor(
  provider: LlmProvider,
  baseUrl: string,
): ProviderApiKeyName {
  return API_KEY_NAME_BY_PRESET[presetIdFor(KEY_PRESETS, { provider, baseUrl })];
}

/** The only resolver for a top-level LLM key. Custom endpoints are
 *  additionally host-bound so changing their Base URL cannot reuse a
 *  secret that belonged to the previous third-party host. */
export function resolveProviderApiKey(
  settings: Settings,
  provider: LlmProvider = settings.provider,
  baseUrl: string = settings.baseUrl,
): string {
  const name = providerApiKeyNameFor(provider, baseUrl);
  if (name === "apiKeyCustom" && settings.llmCustomHost !== providerHostFor(baseUrl)) {
    return "";
  }
  return settings[name] ?? "";
}

export function providerApiKeyPatch(
  provider: LlmProvider,
  baseUrl: string,
  apiKey: string,
): Partial<Settings> {
  const name = providerApiKeyNameFor(provider, baseUrl);
  if (name === "apiKeyCustom") {
    return { apiKeyCustom: apiKey, llmCustomHost: providerHostFor(baseUrl) };
  }
  return { [name]: apiKey };
}

export function hasAnyProviderApiKey(settings: Settings): boolean {
  return PROVIDER_API_KEY_NAMES.some((name) => !!settings[name]);
}
