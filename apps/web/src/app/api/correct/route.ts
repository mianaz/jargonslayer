export const runtime = "nodejs";

import { NextResponse } from "next/server";
import * as z from "zod";
import { mapLlmError, pickModel, resolveLlmConfig, withFallback } from "@/lib/llm/anthropic";
import { allowDailyBudget, allowRequest, clientIp } from "@/lib/llm/rateLimit";
import { DEFAULT_CORRECT_MODEL, runCorrectTask } from "@/lib/llm/tasks/correct";
import { newRequestId } from "@/lib/diag/requestId";
import type { ApiErrorBody, CorrectResponse } from "@jargonslayer/core/types";

// Mirrors CorrectRequest (types.ts) — segment text cap matches
// translate/route.ts's own SegmentSchema (a transcript segment is the
// same one-utterance unit whether corrected live-adjacent or after the
// fact). segments/lexicon caps are this route's own HTTP-input-
// validation guard (see the summarize route's identical MAX_SEGMENTS
// rationale) — a whole meeting's worth of segments, generously capped.
const SegmentSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(1500),
});

const BodySchema = z.object({
  segments: z.array(SegmentSchema).min(1).max(300),
  context: z.string().max(4000),
  lexicon: z.array(z.string().max(200)).max(500),
  meetingTitle: z.string().max(200).optional(),
  model: z.string().optional(),
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
  const { segments, context, lexicon, meetingTitle, model } = parsedBody.data;

  // §5 A5: correction rides the detect-domain config — same kind
  // define's own route already resolves through (define's server-side
  // resolveLlmConfig behavior is identical for "detect"/"define": both
  // fall through to the shared detectClassModel, only "summary"/
  // "translate" branch differently — see anthropic.ts's own doc).
  const cfg = resolveLlmConfig(req, "detect");
  if (!cfg) {
    return errorBody({ error: "未配置 API Key", code: "no_key" }, 401);
  }
  if (cfg.provider === "openai-compat" && !cfg.baseUrl) {
    return errorBody({ error: "缺少 Base URL", code: "bad_request" }, 400);
  }
  // Shared server credential: batch, review-gated, one-shot per
  // meeting (not a live polling loop) — tight per-IP budget, same
  // order of magnitude as summarize's.
  if (cfg.isServerKey && !allowRequest(`correct:${clientIp(req)}`, 4)) {
    return errorBody({ error: "请求过于频繁，请稍后重试", code: "rate_limit" }, 429);
  }
  // Global daily budget (distributed-IP/slow-burn spend the per-IP
  // limiter above can't see) — see rateLimit.ts's allowDailyBudget doc.
  if (cfg.isServerKey && !allowDailyBudget("correct")) {
    return errorBody(
      { error: "体验版今日 AI 额度已用完，请明日再试，或使用本地版 / 自备 API Key", code: "rate_limit" },
      429,
    );
  }

  try {
    // pickModel (#61): client model honored only inside the server-side
    // allowlist when the shared key serves the request; BYOK unchanged.
    // Prompt assembly + provider call + id-filter now live in the
    // shared tasks/correct.ts module — see detect/route.ts's identical
    // comment.
    const filtered = await runCorrectTask(
      {
        apiKey: cfg.apiKey,
        model: pickModel(cfg, model, DEFAULT_CORRECT_MODEL),
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        extraBody: cfg.extraBody,
        segments,
        context,
        lexicon,
        meetingTitle,
      },
      withFallback(cfg.fallbackModel),
    );

    return NextResponse.json(filtered satisfies CorrectResponse);
  } catch (err) {
    const mapped = mapLlmError(err);
    return errorBody(mapped.body, mapped.status);
  }
}
