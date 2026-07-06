export const runtime = "nodejs";

// Thin CORS shim for OpenRouter's OAuth PKCE code→key exchange
// (https://openrouter.ai/docs/use-cases/oauth-pkce). The docs don't
// state whether https://openrouter.ai/api/v1/auth/keys is CORS-enabled
// for direct browser fetch, so this route proxies the POST server-side
// instead. No server credential is involved — the browser's own
// code_verifier is passed straight through and the resulting
// user-controlled key is returned as-is; this never touches
// resolveLlmConfig or any BYOK/server-key logic.

import { NextResponse } from "next/server";
import * as z from "zod";
import { allowRequest, clientIp } from "@/lib/llm/rateLimit";
import { EXCHANGE_URL } from "@/lib/oauth/openrouterPkce";
import type { ApiErrorBody } from "@/lib/types";

const BodySchema = z.object({
  code: z.string().min(1),
  code_verifier: z.string().min(1),
  code_challenge_method: z.literal("S256"),
});

function errorBody(body: ApiErrorBody, status: number) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  // Abuse guard: this endpoint takes no API key of its own, so it's
  // otherwise an open proxy to OpenRouter's exchange endpoint.
  if (!allowRequest(`openrouter-exchange:${clientIp(req)}`, 10)) {
    return errorBody({ error: "请求过于频繁，请稍后再试", code: "rate_limit" }, 429);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorBody({ error: "请求体不是合法 JSON", code: "bad_request" }, 400);
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return errorBody({ error: "请求参数不合法", code: "bad_request" }, 400);
  }

  let upstream: Response;
  try {
    upstream = await fetch(EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed.data),
    });
  } catch {
    return errorBody({ error: "无法连接 OpenRouter", code: "upstream" }, 502);
  }

  let upstreamJson: unknown;
  try {
    upstreamJson = await upstream.json();
  } catch {
    return errorBody({ error: "OpenRouter 返回了非法响应", code: "upstream" }, 502);
  }

  if (!upstream.ok) {
    const message =
      upstreamJson &&
      typeof upstreamJson === "object" &&
      "error" in upstreamJson &&
      typeof (upstreamJson as { error?: unknown }).error === "string"
        ? (upstreamJson as { error: string }).error
        : "兑换 API Key 失败";
    return errorBody({ error: message, code: "upstream" }, upstream.status);
  }

  return NextResponse.json(upstreamJson);
}
