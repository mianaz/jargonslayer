// Browser-side fetch helpers for /api/detect and /api/summarize.
// OWNER: worker B.

import type {
  ApiErrorBody,
  DefineRequest,
  DefineResult,
  DetectRequest,
  DetectResponse,
  Settings,
  SummarizeRequest,
  SummaryResult,
  TranslateRequest,
  TranslateResponse,
} from "../types";
import { PROVIDER_HEADERS } from "../types";
import { withBase } from "../basePath";

export class NoKeyError extends Error {
  constructor(message = "未配置 API Key") {
    super(message);
    this.name = "NoKeyError";
  }
}

export class RateLimitApiError extends Error {
  constructor(message = "请求过于频繁，请稍后再试") {
    super(message);
    this.name = "RateLimitApiError";
  }
}

export class UpstreamError extends Error {
  constructor(message = "模型请求失败") {
    super(message);
    this.name = "UpstreamError";
  }
}

/** Every header the routes need to resolve key + provider + endpoint
 *  for a request, built from the current settings. */
function authHeaders(settings: Settings): Record<string, string> {
  const headers: Record<string, string> = {
    [PROVIDER_HEADERS.provider]: settings.provider,
  };
  if (settings.apiKey) {
    headers[PROVIDER_HEADERS.key] = settings.apiKey;
  }
  if (settings.provider === "openai-compat" && settings.baseUrl) {
    headers[PROVIDER_HEADERS.baseUrl] = settings.baseUrl;
  }
  return headers;
}

async function parseErrorBody(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body?.error;
  } catch {
    return undefined;
  }
}

async function throwForStatus(res: Response): Promise<never> {
  if (res.status === 401) {
    const msg = await parseErrorBody(res);
    throw new NoKeyError(msg ?? "未配置 API Key");
  }
  if (res.status === 429) {
    const msg = await parseErrorBody(res);
    throw new RateLimitApiError(msg ?? "请求过于频繁，请稍后再试");
  }
  const msg = await parseErrorBody(res);
  throw new UpstreamError(msg ?? `请求失败（${res.status}）`);
}

export async function detectApi(
  body: DetectRequest,
  settings: Settings,
): Promise<DetectResponse> {
  let res: Response;
  try {
    res = await fetch(withBase("/api/detect"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(settings),
      },
      body: JSON.stringify({ ...body, lang: settings.explainLanguage } satisfies DetectRequest),
      // Reasoning models behind openai-compat endpoints (e.g. the
      // hosted demo's MiniMax M-series) routinely take 8-15s per
      // batch; the previous 8s (tuned for Haiku) timed every batch
      // out and tripped the scheduler's consecutive-failure fallback
      // latch. Detection is async and additive, so a slow batch is
      // still useful — cards just land a moment later.
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new UpstreamError("检测请求超时");
    }
    throw new UpstreamError("检测请求失败，请检查网络连接");
  }

  if (!res.ok) {
    await throwForStatus(res);
  }

  return (await res.json()) as DetectResponse;
}

export async function summarizeApi(
  body: SummarizeRequest,
  settings: Settings,
): Promise<SummaryResult> {
  let res: Response;
  try {
    res = await fetch(withBase("/api/summarize"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(settings),
      },
      body: JSON.stringify({
        ...body,
        lang: settings.explainLanguage,
      } satisfies SummarizeRequest),
      signal: AbortSignal.timeout(300000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new UpstreamError("生成报告超时，请稍后重试");
    }
    throw new UpstreamError("报告生成失败，请检查网络连接");
  }

  if (!res.ok) {
    await throwForStatus(res);
  }

  return (await res.json()) as SummaryResult;
}

export async function defineApi(
  body: DefineRequest,
  settings: Settings,
): Promise<DefineResult> {
  let res: Response;
  try {
    res = await fetch(withBase("/api/define"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(settings),
      },
      body: JSON.stringify({ ...body, lang: settings.explainLanguage } satisfies DefineRequest),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new UpstreamError("解释请求超时");
    }
    throw new UpstreamError("解释请求失败，请检查网络连接");
  }

  if (!res.ok) {
    await throwForStatus(res);
  }

  return (await res.json()) as DefineResult;
}

export async function translateApi(
  body: TranslateRequest,
  settings: Settings,
): Promise<TranslateResponse> {
  let res: Response;
  try {
    res = await fetch(withBase("/api/translate"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(settings),
      },
      body: JSON.stringify(body satisfies TranslateRequest),
      // Reasoning-model latency, same rationale as detect's 20s, but
      // batches here carry up to 6 segments instead of one.
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new UpstreamError("翻译请求超时");
    }
    throw new UpstreamError("翻译请求失败，请检查网络连接");
  }

  if (!res.ok) {
    await throwForStatus(res);
  }

  return (await res.json()) as TranslateResponse;
}

/** Probe the configured provider/key/baseUrl with a trivial detect
 *  call and translate the outcome into a user-facing message for the
 *  Settings dialog's 「测试连接」button. Never throws. */
export async function testConnection(
  settings: Settings,
): Promise<{ ok: boolean; message: string }> {
  try {
    await detectApi(
      { context: "", new_text: "We need to circle back on this." },
      settings,
    );
    return { ok: true, message: "连接成功，模型可用" };
  } catch (err) {
    if (err instanceof NoKeyError) {
      return { ok: false, message: "Key 未配置或无效" };
    }
    if (err instanceof RateLimitApiError) {
      return { ok: true, message: "连接成功但被限流（Key 有效）" };
    }
    return { ok: false, message: err instanceof Error ? err.message : "连接失败" };
  }
}
