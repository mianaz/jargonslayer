"use client";

// Settings modal: transcription engine + AI detection configuration.
// Edits a local draft; only committed to the store on 保存.

import { useEffect, useState } from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { listAudioInputs } from "@/lib/audio/devices";
import type { LlmProvider, STTEngineKind, Settings } from "@/lib/types";

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const ENGINE_CARDS: {
  value: STTEngineKind;
  label: string;
  hint: string;
  disabled?: boolean;
}[] = [
  {
    value: "demo",
    label: "演示",
    hint: "内置脚本，无需麦克风",
  },
  {
    value: "webspeech",
    label: "浏览器识别",
    hint: "零配置，Chrome/Edge 最佳",
  },
  {
    value: "whisper",
    label: "本地 Whisper",
    hint: "音频经浏览器厂商/whisper 隐私最佳，需启动 sidecar",
  },
  {
    value: "tabaudio",
    label: "标签页音频",
    hint: "共享标签页听懂对方，即将上线",
    disabled: true,
  },
];

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

  useEffect(() => {
    if (open) {
      setDraft(settings);
      void listAudioInputs().then(setMics);
    }
    // Only reset the draft when the dialog is (re)opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const patch = (p: Partial<Settings>) => setDraft((d) => ({ ...d, ...p }));

  const handleSave = () => {
    updateSettings(draft);
    showToast("设置已保存");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="scroll-thin max-h-[85vh] w-[540px] max-w-[92vw] overflow-y-auto rounded-xl border border-edge bg-panel p-5">
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
                  className={`rounded-lg border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    draft.engine === opt.value
                      ? "border-acc bg-panel3 text-fg"
                      : "border-edge text-fg hover:bg-panel3"
                  }`}
                >
                  <div className="font-medium">{opt.label}</div>
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
                className="mt-1 w-full rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
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
                className="mt-1 w-full rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
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
                className="mt-1 w-full rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
              />
            </div>
          </section>

          {/* AI 检测 */}
          <section className="space-y-3 border-t border-edge pt-5">
            <SectionHeading>AI 检测</SectionHeading>

            <div>
              <label className="text-xs text-mut">提供方</label>
              <select
                value={draft.provider}
                onChange={(e) => patch({ provider: e.target.value as LlmProvider })}
                className="mt-1 w-full rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
              >
                <option value="anthropic">Anthropic 官方</option>
                <option value="openai-compat">OpenAI 兼容端点</option>
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
                  className="mt-1 w-full rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                />
                <div className="mt-1 text-xs leading-[1.7] text-mut2">
                  DeepSeek: https://api.deepseek.com · Ollama 本地:
                  http://localhost:11434/v1 · OpenRouter:
                  https://openrouter.ai/api/v1
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
                  className="w-full rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "隐藏" : "显示"}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-mut hover:bg-panel3 hover:text-fg"
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

            <div>
              <label className="text-xs text-mut">检测模型</label>
              <input
                list="detect-model-options"
                type="text"
                value={draft.detectModel}
                onChange={(e) => patch({ detectModel: e.target.value })}
                className="mt-1 w-full rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
              />
              <datalist id="detect-model-options">
                {DETECT_MODEL_OPTIONS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>

            <div>
              <label className="text-xs text-mut">报告模型</label>
              <input
                list="summary-model-options"
                type="text"
                value={draft.summaryModel}
                onChange={(e) => patch({ summaryModel: e.target.value })}
                className="mt-1 w-full rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
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
                className="h-4 w-4 accent-acc"
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
                className="h-4 w-4 accent-acc"
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
                className="mt-1 w-full accent-acc"
              />
            </div>
          </section>
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t border-edge pt-4">
          <button
            type="button"
            onClick={onClose}
            className="btn-tactile rounded-lg px-4 py-2 text-sm text-mut hover:bg-panel3 hover:text-fg"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="btn-tactile rounded-lg bg-acc px-4 py-2 text-sm font-medium text-white hover:bg-acchover"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
