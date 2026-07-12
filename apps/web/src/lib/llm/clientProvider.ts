// v0.4 S2 (PLAN-v0.4 §1A/§4) — the client-side ProviderCaller: calls
// the LLM provider directly over HTTP (no Node server involved), for
// the client-side callProvider path lib/llm/client.ts uses when
// llmTransport.ts's useClientTransport() is on. This is what S3's
// Tauri desktop build runs exclusively (no /api/* routes exist there —
// static export, see next.config.mjs's BUILD_TARGET=desktop hook).
//
// openai-compat: fully reused, zero new logic — providerCore.ts's
// callJsonOpenAiCompat is ALREADY plain fetch (isomorphic), so the
// exact same function serves both the existing server route (via
// anthropic.ts's re-export) and this client path; only the Transport
// it resolves through differs (llmTransport.ts's getTransport, unset
// server-side, injected by S3 client-side).
//
// anthropic: genuinely new — the server path calls the Anthropic SDK's
// `.messages.create()`/`.parse()` (never hand-rolls the HTTP request),
// so there is no existing raw-fetch call to extract here. Verified
// against the installed @anthropic-ai/sdk (0.110.0) source
// (node_modules/@anthropic-ai/sdk/client.mjs): POST
// https://api.anthropic.com/v1/messages, headers `X-Api-Key`,
// `anthropic-version: 2023-06-01`, and — only when
// `dangerouslyAllowBrowser` is set — `anthropic-dangerous-direct-
// browser-access: true` (see buildHeaders/authHeaders in that file).
// The request BODY shape is shared with the server's SDK-fallback path
// via providerCore.ts's buildAnthropicMessagesRequestBody (prompt-cache
// preservation, risk #4 — byte-identical `system`).
//
// Anthropic provider never carries a baseUrl override here, matching
// server behavior exactly: anthropic.ts's callJson constructs
// `new Anthropic({ apiKey: opts.apiKey })` with NO baseUrl even though
// CallJsonOptions.baseUrl exists (that field is openai-compat-only —
// see resolveLlmConfig/taskHeaders, which likewise only ever send the
// base-url header for provider "openai-compat").

import {
  buildAnthropicMessagesRequestBody,
  callJsonOpenAiCompat,
  parseJsonContent,
  BadOutputError,
  type CallJsonOptions,
} from "./providerCore";
import { getTransport } from "./llmTransport";

/** Thrown for any non-2xx response from a DIRECT provider call (both
 *  Anthropic-direct and, via callJsonOpenAiCompat, openai-compat-
 *  direct share this error's SHAPE — but openai-compat's own call
 *  path already throws providerCore.ts's OpenAiCompatError, unchanged,
 *  for server-path re-export compatibility). Kept distinct from
 *  OpenAiCompatError (rather than reusing it for Anthropic too) so a
 *  future reader never has to wonder why an Anthropic failure carries
 *  an "OpenAiCompat"-named error — same `{ message, status }` shape,
 *  correct name. lib/llm/client.ts's direct-path error mapper checks
 *  for EITHER class (see mapDirectProviderError). */
export class ProviderHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

const ANTHROPIC_DIRECT_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicDirectContentBlock {
  type: string;
  text?: string;
}

interface AnthropicDirectMessageResponse {
  content?: AnthropicDirectContentBlock[];
}

async function callAnthropicDirect<T>(opts: CallJsonOptions<T>): Promise<T> {
  const body = buildAnthropicMessagesRequestBody(opts);

  const res = await getTransport()(ANTHROPIC_DIRECT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      // Required for a browser (or Tauri webview) origin to be allowed
      // to call the Messages API directly at all — see this file's
      // header comment for the SDK-source verification.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
    ...(opts.timeoutMs !== undefined ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderHttpError(text.slice(0, 500) || `请求失败（${res.status}）`, res.status);
  }

  let payload: AnthropicDirectMessageResponse;
  try {
    payload = (await res.json()) as AnthropicDirectMessageResponse;
  } catch (err) {
    throw new BadOutputError("模型输出解析失败：JSON 格式错误", err);
  }

  const textBlock = payload.content?.find((b) => b.type === "text" && b.text?.trim());
  if (!textBlock?.text) {
    throw new BadOutputError("模型未返回文本内容");
  }

  return parseJsonContent(textBlock.text, opts);
}

/** The client path's ProviderCaller (providerCore.ts's ProviderCaller
 *  type) — every tasks/*.ts module calls through this (or the server's
 *  SDK-based equivalent in anthropic.ts) without knowing which one it
 *  got. Never uses SDK structured-output/`output_config` — always the
 *  manual-extraction shape (extractJsonValue + schema.safeParse), which
 *  is already what callers observe from the server path whenever its
 *  primary structured-output attempt doesn't apply (callJsonViaFallback
 *  is the SAME shape) — so this is not a behavior downgrade, just the
 *  one shape used unconditionally instead of attempted-then-fallen-
 *  back-to. */
export async function callProviderDirect<T>(opts: CallJsonOptions<T>): Promise<T> {
  if (opts.provider === "openai-compat") {
    return callJsonOpenAiCompat(opts);
  }
  return callAnthropicDirect(opts);
}
