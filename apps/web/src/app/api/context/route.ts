export const runtime = "nodejs";

import { NextResponse } from "next/server";
import * as z from "zod";
import {
  CLIENT_CREDS_REJECTED_BODY,
  mapLlmError,
  pickModel,
  rejectClientCreds,
  resolveLlmConfig,
  withFallback,
} from "@/lib/llm/anthropic";
import { allowDailyBudget, allowRequest, clientIp } from "@/lib/llm/rateLimit";
import { DEFAULT_INFER_CONTEXT_MODEL, runInferContextTask } from "@/lib/llm/tasks/inferContext";
import { newRequestId } from "@/lib/diag/requestId";
import type { ApiErrorBody, InferContextResponse } from "@jargonslayer/core/types";

const BodySchema = z.object({
  // Largest excerpt this feature ever sends is the 7000-char refresh
  // window (useMeeting.ts's CONTEXT_REFRESH_CHARS) — capped a bit
  // above that for slack.
  excerpt: z.string().min(1).max(8000),
  lang: z.enum(["zh", "en"]),
  model: z.string().optional(),
});

// Diagnostics (item 5) — see detect/route.ts's identical helper doc.
function errorBody(body: ApiErrorBody, status: number) {
  return NextResponse.json({ ...body, requestId: newRequestId() } satisfies ApiErrorBody, {
    status,
  });
}

export async function POST(req: Request) {
  // Preview strict mode (D2) — see rejectClientCreds's own doc. Runs
  // before body parsing/rate limiting/resolveLlmConfig so a rejected
  // request never reaches any of those.
  if (rejectClientCreds(req)) {
    return errorBody(CLIENT_CREDS_REJECTED_BODY, 400);
  }

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
  const { excerpt, lang, model } = parsedBody.data;

  // Rides the detect-domain config, same kind correct/define's own
  // routes already resolve through — see correct/route.ts's identical
  // comment.
  const cfg = resolveLlmConfig(req, "detect");
  if (!cfg) {
    return errorBody({ error: "未配置 API Key", code: "no_key" }, 401);
  }
  if (cfg.provider === "openai-compat" && !cfg.baseUrl) {
    return errorBody({ error: "缺少 Base URL", code: "bad_request" }, 400);
  }
  // Shared server credential: at most 3 calls per meeting (initial +
  // one retry + one later refresh), spread across minutes — tight
  // per-IP budget, same order of magnitude as define's.
  if (cfg.isServerKey && !allowRequest(`context:${clientIp(req)}`, 10)) {
    return errorBody({ error: "请求过于频繁，请稍后重试", code: "rate_limit" }, 429);
  }
  // Global daily budget (distributed-IP/slow-burn spend the per-IP
  // limiter above can't see) — see rateLimit.ts's allowDailyBudget doc.
  if (cfg.isServerKey && !allowDailyBudget("context")) {
    return errorBody(
      { error: "体验版今日 AI 额度已用完，请明日再试，或使用本地版 / 自备 API Key", code: "rate_limit" },
      429,
    );
  }

  try {
    // pickModel (#61): client model honored only inside the server-side
    // allowlist when the shared key serves the request; BYOK unchanged.
    // Prompt assembly + provider call + sanitize now live in the shared
    // tasks/inferContext.ts module — see detect/route.ts's identical
    // comment.
    const result = await runInferContextTask(
      {
        apiKey: cfg.apiKey,
        model: pickModel(cfg, model, DEFAULT_INFER_CONTEXT_MODEL),
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        extraBody: cfg.extraBody,
        excerpt,
        lang,
      },
      withFallback(cfg.fallbackModel),
    );

    return NextResponse.json(result satisfies InferContextResponse);
  } catch (err) {
    const mapped = mapLlmError(err);
    return errorBody(mapped.body, mapped.status);
  }
}
