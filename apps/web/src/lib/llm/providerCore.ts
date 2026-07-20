// Isomorphic LLM provider core — safe to import from EITHER server code
// (anthropic.ts, Next.js route handlers) OR client/browser code (the
// S2 client-side callProvider path, lib/llm/clientProvider.ts). Unlike
// anthropic.ts, this file must never read `process.env` and must never
// assume a Node runtime — every export here is a pure function, a pure
// value (zod schema / constant), or a tiny stateless class.
//
// Why this file exists (v0.4 S2, PLAN-v0.4 §1A/§4): the request-
// shaping/parsing logic that used to live only in anthropic.ts is now
// shared by TWO callers — the existing Next.js routes (server-only,
// still going through anthropic.ts's Anthropic-SDK-based callJson for
// the "anthropic" provider) and the new client-side direct-to-provider
// path (lib/llm/clientProvider.ts, raw fetch only, Tauri desktop has no
// Node server to route through). Moving the SHARED pieces here once —
// rather than forking a second copy for the client path — is the
// "extract, don't fork" contract from the S2 design doc. anthropic.ts
// re-exports every symbol below under its original name, so every
// existing importer (routes, anthropic-openai-compat.test.ts) is
// unaffected by the move.

import * as z from "zod";
import type {
  CorrectResponse,
  DefineResult,
  DetectedExpression,
  DetectedTerm,
  ExpressionCategory,
  LlmProvider,
  MeetingSummary,
  TermType,
  TranslateResponse,
} from "@jargonslayer/core/types";
import { getTransport } from "./llmTransport";

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

// AI transcript correction (v0.5 Wave-1 Feature 2, §5 A5) — id-keyed,
// mirrors TranslateSegmentsSchema's shape exactly. This schema is shape
// validation ONLY (id: string, text: string); rejecting a blank/
// duplicate id and filtering to requested ids is the task module's job
// (tasks/correct.ts's postFilter, mirroring translate's own postFilter
// placement) — a single malformed row must never sink the whole batch.
export const CorrectResponseSchema = z.object({
  corrections: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
    }),
  ),
}) satisfies z.ZodType<CorrectResponse>;

// "define this" (on-demand personal-dictionary entry) — moved here
// (was inline in app/api/define/route.ts) so tasks/define.ts's shared
// orchestration can validate against the SAME schema instance the
// route always has, for both the Next.js path and the client path.
export const DefineResultSchema = z.object({
  kind: z.enum(["expression", "term"]),
  headword: z.string(),
  variants: z.array(z.string()),
  chinese_explanation: z.string(),
  example: z.string(),
  // expression-only
  category: z.enum(EXPRESSION_CATEGORY_VALUES).optional(),
  meaning: z.string().optional(),
  plain_english: z.string().optional(),
  tone: z.string().optional(),
  // term-only
  termType: z.enum(TERM_TYPE_VALUES).optional(),
  gloss_en: z.string().optional(),
}) satisfies z.ZodType<DefineResult>;

// ---------------------------------------------------------------
// Confidence clamping — callers may also clamp again downstream;
// this keeps parsed output well-formed regardless of path taken.
// ---------------------------------------------------------------

export function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function clampExpressionConfidences(res: {
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
// routes/the client path can map it to a distinct HTTP status / error
// class.
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
// callJson options — the one shared "build a provider request, parse
// the reply" value object. Every task module (tasks/*.ts) builds one
// of these per provider call; anthropic.ts's SDK-based callJson/
// callJsonWithFallback (server, Anthropic SDK) and clientProvider.ts's
// callProviderDirect (client, raw fetch) both accept this exact same
// shape — that symmetry is what lets tasks/*.ts stay provider-caller-
// agnostic (see ProviderCaller below).
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
  /** Client-path-only: abort the call after this many ms (see
   *  clientProvider.ts's callAnthropicDirect/callJsonOpenAiCompat).
   *  anthropic.ts's SDK-based callJson ignores this field entirely —
   *  the server route has no equivalent per-call abort budget (Next.js
   *  bounds route execution via `maxDuration` instead), so leaving it
   *  unset there is intentional, not an oversight. */
  timeoutMs?: number;
}

/** A function that turns CallJsonOptions into a parsed, schema-
 *  validated result — the one seam every isomorphic task module
 *  (tasks/*.ts) calls through. The Next.js routes inject a wrapper
 *  around anthropic.ts's SDK-based callJson/callJsonWithFallback
 *  (server-only concerns — pickModel's allowlist, the #61 fallback
 *  model, rate limiting — are already resolved BEFORE this point, see
 *  each route); the client path (lib/llm/client.ts) injects
 *  clientProvider.ts's callProviderDirect. Neither the task modules nor
 *  this type know which one is in play. */
export type ProviderCaller = <T>(opts: CallJsonOptions<T>) => Promise<T>;

/** If `parsed` is an array and `arrayKey` is set, wrap it as
 *  `{ [arrayKey]: parsed }`; otherwise return `parsed` unchanged. */
export function applyArrayKey(parsed: unknown, arrayKey: string | undefined): unknown {
  if (arrayKey && Array.isArray(parsed)) {
    return { [arrayKey]: parsed };
  }
  return parsed;
}

/** Build the `system` param — either a plain string, or a single
 *  cache_control-tagged text block when cacheSystem is requested. */
export function buildSystemParam(system: string, cacheSystem?: boolean) {
  if (!cacheSystem) return system;
  return [
    {
      type: "text" as const,
      text: system,
      cache_control: { type: "ephemeral" as const },
    },
  ];
}

/** Build the Anthropic Messages API request body — shared by
 *  anthropic.ts's SDK-based callJsonViaFallback (server, the SDK's
 *  `.messages.create()` takes this exact shape) and clientProvider.ts's
 *  raw-fetch callAnthropicDirect (client — JSON.stringify'd straight
 *  into the POST body). This is the "provider request-shaping" the S2
 *  design doc calls out to extract rather than fork: prompt-cache
 *  survival (risk #4) depends on both paths sending byte-identical
 *  `system`. Deliberately the manual-extraction shape only (no
 *  `output_config`/structured-output params) — matches
 *  callJsonViaFallback exactly, which is already the SDK's own
 *  fallback-path shape and is what callers observe today whenever the
 *  primary structured-output attempt doesn't apply. */
export function buildAnthropicMessagesRequestBody<T>(opts: CallJsonOptions<T>) {
  return {
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: buildSystemParam(opts.system, opts.cacheSystem),
    messages: [{ role: "user" as const, content: opts.user }],
  };
}

/** Extract + parse + schema-validate a chat-completion's content
 *  string. Throws BadOutputError on any failure — callers use this to
 *  decide whether a single repair retry (openai-compat) applies, or
 *  simply propagate (Anthropic direct/SDK-fallback paths, which don't
 *  retry). Shared by anthropic.ts's callJsonOpenAiCompat AND (via the
 *  same function) both callJsonViaFallback's SDK-fallback text block
 *  and clientProvider.ts's callAnthropicDirect text block — one parse/
 *  validate implementation for every path that ends up with a raw
 *  assistant-text string to extract JSON from. */
export function parseJsonContent<T>(content: string, opts: CallJsonOptions<T>): T {
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

// ---------------------------------------------------------------
// OpenAI-compatible chat-completions path (DeepSeek / Qwen /
// OpenRouter / Ollama / any server speaking the same wire shape).
// Fully isomorphic (plain fetch, no Node-only API) — the SAME
// implementation serves anthropic.ts's server-side callJsonOpenAiCompat
// AND clientProvider.ts's client-side direct path; only the Transport
// the fetch call resolves through differs (see llmTransport.ts's
// getTransport — server never calls setTransport, so this keeps
// calling the real global fetch exactly as before the S2 move).
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

/** Pure request-shaping: URL + RequestInit for a `/chat/completions`
 *  POST. Split out from postChatCompletions below so the URL/header/
 *  body construction itself has exactly one implementation regardless
 *  of which Transport ends up issuing the fetch. */
export function buildOpenAiCompatRequestInit(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
): { url: string; init: RequestInit } {
  return {
    url: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
  };
}

async function postChatCompletions(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Response> {
  const { url, init } = buildOpenAiCompatRequestInit(baseUrl, apiKey, body);
  return getTransport()(url, {
    ...init,
    ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
}

// ---------------------------------------------------------------
// Raw-response-excerpt sanitation (F1, codex v04-integration review):
// requestChatContent below (openai-compat — used by BOTH the server
// route path, via anthropic.ts's callJsonOpenAiCompat re-export, AND
// the client-side callProvider path, via clientProvider.ts) and
// clientProvider.ts's own callAnthropicDirect each embed up to 500
// chars of a non-2xx provider response body into an Error message —
// genuinely useful for surfacing a plain-text upstream error. A
// misconfigured or hostile endpoint that echoes request headers back
// into its response body would otherwise put the caller's own API key
// straight into that excerpt, which then propagates UNFILTERED into
// OpenAiCompatError/ProviderHttpError.message, mapLlmError's HTTP
// error body (server path — including the server's OWN shared key
// when JARGONSLAYER_PROVIDER=openai-compat, a pre-existing risk now
// fixed here since providerCore is the shared seam both paths call
// through), client.ts's thrown UpstreamError (both the server-routed
// and direct client paths — see throwForStatus/throwForProviderError,
// which deliberately let body.error/err.message through verbatim to
// the user-facing toast), and every `console.warn(..., err)` call site
// that logs the raw Error object (detect/scheduler.ts, translate/
// queue.ts, tasks/summarize.ts's fail-soft catches) — all of those
// just read this SAME Error's `.message` after the fact. Sanitizing
// once, here, at construction time (both call sites below route the
// raw response text through this before building the Error) closes
// every one of those downstream sites without touching any of them
// individually — see tasks/summarize.ts's own comment on its
// console.warn sites for why nothing changed there either.
// ---------------------------------------------------------------

/** Authorization/X-Api-Key-shaped header echoes — catches a hostile or
 *  misconfigured endpoint mirroring request headers back into its
 *  response body even when the echoed value doesn't byte-for-byte
 *  match a known secret (re-quoted, re-cased, or truncated). Applied
 *  IN ADDITION to the exact-secret replacement below, never instead
 *  of it. */
const SECRET_HEADER_RE = /(authorization|x-api-key)\s*[:=]\s*\S+/gi;

/** Redact every occurrence of each non-empty entry in `secrets` from
 *  `text`, then strip Authorization/X-Api-Key header-shaped patterns.
 *  Every call site that turns a raw provider response body into an
 *  Error message must route the text through this FIRST, on the FULL
 *  (untruncated) text — sanitizing before the caller's char-count cap
 *  is applied, rather than after, so a secret that straddles or falls
 *  past that cap boundary is still caught, and the cap never leaves a
 *  partial-but-recognizable secret fragment visible. Plain string
 *  split/join (not RegExp) for the exact-secret pass, so a key
 *  containing regex metacharacters never needs escaping. */
export function sanitizeProviderExcerpt(text: string, secrets: readonly string[]): string {
  let sanitized = text;
  for (const secret of secrets) {
    if (!secret) continue;
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized.replace(SECRET_HEADER_RE, "$1: [REDACTED]");
}

/** Extra instruction appended to `system` on the single repair retry
 *  below, to steer a non-compliant model away from the three failure
 *  modes extractJsonValue already tolerates but which are cheaper to
 *  avoid outright: fences, <think> blocks, and stray commentary. */
export const OPENAI_COMPAT_JSON_REMINDER =
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

  let res = await postChatCompletions(
    opts.baseUrl!,
    opts.apiKey,
    { ...baseRequest, response_format: { type: "json_object" } },
    opts.timeoutMs,
  );

  // Some openai-compat servers reject response_format with a 400 —
  // retry once without it before treating the request as failed.
  if (res.status === 400) {
    res = await postChatCompletions(opts.baseUrl!, opts.apiKey, baseRequest, opts.timeoutMs);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // F1 (codex v04-integration review): sanitize BEFORE truncating —
    // see sanitizeProviderExcerpt's own comment above.
    const safeText = sanitizeProviderExcerpt(text, [opts.apiKey]).slice(0, 500);
    throw new OpenAiCompatError(
      safeText || `请求失败（${res.status}）`,
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

export async function callJsonOpenAiCompat<T>(opts: CallJsonOptions<T>): Promise<T> {
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
