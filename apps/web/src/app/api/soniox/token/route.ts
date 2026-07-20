export const runtime = "nodejs";

// Preview-lane Soniox temporary-key mint. The hosted preview build
// (NEXT_PUBLIC_DEPLOY_TIER=preview) offers Soniox real-time STT as a
// trial on the OWNER's Soniox credential — users get the flagship
// zh-en engine without BYOK. This route is the ONLY place that
// credential is touched: it exchanges the server key for a short-lived
// temporary key (Soniox /v1/auth/temporary-api-key), scoped so a
// single mint can only ever fund one bounded session:
//
//   • max_session_duration_seconds — Soniox SERVER-drops the websocket
//     at the cap (verified live: 403 "session duration limit
//     exceeded"), so a client can't hold a socket open to run up cost.
//   • single_use — the returned key authenticates exactly one ws
//     session (SonioxTransport has no reconnect, so this never bites).
//   • expires_in_seconds — the key is only valid long enough to open
//     the socket after the mic is acquired.
//
// The monthly $ ceiling is enforced by allowSonioxMint (rateLimit.ts):
// global daily mint cap × 31 days stays under the owner's budget, plus
// a per-IP daily cap for fairness. The server key never leaves this
// process — only the temp key is returned, and it's already
// session-capped + single-use + short-lived.

import { NextResponse } from "next/server";
import { allowRequest, allowSonioxMint, clientIp, refundSonioxMint } from "@/lib/llm/rateLimit";
import type { ApiErrorBody } from "@jargonslayer/core/types";

const MINT_URL = "https://api.soniox.com/v1/auth/temporary-api-key";

// How long each minted session may run (server-enforced). 10 min is a
// real trial length; it also sets the per-mint cost bound
// (10min × $0.12/hr = $0.02). Env-overridable to retune the ceiling.
const SESSION_SECONDS = (() => {
  const raw = Number(process.env.JARGONSLAYER_SONIOX_SESSION_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 600;
})();

// The key must survive from mint until the client opens the ws (after
// the mic-permission prompt). 120s is ample; it does NOT extend the
// session (max_session_duration_seconds governs that once connected).
const KEY_TTL_SECONDS = 120;

function errorBody(body: ApiErrorBody, status: number) {
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  const serverKey = process.env.JARGONSLAYER_SONIOX_KEY;
  if (!serverKey) {
    // Not a preview deploy (or the key isn't provisioned) — the client
    // treats any non-200 here as "fall back to browser 识别".
    return errorBody(
      { error: "此部署未启用 Soniox 预览体验", code: "no_key" },
      404,
    );
  }

  const ip = clientIp(req);

  // Burst guard: minting is cheap but a tight loop shouldn't hammer
  // Soniox's auth endpoint (this is separate from the daily money cap).
  if (!allowRequest(`soniox-token:${ip}`, 2)) {
    return errorBody({ error: "请求过于频繁，请稍后重试", code: "rate_limit" }, 429);
  }

  // The money ceiling. Exhaustion is expected, not an error condition —
  // the client falls back to browser 识别 on this specific code.
  if (!allowSonioxMint(ip)) {
    return errorBody(
      { error: "预览版 Soniox 体验额度已达上限，请改用浏览器识别或自备密钥", code: "preview_budget" },
      429,
    );
  }

  // Every failure below this point refunds the reserved slot — see
  // refundSonioxMint's doc for why reserve-then-refund (not
  // check-then-count-late) is the race-free shape.
  let upstream: Response;
  try {
    upstream = await fetch(MINT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serverKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        usage_type: "transcribe_websocket",
        expires_in_seconds: KEY_TTL_SECONDS,
        max_session_duration_seconds: SESSION_SECONDS,
        single_use: true,
      }),
    });
  } catch {
    refundSonioxMint(ip);
    return errorBody({ error: "无法连接 Soniox", code: "upstream" }, 502);
  }

  if (!upstream.ok) {
    // Never forward Soniox's body — it could echo account detail. The
    // server key is not in scope of the response either way.
    refundSonioxMint(ip);
    return errorBody({ error: "Soniox 临时密钥签发失败", code: "upstream" }, 502);
  }

  let minted: { api_key?: unknown; expires_at?: unknown };
  try {
    minted = await upstream.json();
  } catch {
    refundSonioxMint(ip);
    return errorBody({ error: "Soniox 返回了非法响应", code: "upstream" }, 502);
  }

  if (typeof minted.api_key !== "string" || !minted.api_key) {
    refundSonioxMint(ip);
    return errorBody({ error: "Soniox 未返回临时密钥", code: "upstream" }, 502);
  }

  // Only the temp key (session-capped, single-use, short-lived) and its
  // expiry leave here. No-store so no proxy/browser cache retains it.
  return NextResponse.json(
    { api_key: minted.api_key, expires_at: minted.expires_at ?? null },
    { headers: { "cache-control": "no-store" } },
  );
}
