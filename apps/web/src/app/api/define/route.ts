export const runtime = "nodejs";

import { NextResponse } from "next/server";
import * as z from "zod";
import { mapLlmError, pickModel, resolveLlmConfig, withFallback } from "@/lib/llm/anthropic";
import { allowRequest, clientIp } from "@/lib/llm/rateLimit";
import { DEFAULT_DEFINE_MODEL, runDefineTask } from "@/lib/llm/tasks/define";
import { PROFILE_HINT_MAX_CHARS } from "@jargonslayer/core/llm/profileHint";
import { newRequestId } from "@/lib/diag/requestId";
import type { ApiErrorBody, DefineResult } from "@jargonslayer/core/types";

const BodySchema = z.object({
  phrase: z.string().min(1).max(120),
  context: z.string().max(600),
  model: z.string().optional(),
  lang: z.enum(["zh", "en"]).optional(),
  // Pre-rendered background-profile hint (#48 step 3) — same shared
  // constant as /api/detect (#48 s1 review item 9).
  profile: z.string().max(PROFILE_HINT_MAX_CHARS).optional(),
});

// Diagnostics (item 5) — see detect/route.ts's identical helper doc.
function errorBody(body: ApiErrorBody, status: number) {
  return NextResponse.json({ ...body, requestId: newRequestId() } satisfies ApiErrorBody, {
    status,
  });
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
  const { phrase, context, model, lang, profile } = parsedBody.data;

  const cfg = resolveLlmConfig(req, "define");
  if (!cfg) {
    return errorBody({ error: "未配置 API Key", code: "no_key" }, 401);
  }
  if (cfg.provider === "openai-compat" && !cfg.baseUrl) {
    return errorBody({ error: "缺少 Base URL", code: "bad_request" }, 400);
  }
  if (cfg.isServerKey && !allowRequest(`define:${clientIp(req)}`, 10)) {
    return errorBody({ error: "请求过于频繁，请稍后重试", code: "rate_limit" }, 429);
  }

  try {
    // pickModel (#61): client model honored only inside the server-side
    // allowlist when the shared key serves the request; BYOK unchanged.
    // Prompt assembly + provider call + result finalization now live in
    // the shared tasks/define.ts module (v0.4 S2) — see detect/route.
    // ts's identical comment.
    const result = await runDefineTask(
      {
        apiKey: cfg.apiKey,
        model: pickModel(cfg, model, DEFAULT_DEFINE_MODEL),
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        extraBody: cfg.extraBody,
        phrase,
        context,
        lang,
        profile,
      },
      withFallback(cfg.fallbackModel),
    );

    return NextResponse.json(result satisfies DefineResult);
  } catch (err) {
    const mapped = mapLlmError(err);
    return errorBody(mapped.body, mapped.status);
  }
}
