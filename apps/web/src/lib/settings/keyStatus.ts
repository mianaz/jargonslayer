// S14: per-credential status chips for SettingsDialog/CredentialFields
// (未配置/已配置/正常/异常, rendered next to the primary LLM key, each
// enabled taskLlm override, hfToken, and sonioxKey). Pure derivation
// only — no React, no live store reads — the component reads whatever
// evidence it already has (useLlmTelemetry, a 测试连接 result,
// sidecarStatus.diarize, …) and passes the relevant slice in, mirroring
// AiStatusPanel.tsx's own deriveHealthStatus (a sibling pure function
// over telemetry.ts's shape) but one level up: THAT function judges a
// telemetry DOMAIN's health, this one judges one CREDENTIAL VALUE's
// health, which may draw on several domains at once (the primary key
// backs whichever domains aren't overridden) or no telemetry at all
// (sonioxKey has no probe; hfToken's only signal is the diarization
// probe's boolean readiness, not an LLM call).
//
// ponytail: evidence isn't keyed to the exact credential VALUE that
// produced it (telemetry/testConnection/sidecarStatus only ever record
// "the last outcome for this domain/probe", not which key string was
// live at the time). FINDING 5 (2026-07-19) closes the one concrete
// case this bit anyone in practice — a chip now only SHOWS that
// evidence while the draft's resolved credential still equals the
// SAVED settings' resolved credential (credsMatch below), so editing
// away from a tested/saved key immediately caps its chip at 已配置
// instead of keeping the old key's 正常/异常. What's still NOT tracked:
// evidence keyed to the exact key STRING across a save/reload cycle
// (e.g. type key A, save, test, retype the ORIGINAL key A again later
// the same session — the stale evidence reads as valid again, since
// A still equals A). Upgrade path: stamp evidence with a hash of the
// tested value if that residual proves confusing in practice; not
// worth it until then.
import type { LlmDomainStat, LlmTelemetryDomain } from "@/lib/llm/telemetry";
import type { LlmProvider, LlmTaskDomain, Settings } from "@jargonslayer/core/types";

export type KeyStatus = "unconfigured" | "configured" | "active" | "error";

export const KEY_STATUS_LABEL: Record<KeyStatus, string> = {
  unconfigured: "未配置",
  configured: "已配置",
  active: "正常",
  error: "异常",
};

/** Evidence already gathered for ONE credential this session. A success
 *  always wins over a failure — a key that has demonstrably worked once
 *  this session is valid, even if a later/unrelated call (a different
 *  domain, a different rate limit) failed against it. */
export interface KeyStatusEvidence {
  hasSuccess?: boolean;
  hasFailure?: boolean;
}

/** value: the raw credential string (Settings.apiKey/.hfToken/
 *  .sonioxKey/TaskLlmConfig.apiKey). "" is always unconfigured
 *  regardless of evidence — stale evidence from a key the user just
 *  cleared must never read as configured/active. */
export function deriveKeyStatus(value: string, evidence?: KeyStatusEvidence): KeyStatus {
  if (!value) return "unconfigured";
  if (evidence?.hasSuccess) return "active";
  if (evidence?.hasFailure) return "error";
  return "configured";
}

/** Folds one or more telemetry.ts LlmDomainStat entries (already
 *  attributed to a single credential — see primaryTelemetryDomains/
 *  TASK_DOMAIN_TELEMETRY below) plus an optional 测试连接 result into
 *  KeyStatusEvidence.
 *
 *  Two nuances, both mirroring existing, already-shipped policy rather
 *  than inventing a new one:
 *   - lastErrorKind:"nokey" is excluded from hasFailure, same carve-out
 *     AiStatusPanel.tsx's deriveHealthStatus already applies (a nokey
 *     failure is often the subscription-direct dictionary-fallback
 *     signal, not evidence this KEY is bad — see that function's own
 *     doc comment).
 *   - testConnectionOk:true can UPGRADE to hasSuccess even when every
 *     attributed stat's own lastStatus is "fail": client.ts's
 *     testConnection() treats a caught RateLimitApiError as "key is
 *     fine, just throttled" (ok:true), but withTelemetry records that
 *     same thrown error as a plain ratelimit FAILURE before
 *     testConnection gets to re-interpret it — this is what lets the
 *     chip agree with testConnection's smarter reading instead of the
 *     raw telemetry outcome. testConnectionOk:false does NOT force
 *     hasFailure — a stale success from earlier this session still
 *     stands, same any-success-wins rule as the stats themselves. */
export function llmKeyEvidence(
  stats: LlmDomainStat[],
  testConnectionOk?: boolean,
): KeyStatusEvidence {
  return {
    hasSuccess: testConnectionOk === true || stats.some((s) => s.lastStatus === "ok"),
    hasFailure: stats.some((s) => s.lastStatus === "fail" && s.lastErrorKind !== "nokey"),
  };
}

/** The three fields telemetry/testConnection evidence is actually
 *  ABOUT — the exact shape resolveTaskCreds (taskConfig.ts) returns
 *  minus `model` (a chip's health has nothing to do with which model
 *  string rides alongside the credential), and the exact shape the
 *  primary Settings fields form directly for the non-taskLlm primary
 *  chip. */
export interface CredsTriple {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
}

/** FINDING 5 (2026-07-19, S14 review round): true when two credential
 *  triples are identical. Evidence-validity rule this backs — a chip
 *  may only be handed telemetry/testConnection evidence when the
 *  DRAFT's currently-resolved credential for that chip equals the
 *  SAVED settings' resolved credential (SettingsDialog.tsx applies
 *  this at every deriveKeyStatus call site): telemetry/testConnection
 *  can only ever describe calls made against what's saved/used, never
 *  an unsaved edit sitting in the draft — so the instant the draft
 *  diverges (test key A, paste key B), evidence must stop describing
 *  it and the chip caps at 已配置 until it's re-verified. */
export function credsMatch(a: CredsTriple, b: CredsTriple): boolean {
  return a.provider === b.provider && a.baseUrl === b.baseUrl && a.apiKey === b.apiKey;
}

/** True when `domain` currently resolves to its OWN taskLlm override
 *  key rather than inheriting the primary Settings.apiKey — mirrors
 *  taskConfig.ts's resolveTaskCreds exactly (`t.apiKey || settings.
 *  apiKey`): enabled:true with a BLANK per-domain key still inherits
 *  the primary credential, so its telemetry must attribute to the
 *  primary chip, not a chip of its own. */
export function domainUsesOwnKey(settings: Settings, domain: LlmTaskDomain): boolean {
  const t = settings.taskLlm?.[domain];
  return !!(t?.enabled && t.apiKey);
}

// Which telemetry.ts buckets a taskLlm domain's credential backs.
// "detect" covers "define" too — LlmTaskDomain deliberately has no
// separate "define" entry (define always rides detect's resolved
// creds, see types.ts's own comment and TASK_DOMAIN_META's identical
// hint text in SettingsDialog.tsx). Mirrors AiStatusPanel.tsx's
// AI_STATUS_ROWS domain/telemetryDomain pairing (not imported from
// there — a lib/ leaf importing a components/ file would invert this
// module's own position).
export const TASK_DOMAIN_TELEMETRY: Record<LlmTaskDomain, LlmTelemetryDomain[]> = {
  detect: ["detect", "define"],
  translate: ["translate"],
  summary: ["summary"],
};

/** Every telemetry bucket that currently attributes to the PRIMARY
 *  credential — every taskLlm domain that does NOT have its own
 *  enabled+keyed override right now (domainUsesOwnKey). The primary
 *  key's own chip evidence is llmKeyEvidence() over exactly these
 *  buckets. */
export function primaryTelemetryDomains(settings: Settings): LlmTelemetryDomain[] {
  return (Object.keys(TASK_DOMAIN_TELEMETRY) as LlmTaskDomain[])
    .filter((d) => !domainUsesOwnKey(settings, d))
    .flatMap((d) => TASK_DOMAIN_TELEMETRY[d]);
}
