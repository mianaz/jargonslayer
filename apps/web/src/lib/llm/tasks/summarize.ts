// Isomorphic "summarize" task (v0.4 S2, PLAN-v0.4 §1A/§4) — the
// three-stage post-meeting report (summary + chunked/parallel
// translation + missed-item sweep) + flashcard assembly, shared by
// app/api/summarize/route.ts and lib/llm/client.ts's client-side path.
// See tasks/detect.ts's header comment for the general contract.
//
// Request-size caps (MAX_SEGMENTS/MAX_TOTAL_SEGMENT_CHARS) are NOT
// here — those are an HTTP-input-validation/DoS guard against
// ARBITRARY untrusted callers of our own route (see route.ts's own
// comment), which doesn't apply the same way to the client path (our
// own code, invoked with the user's own already-in-memory session
// data, spending the user's own key) — see task report for this
// deliberate scope note.

import type {
  DetectedExpression,
  DetectedTerm,
  ExplainLanguage,
  Flashcard,
  LlmProvider,
  MeetingSummary,
  SummarizeRequest,
  SummaryResult,
  TranslationPair,
} from "@jargonslayer/core/types";
import {
  buildSweepSystemPrompt,
  buildSweepUserMessage,
  SUMMARY_SYSTEM_PROMPT,
  TRANSLATE_SYSTEM_PROMPT,
} from "@jargonslayer/core/llm/prompts";
import {
  clampConfidence,
  DetectResponseSchema,
  MeetingSummarySchema,
  TranslationsSchema,
  type ProviderCaller,
} from "../providerCore";

export const DEFAULT_SUMMARIZE_MODEL = "claude-sonnet-5";

/** Provider/baseUrl/extraBody threaded through every callJson call in
 *  this module so all three stages hit the same configured endpoint —
 *  moved verbatim from app/api/summarize/route.ts's own LlmConfig. */
export interface SummarizeLlmConfig {
  provider: LlmProvider;
  baseUrl: string;
  extraBody?: Record<string, unknown>;
}

export interface SummarizeTaskInput {
  apiKey: string;
  model: string;
  llm: SummarizeLlmConfig;
  segments: SummarizeRequest["segments"];
  expressions: DetectedExpression[];
  terms: DetectedTerm[];
  lang?: ExplainLanguage;
  profile?: string;
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
  llm: SummarizeLlmConfig,
  call: ProviderCaller,
): Promise<MeetingSummary> {
  return call({
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
  llm: SummarizeLlmConfig,
  call: ProviderCaller,
): Promise<Map<number, string>> {
  const userPayload = JSON.stringify(chunk.map((s) => ({ i: s.index, en: s.text })));
  const res = await call({
    apiKey,
    model,
    system: TRANSLATE_SYSTEM_PROMPT,
    user: userPayload,
    schema: TranslationsSchema,
    maxTokens: 3000,
    arrayKey: "translations",
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
  llm: SummarizeLlmConfig,
  call: ProviderCaller,
): Promise<TranslationPair[]> {
  if (segments.length === 0) return [];

  const chunks = chunkSegments(segments);
  const resultsByIndex = new Map<number, string>();

  const chunkMaps = await runPool(chunks, TRANSLATE_CONCURRENCY, async (chunk) => {
    try {
      return await translateChunk(apiKey, model, chunk, llm, call);
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
      const repairMap = await translateChunk(apiKey, model, missing, llm, call);
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
// translation stages above stay zh bilingual regardless of `lang`).
// ---------------------------------------------------------------

const SWEEP_MAX_EXPRESSIONS = 10;
const SWEEP_MAX_TERMS = 6;

async function runSweepStage(
  apiKey: string,
  model: string,
  segments: SummarizeRequest["segments"],
  alreadyCaptured: string[],
  llm: SummarizeLlmConfig,
  lang: ExplainLanguage,
  profileHint: string | undefined,
  call: ProviderCaller,
): Promise<{ expressions: DetectedExpression[]; terms: DetectedTerm[] }> {
  const fullTranscript = segments
    .map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text))
    .join("\n");

  try {
    const res = await call({
      apiKey,
      model,
      system: buildSweepSystemPrompt(lang),
      user: buildSweepUserMessage(fullTranscript, alreadyCaptured, profileHint),
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
// Entry point
// ---------------------------------------------------------------

/** Only the summary stage is fatal (translation/sweep already degrade
 *  gracefully internally, see above); any throw reaching a caller maps
 *  through that caller's own error mapper (route.ts's mapLlmError /
 *  client.ts's direct-path mapper). No callJsonWithFallback-equivalent
 *  here — a summary spans several sequential stages and silently
 *  mixing models mid-report isn't worth the save (same rationale
 *  app/api/summarize/route.ts already documented; the client path
 *  never had a fallback model to begin with — BYOK, see tasks/
 *  detect.ts's header comment). */
export async function runSummarizeTask(
  input: SummarizeTaskInput,
  call: ProviderCaller,
): Promise<SummaryResult> {
  const { apiKey, model, llm, segments, expressions, terms } = input;
  const lang = input.lang ?? "zh";

  const summary = await runSummaryStage(apiKey, model, segments, llm, call);

  const [translations, sweep] = await Promise.all([
    runTranslationStage(apiKey, model, segments, llm, call),
    runSweepStage(
      apiKey,
      model,
      segments,
      [...expressions.map((e) => e.expression), ...terms.map((t) => t.term)],
      llm,
      lang,
      input.profile,
      call,
    ),
  ]);

  const flashcards = buildFlashcards(expressions, sweep.expressions, terms, sweep.terms);

  return {
    summary,
    translations: [...translations].sort((a, b) => a.index - b.index),
    flashcards,
    generatedAt: Date.now(),
    model,
  };
}
