// Per-task provider/model inheritance resolver (#56, BYOK-only). Pure
// function, single source of truth for how a per-domain TaskLlmConfig
// override folds over the primary (top-level) credential fields. Every
// client call site that used to build headers/model straight off
// `settings` now goes through this first — see client.ts's
// taskHeaders (Q3) for the header-building half of this design.
//
// Subscription-direct interplay: NONE, by design — this resolver (and
// taskHeaders) only ever feeds the Next.js path (detectViaNext/
// defineViaNext/translateApi/summarizeApi). agentDetect/agentDefine
// keep reading settings.subscriptionProvider directly and never
// consult taskLlm.
import type { LlmProvider, LlmTaskDomain, Settings } from "../types";

export interface ResolvedTaskCreds {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  // "" for translate-when-inherited (today's server-default behavior —
  // translate has no user-facing top-level model field, see
  // DEFAULT_SETTINGS's own comment on detectModel/summaryModel).
  model: string;
}

/** Resolve a task domain's effective credentials + model, folding an
 *  optional per-domain override over the primary Settings fields.
 *  Absent/disabled override (the default for every pre-#56 user) is
 *  byte-identical to reading `settings` directly, for every domain. */
export function resolveTaskCreds(settings: Settings, domain: LlmTaskDomain): ResolvedTaskCreds {
  const primaryModel =
    domain === "summary"
      ? settings.summaryModel
      : domain === "detect"
        ? settings.detectModel
        : ""; // translate has no legacy top-level model — inherited = server default

  const t = settings.taskLlm?.[domain];
  if (!t?.enabled) {
    return {
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: primaryModel,
    };
  }
  return {
    provider: t.provider ?? settings.provider,
    baseUrl: t.baseUrl ?? settings.baseUrl,
    // Blank per-domain key inherits the primary key (design Q5's
    // placeholder: 「留空则用主配置的 Key」) — `||`, not `??`, because an
    // explicitly-typed empty string in the domain's own Key field is
    // indistinguishable from "never set" and must fall through, same
    // as every other blank-string Settings field in this codebase
    // (e.g. apiKey/baseUrl's own "" = unset convention).
    apiKey: t.apiKey || settings.apiKey,
    model: t.model ?? primaryModel,
  };
}
