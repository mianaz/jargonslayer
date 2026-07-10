export const runtime = "nodejs";

import { NextResponse } from "next/server";
import * as z from "zod";
import {
  callJsonWithFallback,
  clampConfidence,
  DetectResponseSchema,
  mapLlmError,
  pickModel,
  resolveLlmConfig,
} from "@/lib/llm/anthropic";
import { allowRequest, clientIp } from "@/lib/llm/rateLimit";
import { buildDetectSystemPrompt, buildDetectUserMessage } from "@/lib/llm/prompts";
import type { ApiErrorBody, DetectResponse } from "@/lib/types";

const BodySchema = z.object({
  context: z.string().max(4000),
  new_text: z.string().min(1).max(3000),
  model: z.string().optional(),
  lang: z.enum(["zh", "en"]).optional(),
  // Pre-rendered background-profile hint (#48 step 3); client-truncated
  // to ~60 tokens (profileHint.ts) — this cap is a generous
  // defense-in-depth bound, not the token budget itself.
  profile: z.string().max(500).optional(),
});

const MAX_EXPRESSIONS = 6;
const MAX_TERMS = 4;

function errorBody(body: ApiErrorBody, status: number) {
  return NextResponse.json(body, { status });
}

/** Anti-hallucination post-filter: drop any expression whose
 *  `expression` string doesn't actually appear (case-insensitively)
 *  in the analyzed text, then clamp counts/confidence. */
function postFilter(res: DetectResponse, newText: string): DetectResponse {
  const haystack = newText.toLowerCase();

  const expressions = res.expressions
    .filter((e) => haystack.includes(e.expression.toLowerCase()))
    .map((e) => ({ ...e, confidence: clampConfidence(e.confidence) }))
    .slice(0, MAX_EXPRESSIONS);

  const terms = res.terms.slice(0, MAX_TERMS);

  return { expressions, terms };
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
  const { context, new_text, model, lang, profile } = parsedBody.data;

  const cfg = resolveLlmConfig(req, "detect");
  if (!cfg) {
    return errorBody({ error: "未配置 API Key", code: "no_key" }, 401);
  }
  if (cfg.provider === "openai-compat" && !cfg.baseUrl) {
    return errorBody({ error: "缺少 Base URL", code: "bad_request" }, 400);
  }
  // Shared server credential: budget the caller (live detection fires
  // every few seconds, so this is the most generous of the three).
  if (cfg.isServerKey && !allowRequest(`detect:${clientIp(req)}`, 20)) {
    return errorBody({ error: "请求过于频繁，请稍后再试", code: "rate_limit" }, 429);
  }

  try {
    // pickModel (#61): client model honored only inside the server-side
    // allowlist when the shared key serves the request; BYOK unchanged.
    const raw = await callJsonWithFallback(
      {
        apiKey: cfg.apiKey,
        model: pickModel(cfg, model, "claude-haiku-4-5"),
        system: buildDetectSystemPrompt(lang ?? "zh"),
        user: buildDetectUserMessage(context, new_text, profile),
        schema: DetectResponseSchema,
        maxTokens: 1000,
        cacheSystem: true,
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        extraBody: cfg.extraBody,
      },
      cfg.fallbackModel,
    );

    const filtered = postFilter(raw, new_text);
    return NextResponse.json(filtered satisfies DetectResponse);
  } catch (err) {
    const mapped = mapLlmError(err);
    return errorBody(mapped.body, mapped.status);
  }
}
