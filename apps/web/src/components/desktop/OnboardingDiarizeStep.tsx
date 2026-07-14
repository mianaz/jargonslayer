"use client";

// S10 field-fix (docs/design-explorations/s10-fieldfix-blueprint.md,
// item #3 / Chunk C) — first-run onboarding step 2/2, mounted by
// DesktopWizard.tsx's DesktopOnboardingSteps. Optional: 说话人分离
// (pyannote) needs a Hugging Face token with two models' terms
// accepted; skipping leaves Settings untouched (see this file's own
// sibling OnboardingByokStep.tsx for the shared conventions this step
// follows — direct useApp access, not a callback-prop bootstrap
// dependency).
//
// 跳过 is styled with the SAME bg-act weight DesktopWizard's own
// primary actions use (e.g. ConsentScreen's 开始安装) — a deliberate
// INVERSION of that screen's own primary/secondary weighting: this
// step's "prominent, zero-friction default" is explicitly skip (per
// the blueprint), not the token entry, so skip gets the accent
// treatment and 保存并继续 stays a plain secondary button.
//
// Every external link here goes through openExternal (S10 Chunk A),
// never a plain <a target="_blank"> — this component only ever mounts
// on desktop (DesktopWizard.tsx), where external nav dies inside the
// Tauri WKWebView (see the blueprint's item #2 triage).

import { useState } from "react";
import { useApp } from "@/lib/store";
import { openExternal } from "@/lib/platform/openExternal";
import { buildHfTokenPatch } from "./onboardingSettings";

export interface OnboardingDiarizeStepProps {
  /** Fires after either a token save or an explicit skip. */
  onNext: () => void;
}

function ExternalLink({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => void openExternal(url)}
      className="btn-tactile text-lab-cyan underline decoration-lab-cyan/40"
    >
      {children}
    </button>
  );
}

export default function OnboardingDiarizeStep({ onNext }: OnboardingDiarizeStepProps) {
  const updateSettings = useApp((s) => s.updateSettings);
  const [token, setToken] = useState("");

  const saveToken = () => {
    const patch = buildHfTokenPatch(token);
    if (!patch) return;
    updateSettings(patch);
    onNext();
  };

  return (
    <div data-testid="onboarding-diarize-step" className="space-y-4">
      <div className="text-base font-medium text-fg">说话人分离（可选）</div>
      <p className="text-sm leading-[1.8] text-mut">
        说话人分离能在转录里自动标出是谁在说话，完全可选，不开也不影响转录本身。要开的话需要一个 Hugging Face token，并提前接受 pyannote
        两个模型的使用条款，不接受会在识别时报 403。
      </p>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs" data-testid="onboarding-diarize-links">
        <ExternalLink url="https://huggingface.co/settings/tokens">创建 HF token</ExternalLink>
        <ExternalLink url="https://huggingface.co/pyannote/segmentation-3.0">接受 segmentation-3.0 条款</ExternalLink>
        <ExternalLink url="https://huggingface.co/pyannote/speaker-diarization-3.1">接受 speaker-diarization-3.1 条款</ExternalLink>
      </div>

      <div>
        <input
          type="password"
          data-testid="input-onboarding-hf-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="hf_…"
          className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
        />
        <div className="mt-1 text-xs text-mut2">仅存本机，随任务经 localhost 传给 sidecar，不经任何云端</div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          data-testid="btn-onboarding-diarize-skip"
          onClick={onNext}
          className="btn-terminal rounded-none bg-act px-4 py-2 text-sm font-semibold text-ink hover:bg-act/85"
        >
          跳过
        </button>
        <button
          type="button"
          data-testid="btn-onboarding-save-token"
          disabled={!token.trim()}
          onClick={saveToken}
          className="btn-tactile border border-edge px-4 py-2 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-50"
        >
          保存并继续
        </button>
      </div>
      <div className="text-xs leading-[1.7] text-mut2">可以稍后在 设置 → 转录引擎 中随时开启</div>
    </div>
  );
}
