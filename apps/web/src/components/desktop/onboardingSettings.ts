// S10 field-fix (docs/design-explorations/s10-fieldfix-blueprint.md,
// item #3 / Chunk C) — pure Settings-patch/copy helpers shared by
// OnboardingByokStep.tsx / OnboardingDiarizeStep.tsx, split out so
// they're unit-testable independent of those files' own
// connectOpenRouterDesktop/openExternal imports (S10 Chunk A, worker
// A) — mirrors this codebase's own store.ts/provisionMachine.ts
// precedent of keeping business logic as plain functions with the
// component/reducer shell thin around them.

import type { Settings } from "@jargonslayer/core/types";

/** Paste-key path (OnboardingByokStep primary path): the EXACT settings
 *  shape the web OAuth callback writes (app/oauth/openrouter/page.tsx
 *  ~lines 83-87) — same shape regardless of whether the key came from
 *  OAuth or was pasted by hand. `null` on an empty/whitespace-only
 *  input (caller must not write a blank key). */
export function buildByokKeyPatch(
  rawKey: string,
): Pick<Settings, "provider" | "baseUrl" | "apiKey"> | null {
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  return { provider: "openai-compat", baseUrl: "https://openrouter.ai/api/v1", apiKey: trimmed };
}

/** 说话人分离 token path (OnboardingDiarizeStep) — writes the existing
 *  hfToken settings field (see SettingsDialog.tsx's own hfToken input).
 *  `null` on an empty/whitespace-only input. */
export function buildHfTokenPatch(rawToken: string): Pick<Settings, "hfToken"> | null {
  const trimmed = rawToken.trim();
  if (!trimmed) return null;
  return { hfToken: trimmed };
}

/** connectOpenRouterDesktop()'s pinned failure `reason` union
 *  (lib/oauth/openrouterDesktop.ts, S10 Chunk A) — duplicated here as a
 *  plain Record key type rather than importing that module, so this
 *  file stays free of the not-yet-resolvable worker-A import chain. */
const OAUTH_FAILURE_LABEL: Record<string, string> = {
  timeout: "连接超时",
  cancelled: "已取消登录",
  "exchange-failed": "换取 Key 失败",
  "port-bind-failed": "本机端口被占用，无法启动登录",
};

/** One-line zh hint for a failed connectOpenRouterDesktop() attempt —
 *  points at the paste field; the openrouter.ai/keys link itself is
 *  rendered by the caller (OnboardingByokStep), not part of this
 *  string. An unrecognized reason still degrades to a generic label
 *  rather than throwing. */
export function describeOAuthFailure(reason: string, message?: string): string {
  const label = OAUTH_FAILURE_LABEL[reason] ?? "登录失败";
  return `${label}${message ? "：" + message : ""}，可以在下方粘贴已有的 API Key`;
}
