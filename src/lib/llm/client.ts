// Browser-side fetch helpers for /api/detect and /api/summarize.
// OWNER: worker B.

import type {
  ApiErrorBody,
  DefineRequest,
  DefineResult,
  DetectRequest,
  DetectResponse,
  LlmTaskDomain,
  Settings,
  SummarizeRequest,
  SummaryResult,
  TranslateRequest,
  TranslateResponse,
} from "../types";
import { PROVIDER_HEADERS } from "../types";
import { withBase } from "../basePath";
import { PREVIEW_TIER } from "../deployTier";
import { diagLog } from "../diag/log";
import { resolveTaskCreds } from "./taskConfig";
import { renderProfileHint } from "./profileHint";
import {
  agentDetect,
  agentDefine,
  agentHealth,
  AgentNoKeyError,
  AgentRateLimitError,
  AgentUnreachableError,
  SUBSCRIPTION_DIRECT_BUILT,
} from "../agent/localHost";
import { useApp } from "../store";

export class NoKeyError extends Error {
  constructor(message = "未配置 API Key") {
    super(message);
    this.name = "NoKeyError";
  }
}

export class RateLimitApiError extends Error {
  constructor(message = "请求过于频繁，请稍后再试") {
    super(message);
    this.name = "RateLimitApiError";
  }
}

export class UpstreamError extends Error {
  constructor(message = "模型请求失败") {
    super(message);
    this.name = "UpstreamError";
  }
}

/** Every header the routes need to resolve key + provider + endpoint
 *  for a request, resolved per-domain (#56): an unconfigured/disabled
 *  domain inherits the primary credential fields, so this is
 *  byte-identical to the old global authHeaders(settings) for every
 *  pre-#56 user (see resolveTaskCreds's own round-trip test). Exported
 *  so upload.ts's cloud-transcription path can reuse the exact same
 *  builder instead of hand-rolling a second copy (design Q3 — two
 *  header builders is a drift bug factory). */
export function taskHeaders(settings: Settings, domain: LlmTaskDomain): Record<string, string> {
  const creds = resolveTaskCreds(settings, domain);
  const headers: Record<string, string> = {
    [PROVIDER_HEADERS.provider]: creds.provider,
  };
  if (creds.apiKey) {
    headers[PROVIDER_HEADERS.key] = creds.apiKey;
  }
  if (creds.provider === "openai-compat" && creds.baseUrl) {
    headers[PROVIDER_HEADERS.baseUrl] = creds.baseUrl;
  }
  return headers;
}

async function parseErrorBody(res: Response): Promise<ApiErrorBody | undefined> {
  try {
    return (await res.json()) as ApiErrorBody;
  } catch {
    return undefined;
  }
}

// Diagnostics (item 2/5): every request-failure choke point in this
// file logs status code + provider/model id — NEVER request/response
// bodies beyond the small fixed zh error phrase the route already
// returns (see log.ts's PRIVACY RULE). `requestId` (item 5) chains a
// user's ref back to the matching server-side response, when the
// failing route is one of the three that stamps one (detect/define/
// summarize — translate's route does not, so requestId is simply
// absent there).
interface RequestErrorContext {
  tag: string;
  provider: string;
  model?: string;
}

function errorDetail(ctx: RequestErrorContext, status?: number, requestId?: string): string {
  const parts = [`provider=${ctx.provider}`, `model=${ctx.model || "(inherited)"}`];
  if (status !== undefined) parts.push(`status=${status}`);
  if (requestId) parts.push(`requestId=${requestId}`);
  return parts.join(" ");
}

async function throwForStatus(res: Response, ctx: RequestErrorContext): Promise<never> {
  const body = await parseErrorBody(res);
  const detail = errorDetail(ctx, res.status, body?.requestId);
  if (res.status === 401) {
    const msg = body?.error ?? "未配置 API Key";
    diagLog("error", ctx.tag, msg, detail);
    throw new NoKeyError(msg);
  }
  if (res.status === 429) {
    const msg = body?.error ?? "请求过于频繁，请稍后再试";
    diagLog("error", ctx.tag, msg, detail);
    throw new RateLimitApiError(msg);
  }
  const msg = body?.error ?? `请求失败（${res.status}）`;
  diagLog("error", ctx.tag, msg, detail);
  throw new UpstreamError(msg);
}

/** Existing Next.js-routed detect call (BYOK / shared-key / Poe / …).
 *  Unchanged — see detectApi below for the subscription-direct
 *  pre-branch that wraps this. */
async function detectViaNext(
  body: DetectRequest,
  settings: Settings,
): Promise<DetectResponse> {
  const creds = resolveTaskCreds(settings, "detect");
  const ctx: RequestErrorContext = { tag: "llm-detect", provider: creds.provider, model: body.model ?? creds.model };
  let res: Response;
  try {
    res = await fetch(withBase("/api/detect"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...taskHeaders(settings, "detect"),
      },
      body: JSON.stringify({
        ...body,
        lang: settings.explainLanguage,
        profile: renderProfileHint(settings.profile),
      } satisfies DetectRequest),
      // Reasoning models behind openai-compat endpoints (e.g. the
      // hosted demo's MiniMax M-series) routinely take 8-15s per
      // batch; the previous 8s (tuned for Haiku) timed every batch
      // out and tripped the scheduler's consecutive-failure fallback
      // latch. Detection is async and additive, so a slow batch is
      // still useful — cards just land a moment later.
      // Preview tier (#61): PREVIEW_LIVE_MODELS' minimax-m3 measures a
      // ~19.7s detect median — 25s covers p75 + headroom without
      // ballooning the full-tier (Haiku-tuned) budget.
      signal: AbortSignal.timeout(PREVIEW_TIER ? 25000 : 20000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      diagLog("error", ctx.tag, "检测请求超时", errorDetail(ctx));
      throw new UpstreamError("检测请求超时");
    }
    diagLog("error", ctx.tag, "检测请求失败，请检查网络连接", errorDetail(ctx));
    throw new UpstreamError("检测请求失败，请检查网络连接");
  }

  if (!res.ok) {
    await throwForStatus(res, ctx);
  }

  return (await res.json()) as DetectResponse;
}

export async function summarizeApi(
  body: SummarizeRequest,
  settings: Settings,
): Promise<SummaryResult> {
  const creds = resolveTaskCreds(settings, "summary");
  const ctx: RequestErrorContext = { tag: "llm-summary", provider: creds.provider, model: body.model ?? creds.model };
  let res: Response;
  try {
    res = await fetch(withBase("/api/summarize"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...taskHeaders(settings, "summary"),
      },
      body: JSON.stringify({
        ...body,
        lang: settings.explainLanguage,
        profile: renderProfileHint(settings.profile),
      } satisfies SummarizeRequest),
      signal: AbortSignal.timeout(300000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      diagLog("error", ctx.tag, "生成报告超时，请稍后重试", errorDetail(ctx));
      throw new UpstreamError("生成报告超时，请稍后重试");
    }
    diagLog("error", ctx.tag, "报告生成失败，请检查网络连接", errorDetail(ctx));
    throw new UpstreamError("报告生成失败，请检查网络连接");
  }

  if (!res.ok) {
    await throwForStatus(res, ctx);
  }

  return (await res.json()) as SummaryResult;
}

/** Existing Next.js-routed define call. Unchanged — see defineApi
 *  below for the subscription-direct pre-branch that wraps this. */
async function defineViaNext(
  body: DefineRequest,
  settings: Settings,
): Promise<DefineResult> {
  // define rides detect's config (see taskHeaders call below) — same
  // domain for the diag tag's provider/model context.
  const creds = resolveTaskCreds(settings, "detect");
  const ctx: RequestErrorContext = { tag: "llm-define", provider: creds.provider, model: body.model ?? creds.model };
  let res: Response;
  try {
    res = await fetch(withBase("/api/define"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...taskHeaders(settings, "detect"),
      },
      body: JSON.stringify({
        ...body,
        lang: settings.explainLanguage,
        profile: renderProfileHint(settings.profile),
      } satisfies DefineRequest),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      diagLog("error", ctx.tag, "解释请求超时", errorDetail(ctx));
      throw new UpstreamError("解释请求超时");
    }
    diagLog("error", ctx.tag, "解释请求失败，请检查网络连接", errorDetail(ctx));
    throw new UpstreamError("解释请求失败，请检查网络连接");
  }

  if (!res.ok) {
    await throwForStatus(res, ctx);
  }

  return (await res.json()) as DefineResult;
}

// ---------------------------------------------------------------
// Subscription-direct (v0.2.2, experimental, LOCAL DEV BUILD ONLY)
// routing branch — the ONLY place detect/define ever decide between
// the sidecar (sidecar/agent_server.py's /agent/*) and the existing
// Next.js path. translate/summarize NEVER touch this branch, in any
// build (see translateApi/summarizeApi above and below — both call
// their /api/* route directly, unmodified).
//
// Kill-switch order (fastest/cheapest check first):
//   1. SUBSCRIPTION_DIRECT_BUILT — build-time flag; when the build
//      didn't set NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT, this const
//      resolves to a literal `false` at ITS OWN definition site in
//      localHost.ts, so shouldAttemptSubscriptionDirect below always
//      returns false at runtime — verified via a real running server
//      (curl against a build with the flag unset never reaches
//      agentDetect/agentHealth). Whether that guarantees this file's
//      OWN source text is eliminated from the bundle is a separate,
//      weaker guarantee: SettingsDialog.tsx's user-visible JSX (the
//      part that matters most for "does this build expose the
//      feature") reads process.env.NEXT_PUBLIC_X directly for exactly
//      this reason and is confirmed eliminated by `npm run build`
//      bundle inspection; this file's own dead branch may or may not
//      survive as unreachable text depending on webpack/Terser's
//      cross-module inlining heuristics for a re-exported const — see
//      task report for the full empirical investigation.
//   2. settings.subscriptionDirect — the user's own on/off switch.
//   3. store.subscriptionKillCheckSettled — closes a real startup race
//      (found in adversarial review): store.ts's hydrate() sets
//      `hydrated: true` (with the persisted subscriptionDirect:true
//      already live) SYNCHRONOUSLY, then fires the remote-kill check
//      (isRemotelyKilled) fire-and-forget so it never delays app
//      startup. Without this check, a detect/define call landing in
//      that brief window — before the remote check has had a chance
//      to resolve — would use subscription-direct even if a same-
//      session remote kill would have disabled it, defeating "an
//      already-shipped build can be remotely killed within one page
//      load." Fail CLOSED for this specific race window only (not
//      isRemotelyKilled's own fail-open contract, which still governs
//      once the fetch actually settles) — see the AppState field's own
//      doc in store.ts for the full rationale. In practice this window
//      is usually sub-second and detect rarely fires that early, but
//      the guard removes the "usually" entirely.
//   4. agentHealth() probe — is the sidecar actually reachable RIGHT
//      NOW? Only attempt the real call if so; if unreachable, fall
//      through to the existing Next.js path exactly as if this whole
//      feature didn't exist (no error, no toast — see the design
//      doc's "宿主不可达 -> 静默走现有 Next 路径" rule).
// ---------------------------------------------------------------

/** Fired at most once per consecutive run of subscription-direct
 *  failures (mirrors DetectionScheduler's noKeyToastFired/
 *  rateLimitFallbackFired pattern) — reset back to false the next
 *  time a subscription-direct call actually succeeds, so a LATER
 *  failure episode (e.g. quota resets, then runs out again) still
 *  gets its own toast rather than going silent forever after the
 *  first one. */
let subscriptionToastFired = false;

/** Test helper — clears the toast-once latch (mirrors rateLimit.ts's
 *  resetRateLimiter). Needed because this module-level flag otherwise
 *  leaks between independent `it()` blocks that each expect a clean
 *  "toast not yet fired" starting state. */
export function resetSubscriptionToastLatch(): void {
  subscriptionToastFired = false;
}

function shouldAttemptSubscriptionDirect(settings: Settings): boolean {
  return (
    SUBSCRIPTION_DIRECT_BUILT &&
    settings.subscriptionDirect &&
    useApp.getState().subscriptionKillCheckSettled
  );
}

/** Shared pre-branch for detectApi/defineApi: probes reachability,
 *  then runs `viaAgent`. On success, resets the toast-once latch and
 *  returns the result. On any AgentNoKeyError/AgentRateLimitError (the
 *  sidecar was reached but the call itself failed — expired/missing
 *  login, or subscription quota/rate-limit exhausted), fires the
 *  required one-time toast and returns `null` so the caller falls back
 *  to dictionary mode — NEVER to BYOK/the shared Next.js key, per the
 *  design's explicit "不静默切 BYOK" rule (that would silently spend a
 *  DIFFERENT credential than the one the user thinks they're using).
 *  On AgentUnreachableError (host not running) or the reachability
 *  probe itself failing, returns `undefined` — a distinct "not even
 *  attempted" signal so the caller falls through to the existing
 *  Next.js path SILENTLY (no toast at all, exactly as if this feature
 *  were off), per the design's "宿主不可达 -> 静默走现有 Next 路径"
 *  rule. Any other thrown error (a schema/parse failure inside the
 *  sidecar, mapped to AgentUpstreamError) propagates as-is, matching
 *  how the existing Next.js path already lets non-key/non-rate-limit
 *  errors surface to the caller rather than silently swallowing them. */
async function attemptSubscriptionDirect<T>(
  settings: Settings,
  viaAgent: () => Promise<T>,
): Promise<T | null | undefined> {
  const health = await agentHealth(settings);
  if (!health) return undefined; // host unreachable -> silent Next fallback

  try {
    const result = await viaAgent();
    subscriptionToastFired = false;
    return result;
  } catch (err) {
    if (err instanceof AgentNoKeyError || err instanceof AgentRateLimitError) {
      if (!subscriptionToastFired) {
        subscriptionToastFired = true;
        useApp.getState().showToast("订阅额度暂不可用，已回退至词典检测");
      }
      return null; // caller falls back to dictionary mode
    }
    if (err instanceof AgentUnreachableError) {
      return undefined; // treated the same as an unreachable health probe
    }
    throw err;
  }
}

export async function detectApi(
  body: DetectRequest,
  settings: Settings,
): Promise<DetectResponse> {
  if (shouldAttemptSubscriptionDirect(settings)) {
    const result = await attemptSubscriptionDirect(settings, () => agentDetect(body, settings));
    if (result === null) {
      // Dictionary-mode signal: every existing detectApi caller
      // (DetectionScheduler, LookupPopover, upload.ts's import
      // pipeline) already knows how to treat NoKeyError as "fall back
      // to the offline dictionary, no error surfaced" — reusing that
      // exact contract here means the toast above (already fired,
      // with the required subscription-specific wording) is the only
      // UI difference from today's no-key path; every caller's
      // existing fallback logic applies unchanged.
      throw new NoKeyError("订阅额度暂不可用");
    }
    if (result !== undefined) return result;
    // undefined -> host unreachable; fall through to the existing
    // Next.js path below, silently.
  }
  return detectViaNext(body, settings);
}

export async function defineApi(
  body: DefineRequest,
  settings: Settings,
): Promise<DefineResult> {
  if (shouldAttemptSubscriptionDirect(settings)) {
    const result = await attemptSubscriptionDirect(settings, () => agentDefine(body, settings));
    if (result === null) {
      // Same NoKeyError-reuse contract as detectApi above —
      // LookupPopover's handleAddToGlossary already treats NoKeyError
      // as "fall back to an empty draft, no scary error" (see
      // LookupPopover.tsx), so the toast fired above is the only
      // difference from today's no-key UX.
      throw new NoKeyError("订阅额度暂不可用");
    }
    if (result !== undefined) return result;
  }
  return defineViaNext(body, settings);
}

export async function translateApi(
  body: TranslateRequest,
  settings: Settings,
): Promise<TranslateResponse> {
  // #56: translate's resolved model is "" when inherited (no top-level
  // model field for this domain — see resolveTaskCreds), which must
  // send NO body model at all (today's server-default behavior),
  // never a literal empty-string model. Callers (translate/queue.ts,
  // ingest/importText.ts) never set body.model themselves — resolved
  // here, once, same as headers.
  const translateCreds = resolveTaskCreds(settings, "translate");
  const resolvedModel = translateCreds.model;
  const outBody: TranslateRequest = resolvedModel ? { ...body, model: resolvedModel } : body;
  // /api/translate is not one of the three routes that stamp a
  // requestId (item 5's scope) — errorDetail/throwForStatus still work
  // fine, `requestId` just stays absent in the logged detail.
  const ctx: RequestErrorContext = { tag: "llm-translate", provider: translateCreds.provider, model: resolvedModel };

  let res: Response;
  try {
    res = await fetch(withBase("/api/translate"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...taskHeaders(settings, "translate"),
      },
      body: JSON.stringify(outBody satisfies TranslateRequest),
      // Reasoning-model latency, same rationale as detect's 20s, but
      // batches here carry up to 6 segments instead of one.
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      diagLog("error", ctx.tag, "翻译请求超时", errorDetail(ctx));
      throw new UpstreamError("翻译请求超时");
    }
    diagLog("error", ctx.tag, "翻译请求失败，请检查网络连接", errorDetail(ctx));
    throw new UpstreamError("翻译请求失败，请检查网络连接");
  }

  if (!res.ok) {
    await throwForStatus(res, ctx);
  }

  return (await res.json()) as TranslateResponse;
}

/** Probe the configured provider/key/baseUrl with a trivial detect
 *  call and translate the outcome into a user-facing message for the
 *  Settings dialog's 「测试连接」button. Never throws. */
export async function testConnection(
  settings: Settings,
): Promise<{ ok: boolean; message: string }> {
  try {
    await detectApi(
      { context: "", new_text: "We need to circle back on this." },
      settings,
    );
    return { ok: true, message: "连接成功，模型可用" };
  } catch (err) {
    if (err instanceof NoKeyError) {
      return { ok: false, message: "Key 未配置或无效" };
    }
    if (err instanceof RateLimitApiError) {
      return { ok: true, message: "连接成功但被限流（Key 有效）" };
    }
    return { ok: false, message: err instanceof Error ? err.message : "连接失败" };
  }
}
