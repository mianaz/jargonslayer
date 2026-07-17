// Isomorphic "define" task (v0.4 S2, PLAN-v0.4 §1A/§4) — shared by
// app/api/define/route.ts and lib/llm/client.ts's client-side path.
// See tasks/detect.ts's header comment for the general contract
// (server-only concerns never enter this module).

import type { DefineResult, ExplainLanguage, LlmProvider } from "@jargonslayer/core/types";
import { buildDefineSystemPrompt, buildDefineUserMessage } from "@jargonslayer/core/llm/prompts";
import { DefineResultSchema, type ProviderCaller } from "../providerCore";

// Field-test fix (v0.4.4) — see tasks/detect.ts's DEFAULT_DETECT_MODEL
// doc comment for the full rationale (bare Anthropic ids 400 on
// OpenRouter; DeepSeek's own OpenRouter slug is the new default).
export const DEFAULT_DEFINE_MODEL = "deepseek/deepseek-v4-flash";

// Length ceilings mirror the prompt's own guidance (see
// DEFINE_SYSTEM_PROMPT); enforced in code rather than zod .max() so a
// slightly-over-budget but otherwise valid model reply still saves
// instead of failing the whole request. Moved verbatim from
// app/api/define/route.ts.
const HEADWORD_MAX = 120;
const CHINESE_EXPLANATION_MAX = 90;
const EXAMPLE_MAX = 300;
const MEANING_MAX = 200;
const PLAIN_ENGLISH_MAX = 120;
const TONE_MAX = 60;
const GLOSS_EN_MAX = 150;
const VARIANTS_MAX = 8;

export interface DefineTaskInput {
  apiKey: string;
  model: string;
  provider: LlmProvider;
  baseUrl: string;
  extraBody?: Record<string, unknown>;
  phrase: string;
  context: string;
  lang?: ExplainLanguage;
  profile?: string;
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Clamp string lengths and post-validate kind-specific fields: fill
 *  sane defaults when the model omitted something it should have
 *  included for the chosen kind, rather than shipping a half-empty
 *  glossary entry to the client. Moved verbatim from
 *  app/api/define/route.ts. */
function finalizeDefineResult(raw: DefineResult, phrase: string): DefineResult {
  const headword = clamp(raw.headword.trim() || phrase.trim(), HEADWORD_MAX);
  const variants = raw.variants
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, VARIANTS_MAX);
  const chinese_explanation = clamp(raw.chinese_explanation.trim(), CHINESE_EXPLANATION_MAX);
  const example = clamp(raw.example.trim(), EXAMPLE_MAX);

  const result: DefineResult = {
    kind: raw.kind,
    headword,
    variants,
    chinese_explanation,
    example,
  };

  if (raw.kind === "expression") {
    result.category = raw.category ?? "other";
    result.meaning = clamp((raw.meaning ?? chinese_explanation).trim(), MEANING_MAX);
    result.plain_english = clamp((raw.plain_english ?? headword).trim(), PLAIN_ENGLISH_MAX);
    result.tone = clamp((raw.tone ?? "neutral").trim(), TONE_MAX);
  } else {
    result.termType = raw.termType ?? "other";
    result.gloss_en = clamp((raw.gloss_en ?? chinese_explanation).trim(), GLOSS_EN_MAX);
  }

  return result;
}

export async function runDefineTask(
  input: DefineTaskInput,
  call: ProviderCaller,
): Promise<DefineResult> {
  const raw = await call({
    apiKey: input.apiKey,
    model: input.model,
    system: buildDefineSystemPrompt(input.lang ?? "zh"),
    user: buildDefineUserMessage(input.phrase, input.context, input.profile),
    schema: DefineResultSchema,
    maxTokens: 900,
    provider: input.provider,
    baseUrl: input.baseUrl,
    extraBody: input.extraBody,
  });

  return finalizeDefineResult(raw, input.phrase);
}
