// Browser-side fetch helpers for /api/detect and /api/summarize.
// OWNER: worker B.

import type {
  ApiErrorBody,
  DefineRequest,
  DefineResult,
  DetectRequest,
  DetectResponse,
  LlmProvider,
  LlmTaskDomain,
  Settings,
  SummarizeRequest,
  SummaryResult,
  TranslateRequest,
  TranslateResponse,
} from "@jargonslayer/core/types";
import { PROVIDER_HEADERS } from "@jargonslayer/core/types";
import { withBase } from "../basePath";
import { PREVIEW_TIER } from "../deployTier";
import { diagLog } from "../diag/log";
import { resolveTaskCreds } from "./taskConfig";
import type { ResolvedTaskCreds } from "./taskConfig";
import { renderProfileHint } from "@jargonslayer/core/llm/profileHint";
// v0.4 S2 (PLAN-v0.4 §1A/§4) — client-side callProvider path: an
// internal, default-OFF flag (llmTransport.ts's useClientTransport)
// lets every *Api function below call the provider directly instead of
// routing through /api/* — the path S3's Tauri desktop build runs
// exclusively (no Node server there). BadOutputError/OpenAiCompatError
// and the CallJsonOptions/ProviderCaller shapes are the same ones
// anthropic.ts's SDK-based server path already uses (providerCore.ts,
// S2's isomorphic extraction) — see throwForProviderError below for
// how a caught error maps to this file's existing NoKeyError/
// RateLimitApiError/UpstreamError taxonomy.
import { useClientTransport } from "./llmTransport";
import { callProviderDirect, ProviderHttpError } from "./clientProvider";
import {
  BadOutputError,
  OpenAiCompatError,
  type CallJsonOptions,
  type ProviderCaller,
} from "./providerCore";
import { DEFAULT_DETECT_MODEL, runDetectTask } from "./tasks/detect";
import { DEFAULT_DEFINE_MODEL, runDefineTask } from "./tasks/define";
import { DEFAULT_TRANSLATE_MODEL, runTranslateTask } from "./tasks/translate";
import {
  DEFAULT_SUMMARIZE_MODEL,
  MAX_SEGMENTS,
  MAX_TOTAL_SEGMENT_CHARS,
  runSummarizeTask,
  SUMMARIZE_TOO_LARGE_MESSAGE,
  totalSegmentChars,
} from "./tasks/summarize";
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
  constructor(message = "请求过于频繁，请稍后重试") {
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

// Item 5: a request whose resolved creds carry no key runs KEYLESS —
// taskHeaders only sets the key header `if (creds.apiKey)`, so the
// Next.js route falls back to ITS OWN server-managed credential
// (anthropic.ts's resolveLlmConfig: env JARGONSLAYER_API_KEY/
// ANTHROPIC_API_KEY — the preview tier's shared key, or a full-tier
// deploy's optional server key) whenever no client key header arrives.
// The client's own idle settings.provider (or a taskLlm domain
// override) never actually serves that request, so logging it in a
// diag ctx is misleading — the owner saw "anthropic" paired with
// hasApiKey:false on the server-managed preview tier (report.ts's
// summarizeSettings fix addresses the same confusion in the settings
// summary). "server" makes the real, server-decided routing explicit
// instead of echoing a client-side setting nobody's request actually
// used.
function ctxProvider(creds: { provider: LlmProvider; apiKey: string }): string {
  return creds.apiKey ? creds.provider : "server";
}

// Diagnostics privacy (tag-blocker BLOCKER 2): body.error is NOT safe
// to put in a diagLog message — for openai-compat providers it can be
// up to a 500-char slice of the raw upstream response body (see
// anthropic.ts's requestChatContent), which can echo back fragments of
// the request (transcript/profile content) the provider rejected. The
// diag ring buffer renders straight into the copyable 诊断信息 panel/
// issue report (log.ts's hard privacy rule), so this function logs a
// FIXED zh category message keyed off the HTTP status only — never
// `body.error`. The THROWN error (the user-facing toast path) is
// unchanged: it still carries body.error, same as before this fix.
function diagMessageForStatus(status: number): string {
  if (status === 401 || status === 403) return "API Key 无效或未配置";
  if (status === 429) return "请求过于频繁";
  return `请求失败（${status}）`;
}

async function throwForStatus(res: Response, ctx: RequestErrorContext): Promise<never> {
  const body = await parseErrorBody(res);
  const detail = errorDetail(ctx, res.status, body?.requestId);
  diagLog("error", ctx.tag, diagMessageForStatus(res.status), detail);
  if (res.status === 401) {
    throw new NoKeyError(body?.error ?? "未配置 API Key");
  }
  if (res.status === 429) {
    throw new RateLimitApiError(body?.error ?? "请求过于频繁，请稍后重试");
  }
  throw new UpstreamError(body?.error ?? `请求失败（${res.status}）`);
}

/** Direct-provider equivalent of throwForStatus above — the client-
 *  side callProvider path (v0.4 S2) talks straight to the provider, so
 *  there is no intermediate /api/* Response to parse; this maps
 *  whatever clientProvider.ts's callProviderDirect (called from inside
 *  a tasks/*.ts orchestration) threw onto the SAME NoKeyError/
 *  RateLimitApiError/UpstreamError taxonomy instead.
 *
 *  Status-code bucketing deliberately treats 401 AND 403 as "no key"
 *  (unlike throwForStatus's 401-only branch): throwForStatus reads an
 *  ALREADY-NORMALIZED status from our own route (mapLlmError folds
 *  upstream 403s into 401 before the client ever sees one — see
 *  anthropic.ts's OpenAiCompatError branch), so a literal 403 reaching
 *  throwForStatus is defensive-only. This function sees the RAW
 *  provider status with no normalizing middle layer, where a genuine
 *  403 (e.g. Anthropic's permission_error) is a real, expected case —
 *  matching mapLlmError's own 401||403 bucketing exactly, and
 *  diagMessageForStatus already anticipates this (see its own 403
 *  branch/test).
 *
 *  Same privacy rule as diagMessageForStatus/throwForStatus: diagLog
 *  only ever gets a FIXED short zh category message, never a raw
 *  upstream body/model-output slice (OpenAiCompatError/
 *  ProviderHttpError's `.message` can carry up to 500 raw upstream
 *  chars — see providerCore.ts's requestChatContent) and never a zod
 *  issue detail (BadOutputError's `.message` — mirrors mapLlmError's
 *  OWN BadOutputError branch, which likewise discards the issue detail
 *  before it ever reaches an HTTP body). */
function throwForProviderError(
  err: unknown,
  ctx: RequestErrorContext,
  messages: { timeout: string; network: string },
): never {
  if (err instanceof OpenAiCompatError || err instanceof ProviderHttpError) {
    const detail = errorDetail(ctx, err.status);
    diagLog("error", ctx.tag, diagMessageForStatus(err.status), detail);
    if (err.status === 401 || err.status === 403) {
      throw new NoKeyError("API Key 无效");
    }
    if (err.status === 429) {
      throw new RateLimitApiError("请求过于频繁，请稍后重试");
    }
    throw new UpstreamError(err.message || `请求失败（${err.status}）`);
  }
  if (err instanceof BadOutputError) {
    diagLog("error", ctx.tag, "模型输出解析失败", errorDetail(ctx));
    throw new UpstreamError("模型输出解析失败");
  }
  if (err instanceof DOMException && err.name === "AbortError") {
    diagLog("error", ctx.tag, messages.timeout, errorDetail(ctx));
    throw new UpstreamError(messages.timeout);
  }
  diagLog("error", ctx.tag, messages.network, errorDetail(ctx));
  throw new UpstreamError(messages.network);
}

/** Direct-provider paths have no server to fall back to, so an
 *  unconfigured key must fail IMMEDIATELY — without dispatching a
 *  request the provider is guaranteed to 401 anyway. Mirrors
 *  resolveLlmConfig returning null server-side (the exact same
 *  message + diag shape throwForStatus's own 401 default produces:
 *  `body?.error ?? "未配置 API Key"`), just resolved locally instead of
 *  over the wire. */
function requireApiKey(apiKey: string, ctx: RequestErrorContext): void {
  if (apiKey) return;
  diagLog("error", ctx.tag, diagMessageForStatus(401), errorDetail(ctx, 401));
  throw new NoKeyError("未配置 API Key");
}

/** Existing Next.js-routed detect call (BYOK / shared-key / Poe / …).
 *  Unchanged — see detectApi below for the subscription-direct
 *  pre-branch that wraps this. */
async function detectViaNext(
  body: DetectRequest,
  settings: Settings,
): Promise<DetectResponse> {
  const creds = resolveTaskCreds(settings, "detect");
  const ctx: RequestErrorContext = { tag: "llm-detect", provider: ctxProvider(creds), model: body.model ?? creds.model };
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
      diagLog("error", ctx.tag, "检测请求超时，请稍后重试", errorDetail(ctx));
      throw new UpstreamError("检测请求超时，请稍后重试");
    }
    diagLog("error", ctx.tag, "检测请求失败，请检查网络连接", errorDetail(ctx));
    throw new UpstreamError("检测请求失败，请检查网络连接");
  }

  if (!res.ok) {
    await throwForStatus(res, ctx);
  }

  return (await res.json()) as DetectResponse;
}

/** Client-side callProvider detect call (v0.4 S2) — used instead of
 *  detectViaNext above when llmTransport.ts's useClientTransport() is
 *  on. BYOK-only: server-only concerns (pickModel's allowlist, rate
 *  limiting, the #61 fallback model) never apply here — see
 *  tasks/detect.ts's header comment. `body.model ?? DEFAULT_DETECT_
 *  MODEL` mirrors the server's pickModel BYOK branch exactly (see
 *  anthropic.ts's pickModel: `requestedModel ?? fallbackDefault`) —
 *  detectViaNext never injects `creds.model` into the wire body either
 *  (only into the diag ctx label), so callers that don't set
 *  body.model themselves (e.g. stt/upload.ts) get the same task
 *  default here as they do server-side today. */
async function detectViaClient(
  body: DetectRequest,
  settings: Settings,
): Promise<DetectResponse> {
  const creds = resolveTaskCreds(settings, "detect");
  // creds.provider directly, never ctxProvider(creds) — see
  // summarizeViaClient's comment on why the "server" label doesn't
  // apply to this BYOK-only path.
  const ctx: RequestErrorContext = { tag: "llm-detect", provider: creds.provider, model: body.model ?? creds.model };
  requireApiKey(creds.apiKey, ctx);
  const call: ProviderCaller = function callDirect<T>(opts: CallJsonOptions<T>): Promise<T> {
    // Same PREVIEW_TIER-aware budget as detectViaNext's fetch above —
    // kept for consistency even though the direct path is BYOK-only
    // (PREVIEW_TIER is a server-key/showroom-build concept) so the two
    // paths never silently disagree on how long "too slow" means.
    return callProviderDirect({ ...opts, timeoutMs: PREVIEW_TIER ? 25000 : 20000 });
  };

  try {
    return await runDetectTask(
      {
        apiKey: creds.apiKey,
        model: body.model ?? DEFAULT_DETECT_MODEL,
        provider: creds.provider,
        baseUrl: creds.baseUrl,
        context: body.context,
        new_text: body.new_text,
        lang: settings.explainLanguage,
        profile: renderProfileHint(settings.profile),
      },
      call,
    );
  } catch (err) {
    throwForProviderError(err, ctx, {
      timeout: "检测请求超时，请稍后重试",
      network: "检测请求失败，请检查网络连接",
    });
  }
}

export async function summarizeApi(
  body: SummarizeRequest,
  settings: Settings,
): Promise<SummaryResult> {
  const creds = resolveTaskCreds(settings, "summary");
  const ctx: RequestErrorContext = { tag: "llm-summary", provider: ctxProvider(creds), model: body.model ?? creds.model };

  if (useClientTransport()) {
    return summarizeViaClient(body, settings, creds);
  }

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
      diagLog("error", ctx.tag, "报告生成超时，请稍后重试", errorDetail(ctx));
      throw new UpstreamError("报告生成超时，请稍后重试");
    }
    diagLog("error", ctx.tag, "报告生成失败，请检查网络连接", errorDetail(ctx));
    throw new UpstreamError("报告生成失败，请检查网络连接");
  }

  if (!res.ok) {
    await throwForStatus(res, ctx);
  }

  return (await res.json()) as SummaryResult;
}

/** Client-side callProvider summarize call (v0.4 S2) — used instead of
 *  the fetch above when useClientTransport() is on. Runs the full
 *  three-stage orchestration (summary + chunked/parallel translation +
 *  sweep, see tasks/summarize.ts) as several direct provider calls —
 *  exactly what the user's own BYOK key would do called any other way.
 *  `body.model ?? DEFAULT_SUMMARIZE_MODEL` mirrors summarizeApi's own
 *  wire contract: the existing fetch above sends `body.model` through
 *  UNCHANGED (`{ ...body, lang, profile }` never touches `model`), and
 *  the server's pickModel resolves an absent one to this exact
 *  default in BYOK mode.
 *
 *  Builds its OWN ctx (creds.provider directly, never through
 *  ctxProvider) rather than reusing summarizeApi's — ctxProvider's
 *  apiKey-empty-means-"server" convention is specific to the Next.js
 *  path (a keyless request there really is served by the route's own
 *  env-managed key); the direct path is BYOK-only and has no such
 *  fallback, so the diag label must always name the real configured
 *  provider (design constraint #5) — see requireApiKey below for how a
 *  genuinely missing key is handled instead. */
async function summarizeViaClient(
  body: SummarizeRequest,
  settings: Settings,
  creds: ResolvedTaskCreds,
): Promise<SummaryResult> {
  const ctx: RequestErrorContext = { tag: "llm-summary", provider: creds.provider, model: body.model ?? creds.model };

  // F4 (codex v04-integration review): the Next.js route enforces
  // MAX_SEGMENTS/MAX_TOTAL_SEGMENT_CHARS as an HTTP-input-validation
  // guard against arbitrary callers (route.ts's own comment) — this
  // direct-provider path has no such guard by default, so an unbounded
  // marathon meeting would otherwise build unbounded strings/chunk
  // lists straight on the UI thread. Self-protection + behavior
  // parity, not DoS defense: same caps, same order (before key
  // resolution, matching the route), same user-facing error shape —
  // UpstreamError with the route's own exact zh message, byte-
  // identical to what a request that hit this cap server-side already
  // throws today (see throwForStatus's else-branch, which is what a
  // 413 maps to on the Next.js-routed summarizeApi path). Graceful
  // truncation is a deliberate non-goal until the desktop UX pass —
  // this only prevents a freeze, it doesn't salvage an over-cap
  // meeting.
  if (
    body.segments.length > MAX_SEGMENTS ||
    totalSegmentChars(body.segments) > MAX_TOTAL_SEGMENT_CHARS
  ) {
    diagLog("error", ctx.tag, SUMMARIZE_TOO_LARGE_MESSAGE, errorDetail(ctx));
    throw new UpstreamError(SUMMARIZE_TOO_LARGE_MESSAGE);
  }

  requireApiKey(creds.apiKey, ctx);

  const call: ProviderCaller = function callDirect<T>(opts: CallJsonOptions<T>): Promise<T> {
    return callProviderDirect({ ...opts, timeoutMs: 300000 });
  };

  try {
    return await runSummarizeTask(
      {
        apiKey: creds.apiKey,
        model: body.model ?? DEFAULT_SUMMARIZE_MODEL,
        llm: { provider: creds.provider, baseUrl: creds.baseUrl },
        segments: body.segments,
        expressions: body.expressions,
        terms: body.terms,
        lang: settings.explainLanguage,
        profile: renderProfileHint(settings.profile),
      },
      call,
    );
  } catch (err) {
    throwForProviderError(err, ctx, {
      timeout: "报告生成超时，请稍后重试",
      network: "报告生成失败，请检查网络连接",
    });
  }
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
  // Not explicitly named in item 5's "detect/translate/summary" list,
  // but this is the exact same RequestErrorContext pattern (same
  // ctxProvider(creds) fix applies for the identical reason) — applied
  // for consistency rather than leaving one of the four occurrences
  // stale; see the task report for this call.
  const ctx: RequestErrorContext = { tag: "llm-define", provider: ctxProvider(creds), model: body.model ?? creds.model };
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
      diagLog("error", ctx.tag, "解释请求超时，请稍后重试", errorDetail(ctx));
      throw new UpstreamError("解释请求超时，请稍后重试");
    }
    diagLog("error", ctx.tag, "解释请求失败，请检查网络连接", errorDetail(ctx));
    throw new UpstreamError("解释请求失败，请检查网络连接");
  }

  if (!res.ok) {
    await throwForStatus(res, ctx);
  }

  return (await res.json()) as DefineResult;
}

/** Client-side callProvider define call (v0.4 S2) — used instead of
 *  defineViaNext above when useClientTransport() is on. Rides detect's
 *  creds for provider/key routing, same as defineViaNext (see that
 *  function's own comment) — DEFAULT_DEFINE_MODEL is its own constant
 *  in tasks/define.ts even though it happens to equal detect's default
 *  today (see that file's own comment on why they're not unified). */
async function defineViaClient(
  body: DefineRequest,
  settings: Settings,
): Promise<DefineResult> {
  const creds = resolveTaskCreds(settings, "detect");
  // creds.provider directly, never ctxProvider(creds) — see
  // summarizeViaClient's comment on why the "server" label doesn't
  // apply to this BYOK-only path.
  const ctx: RequestErrorContext = { tag: "llm-define", provider: creds.provider, model: body.model ?? creds.model };
  requireApiKey(creds.apiKey, ctx);
  const call: ProviderCaller = function callDirect<T>(opts: CallJsonOptions<T>): Promise<T> {
    return callProviderDirect({ ...opts, timeoutMs: 20000 });
  };

  try {
    return await runDefineTask(
      {
        apiKey: creds.apiKey,
        model: body.model ?? DEFAULT_DEFINE_MODEL,
        provider: creds.provider,
        baseUrl: creds.baseUrl,
        phrase: body.phrase,
        context: body.context,
        lang: settings.explainLanguage,
        profile: renderProfileHint(settings.profile),
      },
      call,
    );
  } catch (err) {
    throwForProviderError(err, ctx, {
      timeout: "解释请求超时，请稍后重试",
      network: "解释请求失败，请检查网络连接",
    });
  }
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
  // v0.4 S2: independent of subscription-direct above — when on, this
  // ALWAYS wins over the existing Next.js path (desktop has no /api/*
  // to fall back to at all; see llmTransport.ts).
  return useClientTransport() ? detectViaClient(body, settings) : detectViaNext(body, settings);
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
  // v0.4 S2 — see detectApi's identical comment.
  return useClientTransport() ? defineViaClient(body, settings) : defineViaNext(body, settings);
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
  const ctx: RequestErrorContext = { tag: "llm-translate", provider: ctxProvider(translateCreds), model: resolvedModel };

  if (useClientTransport()) {
    return translateViaClient(body, translateCreds);
  }

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
      diagLog("error", ctx.tag, "翻译请求超时，请稍后重试", errorDetail(ctx));
      throw new UpstreamError("翻译请求超时，请稍后重试");
    }
    diagLog("error", ctx.tag, "翻译请求失败，请检查网络连接", errorDetail(ctx));
    throw new UpstreamError("翻译请求失败，请检查网络连接");
  }

  if (!res.ok) {
    await throwForStatus(res, ctx);
  }

  return (await res.json()) as TranslateResponse;
}

/** Client-side callProvider translate call (v0.4 S2) — used instead of
 *  the fetch above when useClientTransport() is on.
 *  `resolvedModel || body.model || DEFAULT_TRANSLATE_MODEL` is the
 *  exact two-stage resolution translateApi's own outBody construction
 *  above + the server's pickModel BYOK branch collapse to end-to-end
 *  today: a truthy resolvedModel (taskLlm override or legacy field)
 *  always wins; otherwise fall through to whatever body.model already
 *  was (dead in practice per every current caller, see this function's
 *  own comment above — kept for precision, not because any caller
 *  relies on it); otherwise the task default.
 *
 *  Builds its own ctx (creds.provider directly) rather than reusing
 *  translateApi's — see summarizeViaClient's identical comment. */
async function translateViaClient(
  body: TranslateRequest,
  creds: ResolvedTaskCreds,
): Promise<TranslateResponse> {
  const ctx: RequestErrorContext = { tag: "llm-translate", provider: creds.provider, model: creds.model };
  requireApiKey(creds.apiKey, ctx);

  const call: ProviderCaller = function callDirect<T>(opts: CallJsonOptions<T>): Promise<T> {
    // Same rationale as translateApi's own 30s fetch timeout above.
    return callProviderDirect({ ...opts, timeoutMs: 30000 });
  };

  try {
    return await runTranslateTask(
      {
        apiKey: creds.apiKey,
        // creds.model || (body.model ?? DEFAULT): the `??` on the
        // inner term (not `||`) matches the server's pickModel exactly
        // — `requestedModel ?? fallbackDefault` where requestedModel IS
        // body.model, so an explicit (if never-in-practice) empty-
        // string body.model would stay "" server-side too, not silently
        // upgrade to the default.
        model: creds.model || (body.model ?? DEFAULT_TRANSLATE_MODEL),
        provider: creds.provider,
        baseUrl: creds.baseUrl,
        segments: body.segments,
        lang: body.lang,
      },
      call,
    );
  } catch (err) {
    throwForProviderError(err, ctx, {
      timeout: "翻译请求超时，请稍后重试",
      network: "翻译请求失败，请检查网络连接",
    });
  }
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
