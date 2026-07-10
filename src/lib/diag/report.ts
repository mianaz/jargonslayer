// Diagnostic bundle a user can copy straight into a GitHub issue: app
// version + deploy tier + engine/settings summary (secrets stripped to
// presence booleans — mirrors history/autoExport.ts's stripKeyMaterial,
// same field list/reasoning) + browser UA + theme/uiMode + the last
// DIAG_REPORT_ENTRIES diag.ts ring-buffer entries.
//
// PRIVACY RULE: same hard rule as log.ts — this module trusts every
// diag entry it's handed was already scrubbed at its call site (no
// transcript/translation/summary/profile VALUES ever reach diagLog);
// its OWN scrubbing responsibility is Settings' key material only,
// enforced below by summarizeSettings (never spreads `settings`
// wholesale into the report — every field is named explicitly).

import pkg from "../../../package.json";
import { PREVIEW_TIER } from "../deployTier";
import type { Settings } from "../types";
import { type DiagEntry, getDiagEntries } from "./log";

export const DIAG_REPORT_ENTRIES = 50;

function hasSecret(v: string | undefined): boolean {
  return !!v;
}

/** Every Settings field that can hold BYOK key material collapses to
 *  a `has*` presence boolean — see autoExport.ts's stripKeyMaterial
 *  doc comment for the same field list (apiKey/hfToken/agentToken/
 *  webhookUrl, plus each taskLlm domain's own optional apiKey).
 *  Everything else here is either a non-secret setting or a boolean
 *  already, so it's safe to include as-is. */
function summarizeSettings(settings: Settings): Record<string, unknown> {
  const taskLlm = settings.taskLlm
    ? Object.fromEntries(
        Object.entries(settings.taskLlm).map(([domain, cfg]) => [
          domain,
          cfg
            ? { enabled: cfg.enabled, provider: cfg.provider, hasApiKey: hasSecret(cfg.apiKey) }
            : cfg,
        ]),
      )
    : undefined;

  return {
    engine: settings.engine,
    provider: settings.provider,
    hasApiKey: hasSecret(settings.apiKey),
    hasHfToken: hasSecret(settings.hfToken),
    hasAgentToken: hasSecret(settings.agentToken),
    hasWebhookUrl: hasSecret(settings.webhookUrl),
    autoDetect: settings.autoDetect,
    aiDetect: settings.aiDetect,
    bilingualTranscript: settings.bilingualTranscript,
    realtimeDiarize: settings.realtimeDiarize,
    subscriptionDirect: settings.subscriptionDirect,
    themeId: settings.themeId,
    uiMode: settings.uiMode,
    taskLlm,
  };
}

function formatEntry(e: DiagEntry): string {
  const time = new Date(e.ts).toISOString();
  const refPart = e.ref ? ` [${e.ref}]` : "";
  const detailPart = e.detail ? ` — ${e.detail}` : "";
  return `- ${time} [${e.level}] (${e.tag})${refPart} ${e.message}${detailPart}`;
}

/** Markdown-ish text — no server round-trip, built entirely from
 *  in-memory state (settings + the diag ring buffer) so it's safe to
 *  call from a toast action or the Settings dialog alike. */
export function buildDiagnosticReport(settings: Settings): string {
  const entries = getDiagEntries().slice(-DIAG_REPORT_ENTRIES);
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "(no navigator)";

  const lines = [
    "# JargonSlayer 诊断信息",
    "",
    `版本: ${pkg.version}`,
    `部署层级: ${PREVIEW_TIER ? "preview" : "full"}`,
    `浏览器: ${ua}`,
    `主题: ${settings.themeId} · 界面模式: ${settings.uiMode}`,
    "",
    "## 设置摘要（已脱敏，不含任何 Key/Token 明文）",
    "```json",
    JSON.stringify(summarizeSettings(settings), null, 2),
    "```",
    "",
    `## 最近 ${entries.length} 条诊断记录`,
    ...(entries.length > 0 ? entries.map(formatEntry) : ["（暂无记录）"]),
  ];

  return lines.join("\n");
}

/** Clipboard write for the 复制诊断/复制诊断信息 actions (Toast.tsx,
 *  SettingsDialog.tsx) — one place for the writeText + failure
 *  handling so both callers behave identically. Returns false (never
 *  throws) when the Clipboard API is unavailable or permission was
 *  denied; the caller shows its own success/failure toast. */
export async function copyDiagnosticReport(settings: Settings): Promise<boolean> {
  const text = buildDiagnosticReport(settings);
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permission denied / unsupported browser — caller surfaces failure
  }
  return false;
}
