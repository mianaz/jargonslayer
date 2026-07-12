// Server-only Anthropic client helper. Never import this from a
// client component — it reads process.env and is meant to run in
// Next.js route handlers only. (No `server-only` package guard: it
// is not in the approved dependency list, so this relies on the
// import graph — only api/detect and api/summarize import it.)
//
// v0.4 S2 (PLAN-v0.4 §1A/§4): the provider-request-shaping/parsing
// logic this file used to own outright (zod schemas, JSON extraction,
// the openai-compat raw-fetch path, CallJsonOptions) now lives in
// providerCore.ts — isomorphic, safe for the new client-side
// callProvider path (lib/llm/clientProvider.ts) to import too. This
// file re-exports every one of those symbols under its original name,
// so every existing importer (the routes, anthropic-openai-compat.
// test.ts) is unaffected by the move — only genuinely server-only code
// (env-var key/provider/model resolution, the Anthropic SDK client
// object, the #61 allowlist/fallback-model policy, HTTP-status error
// mapping) stays here.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { TextBlock } from "@anthropic-ai/sdk/resources/messages";
import type { LlmProvider } from "@jargonslayer/core/types";
import { PROVIDER_HEADERS } from "@jargonslayer/core/types";
import {
  applyArrayKey,
  BadOutputError,
  buildAnthropicMessagesRequestBody,
  buildSystemParam,
  callJsonOpenAiCompat,
  clampConfidence,
  clampExpressionConfidences,
  DefineResultSchema,
  DetectResponseSchema,
  extractJsonObject,
  extractJsonValue,
  MeetingSummarySchema,
  OpenAiCompatError,
  parseJsonContent,
  TranslateSegmentsSchema,
  TranslationsSchema,
  type CallJsonOptions,
  type ProviderCaller,
} from "./providerCore";

// Re-exported verbatim (S2 move — see header comment): every existing
// importer of these names from "@/lib/llm/anthropic" keeps working
// unchanged.
export {
  applyArrayKey,
  BadOutputError,
  buildAnthropicMessagesRequestBody,
  buildSystemParam,
  callJsonOpenAiCompat,
  clampConfidence,
  clampExpressionConfidences,
  DefineResultSchema,
  DetectResponseSchema,
  extractJsonObject,
  extractJsonValue,
  MeetingSummarySchema,
  OpenAiCompatError,
  parseJsonContent,
  TranslateSegmentsSchema,
  TranslationsSchema,
};
export type { CallJsonOptions, ProviderCaller };

// ---------------------------------------------------------------
// Key / provider resolution
// ---------------------------------------------------------------

/** Resolve the API key for a request: user-supplied header first
 *  (BYOK, never persisted server-side), falling back to the server
 *  env var. Returns null when neither is configured. */
export function resolveKey(req: Request): string | null {
  return req.headers.get("x-jargonslayer-key") || process.env.ANTHROPIC_API_KEY || null;
}

/** Resolve which LLM provider/endpoint a request targets: header
 *  first (per-browser setting), falling back to server env, falling
 *  back to first-party Anthropic. */
export function resolveProvider(req: Request): {
  provider: LlmProvider;
  baseUrl: string;
} {
  const headerProvider = req.headers.get(PROVIDER_HEADERS.provider);
  const provider: LlmProvider =
    headerProvider === "openai-compat" || headerProvider === "anthropic"
      ? headerProvider
      : process.env.JARGONSLAYER_PROVIDER === "openai-compat"
        ? "openai-compat"
        : "anthropic";

  const baseUrl =
    req.headers.get(PROVIDER_HEADERS.baseUrl) || process.env.JARGONSLAYER_BASE_URL || "";

  return { provider, baseUrl };
}

export type LlmCallKind = "detect" | "summary" | "define" | "translate";

/** Parse a comma-separated model-id env var. Unset/empty → []. */
function parseModelList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ResolvedLlmConfig {
  apiKey: string;
  provider: LlmProvider;
  baseUrl: string;
  /** Non-null when the server credential is in play and a server-side
   *  model is configured: routes MUST use this model and ignore the
   *  client-requested one — UNLESS the client's model is inside
   *  allowedModels (see pickModel). */
  forcedModel: string | null;
  /** #61 preview tier: the ONLY client-chosen models the server key
   *  may be paired with, from JARGONSLAYER_MODEL_ALLOWLIST (+ the
   *  summary-only extras for kind "summary"). Empty = client model
   *  never honored in server-key mode (the pre-#61 posture, and the
   *  posture of every deployment that doesn't set the env). Free-form
   *  provider/baseUrl with the server key stays forbidden regardless —
   *  this list relaxes MODEL choice only. Always [] for BYOK (their
   *  key, their model — no list needed). */
  allowedModels: string[];
  /** #61 preview tier: server-side one-shot model fallback for
   *  upstream failures (JARGONSLAYER_FALLBACK_MODEL, e.g. minimax →
   *  deepseek-v4-flash when minimax 502s or hits a model guardrail).
   *  null = no fallback (BYOK always; server key without the env). */
  fallbackModel: string | null;
  /** True when the shared server credential (env) serves the request —
   *  callers apply per-IP rate limiting in that case. */
  isServerKey: boolean;
  /** Extra JSON merged into openai-compat request bodies. Server-key
   *  mode via OpenRouter sets provider.data_collection="allow" here so
   *  the shared demo credential can reach endpoints the account's
   *  default privacy policy would exclude (e.g. MiniMax). Never set
   *  for BYOK requests — relaxing a data policy is the key owner's
   *  decision, not ours. */
  extraBody?: Record<string, unknown>;
}

/** Resolve the full LLM call config for a request.
 *
 *  Two mutually exclusive modes — credentials and routing config are
 *  never mixed across them:
 *
 *  - User key (BYOK header): honor the client's provider/baseUrl
 *    headers and requested model. Their key, their config.
 *  - Server key (env, e.g. the hosted demo's shared OpenRouter
 *    credential): use ONLY server-side env for provider/baseUrl/model
 *    and ignore the client's headers entirely. Pairing the server
 *    credential with a client-supplied baseUrl would let anyone
 *    exfiltrate the key to their own endpoint; honoring a client-
 *    chosen model would let anyone run expensive models on the shared
 *    credential.
 *
 *  Env contract: JARGONSLAYER_API_KEY (preferred; provider-neutral) or
 *  ANTHROPIC_API_KEY (legacy name, works for any provider), plus
 *  JARGONSLAYER_PROVIDER / JARGONSLAYER_BASE_URL and the per-kind
 *  models JARGONSLAYER_DETECT_MODEL / JARGONSLAYER_SUMMARY_MODEL /
 *  JARGONSLAYER_TRANSLATE_MODEL ("define" and "translate" both fall
 *  back to the detect-class model). When no server model is
 *  configured (legacy Anthropic-key setups), forcedModel stays null
 *  and routes keep their existing body-model defaults.
 *
 *  Returns null when neither credential exists (routes map to no_key).
 */
export function resolveLlmConfig(
  req: Request,
  kind: LlmCallKind,
): ResolvedLlmConfig | null {
  const userKey = req.headers.get(PROVIDER_HEADERS.key);
  if (userKey) {
    const headerProvider = req.headers.get(PROVIDER_HEADERS.provider);
    return {
      apiKey: userKey,
      provider: headerProvider === "openai-compat" ? "openai-compat" : "anthropic",
      baseUrl: req.headers.get(PROVIDER_HEADERS.baseUrl) || "",
      forcedModel: null,
      allowedModels: [],
      fallbackModel: null,
      isServerKey: false,
    };
  }

  const serverKey =
    process.env.JARGONSLAYER_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!serverKey) return null;

  const detectClassModel = process.env.JARGONSLAYER_DETECT_MODEL || null;
  const baseUrl = process.env.JARGONSLAYER_BASE_URL || "";
  // #61 allowlists. Comma-separated model ids. The base list applies
  // to every kind; the SUMMARY list adds models only summary may use
  // (measured: deepseek-v4-pro detect median 69.4s — hopeless before
  // the live path's 25s client timeout, fine for the async summary).
  const baseAllowlist = parseModelList(process.env.JARGONSLAYER_MODEL_ALLOWLIST);
  const summaryExtra =
    kind === "summary"
      ? parseModelList(process.env.JARGONSLAYER_MODEL_ALLOWLIST_SUMMARY)
      : [];
  // Exact hostname match, not a substring check: baseUrl only ever
  // comes from a server-side env var (no client attack surface here),
  // so this is purely a typo/operator-error guard — a substring match
  // would also fire on an unrelated host that merely contains
  // "openrouter.ai" somewhere in its name (e.g. a lookalike domain).
  let isOpenRouter = false;
  try {
    isOpenRouter = new URL(baseUrl).hostname === "openrouter.ai";
  } catch {
    isOpenRouter = false;
  }
  return {
    apiKey: serverKey,
    provider:
      process.env.JARGONSLAYER_PROVIDER === "openai-compat"
        ? "openai-compat"
        : "anthropic",
    baseUrl,
    // NOTE: the translate-only `reasoning:{enabled:false}` override
    // used to be injected HERE, keyed on kind alone. That broke the
    // moment #56 let translate reach non-minimax models — deepseek-
    // v4-flash's upstream hard-fails on the param (live 502 through
    // OpenRouter's edge, v0.2.3 E2E). It now lives in the translate
    // route, applied AFTER pickModel decides the actual model and
    // only for minimax/* (where the 2026-07-06 measurement — 4.0s →
    // 1.7s, ~1/4 cost — was taken).
    extraBody: isOpenRouter ? { provider: { data_collection: "allow" } } : undefined,
    forcedModel:
      kind === "summary"
        ? process.env.JARGONSLAYER_SUMMARY_MODEL || detectClassModel
        : kind === "translate"
          ? process.env.JARGONSLAYER_TRANSLATE_MODEL || detectClassModel
          : detectClassModel,
    allowedModels: [...baseAllowlist, ...summaryExtra],
    fallbackModel: process.env.JARGONSLAYER_FALLBACK_MODEL || null,
    isServerKey: true,
  };
}

/** #61 model choice under the amended iron law.
 *
 *  BYOK: the client's requested model, always (their key, their
 *  config) — exactly the pre-#61 behavior.
 *
 *  Server key: the client's requested model is honored ONLY when it
 *  appears in the server-side allowlist for this kind; anything else
 *  (off-list, or no allowlist configured at all) falls back to the
 *  env-forced model exactly as before. The client can therefore never
 *  spend the shared credential on a model the operator didn't budget
 *  for — and provider/baseUrl remain server-env-only regardless (see
 *  resolveLlmConfig; this function relaxes MODEL choice, nothing
 *  else). */
export function pickModel(
  cfg: ResolvedLlmConfig,
  requestedModel: string | undefined,
  fallbackDefault: string,
): string {
  if (!cfg.isServerKey) {
    return requestedModel ?? fallbackDefault;
  }
  if (requestedModel && cfg.allowedModels.includes(requestedModel)) {
    return requestedModel;
  }
  return cfg.forcedModel ?? fallbackDefault;
}

// ---------------------------------------------------------------
// callJson — structured-output call with a manual-extraction fallback.
// (Server-only: the Anthropic SDK client object. The client-side
// equivalent, using raw fetch, is clientProvider.ts's
// callAnthropicDirect — see that file for why it can't just call this.)
// ---------------------------------------------------------------

async function callJsonViaFallback<T>(
  client: Anthropic,
  opts: CallJsonOptions<T>,
): Promise<T> {
  const message = await client.messages.create(buildAnthropicMessagesRequestBody(opts));

  const textBlock = message.content.find(
    (b): b is TextBlock => b.type === "text",
  );
  if (!textBlock || !textBlock.text.trim()) {
    throw new BadOutputError("模型未返回文本内容");
  }

  return parseJsonContent(textBlock.text, opts);
}

/**
 * Call the Anthropic Messages API and parse the reply against `schema`.
 *
 * Primary path: `messages.parse()` with `output_config.format` built
 * from `zodOutputFormat(schema)` — the SDK parses + validates server
 * side and hands back `parsed_output`.
 *
 * Fallback path (used whenever the primary path throws — e.g. a
 * model without structured-output support returning a BadRequestError,
 * or any other runtime hiccup with the parse helper): plain
 * `messages.create()`, extract the first text block, run the
 * balanced-brace JSON extractor, `JSON.parse`, then `schema.safeParse`.
 * This mirrors callJsonViaFallback exactly, so both paths behave the
 * same way for callers regardless of which one actually served the
 * request.
 */
export async function callJson<T>(opts: CallJsonOptions<T>): Promise<T> {
  if (opts.provider === "openai-compat") {
    return callJsonOpenAiCompat(opts);
  }

  const client = new Anthropic({ apiKey: opts.apiKey });

  try {
    const message = await client.messages.parse({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: buildSystemParam(opts.system, opts.cacheSystem),
      messages: [{ role: "user", content: opts.user }],
      output_config: {
        format: zodOutputFormat(opts.schema),
      },
      // NOTE: never pass `temperature` or `thinking` here — newer
      // models 400 on sampling params for this call shape.
    });

    if (message.parsed_output != null) {
      return message.parsed_output;
    }
    // parsed_output came back null (e.g. refusal/stop before JSON
    // completed) — fall through to the manual-extraction fallback
    // rather than surfacing a silent null.
  } catch (err) {
    // Anthropic.AuthenticationError / RateLimitError must propagate
    // untouched so the route can map them to the right HTTP status —
    // only swallow-and-retry-via-fallback for anything else (e.g. a
    // BadRequestError from a model without structured-output support).
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.RateLimitError) {
      throw err;
    }
    // else: fall through to fallback path below.
  }

  return callJsonViaFallback(client, opts);
}

// ---------------------------------------------------------------
// callJsonWithFallback — #61 server-side model fallback.
// ---------------------------------------------------------------

/** callJson, retrying ONCE on `fallbackModel` when the primary model
 *  fails in a way a different model could plausibly survive:
 *  upstream 5xx/model-guardrail 4xx, per-model 429 capacity, or
 *  unparseable output (BadOutputError). Auth failures (401/403) never
 *  retry — the key is the problem, not the model. No-op when
 *  fallbackModel is null (BYOK always) or equals the primary. This
 *  covers ERROR cases only — a slow-but-alive primary is governed by
 *  the client's own request timeout, not raced here.
 *
 *  429 stays in the retryable set DELIBERATELY (Codex review flagged
 *  the 2x-upstream-calls-per-request amplification): a per-model
 *  capacity 429 is the single most common failure this fallback
 *  exists for (primary at peak → fallback serves the user), a 429'd
 *  call is rejected before inference so it doesn't bill, the
 *  amplification is bounded at 2x of an already per-IP-rate-limited
 *  route, and in the account-cap-exhausted case both calls 429 and
 *  the client degrades to the #54 dictionary floor anyway. */
export async function callJsonWithFallback<T>(
  opts: CallJsonOptions<T>,
  fallbackModel: string | null,
): Promise<T> {
  try {
    return await callJson(opts);
  } catch (err) {
    if (!fallbackModel || fallbackModel === opts.model) throw err;
    const retryable =
      err instanceof BadOutputError ||
      (err instanceof OpenAiCompatError && err.status !== 401 && err.status !== 403);
    if (!retryable) throw err;
    return callJson({ ...opts, model: fallbackModel });
  }
}

/** Binds a per-request `fallbackModel` into a ProviderCaller so
 *  detect/define/translate's routes can pass callJsonWithFallback into
 *  the shared tasks/*.ts orchestration (see providerCore.ts's
 *  ProviderCaller) without each route re-deriving this same generic-
 *  function-expression boilerplate. (Plain `callJson` already satisfies
 *  ProviderCaller directly — no wrapper needed — since summarize's
 *  route deliberately never uses the fallback model, see
 *  tasks/summarize.ts's header comment.) */
export function withFallback(fallbackModel: string | null): ProviderCaller {
  return function callWithFallback<T>(opts: CallJsonOptions<T>): Promise<T> {
    return callJsonWithFallback(opts, fallbackModel);
  };
}

// ---------------------------------------------------------------
// Error mapping helper — routes use this to decide the HTTP status
// and ApiErrorBody. Kept here so both routes stay consistent.
// ---------------------------------------------------------------

export interface MappedError {
  status: number;
  body: { error: string; code?: "no_key" | "bad_request" | "upstream" | "rate_limit" };
}

export function mapLlmError(err: unknown): MappedError {
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 401, body: { error: "API Key 无效", code: "no_key" } };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, body: { error: "请求过于频繁，请稍后重试", code: "rate_limit" } };
  }
  if (err instanceof OpenAiCompatError) {
    if (err.status === 400 && err.message === "缺少 Base URL") {
      return { status: 400, body: { error: "缺少 Base URL", code: "bad_request" } };
    }
    if (err.status === 401 || err.status === 403) {
      return { status: 401, body: { error: "API Key 无效", code: "no_key" } };
    }
    if (err.status === 429) {
      return { status: 429, body: { error: "请求过于频繁，请稍后重试", code: "rate_limit" } };
    }
    return { status: 502, body: { error: err.message, code: "upstream" } };
  }
  if (err instanceof BadOutputError) {
    return { status: 502, body: { error: "模型输出解析失败", code: "upstream" } };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: 502, body: { error: err.message, code: "upstream" } };
  }
  return {
    status: 502,
    body: { error: err instanceof Error ? err.message : "未知错误", code: "upstream" },
  };
}
