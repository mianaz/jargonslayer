// Isomorphic "correct" task (v0.5 Wave-1 Feature 2, batch/review-gated
// AI transcript correction — docs/design-explorations/v05-wave1-
// blueprint.md §1 Feature 2 + §5 A5). Shared by app/api/correct/route.ts
// (web) and lib/llm/client.ts's client-side path (desktop/iOS, which
// strip app/api) — see tasks/translate.ts's header comment for the
// general isomorphic-task contract this mirrors.

import type { CorrectResponse, LlmProvider } from "@jargonslayer/core/types";
import { buildCorrectUserMessage, CORRECT_SYSTEM_PROMPT } from "@jargonslayer/core/llm/prompts";
import { CorrectResponseSchema, type ProviderCaller } from "../providerCore";

// Rides the detect-domain default (§5 A5: "correction rides the
// detect-domain config") — same fallback id as DEFAULT_DETECT_MODEL/
// DEFAULT_DEFINE_MODEL/DEFAULT_TRANSLATE_MODEL.
export const DEFAULT_CORRECT_MODEL = "deepseek/deepseek-v4-flash";

export interface CorrectTaskInput {
  apiKey: string;
  model: string;
  provider: LlmProvider;
  baseUrl: string;
  extraBody?: Record<string, unknown>;
  segments: { id: string; text: string }[];
  context: string;
  lexicon: string[];
  meetingTitle?: string;
}

/** A5 (BLOCKER): reject a blank/duplicate id and drop anything the
 *  model returned for an id that wasn't requested. `changed` is never
 *  computed here (or trusted from the model at all — see
 *  CorrectResponse's own doc in types.ts); every consumer computes it
 *  CLIENT-side by diffing this `text` against the ORIGINAL request
 *  text. Moved verbatim in spirit from tasks/translate.ts's own
 *  postFilter, extended with the blank/duplicate-id guard correction
 *  additionally needs. */
function postFilter(
  res: CorrectResponse,
  requestedIds: Set<string>,
): CorrectResponse {
  const seen = new Set<string>();
  const corrections = res.corrections.filter((c) => {
    if (!c.id || seen.has(c.id) || !requestedIds.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  return { corrections };
}

export async function runCorrectTask(
  input: CorrectTaskInput,
  call: ProviderCaller,
): Promise<CorrectResponse> {
  // ponytail: no chunking — one shot, whole-meeting batch. A very long
  // meeting can exceed maxTokens (every segment is echoed back, even
  // unchanged); add MAX_SEGMENTS-style chunking mirroring tasks/
  // summarize.ts's translation-stage pattern if that becomes a real
  // problem (§4's "Correction QUALITY on a real jargon transcript" is
  // an owner field-test item, not caught by any of this lane's tests).
  const raw = await call({
    apiKey: input.apiKey,
    model: input.model,
    system: CORRECT_SYSTEM_PROMPT,
    user: buildCorrectUserMessage(input.segments, input.lexicon, input.context, input.meetingTitle),
    schema: CorrectResponseSchema,
    maxTokens: 8000,
    provider: input.provider,
    baseUrl: input.baseUrl,
    // The hosted model wraps output in ```json fences and/or a bare
    // top-level array; extractJsonValue + arrayKey already tolerate
    // both (see providerCore.ts).
    arrayKey: "corrections",
    extraBody: input.extraBody,
  });

  return postFilter(raw, new Set(input.segments.map((s) => s.id)));
}
