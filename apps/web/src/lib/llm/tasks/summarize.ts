// Isomorphic "summarize" task (v0.4 S2, PLAN-v0.4 §1A/§4) — the
// three-stage post-meeting report (summary + chunked/parallel
// translation + missed-item sweep) + flashcard assembly, shared by
// app/api/summarize/route.ts and lib/llm/client.ts's client-side path.
// See tasks/detect.ts's header comment for the general contract.
//
// Request-size caps (MAX_SEGMENTS/MAX_TOTAL_SEGMENT_CHARS below) are
// single-sourced here but their ENFORCEMENT (the actual `if (...)
// throw`) deliberately does NOT live here — this module is shared by
// BOTH callers, and each applies its own guard at its own natural
// entry point instead of a third copy inside runSummarizeTask itself
// (which would make the route path guard twice for no benefit). This
// used to be a route.ts-only guard (HTTP-input-validation/DoS defense
// against ARBITRARY untrusted callers of our own route) — F4 (codex
// v04-integration review) added the SAME caps to client.ts's
// summarizeViaClient too, for a DIFFERENT reason: even our own code,
// running with the user's own already-in-memory session data, can
// freeze the UI thread building unbounded strings/chunk lists for a
// long enough marathon meeting. Self-protection + behavior parity
// (byte-identical user-facing error), not DoS defense — see that call
// site's own comment. Graceful truncation instead of a hard reject is
// a deliberate non-goal until the desktop UX pass.

import {
  DEFAULT_SETTINGS,
  type DetectedExpression,
  type DetectedTerm,
  type ExplainLanguage,
  type Flashcard,
  type LlmProvider,
  type MeetingSummary,
  type SummarizeRequest,
  type SummaryResult,
  type TranslationPair,
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
import { filterDetectSpans, type DetectSpanCaps } from "../../detect/spanQc";

// v0.4.5 detect-span QC (item 6): this module is isomorphic (shared by
// the Next.js route AND the client-side BYOK path — see header
// comment above) and, unlike scheduler.ts/upload.ts, has no `Settings`
// object threaded through it — route.ts is a stateless server handler
// with no user Settings store to read at all. `SummarizeTaskInput.
// spanQcCaps` is therefore OPTIONAL: a caller that has the user's real
// settings.detectIdiomMaxWords/Chars (client.ts's summarizeViaClient
// does) can pass them through; one that doesn't (or hasn't been wired
// up yet) falls back to DEFAULT_SETTINGS' own values below, so the
// sweep's span QC is never silently skipped either way.
const DEFAULT_SPAN_QC_CAPS: DetectSpanCaps = {
  idiomMaxWords: DEFAULT_SETTINGS.detectIdiomMaxWords,
  idiomMaxChars: DEFAULT_SETTINGS.detectIdiomMaxChars,
};

// Field-test fix (v0.4.4) — see tasks/detect.ts's DEFAULT_DETECT_MODEL
// doc comment for the full rationale (bare Anthropic ids 400 on
// OpenRouter; DeepSeek's own OpenRouter slug is the new default — the
// PRO variant here, since summary is async and has no live-UI budget,
// unlike detect/define/translate's FLASH variant).
export const DEFAULT_SUMMARIZE_MODEL = "deepseek/deepseek-v4-pro";

// ---------------------------------------------------------------
// Request-size caps — see this file's header comment for why the
// VALUES live here (single-sourced) while the ENFORCEMENT lives in
// each caller instead.
// ---------------------------------------------------------------

export const MAX_SEGMENTS = 2000;
export const MAX_TOTAL_SEGMENT_CHARS = 400_000;

export function totalSegmentChars(segments: SummarizeRequest["segments"]): number {
  let total = 0;
  for (const s of segments) total += s.text.length;
  return total;
}

/** The exact zh message (+ HTTP 413/"bad_request" on the route) for
 *  over-cap input — single-sourced so client.ts's self-protection
 *  guard throws byte-identical user-facing text to what a request
 *  that hit the SAME cap server-side already produces today (see
 *  client.ts's throwForStatus, which maps a 413 to this exact string
 *  via UpstreamError). */
export const SUMMARIZE_TOO_LARGE_MESSAGE = "会议内容过长，超出报告生成上限";

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
  /** v0.4.5 detect-span QC (item 6) — see DEFAULT_SPAN_QC_CAPS' own doc
   *  comment above for why this is optional rather than required. */
  spanQcCaps?: DetectSpanCaps;
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

// F1 (codex v04-integration review) — the console.warn(..., err) calls
// in this stage and in runSweepStage below log `err` RAW (not just a
// derived message), and `call` here can throw providerCore.ts's
// OpenAiCompatError or clientProvider.ts's ProviderHttpError directly
// (unlike client.ts's *Api callers, this module's ProviderCaller is
// injected by the route/client caller and its errors are never first
// re-wrapped into client.ts's UpstreamError taxonomy). That is
// deliberately left as-is here rather than re-sanitizing a second
// time: both error classes' `.message` are already sanitized at
// construction (providerCore.ts's requestChatContent /
// clientProvider.ts's callAnthropicDirect route every raw response
// excerpt through sanitizeProviderExcerpt before it ever reaches an
// Error), so logging the raw `err` object here just re-logs an
// already-safe message — verified by a dedicated regression test
// (clientTransport.test.ts). Re-sanitizing here too would need this
// isomorphic, provider-caller-agnostic module to import a SPECIFIC
// caller implementation (clientProvider.ts's ProviderHttpError) just
// to type-check an instanceof, which is exactly the layering this
// module's header comment says to avoid.
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
  spanQcCaps: DetectSpanCaps,
  call: ProviderCaller,
): Promise<{ expressions: DetectedExpression[]; terms: DetectedTerm[]; qcDropped: number }> {
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

    // v0.4.5 detect-span QC (field bug: the sweep had NO span-length
    // QC at all before this fix — see spanQc.ts's own header comment).
    // Filtered BEFORE the top-N slice so a dropped oversized span never
    // occupies one of the sweep's limited expression slots.
    //
    // F4 (adversarial review): this module is isomorphic and, on the
    // default web transport, runs server-side inside the /api/summarize
    // route — calling recordLlmQcDrop here would write to a throwaway
    // server-process zustand store no browser ever reads. Tally the
    // drop count and hand it back through runSummarizeTask's returned
    // SummaryResult instead; client.ts's summarizeApi (the one place
    // both transports funnel through) is what actually records it.
    let qcDropped = 0;
    const filtered = filterDetectSpans(res, spanQcCaps, (droppedCount) => {
      qcDropped = droppedCount;
    });

    return {
      expressions: filtered.expressions
        .slice(0, SWEEP_MAX_EXPRESSIONS)
        .map((e) => ({ ...e, confidence: clampConfidence(e.confidence) })),
      terms: filtered.terms.slice(0, SWEEP_MAX_TERMS),
      qcDropped,
    };
  } catch (err) {
    console.warn("[summarize] sweep stage failed, proceeding without it", err);
    return { expressions: [], terms: [], qcDropped: 0 };
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
  const spanQcCaps = input.spanQcCaps ?? DEFAULT_SPAN_QC_CAPS;

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
      spanQcCaps,
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
    sweepQcDropped: sweep.qcDropped,
  };
}
