"use client";

// Shared LLM-credential form fields (#56): provider preset + Base URL
// + API Key + one-or-more model inputs, each with an auto-detected
// dropdown (useProviderModels) falling back to a curated static
// datalist. Extracted from SettingsDialog's primary "AI 检测" section
// so the primary block and the three #56 per-task domain blocks
// (SettingsDialog's 分任务模型（高级） disclosure) render the exact same
// markup instead of three hand-rolled copies (design Q5's explicit
// instruction) — every prop below is deliberately generic over "a
// provider/baseUrl/apiKey triple", not tied to the primary Settings
// object or a TaskLlmConfig specifically.
import { useState } from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import type { LlmProvider } from "@/lib/types";
import { useProviderModels } from "@/hooks/useProviderModels";

export type ProviderPresetId =
  | "anthropic"
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
  baseUrl: string; // "" for custom — user fills it in
  modelHint?: string;
}

/** Reverse-match a provider/baseUrl pair to a preset id for the
 *  select's displayed value (falls back to "custom" for any
 *  openai-compat baseUrl that doesn't match a known preset). Generic
 *  over any {provider,baseUrl} shape — Settings' primary fields AND a
 *  TaskLlmConfig override both fit. */
export function presetIdFor(
  presets: ProviderPreset[],
  creds: { provider: LlmProvider; baseUrl: string },
): ProviderPresetId {
  if (creds.provider === "anthropic") return "anthropic";
  const hit = presets.find(
    (p) => p.provider === "openai-compat" && p.baseUrl && p.baseUrl === creds.baseUrl,
  );
  return hit?.id ?? "custom";
}

export interface CredentialFieldsModel {
  key: string; // stable react key + datalist id suffix
  label: string;
  value: string;
  onChange: (v: string) => void;
  staticOptions: readonly string[];
  hint?: React.ReactNode;
  /** Preview tier (#61): render a plain <select> restricted to this
   *  list instead of the free-text input+datalist. Only the PRIMARY
   *  credential block ever passes this — the #56 domain blocks are
   *  greyed wholesale under preview instead (design Q5), so they never
   *  reach this branch. */
  previewOptions?: readonly string[];
}

export interface CredentialFieldsProps {
  idPrefix: string; // datalist ids must be unique per rendered instance
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  /** Fired with the selected preset's id — the caller owns the actual
   *  presets.find() lookup and whatever it wants to do beyond
   *  provider/baseUrl (e.g. the primary block's suggestedModels
   *  auto-fill; a #56 domain block just applies provider+baseUrl). */
  onSelectPreset: (presetId: ProviderPresetId) => void;
  onBaseUrlChange: (baseUrl: string) => void;
  onApiKeyChange: (apiKey: string) => void;
  apiKeyPlaceholder: string;
  /** Small caption under the Key field — callers differ (primary:
   *  storage/transmission disclosure; #56 domain block: none, since
   *  Q5's placeholder text already carries the "blank = inherit"
   *  explanation). Omit for no caption. */
  apiKeyHint?: React.ReactNode;
  models: CredentialFieldsModel[];
  presets: ProviderPreset[];
  disabled?: boolean;
  /** OpenRouter's one-click PKCE connect button — primary-only (design
   *  Q5 lists no equivalent affordance for a #56 domain override; a
   *  fresh OAuth key is meant to land in the primary field once, then
   *  be reused/overridden per-domain from there). */
  onConnectOpenRouter?: () => void;
}

/** Shared provider + Base URL + API Key + model(s) block. Owns its own
 *  useProviderModels fetch per model field (lazy — only once THIS
 *  block is actually mounted/visible; SettingsDialog gates mounting
 *  domain blocks on their own expand state, see the 分任务模型 section). */
export default function CredentialFields({
  idPrefix,
  provider,
  baseUrl,
  apiKey,
  onSelectPreset,
  onBaseUrlChange,
  onApiKeyChange,
  apiKeyPlaceholder,
  apiKeyHint,
  models,
  presets,
  disabled,
  onConnectOpenRouter,
}: CredentialFieldsProps) {
  const [showKey, setShowKey] = useState(false);
  const activePreset = presetIdFor(presets, { provider, baseUrl });

  return (
    <>
      <div>
        <label className="text-xs text-mut">提供方</label>
        <select
          value={activePreset}
          disabled={disabled}
          onChange={(e) => onSelectPreset(e.target.value as ProviderPresetId)}
          className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {provider === "openai-compat" && (
        <div>
          <label className="text-xs text-mut">Base URL</label>
          <input
            type="text"
            value={baseUrl}
            disabled={disabled}
            onChange={(e) => onBaseUrlChange(e.target.value)}
            placeholder="https://api.deepseek.com"
            className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      )}

      {activePreset === "openrouter" && onConnectOpenRouter && (
        <div className="space-y-1.5">
          <button
            type="button"
            disabled={disabled}
            onClick={onConnectOpenRouter}
            className="btn-tactile w-full border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-50"
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
            value={apiKey}
            disabled={disabled}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={apiKeyPlaceholder}
            className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? "隐藏" : "显示"}
            className="flex h-8 w-8 shrink-0 items-center justify-center text-mut hover:bg-panel3 hover:text-fg"
          >
            {showKey ? <EyeSlash size={18} weight="regular" /> : <Eye size={18} weight="regular" />}
          </button>
        </div>
        {apiKeyHint && <div className="mt-1 text-xs text-mut2">{apiKeyHint}</div>}
      </div>

      {models.map((m) => (
        <ModelField
          key={m.key}
          idPrefix={idPrefix}
          provider={provider}
          baseUrl={baseUrl}
          apiKey={apiKey}
          disabled={disabled}
          model={m}
        />
      ))}
    </>
  );
}

/** One model input-with-datalist + fetch-status line + 刷新模型列表
 *  button (design Q2). Split out of the main component body only so
 *  useProviderModels — which fetches on mount when `enabled` — is
 *  scoped per model field rather than once per whole block; every
 *  current caller passes disabled=false for at most one model per
 *  fetch key anyway (primary's two model fields share one
 *  provider/baseUrl pair, so this is one extra harmless duplicate
 *  fetch, deduped by useProviderModels' own module-level cache). */
function ModelField({
  idPrefix,
  provider,
  baseUrl,
  apiKey,
  disabled,
  model,
}: {
  idPrefix: string;
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  disabled?: boolean;
  model: CredentialFieldsModel;
}) {
  const { models: fetchedModels, status, message, refresh } = useProviderModels({
    provider,
    baseUrl,
    apiKey,
    enabled: !disabled && !model.previewOptions,
  });
  const datalistId = `${idPrefix}-${model.key}-options`;
  // Curated static list first (the seed/fallback), fetched ids appended
  // and deduped — a successful fetch only AUGMENTS, never replaces.
  const combinedOptions = Array.from(new Set([...model.staticOptions, ...fetchedModels]));

  return (
    <div>
      <label className="text-xs text-mut">{model.label}</label>
      {model.previewOptions ? (
        <select
          value={model.value}
          onChange={(e) => model.onChange(e.target.value)}
          className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
        >
          {model.previewOptions.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : (
        <div className="mt-1 flex items-center gap-2">
          <input
            list={datalistId}
            type="text"
            value={model.value}
            disabled={disabled}
            onChange={(e) => model.onChange(e.target.value)}
            className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            type="button"
            onClick={refresh}
            disabled={disabled || status === "loading"}
            className="btn-tactile shrink-0 border border-edge px-2 py-1.5 text-xs text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {status === "loading" ? "获取中…" : "刷新模型列表"}
          </button>
        </div>
      )}
      {!model.previewOptions && (
        <datalist id={datalistId}>
          {combinedOptions.map((opt) => (
            <option key={opt} value={opt} />
          ))}
        </datalist>
      )}
      {message && !model.previewOptions && (
        <div className={`mt-1 text-xs leading-[1.7] ${status === "success" ? "text-lab-green" : "text-mut2"}`}>
          {message}
        </div>
      )}
      {model.hint}
    </div>
  );
}
