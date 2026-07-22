export const runtime = "nodejs";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import * as z from "zod";
import {
  callJson,
  CLIENT_CREDS_REJECTED_BODY,
  mapLlmError,
  pickModel,
  rejectClientCreds,
  resolveLlmConfig,
} from "@/lib/llm/anthropic";
import { allowDailyBudget, allowRequest, clientIp } from "@/lib/llm/rateLimit";
import {
  DEFAULT_SUMMARIZE_MODEL,
  MAX_SEGMENTS,
  MAX_TOTAL_SEGMENT_CHARS,
  runSummarizeTask,
  SUMMARIZE_TOO_LARGE_MESSAGE,
  totalSegmentChars,
} from "@/lib/llm/tasks/summarize";
import { PROFILE_HINT_MAX_CHARS } from "@jargonslayer/core/llm/profileHint";
import { newRequestId } from "@/lib/diag/requestId";
import type { ApiErrorBody, SummarizeRequest, SummaryResult } from "@jargonslayer/core/types";

// ---------------------------------------------------------------
// Request schema — mirrors SummarizeRequest exactly.
// ---------------------------------------------------------------

const SegmentSchema = z.object({
  index: z.number(),
  speaker: z.string().optional(),
  text: z.string(),
});

const DetectedExpressionSchema = z.object({
  expression: z.string(),
  category: z.enum(["idiom", "slang", "phrase", "metaphor", "indirect", "other"]),
  meaning: z.string(),
  chinese_explanation: z.string(),
  plain_english: z.string(),
  tone: z.string(),
  confidence: z.number(),
  source_sentence: z.string(),
});

const DetectedTermSchema = z.object({
  term: z.string(),
  type: z.enum(["acronym", "company", "product", "tech", "metric", "person", "other"]),
  gloss_en: z.string(),
  gloss_zh: z.string(),
});

const BodySchema = z.object({
  segments: z.array(SegmentSchema),
  expressions: z.array(DetectedExpressionSchema),
  terms: z.array(DetectedTermSchema),
  meetingTitle: z.string().optional(),
  model: z.string().optional(),
  lang: z.enum(["zh", "en"]).optional(),
  // Pre-rendered background-profile hint (#48 step 3) — affects the
  // sweep stage only (see tasks/summarize.ts's runSweepStage). Shared
  // cap constant with /api/detect and /api/define (#48 s1 review item 9).
  profile: z.string().max(PROFILE_HINT_MAX_CHARS).optional(),
  // v0.4.5 detect-span QC (item 6, F3 field fix) — the user's configured
  // idiom-category length caps, threaded from client.ts's summarizeApi
  // (server transport) so the sweep stage honors them instead of always
  // falling back to tasks/summarize.ts's own DEFAULT_SPAN_QC_CAPS.
  spanQcCaps: z
    .object({
      idiomMaxWords: z.number().int().positive(),
      idiomMaxChars: z.number().int().positive(),
    })
    .optional(),
}) satisfies z.ZodType<SummarizeRequest>;

// Diagnostics (item 5) — see detect/route.ts's identical helper doc.
function errorBody(body: ApiErrorBody, status: number) {
  return NextResponse.json({ ...body, requestId: newRequestId() } satisfies ApiErrorBody, {
    status,
  });
}

// ---------------------------------------------------------------
// Request size caps — reject oversized bodies before any LLM dispatch
// (chunking/translation/sweep all fan out into multiple provider
// calls, so an unbounded transcript is effectively a cost/DoS vector
// here — this is an HTTP-input-validation guard against ARBITRARY
// callers of our own route). MAX_SEGMENTS/MAX_TOTAL_SEGMENT_CHARS/
// totalSegmentChars/the exact error message are single-sourced in
// tasks/summarize.ts (F4, codex v04-integration review — see that
// module's header comment): client.ts's summarizeViaClient applies the
// SAME caps for a different reason (self-protection against an
// unbounded marathon meeting freezing the UI, not DoS defense), and
// must throw byte-identical user-facing text, so the values and
// message can never drift apart between the two enforcement points.
//
// Route handler below.
// ---------------------------------------------------------------

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
  const { segments, expressions, terms, model: requestedModel, lang, profile, spanQcCaps } =
    parsedBody.data;

  if (
    segments.length > MAX_SEGMENTS ||
    totalSegmentChars(segments) > MAX_TOTAL_SEGMENT_CHARS
  ) {
    return errorBody({ error: SUMMARIZE_TOO_LARGE_MESSAGE, code: "bad_request" }, 413);
  }

  const cfg = resolveLlmConfig(req, "summary");
  if (!cfg) {
    return errorBody({ error: "未配置 API Key", code: "no_key" }, 401);
  }
  if (cfg.provider === "openai-compat" && !cfg.baseUrl) {
    return errorBody({ error: "缺少 Base URL", code: "bad_request" }, 400);
  }
  // Shared server credential: one summary spawns several upstream
  // calls (summary + chunked translation + sweep), so keep this tight.
  if (cfg.isServerKey && !allowRequest(`summarize:${clientIp(req)}`, 4)) {
    return errorBody({ error: "请求过于频繁，请稍后重试", code: "rate_limit" }, 429);
  }
  // Global daily budget (distributed-IP/slow-burn spend the per-IP
  // limiter above can't see) — see rateLimit.ts's allowDailyBudget doc.
  if (cfg.isServerKey && !allowDailyBudget("summarize")) {
    return errorBody(
      { error: "体验版今日 AI 额度已用完，请明日再试，或使用本地版 / 自备 API Key", code: "rate_limit" },
      429,
    );
  }

  // pickModel (#61): client model honored only inside the server-side
  // allowlist (summary additionally admits JARGONSLAYER_MODEL_ALLOWLIST_
  // SUMMARY entries — the pro-class models too slow for live paths).
  // No callJsonWithFallback here: a summary spans several sequential
  // stages and silently mixing models mid-report isn't worth the save
  // (see tasks/summarize.ts's runSummarizeTask doc) — callJson is
  // already shaped as a ProviderCaller directly, no wrapper needed.
  const model = pickModel(cfg, requestedModel, DEFAULT_SUMMARIZE_MODEL);

  try {
    // Three-stage orchestration (summary + chunked translation +
    // sweep) + flashcard assembly now live in the shared
    // tasks/summarize.ts module (v0.4 S2) — see detect/route.ts's
    // identical comment.
    const result = await runSummarizeTask(
      {
        apiKey: cfg.apiKey,
        model,
        llm: { provider: cfg.provider, baseUrl: cfg.baseUrl, extraBody: cfg.extraBody },
        segments,
        expressions,
        terms,
        lang,
        profile,
        spanQcCaps,
      },
      callJson,
    );

    return NextResponse.json(result satisfies SummaryResult);
  } catch (err) {
    // Only the summary stage is fatal (translation/sweep already
    // degrade gracefully internally); any throw reaching here maps
    // through the shared error mapper.
    const mapped = mapLlmError(err);
    return errorBody(mapped.body, mapped.status);
  }
}
