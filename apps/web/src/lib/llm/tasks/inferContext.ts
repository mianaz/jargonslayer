// Isomorphic "infer meeting context" task (auto meeting-context
// detection — field request: "need AI to auto detect the context for
// better detection"). Mirrors tasks/define.ts's shape: shared by
// app/api/context/route.ts (web) and lib/llm/client.ts's client-side
// path. Rides the detect-domain config (creds resolved by the caller —
// resolveTaskCreds(settings, "detect") — same "no dedicated LLM task
// domain" posture as tasks/correct.ts's own DEFAULT_CORRECT_MODEL).

import {
  MEETING_CONTEXT_MAX_CHARS,
  type ExplainLanguage,
  type InferContextResponse,
  type LlmProvider,
} from "@jargonslayer/core/types";
import {
  buildInferContextSystemPrompt,
  buildInferContextUserMessage,
} from "@jargonslayer/core/llm/prompts";
import { InferContextResponseSchema, type ProviderCaller } from "../providerCore";

// Field-test fix (v0.4.4) — see tasks/detect.ts's DEFAULT_DETECT_MODEL
// doc comment for the full rationale (bare Anthropic ids 400 on
// OpenRouter; DeepSeek's own OpenRouter slug is the new default).
export const DEFAULT_INFER_CONTEXT_MODEL = "deepseek/deepseek-v4-flash";

export interface InferContextTaskInput {
  apiKey: string;
  model: string;
  provider: LlmProvider;
  baseUrl: string;
  extraBody?: Record<string, unknown>;
  excerpt: string;
  lang?: ExplainLanguage;
}

export async function runInferContextTask(
  input: InferContextTaskInput,
  call: ProviderCaller,
): Promise<InferContextResponse> {
  const raw = await call({
    apiKey: input.apiKey,
    model: input.model,
    system: buildInferContextSystemPrompt(input.lang ?? "zh"),
    user: buildInferContextUserMessage(input.excerpt),
    schema: InferContextResponseSchema,
    maxTokens: 300,
    provider: input.provider,
    baseUrl: input.baseUrl,
    extraBody: input.extraBody,
  });

  // Sanitize: trim, hard-cap. An empty (or now-empty-after-cap-less
  // trim) string is a valid "genuinely unclear" result per the
  // prompt's own rule 3 — callers treat "" as no result, nothing
  // special to do with it here.
  return { context: raw.context.trim().slice(0, MEETING_CONTEXT_MAX_CHARS) };
}
