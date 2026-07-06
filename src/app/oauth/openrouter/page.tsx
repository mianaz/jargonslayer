"use client";

// OAuth PKCE callback for "Connect with OpenRouter" (see
// SettingsDialog.tsx's connect button + lib/oauth/openrouterPkce.ts).
// OpenRouter redirects here with ?code=... after the user approves the
// connection on openrouter.ai/auth; this page recovers the PKCE
// code_verifier stashed in sessionStorage before the redirect,
// exchanges the code for a user-controlled API key, and writes it into
// Settings. Can land here directly (new tab from the OAuth redirect),
// so it hydrates the store itself, same as /review.

import { useEffect, useState } from "react";
import { useApp } from "@/lib/store";
import { withBase } from "@/lib/basePath";
import {
  exchangeCodeForKey,
  OAUTH_STATE_STORAGE_KEY,
  OAUTH_VERIFIER_STORAGE_KEY,
} from "@/lib/oauth/openrouterPkce";

type Phase = "exchanging" | "success" | "error";

export default function OpenRouterOAuthCallbackPage() {
  const hydrated = useApp((s) => s.hydrated);
  const hydrate = useApp((s) => s.hydrate);
  const updateSettings = useApp((s) => s.updateSettings);

  const [phase, setPhase] = useState<Phase>("exchanging");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  useEffect(() => {
    if (!hydrated) return;

    const run = async () => {
      const params = new URLSearchParams(window.location.search);
      const errorParam = params.get("error");
      const code = params.get("code");
      const returnedState = params.get("state");

      const codeVerifier = sessionStorage.getItem(OAUTH_VERIFIER_STORAGE_KEY);
      const expectedState = sessionStorage.getItem(OAUTH_STATE_STORAGE_KEY);
      // Clear immediately after reading — one-time use regardless of
      // outcome, so a retry always starts a fresh authorization round.
      sessionStorage.removeItem(OAUTH_VERIFIER_STORAGE_KEY);
      sessionStorage.removeItem(OAUTH_STATE_STORAGE_KEY);

      if (errorParam) {
        setError(`OpenRouter 拒绝了授权请求：${errorParam}`);
        setPhase("error");
        return;
      }
      if (!code) {
        setError("回调地址中缺少 code 参数");
        setPhase("error");
        return;
      }
      if (!codeVerifier) {
        setError("未找到本次授权的 code_verifier，请重新发起连接");
        setPhase("error");
        return;
      }
      // OpenRouter's /auth doesn't document accepting/echoing a state
      // param (see SettingsDialog.tsx's handleConnectOpenRouter), so
      // returnedState is normally ABSENT — we must only enforce the
      // match when a state actually comes back, otherwise every real
      // callback (which carries no state) would falsely fail here. The
      // `returnedState &&` guard keeps this a genuine no-op today while
      // staying ready if a future OpenRouter starts echoing one. The
      // actual replay protection is PKCE itself: `code` alone is
      // useless to an attacker without this codeVerifier.
      if (expectedState && returnedState && returnedState !== expectedState) {
        setError("state 校验失败，请重新发起连接");
        setPhase("error");
        return;
      }

      try {
        const { key } = await exchangeCodeForKey({ code, codeVerifier });
        updateSettings({
          provider: "openai-compat",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: key,
        });
        setPhase("success");
      } catch (err) {
        setError(err instanceof Error ? err.message : "兑换 API Key 失败");
        setPhase("error");
      }
    };

    void run();
    // Only rerun when hydration finishes — window.location.search is
    // read once from the URL this page was loaded with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-[420px] max-w-full rounded-none border border-edge2 bg-panel p-6 text-center">
        {phase === "exchanging" && (
          <>
            <div className="text-sm text-mut">正在连接 OpenRouter…</div>
            <div className="mt-1 text-xs text-mut2">正在用授权码兑换 API Key</div>
          </>
        )}

        {phase === "success" && (
          <>
            <div className="text-sm font-medium text-fg">已成功连接 OpenRouter</div>
            <div className="mt-1 text-xs leading-[1.7] text-mut2">
              API Key 已保存到本地设置。OAuth 颁发的 Key 可能带有额度上限或有效期，建议登录
              OpenRouter 控制台确认。
            </div>
            <a
              href={withBase("/")}
              className="mt-4 inline-block rounded-sm border border-edge px-4 py-1.5 text-sm text-fg hover:bg-panel3"
            >
              返回首页
            </a>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="text-sm font-medium text-warn-soft">连接 OpenRouter 失败</div>
            <div className="mt-1 text-xs leading-[1.7] text-mut2">{error}</div>
            <a
              href={withBase("/")}
              className="mt-4 inline-block rounded-sm border border-edge px-4 py-1.5 text-sm text-fg hover:bg-panel3"
            >
              返回首页重试
            </a>
          </>
        )}
      </div>
    </div>
  );
}
