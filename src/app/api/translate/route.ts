export const runtime = "nodejs";

import { NextResponse } from "next/server";
import * as z from "zod";
import {
  callJson,
  mapLlmError,
  resolveLlmConfig,
  TranslateSegmentsSchema,
} from "@/lib/llm/anthropic";
import { allowRequest, clientIp } from "@/lib/llm/rateLimit";
import { buildTranslateSystemPrompt, buildTranslateUserMessage } from "@/lib/llm/prompts";
import type { ApiErrorBody, TranslateResponse } from "@/lib/types";

const SegmentSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(1500),
});

const BodySchema = z.object({
  segments: z.array(SegmentSchema).min(1).max(6),
  // BCP47-shaped tag, not a free string: this field is spliced
  // straight into the prompt (buildTranslateSystemPrompt/
  // targetLanguageName), and on the shared server-key path that
  // prompt is attacker-reachable — tighten past .min(1) to close off
  // prompt injection / unbounded length. Client only ever sends "zh"
  // or "en", both well inside this shape.
  lang: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,15}$/),
});

function errorBody(body: ApiErrorBody, status: number) {
  return NextResponse.json(body, { status });
}

/** Drop any model-returned item whose id wasn't in the request — a
 *  missing segment in the model output is simply omitted (client
 *  treats it as failed-soft, see translate/queue.ts). */
function postFilter(
  res: TranslateResponse,
  requestedIds: Set<string>,
): TranslateResponse {
  return {
    translations: res.translations.filter((t) => requestedIds.has(t.id)),
  };
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
  const { segments, lang } = parsedBody.data;

  const cfg = resolveLlmConfig(req, "translate");
  if (!cfg) {
    return errorBody({ error: "未配置 API Key", code: "no_key" }, 401);
  }
  if (cfg.provider === "openai-compat" && !cfg.baseUrl) {
    return errorBody({ error: "缺少 Base URL", code: "bad_request" }, 400);
  }
  // Shared server credential: live captions produce roughly 6-10
  // req/min at this batch size (6 segments/1.5s debounce); 30/min
  // leaves headroom for two tabs.
  if (cfg.isServerKey && !allowRequest(`translate:${clientIp(req)}`, 30)) {
    return errorBody({ error: "请求过于频繁，请稍后再试", code: "rate_limit" }, 429);
  }

  try {
    const raw = await callJson({
      apiKey: cfg.apiKey,
      model: cfg.forcedModel ?? "claude-haiku-4-5",
      system: buildTranslateSystemPrompt(lang),
      user: buildTranslateUserMessage(segments),
      schema: TranslateSegmentsSchema,
      maxTokens: 2000,
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      // The hosted model wraps output in ```json fences and/or a bare
      // top-level array; extractJsonValue + arrayKey already tolerate
      // both (see anthropic.ts).
      arrayKey: "translations",
      extraBody: cfg.extraBody,
    });

    const filtered = postFilter(raw, new Set(segments.map((s) => s.id)));
    return NextResponse.json(filtered satisfies TranslateResponse);
  } catch (err) {
    const mapped = mapLlmError(err);
    return errorBody(mapped.body, mapped.status);
  }
}
