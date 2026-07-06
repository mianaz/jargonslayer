"use client";

// First-run tutorial: 5-step carousel. shouldShowTutorial() is an
// SSR-safe pure check consumed by app/page.tsx to decide whether to
// auto-open this overlay on first load.

import { useState } from "react";

export interface TutorialOverlayProps {
  open: boolean;
  onClose: () => void;
}

const TUTORIAL_DONE_KEY = "meetlingo:tutorial_done";

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

const STEPS: { title: string; body: string }[] = [
  {
    title: "MeetLingo 是什么",
    body: "开会时它听英文，你看中文解释卡片。英文习语、俚语、缩写第一时间变成看得懂的解释，不用中途打断会议去查词典。",
  },
  {
    title: "四种转录引擎对比",
    body: "演示模式无需任何配置；浏览器识别零配置但依赖 Chrome/Edge；本地 Whisper 隐私最佳，音频不出本机；标签页音频即将上线，用于听懂对方声音。",
  },
  {
    title: "实时体验",
    body: "新卡片会有金色高亮提示，重复出现的表达会显示次数。转录文本里的金色虚线下划线可以点击定位到对应卡片；选中任意英文文字即可即席查询。",
  },
  {
    title: "三种用法",
    body: "免费：词典模式开箱即用，不用配置任何东西。填 Key：接入 AI 做上下文相关的检测，解释更准确。全离线：本地 Whisper 加 Ollama，音频和内容完全不出本机。",
  },
  {
    title: "会后",
    body: "结束会议后可以生成双语纪要、全文翻译和学习卡片，一键导出 Markdown 或 Anki。所有历史记录都保存在本机，不上传任何服务器。",
  },
];

export default function TutorialOverlay({ open, onClose }: TutorialOverlayProps) {
  const [step, setStep] = useState(0);

  if (!open) return null;

  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  const finish = () => {
    markTutorialDone();
    setStep(0);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[560px] max-w-[92vw] rounded-xl border border-edge bg-panel p-6">
        <div className="flex items-center justify-center gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 w-1.5 rounded-full ${
                i === step ? "bg-acc" : "bg-edge2"
              }`}
            />
          ))}
        </div>

        <div className="mt-6 min-h-[140px]">
          <div className="text-lg font-semibold text-fg">{current.title}</div>
          <div className="mt-3 text-sm leading-[1.7] text-fg/90">
            {current.body}
          </div>
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
                onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
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
