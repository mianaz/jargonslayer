"use client";

// S10 field-fix (docs/design-explorations/s10-fieldfix-blueprint.md,
// item #3 / Chunk C) — first-run onboarding step 1/2, mounted by
// DesktopWizard.tsx's DesktopOnboardingSteps (see that export's own
// header comment for the full mount/timing contract). Optional: 翻译/
// 解释 needs an OpenRouter key, but skipping leaves Settings untouched
// and the app still works (cloud detect/BYOK-less features included).
//
// Primary path = paste an existing key, writing the EXACT settings
// shape the web OAuth callback writes (app/oauth/openrouter/page.tsx
// ~lines 83-87: provider/baseUrl/apiKey) — so a pasted key and an
// OAuth-issued key land identically regardless of which path was used.
// Secondary path = one-click OAuth via worker A's
// connectOpenRouterDesktop() (RFC-8252 loopback flow, S10 Chunk A);
// that helper performs the settings write itself on success (pinned
// contract), so this component only reacts to ok/not-ok.
//
// Unlike DesktopWizard's provisioning screens (ConsentScreen etc,
// purely presentational — every action a callback prop from the
// bootstrap handle), this step reads/writes global Settings directly
// via useApp, matching SettingsDialog.tsx's own convention for the
// same store slice — there is no bootstrap-handle concern here at all.

import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/store";
import { cancelOpenRouterConnect, connectOpenRouterDesktop } from "@/lib/oauth/openrouterDesktop";
import { openExternal } from "@/lib/platform/openExternal";
import { buildByokKeyPatch, describeOAuthFailure } from "./onboardingSettings";

export interface OnboardingByokStepProps {
  /** Fires after EITHER a successful save (paste or OAuth) or an
   *  explicit skip — this step decides for itself whether Settings
   *  were actually touched; the caller only needs "advance". */
  onNext: () => void;
}

export default function OnboardingByokStep({ onNext }: OnboardingByokStepProps) {
  const updateSettings = useApp((s) => s.updateSettings);
  const settings = useApp((s) => s.settings);
  const [key, setKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [oauthHint, setOauthHint] = useState<string | null>(null);

  // Guards against a stale OAuth resolution firing onNext() a second
  // time after the user already advanced past this step some other way
  // (跳过, or a paste-and-save while the OAuth attempt was still in
  // flight) — connectOpenRouterDesktop's own JS timeout is ~180s, far
  // longer than a user is expected to wait here, so skip/paste must
  // stay available (and effective) the whole time, not gated on it.
  const cancelledRef = useRef(false);
  // F4 (HIGH, adversarial review): cancelledRef above only stops THIS
  // component reacting to a stale resolution — it does nothing to stop
  // connectOpenRouterDesktop's own promise from running to completion
  // (and writing settings) after the user has already moved on.
  // cancelOpenRouterConnect (F3's export) tells the underlying attempt
  // itself to stop, so it settles ok:false/"cancelled" instead —
  // called on unmount and at the top of every other exit from this
  // step (paste-save, skip), a harmless no-op if nothing is in flight.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      cancelOpenRouterConnect();
    };
  }, []);

  const savePastedKey = () => {
    cancelOpenRouterConnect();
    const patch = buildByokKeyPatch(key, settings);
    if (!patch) return;
    updateSettings(patch);
    onNext();
  };

  const skip = () => {
    cancelOpenRouterConnect();
    onNext();
  };

  const connectWithOAuth = async () => {
    setConnecting(true);
    setOauthHint(null);
    try {
      const result = await connectOpenRouterDesktop();
      if (cancelledRef.current) return;
      if (result.ok) {
        onNext();
        return;
      }
      setOauthHint(describeOAuthFailure(result.reason, result.message));
    } finally {
      if (!cancelledRef.current) setConnecting(false);
    }
  };

  return (
    <div data-testid="onboarding-byok-step" className="space-y-4">
      <div className="text-base font-medium text-fg">连接 OpenRouter（可选）</div>
      <p className="text-sm leading-[1.8] text-mut">
        实时解释和翻译需要连接一个大模型。用 OpenRouter 账号登录能自动拿到 Key；已经有 Key 的话也可以直接粘贴。这一步随时能跳过，之后在
        设置 中配置一样生效。
      </p>

      <button
        type="button"
        data-testid="btn-onboarding-oauth"
        disabled={connecting}
        onClick={() => void connectWithOAuth()}
        className="btn-tactile w-full border border-edge px-3 py-2 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {connecting ? "连接中…" : "使用 OpenRouter 登录"}
      </button>

      {oauthHint && (
        <div data-testid="onboarding-oauth-hint" className="space-y-1.5 border border-warn-soft/40 bg-panel2 p-2.5 text-xs leading-[1.7] text-warn-soft">
          <div>{oauthHint}</div>
          <button
            type="button"
            data-testid="btn-onboarding-openrouter-keys"
            onClick={() => void openExternal("https://openrouter.ai/keys")}
            className="btn-tactile text-lab-cyan underline decoration-lab-cyan/40"
          >
            前往 openrouter.ai/keys 创建 Key
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-mut2" aria-hidden="true">
        <span className="h-px flex-1 bg-edge" />
        或
        <span className="h-px flex-1 bg-edge" />
      </div>

      <div className="flex items-center gap-2">
        <input
          type="password"
          data-testid="input-onboarding-byok-key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-or-…"
          className="w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
        />
        <button
          type="button"
          data-testid="btn-onboarding-save-key"
          disabled={!key.trim()}
          onClick={savePastedKey}
          className="btn-tactile shrink-0 border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-50"
        >
          保存并继续
        </button>
      </div>

      <div className="flex justify-end pt-1">
        <button
          type="button"
          data-testid="btn-onboarding-byok-skip"
          onClick={skip}
          className="btn-tactile px-3 py-1.5 text-sm text-mut hover:bg-panel3 hover:text-fg"
        >
          跳过
        </button>
      </div>
    </div>
  );
}
