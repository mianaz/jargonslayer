export const runtime = "nodejs";

import { NextResponse } from "next/server";
import * as z from "zod";
import { mapLlmError, pickModel, resolveLlmConfig, withFallback } from "@/lib/llm/anthropic";
import { allowDailyBudget, allowRequest, clientIp } from "@/lib/llm/rateLimit";
import { DEFAULT_DETECT_MODEL, runDetectTask } from "@/lib/llm/tasks/detect";
import { PROFILE_HINT_MAX_CHARS } from "@jargonslayer/core/llm/profileHint";
import { newRequestId } from "@/lib/diag/requestId";
import type { ApiErrorBody, DetectResponse } from "@jargonslayer/core/types";

const BodySchema = z.object({
  context: z.string().max(4000),
  new_text: z.string().min(1).max(3000),
  model: z.string().optional(),
  lang: z.enum(["zh", "en"]).optional(),
  // Pre-rendered background-profile hint (#48 step 3); client-truncated
  // to PROFILE_HINT_MAX_CHARS (profileHint.ts) — enforced here via the
  // SAME exported constant (#48 s1 review item 9) rather than a
  // separately-hardcoded bound that could silently drift from the
  // actual client contract.
  profile: z.string().max(PROFILE_HINT_MAX_CHARS).optional(),
});

// Diagnostics (item 5): every error response carries a short
// requestId so a user's diag ref (client-side) can chain to this
// exact server-side response — see lib/diag/requestId.ts.
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
    return errorBody({ error: "请求过于频繁，请稍后重试", code: "rate_limit" }, 429);
  }
  // Global daily budget (distributed-IP/slow-burn spend the per-IP
  // limiter above can't see) — see rateLimit.ts's allowDailyBudget doc.
  if (cfg.isServerKey && !allowDailyBudget("detect")) {
    return errorBody(
      { error: "体验版今日 AI 额度已用完，请明日再试，或使用本地版 / 自备 API Key", code: "rate_limit" },
      429,
    );
  }

  try {
    // pickModel (#61): client model honored only inside the server-side
    // allowlist when the shared key serves the request; BYOK unchanged.
    // Prompt assembly + provider call + post-filter now live in the
    // shared tasks/detect.ts module (v0.4 S2) — this route stays a
    // thin HTTP adapter: validate, resolve server-only config
    // (pickModel/rate limiting/fallback), delegate, map errors.
    const filtered = await runDetectTask(
      {
        apiKey: cfg.apiKey,
        model: pickModel(cfg, model, DEFAULT_DETECT_MODEL),
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        extraBody: cfg.extraBody,
        context,
        new_text,
        lang,
        profile,
      },
      withFallback(cfg.fallbackModel),
    );

    return NextResponse.json(filtered satisfies DetectResponse);
  } catch (err) {
    const mapped = mapLlmError(err);
    return errorBody(mapped.body, mapped.status);
  }
}
