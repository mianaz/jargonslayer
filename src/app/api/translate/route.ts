export const runtime = "nodejs";

import { NextResponse } from "next/server";
import * as z from "zod";
import {
  callJsonWithFallback,
  mapLlmError,
  pickModel,
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
    return errorBody({ error: "请求过于频繁，请稍后再试", code: "rate_limit" }, 429);
  }

  try {
    // pickModel (#56/#61): client model (now optionally settable via
    // #56's per-task translate override) honored only inside the
    // server-side allowlist when the shared key serves the request;
    // BYOK unchanged. Absent/"" falls through to the env-forced model
    // exactly as before #56 existed.
    const chosenModel = pickModel(cfg, model, "claude-haiku-4-5");
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
    const raw = await callJsonWithFallback(
      {
        apiKey: cfg.apiKey,
        model: chosenModel,
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
        extraBody,
      },
      cfg.fallbackModel,
    );

    const filtered = postFilter(raw, new Set(segments.map((s) => s.id)));
    return NextResponse.json(filtered satisfies TranslateResponse);
  } catch (err) {
    const mapped = mapLlmError(err);
    return errorBody(mapped.body, mapped.status);
  }
}
