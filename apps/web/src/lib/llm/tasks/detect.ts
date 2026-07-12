// Isomorphic "detect" task (v0.4 S2, PLAN-v0.4 §1A/§4) — the shared
// orchestration app/api/detect/route.ts (server, Next.js) and
// lib/llm/client.ts's client-side path (browser/Tauri, BYOK-only) both
// call: prompt assembly (@jargonslayer/core/llm/prompts) -> provider
// call (an injected ProviderCaller) -> anti-hallucination post-filter.
// Server-only concerns (pickModel's allowlist, rate limiting, the #61
// fallback model, resolveLlmConfig's env fallback) stay entirely in
// route.ts — this module never sees them; it receives an already-
// resolved apiKey/provider/baseUrl/model and an already-resolved
// ProviderCaller (see providerCore.ts's ProviderCaller type).

import type { DetectResponse, ExplainLanguage, LlmProvider } from "@jargonslayer/core/types";
import { buildDetectSystemPrompt, buildDetectUserMessage } from "@jargonslayer/core/llm/prompts";
import { DetectResponseSchema, clampConfidence, type ProviderCaller } from "../providerCore";

/** BYOK/no-override fallback model — single-sourced so route.ts's
 *  pickModel(...) call and the client path's own `body.model ??
 *  DEFAULT_DETECT_MODEL` resolution can never drift apart (extract,
 *  don't fork — same rule this session applies to prompts/schemas). */
export const DEFAULT_DETECT_MODEL = "claude-haiku-4-5";

const MAX_EXPRESSIONS = 6;
const MAX_TERMS = 4;

export interface DetectTaskInput {
  apiKey: string;
  model: string;
  provider: LlmProvider;
  baseUrl: string;
  extraBody?: Record<string, unknown>;
  context: string;
  new_text: string;
  lang?: ExplainLanguage;
  /** Pre-rendered background-profile hint (#48 step 3) — USER message
   *  only, never affects the cached SYSTEM prompt (see prompts.ts). */
  profile?: string;
}

/** Anti-hallucination post-filter: drop any expression whose
 *  `expression` string doesn't actually appear (case-insensitively)
 *  in the analyzed text, then clamp counts/confidence. Moved verbatim
 *  from app/api/detect/route.ts so both callers apply the exact same
 *  filter. */
function postFilter(res: DetectResponse, newText: string): DetectResponse {
  const haystack = newText.toLowerCase();

  const expressions = res.expressions
    .filter((e) => haystack.includes(e.expression.toLowerCase()))
    .map((e) => ({ ...e, confidence: clampConfidence(e.confidence) }))
    .slice(0, MAX_EXPRESSIONS);

  const terms = res.terms.slice(0, MAX_TERMS);

  return { expressions, terms };
}

export async function runDetectTask(
  input: DetectTaskInput,
  call: ProviderCaller,
): Promise<DetectResponse> {
  const raw = await call({
    apiKey: input.apiKey,
    model: input.model,
    system: buildDetectSystemPrompt(input.lang ?? "zh"),
    user: buildDetectUserMessage(input.context, input.new_text, input.profile),
    schema: DetectResponseSchema,
    maxTokens: 1000,
    cacheSystem: true,
    provider: input.provider,
    baseUrl: input.baseUrl,
    extraBody: input.extraBody,
  });

  return postFilter(raw, input.new_text);
}
