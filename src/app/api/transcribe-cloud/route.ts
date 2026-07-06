export const runtime = "nodejs";
export const maxDuration = 300;

// Cloud transcription (#22): forwards an uploaded recording to the
// user's configured OpenAI-compatible endpoint's audio/transcriptions
// API (e.g. Groq's whisper-large-v3-turbo). Anthropic has no audio
// API, so this route requires provider "openai-compat" — mirrors the
// key/provider/baseUrl resolution every other route uses.

import { NextResponse } from "next/server";
import { resolveKey, resolveProvider } from "@/lib/llm/anthropic";
import type { ApiErrorBody } from "@/lib/types";

const DEFAULT_MODEL = "whisper-large-v3-turbo";

export interface CloudTranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface CloudTranscribeResponse {
  segments: CloudTranscriptSegment[];
}

interface VerboseJsonSegment {
  start?: number;
  end?: number;
  text?: string;
}

interface VerboseJsonResponse {
  text?: string;
  segments?: VerboseJsonSegment[];
}

function errorBody(body: ApiErrorBody, status: number) {
  return NextResponse.json(body, { status });
}

// Reject oversized uploads before doing any work: first cheaply via
// the Content-Length header (before formData() buffers the body into
// memory), then again on the parsed File in case the header was
// absent/wrong.
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** Normalize an upstream verbose_json (or plain text) transcription
 *  payload into the wire shape this route promises callers. When the
 *  upstream only returned `text` (no segments array), the whole
 *  transcript becomes a single zero-duration segment. */
function normalizeUpstreamResponse(raw: VerboseJsonResponse): CloudTranscribeResponse {
  if (Array.isArray(raw.segments) && raw.segments.length > 0) {
    return {
      segments: raw.segments.map((s) => ({
        start: typeof s.start === "number" ? s.start : 0,
        end: typeof s.end === "number" ? s.end : 0,
        text: (s.text ?? "").trim(),
      })),
    };
  }
  const text = (raw.text ?? "").trim();
  return { segments: text ? [{ start: 0, end: 0, text }] : [] };
}

export async function POST(req: Request) {
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return errorBody({ error: "音频文件过大", code: "bad_request" }, 413);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return errorBody({ error: "请求格式无效，需要 multipart/form-data", code: "bad_request" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return errorBody({ error: "缺少音频文件", code: "bad_request" }, 400);
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return errorBody({ error: "音频文件过大", code: "bad_request" }, 413);
  }

  const language = form.get("language");
  const modelField = form.get("model");
  const model = typeof modelField === "string" && modelField.trim() ? modelField : DEFAULT_MODEL;

  const apiKey = resolveKey(req);
  if (!apiKey) {
    return errorBody({ error: "未配置 API Key", code: "no_key" }, 401);
  }

  const { provider, baseUrl } = resolveProvider(req);
  if (provider === "anthropic") {
    return errorBody(
      { error: "云端转录需要 OpenAI 兼容端点（如 Groq），请在设置中配置", code: "bad_request" },
      400,
    );
  }
  if (!baseUrl) {
    return errorBody({ error: "缺少 Base URL", code: "bad_request" }, 400);
  }

  const upstreamForm = new FormData();
  upstreamForm.set("file", file, file.name);
  upstreamForm.set("model", model);
  upstreamForm.set("response_format", "verbose_json");
  if (typeof language === "string" && language.trim()) {
    upstreamForm.set("language", language);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstreamForm,
    });
  } catch {
    return errorBody({ error: "云端转录请求失败，请检查网络连接", code: "upstream" }, 502);
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text().catch(() => "");
    if (upstreamRes.status === 401 || upstreamRes.status === 403) {
      return errorBody({ error: "API Key 无效", code: "no_key" }, 401);
    }
    if (upstreamRes.status === 429) {
      return errorBody({ error: "请求过于频繁，请稍后再试", code: "rate_limit" }, 429);
    }
    return errorBody(
      { error: text.slice(0, 500) || `云端转录失败（${upstreamRes.status}）`, code: "upstream" },
      502,
    );
  }

  let raw: VerboseJsonResponse;
  try {
    raw = (await upstreamRes.json()) as VerboseJsonResponse;
  } catch {
    return errorBody({ error: "云端转录响应解析失败", code: "upstream" }, 502);
  }

  return NextResponse.json(normalizeUpstreamResponse(raw) satisfies CloudTranscribeResponse);
}
