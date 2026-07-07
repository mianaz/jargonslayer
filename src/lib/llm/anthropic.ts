// Server-only Anthropic client helper. Never import this from a
// client component — it reads process.env and is meant to run in
// Next.js route handlers only. (No `server-only` package guard: it
// is not in the approved dependency list, so this relies on the
// import graph — only api/detect and api/summarize import it.)

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageParam, TextBlock } from "@anthropic-ai/sdk/resources/messages";
import * as z from "zod";
import type {
  DetectedExpression,
  DetectedTerm,
  ExpressionCategory,
  LlmProvider,
  MeetingSummary,
  TermType,
  TranslateResponse,
} from "../types";
import { PROVIDER_HEADERS } from "../types";

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
    extraBody: isOpenRouter
      ? {
          provider: { data_collection: "allow" },
          // Translation needs no chain-of-thought, and the hosted
          // reasoning model (minimax-m3) pays for one by default —
          // measured 2026-07-06: disabling it cut wall time 4.0s ->
          // 1.7s and cost to ~1/4 (320 -> 0 reasoning tokens), with
          // clean (unfenced) JSON output. Scoped to "translate" only:
          // detect/summary/define still benefit from reasoning.
          ...(kind === "translate" ? { reasoning: { enabled: false } } : {}),
        }
      : undefined,
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
// Shared zod schemas — mirror the wire types in ../types.ts exactly.
// Field names are part of the LLM JSON contract; do not rename.
// ---------------------------------------------------------------

const EXPRESSION_CATEGORY_VALUES = [
  "idiom",
  "slang",
  "phrase",
  "metaphor",
  "indirect",
  "other",
] as const satisfies readonly ExpressionCategory[];

const TERM_TYPE_VALUES = [
  "acronym",
  "company",
  "product",
  "tech",
  "metric",
  "person",
  "other",
] as const satisfies readonly TermType[];

const DetectedExpressionSchema = z.object({
  expression: z.string(),
  category: z.enum(EXPRESSION_CATEGORY_VALUES),
  meaning: z.string(),
  chinese_explanation: z.string(),
  plain_english: z.string(),
  tone: z.string(),
  confidence: z.number(),
  source_sentence: z.string(),
}) satisfies z.ZodType<DetectedExpression>;

const DetectedTermSchema = z.object({
  term: z.string(),
  type: z.enum(TERM_TYPE_VALUES),
  gloss_en: z.string(),
  gloss_zh: z.string(),
}) satisfies z.ZodType<DetectedTerm>;

export const DetectResponseSchema = z.object({
  expressions: z.array(DetectedExpressionSchema),
  terms: z.array(DetectedTermSchema),
});

const BilingualLineSchema = z.object({
  en: z.string(),
  zh: z.string(),
});

const ActionItemSchema = z.object({
  owner: z.string(),
  en: z.string(),
  zh: z.string(),
  due: z.string(),
});

export const MeetingSummarySchema = z.object({
  topic: BilingualLineSchema,
  key_points: z.array(BilingualLineSchema),
  decisions: z.array(BilingualLineSchema),
  action_items: z.array(ActionItemSchema),
}) satisfies z.ZodType<MeetingSummary>;

export const TranslationsSchema = z.object({
  translations: z.array(
    z.object({
      i: z.number(),
      zh: z.string(),
    }),
  ),
});

// Live bilingual transcript (#42) — id-keyed shape, distinct from the
// index-keyed TranslationsSchema above (post-meeting summary stage).
export const TranslateSegmentsSchema = z.object({
  translations: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
    }),
  ),
}) satisfies z.ZodType<TranslateResponse>;

// ---------------------------------------------------------------
// Confidence clamping — callers may also clamp again downstream;
// this keeps parsed output well-formed regardless of path taken.
// ---------------------------------------------------------------

export function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function clampExpressionConfidences(res: {
  expressions: DetectedExpression[];
  terms: DetectedTerm[];
}): { expressions: DetectedExpression[]; terms: DetectedTerm[] } {
  return {
    expressions: res.expressions.map((e) => ({
      ...e,
      confidence: clampConfidence(e.confidence),
    })),
    terms: res.terms,
  };
}

// ---------------------------------------------------------------
// Typed error for JSON-extraction / schema-validation failures so
// routes can map it to a distinct HTTP status.
// ---------------------------------------------------------------

export class BadOutputError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "BadOutputError";
  }
}

// ---------------------------------------------------------------
// Balanced-brace JSON extractor: scans from the first "{" tracking
// string/escape state until its matching "}", so surrounding prose
// or trailing tokens from a non-compliant model don't break parsing.
// ---------------------------------------------------------------

export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new BadOutputError("模型输出中未找到 JSON 对象");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  throw new BadOutputError("模型输出的 JSON 对象未闭合");
}

// ---------------------------------------------------------------
// Robust JSON-value extractor: unlike extractJsonObject above, this
// tolerates the three real-world OpenAI-compat failure modes seen in
// production —
//   1. a bare top-level array (`[{...}, {...}]`) instead of an object,
//   2. ```json ... ``` markdown fences around the payload,
//   3. R1-style <think>...</think> reasoning preambles that may
//      themselves contain stray braces.
// Strips (1) think-blocks, then (2) prefers fenced content if present,
// then does a balanced scan from the first "{" or "[" (whichever
// comes first) tracking both brace/bracket depth and string/escape
// state. Kept as a separate function so extractJsonObject's simpler,
// object-only contract is undisturbed for existing callers.
// ---------------------------------------------------------------

const THINK_BLOCK_RE = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
const FENCED_CODE_RE = /```(?:json)?\s*([\s\S]*?)```/i;

export function extractJsonValue(text: string): string {
  const withoutThink = text.replace(THINK_BLOCK_RE, "");

  const fenceMatch = withoutThink.match(FENCED_CODE_RE);
  const candidate = fenceMatch ? fenceMatch[1] : withoutThink;

  const braceStart = candidate.indexOf("{");
  const bracketStart = candidate.indexOf("[");
  const start =
    braceStart === -1
      ? bracketStart
      : bracketStart === -1
        ? braceStart
        : Math.min(braceStart, bracketStart);

  if (start === -1) {
    throw new BadOutputError("模型输出中未找到 JSON");
  }

  const opener = candidate[start];
  const closer = opener === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === opener) {
      depth++;
    } else if (ch === closer) {
      depth--;
      if (depth === 0) {
        return candidate.slice(start, i + 1);
      }
    }
  }

  throw new BadOutputError("模型输出的 JSON 未闭合");
}

// ---------------------------------------------------------------
// callJson — structured-output call with a manual-extraction fallback.
// ---------------------------------------------------------------

export interface CallJsonOptions<T> {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  /** Mark the system prompt as ephemeral-cacheable (long, static
   *  prompts reused across many calls, e.g. live detection). */
  cacheSystem?: boolean;
  /** Which endpoint family to call. Defaults to "anthropic" so
   *  existing call sites keep working unchanged. */
  provider?: LlmProvider;
  /** Required when provider is "openai-compat", e.g.
   *  https://api.deepseek.com or http://localhost:11434/v1. */
  baseUrl?: string;
  /** When set and the extracted JSON value parses to a top-level
   *  array, wrap it as `{ [arrayKey]: parsed }` before schema
   *  validation. Lets schemas shaped like `{ translations: [...] }`
   *  tolerate a model that (incorrectly, but commonly) returns the
   *  bare array instead of the wrapping object. */
  arrayKey?: string;
  /** Extra JSON merged into the openai-compat request body (ignored on
   *  the Anthropic path). See ResolvedLlmConfig.extraBody. */
  extraBody?: Record<string, unknown>;
}

/** If `parsed` is an array and `arrayKey` is set, wrap it as
 *  `{ [arrayKey]: parsed }`; otherwise return `parsed` unchanged. */
function applyArrayKey(parsed: unknown, arrayKey: string | undefined): unknown {
  if (arrayKey && Array.isArray(parsed)) {
    return { [arrayKey]: parsed };
  }
  return parsed;
}

/** Build the `system` param — either a plain string, or a single
 *  cache_control-tagged text block when cacheSystem is requested. */
function buildSystemParam(system: string, cacheSystem?: boolean) {
  if (!cacheSystem) return system;
  return [
    {
      type: "text" as const,
      text: system,
      cache_control: { type: "ephemeral" as const },
    },
  ];
}

async function callJsonViaFallback<T>(
  client: Anthropic,
  opts: CallJsonOptions<T>,
): Promise<T> {
  const message = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: buildSystemParam(opts.system, opts.cacheSystem),
    messages: [{ role: "user", content: opts.user } satisfies MessageParam],
    // NOTE: never pass `temperature` or `thinking` here — newer
    // models 400 on sampling params for this call shape.
  });

  const textBlock = message.content.find(
    (b): b is TextBlock => b.type === "text",
  );
  if (!textBlock || !textBlock.text.trim()) {
    throw new BadOutputError("模型未返回文本内容");
  }

  const jsonText = extractJsonValue(textBlock.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new BadOutputError("模型输出解析失败：JSON 格式错误", err);
  }

  const result = opts.schema.safeParse(applyArrayKey(parsed, opts.arrayKey));
  if (!result.success) {
    throw new BadOutputError(
      `模型输出解析失败：${result.error.issues[0]?.message ?? "schema mismatch"}`,
      result.error,
    );
  }

  return result.data;
}

// ---------------------------------------------------------------
// OpenAI-compatible chat-completions path (DeepSeek / Qwen /
// OpenRouter / Ollama / any server speaking the same wire shape).
// ---------------------------------------------------------------

/** Thrown for any non-2xx response from an openai-compat endpoint.
 *  Carries the upstream HTTP status so mapLlmError can classify it
 *  the same way it classifies Anthropic.AuthenticationError/RateLimitError. */
export class OpenAiCompatError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "OpenAiCompatError";
  }
}

interface OpenAiChatResponse {
  choices?: { message?: { content?: string | null } }[];
}

async function postChatCompletions(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

/** Extra instruction appended to `system` on the single repair retry
 *  below, to steer a non-compliant model away from the three failure
 *  modes extractJsonValue already tolerates but which are cheaper to
 *  avoid outright: fences, <think> blocks, and stray commentary. */
const OPENAI_COMPAT_JSON_REMINDER =
  "\n\nCRITICAL: Respond with ONLY a raw JSON value that matches the required shape. No markdown code fences, no <think> blocks, no commentary before or after.";

/** POST to `/chat/completions` (retrying once without `response_format`
 *  if the server 400s on it) and return the message content string.
 *  Non-2xx responses throw OpenAiCompatError — this must NOT be
 *  retried as a parse failure, so callers should let it propagate
 *  untouched rather than folding it into the repair-retry loop. */
async function requestChatContent(opts: CallJsonOptions<unknown>, system: string): Promise<string> {
  const baseRequest = {
    ...(opts.extraBody ?? {}),
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: opts.user },
    ],
    // NOTE: never pass `temperature` here — keep sampling defaults.
  };

  let res = await postChatCompletions(opts.baseUrl!, opts.apiKey, {
    ...baseRequest,
    response_format: { type: "json_object" },
  });

  // Some openai-compat servers reject response_format with a 400 —
  // retry once without it before treating the request as failed.
  if (res.status === 400) {
    res = await postChatCompletions(opts.baseUrl!, opts.apiKey, baseRequest);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OpenAiCompatError(
      text.slice(0, 500) || `请求失败（${res.status}）`,
      res.status,
    );
  }

  let payload: OpenAiChatResponse;
  try {
    payload = (await res.json()) as OpenAiChatResponse;
  } catch (err) {
    throw new BadOutputError("模型输出解析失败：JSON 格式错误", err);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    throw new BadOutputError("模型未返回文本内容");
  }

  return content;
}

/** Extract + parse + schema-validate a chat-completion's content
 *  string. Throws BadOutputError on any failure — callers use this to
 *  decide whether the single repair retry applies. */
function parseJsonContent<T>(content: string, opts: CallJsonOptions<T>): T {
  const jsonText = extractJsonValue(content);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new BadOutputError("模型输出解析失败：JSON 格式错误", err);
  }

  const result = opts.schema.safeParse(applyArrayKey(parsed, opts.arrayKey));
  if (!result.success) {
    throw new BadOutputError(
      `模型输出解析失败：${result.error.issues[0]?.message ?? "schema mismatch"}`,
      result.error,
    );
  }

  return result.data;
}

async function callJsonOpenAiCompat<T>(opts: CallJsonOptions<T>): Promise<T> {
  if (!opts.baseUrl) {
    throw new OpenAiCompatError("缺少 Base URL", 400);
  }

  const content = await requestChatContent(opts, opts.system);

  try {
    return parseJsonContent(content, opts);
  } catch (err) {
    if (!(err instanceof BadOutputError)) throw err;
    // Extraction/parse/schema failure — give the model exactly one
    // more chance with a hardened system-prompt reminder. Non-2xx
    // HTTP responses never reach here: requestChatContent throws
    // OpenAiCompatError for those, which propagates untouched above.
  }

  const retryContent = await requestChatContent(
    opts,
    opts.system + OPENAI_COMPAT_JSON_REMINDER,
  );
  return parseJsonContent(retryContent, opts);
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
      messages: [{ role: "user", content: opts.user } satisfies MessageParam],
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
 *  the client's own request timeout, not raced here. */
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
    return { status: 429, body: { error: "请求过于频繁，请稍后再试", code: "rate_limit" } };
  }
  if (err instanceof OpenAiCompatError) {
    if (err.status === 400 && err.message === "缺少 Base URL") {
      return { status: 400, body: { error: "缺少 Base URL", code: "bad_request" } };
    }
    if (err.status === 401 || err.status === 403) {
      return { status: 401, body: { error: "API Key 无效", code: "no_key" } };
    }
    if (err.status === 429) {
      return { status: 429, body: { error: "请求过于频繁，请稍后再试", code: "rate_limit" } };
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

export { clampExpressionConfidences };
