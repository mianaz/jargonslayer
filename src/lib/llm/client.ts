// Browser-side fetch helpers for /api/detect and /api/summarize.
// OWNER: worker B.

import type {
  ApiErrorBody,
  DetectRequest,
  DetectResponse,
  Settings,
  SummarizeRequest,
  SummaryResult,
} from "../types";

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

function authHeaders(settings: Settings): Record<string, string> {
  return settings.apiKey ? { "x-meetlingo-key": settings.apiKey } : {};
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
    res = await fetch("/api/detect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(settings),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
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
    res = await fetch("/api/summarize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(settings),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new UpstreamError("生成报告超时，请稍后重试");
    }
    throw new UpstreamError("生成报告请求失败，请检查网络连接");
  }

  if (!res.ok) {
    await throwForStatus(res);
  }

  return (await res.json()) as SummaryResult;
}
