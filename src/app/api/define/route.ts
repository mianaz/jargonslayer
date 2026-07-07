export const runtime = "nodejs";

import { NextResponse } from "next/server";
import * as z from "zod";
import {
  callJsonWithFallback,
  mapLlmError,
  pickModel,
  resolveLlmConfig,
} from "@/lib/llm/anthropic";
import { allowRequest, clientIp } from "@/lib/llm/rateLimit";
import { buildDefineSystemPrompt, buildDefineUserMessage } from "@/lib/llm/prompts";
import type { ApiErrorBody, DefineResult } from "@/lib/types";

const BodySchema = z.object({
  phrase: z.string().min(1).max(120),
  context: z.string().max(600),
  model: z.string().optional(),
  lang: z.enum(["zh", "en"]).optional(),
});

// Length ceilings mirror the prompt's own guidance (see
// DEFINE_SYSTEM_PROMPT); enforced in code rather than zod .max() so a
// slightly-over-budget but otherwise valid model reply still saves
// instead of failing the whole request.
const HEADWORD_MAX = 120;
const CHINESE_EXPLANATION_MAX = 90;
const EXAMPLE_MAX = 300;
const MEANING_MAX = 200;
const PLAIN_ENGLISH_MAX = 120;
const TONE_MAX = 60;
const GLOSS_EN_MAX = 150;
const VARIANTS_MAX = 8;

const DefineResultSchema = z.object({
  kind: z.enum(["expression", "term"]),
  headword: z.string(),
  variants: z.array(z.string()),
  chinese_explanation: z.string(),
  example: z.string(),
  // expression-only
  category: z.enum(["idiom", "slang", "phrase", "metaphor", "indirect", "other"]).optional(),
  meaning: z.string().optional(),
  plain_english: z.string().optional(),
  tone: z.string().optional(),
  // term-only
  termType: z
    .enum(["acronym", "company", "product", "tech", "metric", "person", "other"])
    .optional(),
  gloss_en: z.string().optional(),
}) satisfies z.ZodType<DefineResult>;

function errorBody(body: ApiErrorBody, status: number) {
  return NextResponse.json(body, { status });
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Clamp string lengths and post-validate kind-specific fields: fill
 *  sane defaults when the model omitted something it should have
 *  included for the chosen kind, rather than shipping a half-empty
 *  glossary entry to the client. */
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

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorBody({ error: "请求体不是合法 JSON", code: "bad_request" }, 400);
  }

  const parsedBody = BodySchema.safeParse(json);
  if (!parsedBody.success) {
    return errorBody({ error: "请求参数不合法", code: "bad_request" }, 400);
  }
  const { phrase, context, model, lang } = parsedBody.data;

  const cfg = resolveLlmConfig(req, "define");
  if (!cfg) {
    return errorBody({ error: "未配置 API Key", code: "no_key" }, 401);
  }
  if (cfg.provider === "openai-compat" && !cfg.baseUrl) {
    return errorBody({ error: "缺少 Base URL", code: "bad_request" }, 400);
  }
  if (cfg.isServerKey && !allowRequest(`define:${clientIp(req)}`, 10)) {
    return errorBody({ error: "请求过于频繁，请稍后再试", code: "rate_limit" }, 429);
  }

  try {
    // pickModel (#61): client model honored only inside the server-side
    // allowlist when the shared key serves the request; BYOK unchanged.
    const raw = await callJsonWithFallback(
      {
        apiKey: cfg.apiKey,
        model: pickModel(cfg, model, "claude-haiku-4-5"),
        system: buildDefineSystemPrompt(lang ?? "zh"),
        user: buildDefineUserMessage(phrase, context),
        schema: DefineResultSchema,
        maxTokens: 900,
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        extraBody: cfg.extraBody,
      },
      cfg.fallbackModel,
    );

    const result = finalizeDefineResult(raw, phrase);
    return NextResponse.json(result satisfies DefineResult);
  } catch (err) {
    const mapped = mapLlmError(err);
    return errorBody(mapped.body, mapped.status);
  }
}
