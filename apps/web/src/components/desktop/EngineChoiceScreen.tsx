"use client";

// S11 osspeech blueprint (docs/design-explorations/s11-osspeech-
// blueprint.md, §3 Worker D, §Q5, Miana-veto #1) — the wizard's NEW
// first screen on macOS 26+: a two-card choice between the zero-install
// system engine (SpeechAnalyzer) and today's local Whisper sidecar.
// Mounted by DesktopWizard.tsx INSTEAD of the existing ConsentScreen
// whenever useOsSpeechCaps() reports the capability supported — on
// macOS <26 this screen is skipped entirely and DesktopWizard falls
// straight through to ConsentScreen, byte-identical to pre-S11
// behavior (see that file's own gating, off this component's concern).
//
// Purely presentational, matching ConsentScreen/StepRowsScreen's own
// "every action here is a callback prop" contract in the same file:
// this component only reports WHICH engine the user picked; the caller
// (DesktopWizard.tsx) owns every side effect — persisting the osspeech
// choice + firing the background preinstall + dismissing the wizard
// (bootstrap.ts's own chooseOsSpeechEngine, plus the existing
// onDismissConsent callback) for the osspeech branch, and simply
// advancing to the existing, completely-unchanged ConsentScreen for the
// whisper branch. The only local state this file owns is the card
// selection itself (mirrors ConsentScreen's own `model` picker state).
//
// Miana-veto #1 (accepted, flagged for her final call): 系统识别 is
// pre-selected by default — kills the ~1.5GB + Python venv first-run
// wall for the common case; Whisper 更高质量 stays one click away for
// anyone who wants speaker diarization or stronger mixed-language
// accuracy.

import { useState } from "react";
import { WizardFrame } from "./DesktopWizard";

type EngineChoice = "osspeech" | "whisper";

export interface EngineChoiceScreenProps {
  /** Fires once the user has 系统识别 selected and hits 继续. The caller
   *  is responsible for persisting the choice, firing the background
   *  preinstall, and dismissing the wizard — this component only
   *  reports the choice itself. */
  onChooseOsSpeech: () => void;
  /** Fires once the user has Whisper selected and hits 继续 — the caller
   *  advances to the existing ConsentScreen, completely unchanged. */
  onChooseWhisper: () => void;
}

const CARDS: { value: EngineChoice; title: string; points: string[] }[] = [
  {
    value: "osspeech",
    title: "系统识别 · 开箱即用",
    points: ["无需配置", "无需下载", "macOS 原生识别", "音频不离开本机"],
  },
  {
    value: "whisper",
    // v0.4.4 field-fix (finding 1 — real user report: "parakeet under
    // whisper is confusing... should have more clear explanation that
    // these are 本地大模型"): this card is the gateway into
    // ConsentScreen's own <ModelPicker>, where Whisper's several sizes
    // AND Parakeet both live side by side — framing it as "本地大模型"
    // up front (rather than a bare "Whisper") tells the user everything
    // listed there, including parakeet, is one local-large-model family
    // running on-device, not a separate/unrelated thing.
    title: "本地大模型 · 更高质量",
    points: ["Whisper、Parakeet 等本地大模型", "支持说话人分离", "多语混合更强", "需下载模型（约 0.5GB 起）"],
  },
];

export default function EngineChoiceScreen({ onChooseOsSpeech, onChooseWhisper }: EngineChoiceScreenProps) {
  // Miana-veto #1: pre-selected to osspeech (product recommendation) —
  // see this file's own header comment.
  const [selected, setSelected] = useState<EngineChoice>("osspeech");

  return (
    <WizardFrame>
      <div data-testid="engine-choice-screen" className="space-y-4">
        <div className="text-base font-medium text-fg">选择转录引擎</div>
        <p className="text-sm leading-[1.8] text-mut">
          两种方式都在本机处理，音频不会离开本机；之后随时能在 设置 → 转录引擎 里切换。
        </p>

        <div className="grid grid-cols-2 gap-2">
          {CARDS.map((card) => (
            <button
              key={card.value}
              type="button"
              data-testid={`engine-choice-card-${card.value}`}
              onClick={() => setSelected(card.value)}
              aria-pressed={selected === card.value}
              className={`border p-3 text-left text-sm transition-colors ${
                selected === card.value ? "border-act bg-panel3 text-fg" : "border-edge text-fg hover:bg-panel3"
              }`}
            >
              <div className="font-medium">{card.title}</div>
              <ul className="mt-2 space-y-1 text-xs leading-[1.7] text-mut">
                {card.points.map((point) => (
                  <li key={point}>· {point}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            data-testid="btn-engine-choice-continue"
            onClick={() => (selected === "osspeech" ? onChooseOsSpeech() : onChooseWhisper())}
            className="btn-terminal rounded-none bg-act px-4 py-2 text-sm font-semibold text-ink hover:bg-act/85"
          >
            继续
          </button>
        </div>
      </div>
    </WizardFrame>
  );
}
