// Isomorphic "translate" task (v0.4 S2, PLAN-v0.4 §1A/§4) — live
// bilingual transcript translation (#42), shared by
// app/api/translate/route.ts and lib/llm/client.ts's client-side path.
// See tasks/detect.ts's header comment for the general contract.
//
// NOT SUMMARY_SYSTEM_PROMPT's post-meeting translation stage (see
// tasks/summarize.ts's runTranslationStage) — this is the id-keyed,
// per-segment live path (buildTranslateSystemPrompt/
// buildTranslateUserMessage), index-keyed there.

import type { LlmProvider, TranslateResponse } from "@jargonslayer/core/types";
import { buildTranslateSystemPrompt, buildTranslateUserMessage } from "@jargonslayer/core/llm/prompts";
import { TranslateSegmentsSchema, type ProviderCaller } from "../providerCore";

export const DEFAULT_TRANSLATE_MODEL = "claude-haiku-4-5";

export interface TranslateTaskInput {
  apiKey: string;
  model: string;
  provider: LlmProvider;
  baseUrl: string;
  extraBody?: Record<string, unknown>;
  segments: { id: string; text: string }[];
  lang: string;
}

/** Drop any model-returned item whose id wasn't in the request — a
 *  missing segment in the model output is simply omitted (client
 *  treats it as failed-soft, see translate/queue.ts). Moved verbatim
 *  from app/api/translate/route.ts. */
function postFilter(
  res: TranslateResponse,
  requestedIds: Set<string>,
): TranslateResponse {
  return {
    translations: res.translations.filter((t) => requestedIds.has(t.id)),
  };
}

export async function runTranslateTask(
  input: TranslateTaskInput,
  call: ProviderCaller,
): Promise<TranslateResponse> {
  const raw = await call({
    apiKey: input.apiKey,
    model: input.model,
    system: buildTranslateSystemPrompt(input.lang),
    user: buildTranslateUserMessage(input.segments),
    schema: TranslateSegmentsSchema,
    maxTokens: 2000,
    provider: input.provider,
    baseUrl: input.baseUrl,
    // The hosted model wraps output in ```json fences and/or a bare
    // top-level array; extractJsonValue + arrayKey already tolerate
    // both (see providerCore.ts).
    arrayKey: "translations",
    extraBody: input.extraBody,
  });

  return postFilter(raw, new Set(input.segments.map((s) => s.id)));
}
