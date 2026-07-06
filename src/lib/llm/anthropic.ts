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

  const jsonText = extractJsonObject(textBlock.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new BadOutputError("模型输出解析失败：JSON 格式错误", err);
  }

  const result = opts.schema.safeParse(parsed);
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

async function callJsonOpenAiCompat<T>(opts: CallJsonOptions<T>): Promise<T> {
  if (!opts.baseUrl) {
    throw new OpenAiCompatError("缺少 Base URL", 400);
  }

  const baseRequest = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    // NOTE: never pass `temperature` here — keep sampling defaults.
  };

  let res = await postChatCompletions(opts.baseUrl, opts.apiKey, {
    ...baseRequest,
    response_format: { type: "json_object" },
  });

  // Some openai-compat servers reject response_format with a 400 —
  // retry once without it before treating the request as failed.
  if (res.status === 400) {
    res = await postChatCompletions(opts.baseUrl, opts.apiKey, baseRequest);
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

  const jsonText = extractJsonObject(content);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new BadOutputError("模型输出解析失败：JSON 格式错误", err);
  }

  const result = opts.schema.safeParse(parsed);
  if (!result.success) {
    throw new BadOutputError(
      `模型输出解析失败：${result.error.issues[0]?.message ?? "schema mismatch"}`,
      result.error,
    );
  }

  return result.data;
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
