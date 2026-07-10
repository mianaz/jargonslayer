// Subscription-direct (v0.2.2, experimental, LOCAL DEV BUILD ONLY) —
// browser-side fetch helpers for sidecar/agent_server.py's /agent/*
// endpoints. This lets detect/define call Claude/ChatGPT via YOUR OWN
// local `claude`/`codex` CLI login, reached through a separate local
// sidecar process — never through any server this project runs. This
// is NOT "we connect your subscription for you"; it is "a tool
// running on your machine asks the CLI you already logged into,"
// exactly like running `claude -p` / `codex exec` yourself would. See
// sidecar/agent_server.py's module docstring for the full policy
// analysis this rests on.
//
// Three independent kill switches gate this entire feature (see each
// function below for where it's checked):
//   1. Settings.subscriptionDirect (default false) — the user's own
//      on/off switch, checked by callers (client.ts) before ever
//      calling anything in this file.
//   2. NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT (build-time flag) —
//      SUBSCRIPTION_DIRECT_BUILT below; unset in a build means this
//      whole section + call branch should not exist in that bundle.
//   3. A remote flags.json (checkRemoteKillSwitch) — an emergency
//      after-the-fact kill for already-shipped builds if official
//      policy tightens faster than a new release can go out. Fetch
//      failure/timeout/404 = ALLOWED (a broken/missing flags.json must
//      never brick a feature the user already has working — see the
//      design doc's kill-switch rationale).
//
// Mirrors src/lib/stt/upload.ts's httpBaseFromWs/fetchSidecarHealth
// probe pattern and src/lib/llm/client.ts's detectApi/defineApi error
// handling, so the rest of the app never has to learn a new shape.

import type { DefineRequest, DefineResult, DetectRequest, DetectResponse, Settings } from "../types";
import { renderProfileHint } from "../llm/profileHint";

export type SubscriptionProvider = "claude-sub" | "chatgpt-sub";

export interface AgentHealth {
  ok: boolean;
  claude_sdk_available: boolean;
  claude_logged_in: boolean | null;
  codex_available: boolean;
  codex_logged_in: boolean | null;
  warns: string[];
}

/** Errors thrown by agentDetect/agentDefine. Deliberately a SEPARATE
 *  hierarchy from llm/client.ts's NoKeyError/RateLimitApiError/
 *  UpstreamError (rather than reusing those classes) because client.
 *  ts's routing branch must tell "the sidecar rejected/couldn't
 *  complete this call" (-> dictionary fallback + a specific one-time
 *  toast, NEVER a silent fall-through to BYOK) apart from
 *  "the EXISTING Next.js path itself failed" (its own, already-
 *  existing NoKeyError/RateLimitApiError handling elsewhere in the
 *  app) — collapsing the two into the same classes would make them
 *  indistinguishable at the catch site. AgentUnreachableError is its
 *  own distinct case (see agentDetect/agentDefine's catch block):
 *  the sidecar HOST wasn't reachable at all (connection refused/DNS/
 *  network-level fetch failure, never got an HTTP response at all) —
 *  per the design doc this ALONE falls through silently to the
 *  existing Next.js path, never toasts, never forces dictionary mode. */
export class AgentUnreachableError extends Error {
  constructor(message = "无法连接订阅直连 sidecar") {
    super(message);
    this.name = "AgentUnreachableError";
  }
}

export class AgentNoKeyError extends Error {
  constructor(message = "未登录或凭据无效") {
    super(message);
    this.name = "AgentNoKeyError";
  }
}

export class AgentRateLimitError extends Error {
  constructor(message = "订阅额度暂不可用") {
    super(message);
    this.name = "AgentRateLimitError";
  }
}

export class AgentUpstreamError extends Error {
  constructor(message = "订阅直连请求失败") {
    super(message);
    this.name = "AgentUpstreamError";
  }
}

/** True only when this build was compiled with the feature flag set —
 *  kill-switch layer 2. RUNTIME correctness is unconditional: this
 *  const's own definition (right here) always resolves to a literal
 *  `false` when NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT is unset,
 *  verified by curl-ing a real running server built without the flag
 *  (agentDetect/agentHealth are never reached). BUILD-TIME bundle-text
 *  elimination at a given USAGE site is a separate, weaker guarantee
 *  that depends on webpack/Terser's cross-module inlining heuristics
 *  for a re-exported const — empirically (2026-07-06), a DIRECT inline
 *  `process.env.NEXT_PUBLIC_X === "1"` reference at the call site
 *  reliably eliminates the guarded code from `npm run build`'s output,
 *  while importing this const across a module boundary does not
 *  ALWAYS achieve that (see client.ts/store.ts's own usage — kept as
 *  this const for readability there since eliminating their non-JSX
 *  logic branches' TEXT is a nice-to-have, not the actual security-
 *  relevant guarantee). The one usage where full elimination matters
 *  most — SettingsDialog.tsx's user-visible JSX — reads
 *  process.env.NEXT_PUBLIC_X directly for exactly this reason, and
 *  that elimination is confirmed via `npm run build` bundle
 *  inspection (see task report). */
export const SUBSCRIPTION_DIRECT_BUILT =
  process.env.NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT === "1";

function agentBaseUrl(settings: Settings): string {
  return settings.agentUrl || "http://127.0.0.1:8767";
}

/** GET /agent/health: provider/login-state probe, no connection code
 *  required (see agent_server.py's health_origin_allowed — this
 *  endpoint leaks no credential and costs no subscription quota, so
 *  its gate is deliberately looser than /agent/detect|define's).
 *  3s timeout, mirrors fetchSidecarHealth's probe contract exactly:
 *  returns null on ANY failure (unreachable/timeout/bad response) so
 *  callers render a single "can't reach sidecar" state without
 *  try/catch plumbing — never throws. */
export async function agentHealth(settings: Settings): Promise<AgentHealth | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${agentBaseUrl(settings)}/agent/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as AgentHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

interface AgentErrorBody {
  error?: string;
  code?: "no_key" | "bad_request" | "upstream" | "rate_limit";
}

async function parseAgentErrorBody(res: Response): Promise<AgentErrorBody | undefined> {
  try {
    return (await res.json()) as AgentErrorBody;
  } catch {
    return undefined;
  }
}

/** Maps a non-2xx /agent/* response to the matching Agent*Error class
 *  — mirrors llm/client.ts's throwForStatus, but as its own error
 *  hierarchy (AgentNoKeyError/AgentRateLimitError/AgentUpstreamError)
 *  rather than reusing NoKeyError/RateLimitApiError/UpstreamError
 *  directly: client.ts's routing branch (see detectApi/defineApi)
 *  needs to distinguish "the sidecar itself rejected this call" (map
 *  to the required "订阅额度暂不可用，已回退至词典检测" toast + dictionary
 *  fallback, never silently to BYOK) from "the existing Next.js path
 *  failed" (its own, already-existing NoKeyError/RateLimitApiError
 *  handling) — reusing the same classes would make the two
 *  indistinguishable at the catch site. */
async function throwForAgentStatus(res: Response): Promise<never> {
  const body = await parseAgentErrorBody(res);
  if (res.status === 401 || res.status === 403) {
    throw new AgentNoKeyError(body?.error ?? "未登录或凭据无效");
  }
  if (res.status === 429) {
    throw new AgentRateLimitError(body?.error ?? "订阅额度暂不可用");
  }
  throw new AgentUpstreamError(body?.error ?? `订阅直连请求失败（${res.status}）`);
}

function agentHeaders(settings: Settings): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-JS-Agent-Token": settings.agentToken,
  };
}

/** POST /agent/detect — same DetectResponse shape as the existing
 *  /api/detect route (both run the same postFilter semantics; see
 *  sidecar/agent_postfilter.py). 20s timeout, matching detectApi's
 *  existing client-side budget exactly (this call competes for the
 *  SAME budget the user already expects detect to take). */
export async function agentDetect(
  body: DetectRequest,
  settings: Settings,
): Promise<DetectResponse> {
  let res: Response;
  try {
    res = await fetch(`${agentBaseUrl(settings)}/agent/detect`, {
      method: "POST",
      headers: agentHeaders(settings),
      body: JSON.stringify({
        provider: settings.subscriptionProvider,
        context: body.context,
        new_text: body.new_text,
        lang: settings.explainLanguage,
        // #48 s1 review item 7: with profile enabled, the Next.js path
        // (client.ts's detectViaNext) already splices this same
        // pre-rendered hint into the USER message — this branch must
        // not silently diverge from it. renderProfileHint returns
        // undefined when disabled/empty, which JSON.stringify simply
        // omits (matching the Next.js route's z.string().optional()).
        profile: renderProfileHint(settings.profile),
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    // Any network-level fetch() failure (connection refused because
    // the sidecar isn't running, DNS, or our own 20s abort timing
    // out) is treated as "host unreachable" — per the design doc this
    // falls through SILENTLY to the existing Next.js path (see
    // client.ts's catch(AgentUnreachableError) branch), never toasts,
    // never forces dictionary mode. A slow-but-running sidecar timing
    // out is rare enough that folding it into "unreachable" (same
    // silent behavior) is the safer default over guessing wrong and
    // scaring the user with an error the existing path would have
    // quietly avoided.
    throw new AgentUnreachableError("检测请求失败，请检查 sidecar 是否已启动");
  }

  if (!res.ok) {
    await throwForAgentStatus(res);
  }

  return (await res.json()) as DetectResponse;
}

/** POST /agent/define — same DefineResult shape as the existing
 *  /api/define route. 20s timeout, matching defineApi's existing
 *  client-side budget. */
export async function agentDefine(
  body: DefineRequest,
  settings: Settings,
): Promise<DefineResult> {
  let res: Response;
  try {
    res = await fetch(`${agentBaseUrl(settings)}/agent/define`, {
      method: "POST",
      headers: agentHeaders(settings),
      body: JSON.stringify({
        provider: settings.subscriptionProvider,
        phrase: body.phrase,
        context: body.context,
        lang: settings.explainLanguage,
        // Same AUDIENCE-hint threading as agentDetect above (#48 s1
        // review item 7).
        profile: renderProfileHint(settings.profile),
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    // Same "any network-level failure -> unreachable, silent
    // fall-through" contract as agentDetect above.
    throw new AgentUnreachableError("解释请求失败，请检查 sidecar 是否已启动");
  }

  if (!res.ok) {
    await throwForAgentStatus(res);
  }

  return (await res.json()) as DefineResult;
}

// ---------------------------------------------------------------
// Remote kill switch (layer 3) — an emergency after-the-fact hide for
// already-shipped builds. Points at a static JSON file this project
// controls, default co-located with the existing GitHub Pages landing
// page (the URL itself is configurable via
// NEXT_PUBLIC_SUBSCRIPTION_FLAGS_URL for self-hosted/fork deployments;
// the file at that URL is NOT authored by this task — see task
// report). A 404/network failure/timeout is treated as "allowed": a
// missing or broken flags.json must never brick a feature the user
// already has enabled locally, only an explicit
// {"subscriptionDirect": false} response actively disables it.
// ---------------------------------------------------------------

const DEFAULT_FLAGS_URL = "https://mianaz.github.io/jargonslayer/flags.json";

function flagsUrl(): string {
  return process.env.NEXT_PUBLIC_SUBSCRIPTION_FLAGS_URL || DEFAULT_FLAGS_URL;
}

/** Returns true iff the remote flags.json exists AND explicitly says
 *  `{"subscriptionDirect": false}` — every other outcome (fetch
 *  failure, timeout, non-2xx/404, malformed JSON, or a JSON payload
 *  that omits the key or sets it truthy) means "allowed" per the
 *  design's fail-open kill-switch contract. 3s timeout, same budget as
 *  agentHealth/fetchSidecarHealth's probe pattern. */
export async function isRemotelyKilled(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(flagsUrl(), { signal: controller.signal });
    if (!res.ok) return false; // 404/5xx -> allowed
    const body = (await res.json()) as { subscriptionDirect?: unknown };
    return body?.subscriptionDirect === false;
  } catch {
    return false; // network error/timeout/malformed JSON -> allowed
  } finally {
    clearTimeout(timeout);
  }
}
