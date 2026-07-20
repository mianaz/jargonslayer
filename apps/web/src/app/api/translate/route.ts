export const runtime = "nodejs";

import { NextResponse } from "next/server";
import * as z from "zod";
import { mapLlmError, pickModel, resolveLlmConfig, withFallback } from "@/lib/llm/anthropic";
import { allowDailyBudget, allowRequest, clientIp } from "@/lib/llm/rateLimit";
import { DEFAULT_TRANSLATE_MODEL, runTranslateTask } from "@/lib/llm/tasks/translate";
import type { ApiErrorBody, TranslateResponse } from "@jargonslayer/core/types";

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
  // #56 per-task model (additive, optional): pickModel below applies
  // the same BYOK-honored/server-key-allowlisted rule every other
  // route already uses. Absent/"" (today's behavior — translate has
  // no user-facing model field) falls through to the existing
  // env-forced model exactly as before.
  model: z.string().optional(),
});

function errorBody(body: ApiErrorBody, status: number) {
  return NextResponse.json(body, { status });
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
  const { segments, lang, model } = parsedBody.data;

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
    return errorBody({ error: "请求过于频繁，请稍后重试", code: "rate_limit" }, 429);
  }
  // Global daily budget (distributed-IP/slow-burn spend the per-IP
  // limiter above can't see) — see rateLimit.ts's allowDailyBudget doc.
  if (cfg.isServerKey && !allowDailyBudget("translate")) {
    return errorBody(
      { error: "体验版今日 AI 额度已用完，请明日再试，或使用本地版 / 自备 API Key", code: "rate_limit" },
      429,
    );
  }

  try {
    // pickModel (#56/#61): client model (now optionally settable via
    // #56's per-task translate override) honored only inside the
    // server-side allowlist when the shared key serves the request;
    // BYOK unchanged. Absent/"" falls through to the env-forced model
    // exactly as before #56 existed.
    const chosenModel = pickModel(cfg, model, DEFAULT_TRANSLATE_MODEL);
    // Reasoning-off is a MINIMAX-specific translate optimization
    // (measured 2026-07-06: 4.0s → 1.7s, ~1/4 cost) — other models
    // hard-fail on the param upstream (deepseek-v4-flash 502'd through
    // OpenRouter's edge the moment #56 let translate reach it, v0.2.3
    // live E2E). Applied after pickModel so it keys off the model that
    // will actually serve the call, server-key mode only (BYOK never
    // gets extraBody).
    const extraBody =
      cfg.isServerKey && cfg.extraBody && chosenModel.startsWith("minimax/")
        ? { ...cfg.extraBody, reasoning: { enabled: false } }
        : cfg.extraBody;

    // Prompt assembly + provider call + id-filter now live in the
    // shared tasks/translate.ts module (v0.4 S2) — see detect/route.ts's
    // identical comment.
    const filtered = await runTranslateTask(
      {
        apiKey: cfg.apiKey,
        model: chosenModel,
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        extraBody,
        segments,
        lang,
      },
      withFallback(cfg.fallbackModel),
    );

    return NextResponse.json(filtered satisfies TranslateResponse);
  } catch (err) {
    const mapped = mapLlmError(err);
    return errorBody(mapped.body, mapped.status);
  }
}
