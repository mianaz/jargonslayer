"use client";

// First-run onboarding: 5-step carousel, engine-picker as the core
// step (Handy-app style). shouldShowTutorial() is an SSR-safe pure
// check consumed by app/page.tsx to decide whether to auto-open this
// overlay on first load. OWNER: this worker (#21).

import { useState } from "react";
import { CheckCircle } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import type { STTEngineKind } from "@/lib/types";

export interface TutorialOverlayProps {
  open: boolean;
  onClose: () => void;
}

const TUTORIAL_DONE_KEY = "jargonslayer:tutorial_done";

export function shouldShowTutorial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TUTORIAL_DONE_KEY) !== "1";
  } catch {
    return false;
  }
}

function markTutorialDone(): void {
  try {
    window.localStorage.setItem(TUTORIAL_DONE_KEY, "1");
  } catch {
    // non-fatal — worst case the tutorial reappears next visit
  }
}

const STEP_COUNT = 5;

// ---------------------------------------------------------------
// Step 2: engine picker card grid — Handy-app style. Privacy tags per
// spec: 演示模式·无音频 / 浏览器识别·音频经浏览器厂商 / 本地 Whisper·
// 音频不出本机 / 标签页音频·听懂对方，需本地 Whisper.
// ---------------------------------------------------------------

const ENGINE_OPTIONS: {
  value: STTEngineKind;
  label: string;
  hint: string;
  privacyTag: string;
}[] = [
  {
    value: "demo",
    label: "演示",
    hint: "内置脚本，无需麦克风，先熟悉界面",
    privacyTag: "演示模式·无音频",
  },
  {
    value: "webspeech",
    label: "浏览器识别",
    hint: "零配置，Chrome/Edge 最佳，开箱即用",
    privacyTag: "浏览器识别·音频经浏览器厂商",
  },
  {
    value: "whisper",
    label: "本地 Whisper",
    hint: "隐私最佳，需启动本地 sidecar",
    privacyTag: "本地 Whisper·音频不出本机",
  },
  {
    value: "tabaudio",
    label: "标签页音频",
    hint: "共享标签页听懂对方声音",
    privacyTag: "标签页音频·听懂对方，需本地 Whisper",
  },
];

function EnginePickerStep() {
  const engine = useApp((s) => s.settings.engine);
  const updateSettings = useApp((s) => s.updateSettings);

  return (
    <div>
      <div className="text-lg font-semibold text-fg">选择转录引擎</div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {ENGINE_OPTIONS.map((opt) => {
          const selected = engine === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => updateSettings({ engine: opt.value })}
              className={`rounded-lg border p-3 text-left text-sm transition-colors ${
                selected
                  ? "border-acc ring-1 ring-acc bg-panel3 text-fg"
                  : "border-edge text-fg hover:bg-panel3"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{opt.label}</span>
                {selected && (
                  <CheckCircle size={18} weight="regular" className="shrink-0 text-acc" />
                )}
              </div>
              <div className="mt-1 text-xs leading-[1.7] text-mut">{opt.hint}</div>
              <div className="mt-2 inline-block rounded-full border border-gold/30 px-2 py-0.5 text-[10px] text-gold">
                {opt.privacyTag}
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-3 text-xs leading-[1.7] text-mut2">
        之后随时可在设置里更换；上传录音转录在「历史→导入录音」。
      </div>
    </div>
  );
}

export default function TutorialOverlay({ open, onClose }: TutorialOverlayProps) {
  const [step, setStep] = useState(0);

  if (!open) return null;

  const isLast = step === STEP_COUNT - 1;

  const finish = () => {
    markTutorialDone();
    setStep(0);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[560px] max-w-[92vw] rounded-xl border border-edge bg-panel p-6">
        <div className="flex items-center justify-center gap-1.5">
          {Array.from({ length: STEP_COUNT }, (_, i) => (
            <span
              key={i}
              className={`h-1.5 w-1.5 rounded-full ${
                i === step ? "bg-acc" : "bg-edge2"
              }`}
            />
          ))}
        </div>

        <div className="mt-6 min-h-[260px]">
          {step === 0 && (
            <div>
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-acc to-acc2 text-xs font-bold text-white">
                  ML
                </div>
                <span className="text-lg font-semibold text-fg">JargonSlayer</span>
              </div>
              <div className="mt-4 text-base font-medium leading-[1.7] text-fg">
                把听不懂的行话，一条条屠掉。
              </div>
              <div className="mt-3 text-sm leading-[1.7] text-mut">
                开会时它听英文，你看中文解释卡片。英文习语、俚语、缩写第一时间变成看得懂的解释，不用中途打断会议去查词典。
              </div>
            </div>
          )}

          {step === 1 && <EnginePickerStep />}

          {step === 2 && (
            <div>
              <div className="text-lg font-semibold text-fg">三种用法</div>
              <div className="mt-4 space-y-3">
                <div className="rounded-lg border border-edge p-3">
                  <div className="text-sm font-medium text-fg">免费词典模式</div>
                  <div className="mt-1 text-xs leading-[1.7] text-mut">
                    开箱即用，371 条内置商务表达与术语，无需任何配置。
                  </div>
                </div>
                <div className="rounded-lg border border-edge p-3">
                  <div className="text-sm font-medium text-fg">填 API Key 解锁 AI 上下文检测</div>
                  <div className="mt-1 text-xs leading-[1.7] text-mut">
                    设置→AI 检测，兼容 DeepSeek/Ollama，解释更贴合当前语境。
                  </div>
                </div>
                <div className="rounded-lg border border-edge p-3">
                  <div className="text-sm font-medium text-fg">全离线</div>
                  <div className="mt-1 text-xs leading-[1.7] text-mut">
                    本地 Whisper + Ollama，音频和内容完全不出本机。
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <div className="text-lg font-semibold text-fg">实时体验</div>
              <div className="mt-3 text-sm leading-[1.7] text-fg/90">
                新卡片到达有金色高亮提示；转录文本里的金色虚线下划线可以点击定位到对应卡片。最新几张卡片全展开，其余折叠为摘要，随手展开/折叠。选中任意英文文字即可划词收藏，直接存入个人词库。专注模式下折叠右栏，鼠标悬停在高亮上就能看到释义。
              </div>
            </div>
          )}

          {step === 4 && (
            <div>
              <div className="text-lg font-semibold text-fg">会后</div>
              <div className="mt-3 text-sm leading-[1.7] text-fg/90">
                结束会议后可以生成双语纪要、全文翻译和学习卡片，一键导出 Markdown 或 Anki。练习卡支持复习页反复巩固，所有历史记录自动落盘保存在本机，不上传任何服务器。
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-edge pt-4">
          <button
            type="button"
            onClick={finish}
            className="text-xs text-mut hover:text-fg"
          >
            跳过
          </button>

          <div className="flex gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                className="btn-tactile rounded-lg border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3"
              >
                上一步
              </button>
            )}
            {isLast ? (
              <button
                type="button"
                onClick={finish}
                className="btn-tactile rounded-lg bg-acc px-3 py-1.5 text-sm font-medium text-white hover:bg-acchover"
              >
                开始使用
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setStep((s) => Math.min(STEP_COUNT - 1, s + 1))}
                className="btn-tactile rounded-lg bg-acc px-3 py-1.5 text-sm font-medium text-white hover:bg-acchover"
              >
                下一步
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
