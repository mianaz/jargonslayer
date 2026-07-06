export const runtime = "nodejs";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import * as z from "zod";
import {
  callJson,
  clampConfidence,
  DetectResponseSchema,
  MeetingSummarySchema,
  mapLlmError,
  resolveKey,
  resolveProvider,
  TranslationsSchema,
} from "@/lib/llm/anthropic";
import type { ExplainLanguage, LlmProvider } from "@/lib/types";
import {
  buildSweepSystemPrompt,
  buildSweepUserMessage,
  SUMMARY_SYSTEM_PROMPT,
  TRANSLATE_SYSTEM_PROMPT,
} from "@/lib/llm/prompts";
import type {
  ApiErrorBody,
  DetectedExpression,
  DetectedTerm,
  Flashcard,
  MeetingSummary,
  SummarizeRequest,
  SummaryResult,
  TranslationPair,
} from "@/lib/types";

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
}) satisfies z.ZodType<SummarizeRequest>;

function errorBody(body: ApiErrorBody, status: number) {
  return NextResponse.json(body, { status });
}

/** Provider/baseUrl pair threaded through every callJson call in
 *  this route so all three stages hit the same configured endpoint. */
interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;
}

// ---------------------------------------------------------------
// Stage a — summary
// ---------------------------------------------------------------

function formatSegmentsForSummary(segments: SummarizeRequest["segments"]): string {
  return segments
    .map((s) => (s.speaker ? `[${s.index}] ${s.speaker}: ${s.text}` : `[${s.index}] ${s.text}`))
    .join("\n");
}

async function runSummaryStage(
  apiKey: string,
  model: string,
  segments: SummarizeRequest["segments"],
  llm: LlmConfig,
): Promise<MeetingSummary> {
  return callJson({
    apiKey,
    model,
    system: SUMMARY_SYSTEM_PROMPT,
    user: formatSegmentsForSummary(segments),
    schema: MeetingSummarySchema,
    maxTokens: 4000,
    ...llm,
  });
}

// ---------------------------------------------------------------
// Stage b — translation (chunked, parallel with a repair pass)
// ---------------------------------------------------------------

const CHUNK_MAX_SEGMENTS = 25;
const CHUNK_MAX_WORDS = 500;
const TRANSLATE_CONCURRENCY = 4;

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function chunkSegments(
  segments: SummarizeRequest["segments"],
): SummarizeRequest["segments"][] {
  const chunks: SummarizeRequest["segments"][] = [];
  let current: SummarizeRequest["segments"] = [];
  let currentWords = 0;

  for (const seg of segments) {
    const segWords = wordCount(seg.text);
    const wouldOverflow =
      current.length > 0 &&
      (current.length >= CHUNK_MAX_SEGMENTS || currentWords + segWords > CHUNK_MAX_WORDS);

    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      currentWords = 0;
    }

    current.push(seg);
    currentWords += segWords;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Simple promise-pool runner: at most `concurrency` tasks in flight. */
async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function runNext(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

async function translateChunk(
  apiKey: string,
  model: string,
  chunk: SummarizeRequest["segments"],
  llm: LlmConfig,
): Promise<Map<number, string>> {
  const userPayload = JSON.stringify(chunk.map((s) => ({ i: s.index, en: s.text })));
  const res = await callJson({
    apiKey,
    model,
    system: TRANSLATE_SYSTEM_PROMPT,
    user: userPayload,
    schema: TranslationsSchema,
    maxTokens: 3000,
    ...llm,
  });

  const map = new Map<number, string>();
  for (const t of res.translations) map.set(t.i, t.zh);
  return map;
}

async function runTranslationStage(
  apiKey: string,
  model: string,
  segments: SummarizeRequest["segments"],
  llm: LlmConfig,
): Promise<TranslationPair[]> {
  if (segments.length === 0) return [];

  const chunks = chunkSegments(segments);
  const resultsByIndex = new Map<number, string>();

  const chunkMaps = await runPool(chunks, TRANSLATE_CONCURRENCY, async (chunk) => {
    try {
      return await translateChunk(apiKey, model, chunk, llm);
    } catch (err) {
      console.warn("[summarize] translation chunk failed", err);
      return new Map<number, string>();
    }
  });

  for (const map of chunkMaps) {
    for (const [i, zh] of map) resultsByIndex.set(i, zh);
  }

  const missing = segments.filter((s) => !resultsByIndex.has(s.index));
  if (missing.length > 0) {
    try {
      const repairMap = await translateChunk(apiKey, model, missing, llm);
      for (const [i, zh] of repairMap) resultsByIndex.set(i, zh);
    } catch (err) {
      console.warn("[summarize] translation repair pass failed", err);
      // still-missing indices get a placeholder below.
    }
  }

  return segments.map((s) => ({
    index: s.index,
    zh: resultsByIndex.get(s.index) ?? "（翻译缺失）",
  }));
}

// ---------------------------------------------------------------
// Stage c — sweep for missed expressions/terms. `lang` affects only
// this stage's explanation language (v1 scope — the summary and
// translation stages below stay zh bilingual regardless of `lang`;
// widening those to "en" is left for a later pass).
// ---------------------------------------------------------------

const SWEEP_MAX_EXPRESSIONS = 10;
const SWEEP_MAX_TERMS = 6;

async function runSweepStage(
  apiKey: string,
  model: string,
  segments: SummarizeRequest["segments"],
  alreadyCaptured: string[],
  llm: LlmConfig,
  lang: ExplainLanguage,
): Promise<{ expressions: DetectedExpression[]; terms: DetectedTerm[] }> {
  const fullTranscript = segments
    .map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text))
    .join("\n");

  try {
    const res = await callJson({
      apiKey,
      model,
      system: buildSweepSystemPrompt(lang),
      user: buildSweepUserMessage(fullTranscript, alreadyCaptured),
      schema: DetectResponseSchema,
      maxTokens: 2500,
      ...llm,
    });

    return {
      expressions: res.expressions
        .slice(0, SWEEP_MAX_EXPRESSIONS)
        .map((e) => ({ ...e, confidence: clampConfidence(e.confidence) })),
      terms: res.terms.slice(0, SWEEP_MAX_TERMS),
    };
  } catch (err) {
    console.warn("[summarize] sweep stage failed, proceeding without it", err);
    return { expressions: [], terms: [] };
  }
}

// ---------------------------------------------------------------
// Flashcard assembly — built in code, no LLM formatting.
// Order: live expressions, sweep expressions, live terms, sweep
// terms; dedup by lowercased front.
// ---------------------------------------------------------------

function expressionToFlashcard(e: DetectedExpression): Flashcard {
  return {
    front: e.expression,
    back_zh: e.chinese_explanation,
    back_en: `${e.meaning} (plain: ${e.plain_english})`,
    example: e.source_sentence,
    tags: [e.category, "expression"],
  };
}

function termToFlashcard(t: DetectedTerm): Flashcard {
  return {
    front: t.term,
    back_zh: t.gloss_zh,
    back_en: t.gloss_en,
    example: "",
    tags: [t.type, "term"],
  };
}

function buildFlashcards(
  liveExpressions: DetectedExpression[],
  sweepExpressions: DetectedExpression[],
  liveTerms: DetectedTerm[],
  sweepTerms: DetectedTerm[],
): Flashcard[] {
  const ordered = [
    ...liveExpressions.map(expressionToFlashcard),
    ...sweepExpressions.map(expressionToFlashcard),
    ...liveTerms.map(termToFlashcard),
    ...sweepTerms.map(termToFlashcard),
  ];

  const seen = new Set<string>();
  const deduped: Flashcard[] = [];
  for (const card of ordered) {
    const key = card.front.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(card);
  }
  return deduped;
}

// ---------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------

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
  const { segments, expressions, terms, model: requestedModel, lang } = parsedBody.data;

  const apiKey = resolveKey(req);
  if (!apiKey) {
    return errorBody({ error: "未配置 API Key", code: "no_key" }, 401);
  }

  const { provider, baseUrl } = resolveProvider(req);
  if (provider === "openai-compat" && !baseUrl) {
    return errorBody({ error: "缺少 Base URL", code: "bad_request" }, 400);
  }
  const llm: LlmConfig = { provider, baseUrl };

  const model = requestedModel ?? "claude-sonnet-5";

  try {
    const summary = await runSummaryStage(apiKey, model, segments, llm);

    const [translations, sweep] = await Promise.all([
      runTranslationStage(apiKey, model, segments, llm),
      runSweepStage(
        apiKey,
        model,
        segments,
        [...expressions.map((e) => e.expression), ...terms.map((t) => t.term)],
        llm,
        lang ?? "zh",
      ),
    ]);

    const flashcards = buildFlashcards(expressions, sweep.expressions, terms, sweep.terms);

    const result: SummaryResult = {
      summary,
      translations: [...translations].sort((a, b) => a.index - b.index),
      flashcards,
      generatedAt: Date.now(),
      model,
    };

    return NextResponse.json(result);
  } catch (err) {
    // Only the summary stage is fatal (translation/sweep already
    // degrade gracefully internally); any throw reaching here maps
    // through the shared error mapper.
    const mapped = mapLlmError(err);
    return errorBody(mapped.body, mapped.status);
  }
}
