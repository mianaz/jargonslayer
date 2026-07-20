"use client";

// v0.4.5 ambient AI-status surface (docs/design-explorations/
// v045-ai-transparency-qc.md, Part A) — the concrete answer to the
// owner's "how many agents?" ask: FOUR task-domain rows (解释 is its
// OWN row per her ruling, not folded into 检测 — that split is exactly
// what makes "how many agents" a literal, honest answer). Presentational,
// reused by two hosts that mount it on demand: StatusLine's popover
// (ambient chip, see that file's AiStatusChip) and SettingsDialog's AI
// 检测 section (config-moment mirror, right after 测试连接) — neither
// host is imported here, keeping this a leaf component.
//
// Resolved provider/model is a SNAPSHOT taken once when a host mounts
// this (useState initializer, not a live `useApp` selector) — an
// in-flight Settings-dialog draft edit shouldn't make the OTHER host's
// popover flicker mid-keystroke, and "what's configured right now" is
// all either host needs. Telemetry (calls/failures/qcDropped/lastStatus)
// is the opposite: read LIVE via useLlmTelemetry, since a live per-
// session readout is the entire point of this surface.
import { useState } from "react";
import { useApp } from "@/lib/store";
import {
  useLlmTelemetry,
  type LlmDomainStat,
  type LlmTelemetryDomain,
  type LlmTelemetryErrorKind,
} from "@/lib/llm/telemetry";
import { resolveTaskCreds, type ResolvedTaskCreds } from "@/lib/llm/taskConfig";
import { PREVIEW_TIER } from "@/lib/deployTier";
import type { LlmTaskDomain, Settings } from "@jargonslayer/core/types";

interface AiStatusRowMeta {
  telemetryDomain: LlmTelemetryDomain;
  resolverDomain: LlmTaskDomain;
  label: string;
  footnote?: string;
}

// Row order/labels/footnotes straight from the design doc's table
// (Part A) — 解释 rides 检测's resolver domain but keeps its OWN
// telemetry bucket, 报告 rides "summary" (its 3 internal sub-calls all
// land in the one "summary" bucket, hence the footnote instead of a
// 5th row).
export const AI_STATUS_ROWS: AiStatusRowMeta[] = [
  { telemetryDomain: "detect", resolverDomain: "detect", label: "检测" },
  { telemetryDomain: "define", resolverDomain: "detect", label: "解释", footnote: "与检测共用配置" },
  { telemetryDomain: "translate", resolverDomain: "translate", label: "翻译" },
  {
    telemetryDomain: "summary",
    resolverDomain: "summary",
    label: "报告",
    footnote: "内部分 3 步：摘要 / 翻译 / 补充扫描",
  },
];

export const AI_STATUS_ERROR_KIND_LABEL: Record<LlmTelemetryErrorKind, string> = {
  nokey: "无 Key",
  ratelimit: "限流",
  upstream: "请求失败",
};

/** S14.1 field fix (item 4): "上次失败：限流" alone told the owner
 *  WHICH of the 4 rows failed but not WHY in plain language — she
 *  could see the fail count tick up with no way to inspect it further.
 *  One short zh sentence per kind, appended after the existing short
 *  label (kept, not replaced — AI_STATUS_ERROR_KIND_LABEL is still the
 *  at-a-glance word). ratelimit is tier-aware, mirroring describeRouting
 *  above: on preview it's OUR OWN server-side proxy's budget limiter
 *  (PREVIEW_TIER, same const already imported here); on full/BYOK tier
 *  it's the user's OWN provider throttling their key — telling a BYOK
 *  user "体验版限流" would be flatly wrong. */
export function describeErrorKind(kind: LlmTelemetryErrorKind): string {
  switch (kind) {
    case "nokey":
      return "未配置 API Key，已回退到词典检测";
    case "ratelimit":
      return PREVIEW_TIER ? "请求过于频繁（体验版限流）" : "请求过于频繁，请检查该服务商的 API 额度";
    case "upstream":
      return "上游服务请求失败，请稍后重试";
  }
}

export const AI_STATUS_ZERO_CONFIG_BANNER = {
  preview: "由服务端代理，无需填写 Key",
  keyless: "未配置 API Key：检测将回退至词典检测，翻译 / 报告不可用",
} as const;

export type AiHealthStatus = "ok" | "fail" | "neutral";

export const AI_STATUS_HEALTH_DOT_CLASS: Record<AiHealthStatus, string> = {
  ok: "bg-lab-green",
  fail: "bg-lab-orange",
  neutral: "bg-mut2",
};

/** Collapses a domain's telemetry into the 3-state coloring the dot (and
 *  StatusLine's chip glyph) actually renders. "fail" only for a REAL
 *  error (ratelimit/upstream) — client.ts's NoKeyError path DOES call
 *  recordLlmCall(domain, {kind:"nokey"}) (verified in client.ts), so a
 *  keyless full/desktop row genuinely has lastStatus:"fail" here; this
 *  function is what keeps that grey instead of amber. A keyless row is
 *  a designed dictionary degrade, not a fault — only ratelimit/upstream
 *  outrank the neutral grey (owner ruling, design doc Part A). */
export function deriveHealthStatus(stat: LlmDomainStat): AiHealthStatus {
  if (stat.lastStatus === "ok") return "ok";
  if (stat.lastStatus === "fail" && stat.lastErrorKind !== "nokey") return "fail";
  return "neutral";
}

/** Dot tooltip — unlike deriveHealthStatus's 3-state color, this stays
 *  accurate about WHICH neutral case it is (never called vs. a real but
 *  suppressed nokey failure) rather than collapsing both to one string. */
function healthDotTitle(stat: LlmDomainStat): string {
  if (stat.lastStatus === "ok") return "正常";
  if (stat.lastStatus === "fail") {
    return stat.lastErrorKind === "nokey" ? "未配置 Key（词典检测兜底）" : "失败";
  }
  return "尚未调用";
}

/** apiKey present -> 自带 Key; empty + preview -> 服务端代理; empty +
 *  full/desktop -> 未配置 Key. 订阅直连 gets no label of its own here
 *  (design doc's "skip if it adds complexity" escape hatch) — its own
 *  path (agentDetect/agentDefine + settings.subscriptionProvider) never
 *  runs through resolveTaskCreds (see that resolver's own module doc),
 *  so this panel has no signal to distinguish it from "未配置 Key"
 *  without wiring a second read this pass didn't ask for. */
export function describeRouting(apiKey: string): string {
  if (apiKey) return "自带 Key";
  return PREVIEW_TIER ? "服务端代理（体验版）" : "未配置 Key";
}

/** Mirrors SettingsDialog.tsx's own local providerLabel() — not
 *  imported from there (that would invert the dependency: SettingsDialog
 *  mounts THIS component, not the reverse). */
function describeProvider(resolved: ResolvedTaskCreds): string {
  return resolved.provider === "anthropic" ? "Anthropic" : resolved.baseUrl || "自定义端点";
}

export default function AiStatusPanel() {
  const [settings] = useState<Settings>(() => useApp.getState().settings);
  const telemetry = useLlmTelemetry();

  // F6 (Sol+Opus review, MINOR): gating on settings.apiKey (primary)
  // alone missed a user who left the primary key empty but set a
  // per-task override via taskLlm — that row correctly shows 自带 Key
  // below, while this banner wrongly claimed translation/report were
  // unavailable. Derive from the RESOLVED credentials across every row
  // instead (same resolveTaskCreds each row already calls) — only
  // banner when NO row actually resolves to a key.
  const zeroConfig = !AI_STATUS_ROWS.some((row) => resolveTaskCreds(settings, row.resolverDomain).apiKey);

  return (
    <div data-testid="ai-status-panel" className="space-y-2 font-mono text-xs">
      {zeroConfig && (
        <div
          data-testid="ai-status-zero-config-banner"
          className="border border-edge bg-panel2 p-2 leading-[1.6] text-mut2"
        >
          {PREVIEW_TIER ? AI_STATUS_ZERO_CONFIG_BANNER.preview : AI_STATUS_ZERO_CONFIG_BANNER.keyless}
        </div>
      )}
      {AI_STATUS_ROWS.map((row) => {
        const resolved = resolveTaskCreds(settings, row.resolverDomain);
        const stat = telemetry[row.telemetryDomain];
        const health = deriveHealthStatus(stat);
        return (
          <div
            key={row.telemetryDomain}
            data-testid={`ai-status-row-${row.telemetryDomain}`}
            className="border border-edge bg-panel2 p-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span
                  data-testid={`ai-status-dot-${row.telemetryDomain}`}
                  title={healthDotTitle(stat)}
                  className={`h-2 w-2 rounded-full ${AI_STATUS_HEALTH_DOT_CLASS[health]}`}
                />
                <span className="text-fg">{row.label}</span>
              </div>
              <span className="text-mut2">{describeRouting(resolved.apiKey)}</span>
            </div>
            <div className="mt-1 text-mut2">
              {describeProvider(resolved)} · {resolved.model || "服务端默认"}
            </div>
            {row.footnote && <div className="mt-0.5 text-mut2">{row.footnote}</div>}
            <div className="mt-1 flex gap-3 tabular-nums text-mut2">
              <span>调用 {stat.calls}</span>
              <span>失败 {stat.failures}</span>
              <span>QC 丢弃 {stat.qcDropped}</span>
            </div>
            {stat.lastStatus === "fail" && stat.lastErrorKind && (
              <div
                data-testid={`ai-status-error-${row.telemetryDomain}`}
                className="mt-0.5 text-warn-soft"
              >
                上次失败：{AI_STATUS_ERROR_KIND_LABEL[stat.lastErrorKind]} ——{" "}
                {describeErrorKind(stat.lastErrorKind)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
