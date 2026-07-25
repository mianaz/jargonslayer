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
import { DOMAIN_TAGS, type DomainTag } from "@jargonslayer/core/detect/dictionary-data";
import {
  buildInferContextSystemPrompt,
  buildInferContextUserMessage,
} from "@jargonslayer/core/llm/prompts";
import { InferContextResponseSchema, type ProviderCaller } from "../providerCore";

// Field-test fix (v0.4.4) — see tasks/detect.ts's DEFAULT_DETECT_MODEL
// doc comment for the full rationale (bare Anthropic ids 400 on
// OpenRouter; DeepSeek's own OpenRouter slug is the new default).
export const DEFAULT_INFER_CONTEXT_MODEL = "deepseek/deepseek-v4-flash";

// v0.6 multi-sense-terms sprint (T5).
const MAX_DOMAINS = 3;

/** Validate a raw `domains` array (the model's own output here; also
 *  reused as store.ts's defensive re-validation of a persisted/restored
 *  value — see that file's narrowDomainTags-less reuse of this same
 *  function) against the real DomainTag enum, dropping anything
 *  unrecognized — never fatal, same lenient-drop posture as
 *  remotePacks.ts's own wire validation (untrusted JSON is untrusted
 *  JSON regardless of source). Deduped and capped at MAX_DOMAINS,
 *  preserving the input's own ordering (the model is asked for most-
 *  relevant-first — prompt rule 5, prompts.ts). `raw` is typed
 *  `string[]` (InferContextResponseSchema guarantees an array in the
 *  real provider-call path) but defensively re-checked with
 *  Array.isArray anyway — a ProviderCaller test double, a persisted
 *  session predating this field, or any other caller that bypasses the
 *  schema must not throw on a missing/malformed value. Exported so
 *  store.ts can reuse the exact same rule for its own defensive
 *  re-validation instead of re-implementing it. */
export function sanitizeDomains(raw: string[]): DomainTag[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<DomainTag>();
  for (const value of raw) {
    if (seen.size >= MAX_DOMAINS) break;
    if ((DOMAIN_TAGS as readonly string[]).includes(value)) {
      seen.add(value as DomainTag);
    }
  }
  return [...seen];
}

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
  return {
    context: raw.context.trim().slice(0, MEETING_CONTEXT_MAX_CHARS),
    domains: sanitizeDomains(raw.domains),
  };
}
