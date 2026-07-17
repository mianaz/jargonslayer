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

// Field-test fix (v0.4.4) — see tasks/detect.ts's DEFAULT_DETECT_MODEL
// doc comment for the full rationale (bare Anthropic ids 400 on
// OpenRouter; DeepSeek's own OpenRouter slug is the new default). This
// is also the server's own pickModel fallback for translate — but as
// of the R1 field fix, translate's resolved model now inherits the
// top-level 检测模型 (settings.detectModel, see taskConfig.ts's
// resolveTaskCreds) whenever no #56 per-task override is enabled, so
// this constant is a near-unreachable last resort: only a genuinely
// blank detectModel (or a fully keyless/server-managed call with no
// resolved model at all) ever actually falls through to it.
export const DEFAULT_TRANSLATE_MODEL = "deepseek/deepseek-v4-flash";

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
