// Isomorphic "correct" task (v0.5 Wave-1 Feature 2, batch/review-gated
// AI transcript correction — docs/design-explorations/v05-wave1-
// blueprint.md §1 Feature 2 + §5 A5). Shared by app/api/correct/route.ts
// (web) and lib/llm/client.ts's client-side path (desktop/iOS, which
// strip app/api) — see tasks/translate.ts's header comment for the
// general isomorphic-task contract this mirrors.
//
// Pre-merge review Finding 1: runCorrectTask makes exactly ONE provider
// call for the window it's given (unchanged core contract) — a whole
// meeting is chunked into several such windows BEFORE reaching this
// function; see chunkCorrectSegments/the cap constants below.

import type { CorrectResponse, LlmProvider } from "@jargonslayer/core/types";
import { buildCorrectUserMessage, CORRECT_SYSTEM_PROMPT } from "@jargonslayer/core/llm/prompts";
import { CorrectResponseSchema, type ProviderCaller } from "../providerCore";

// Rides the detect-domain default (§5 A5: "correction rides the
// detect-domain config") — same fallback id as DEFAULT_DETECT_MODEL/
// DEFAULT_DEFINE_MODEL/DEFAULT_TRANSLATE_MODEL.
export const DEFAULT_CORRECT_MODEL = "deepseek/deepseek-v4-flash";

// ---------------------------------------------------------------
// Per-call caps (pre-merge review Finding 1 fix) — single-sourced here
// (mirrors tasks/summarize.ts's MAX_SEGMENTS/MAX_TOTAL_SEGMENT_CHARS
// convention), consumed by BOTH app/api/correct/route.ts's zod schema
// AND assertWithinCallCaps below. A whole meeting can far exceed a
// SINGLE call's budget — see chunkCorrectSegments further down, which
// is what actually keeps every real request under these numbers; the
// caps themselves are the verified per-call ceiling.
//
// Token math (maxTokens=8000 output, ~4 chars/token — the common
// cl100k-class approximation used for English/business prose):
//   - 8000 tokens ~= 32,000 raw output chars.
//   - JSON scaffolding per correction row, worst case (a 36-char
//     crypto.randomUUID() id, see types.ts's newId): `{"id":"<36
//     chars>","text":"…"},` = 56 fixed chars + the text content itself.
//     40 rows (CORRECT_MAX_SEGMENTS_PER_CALL) => ~40*56 + ~20 (the
//     `{"corrections":[...]}` wrapper) ~= 2,260 chars of pure
//     scaffolding.
//   - Remaining budget for corrected TEXT ~= 32,000 - 2,260 ~= 29,740
//     chars. A correction fixes a garbled span IN PLACE — it does not
//     meaningfully lengthen a segment — so even a generous 15% output
//     expansion over CORRECT_MAX_TOTAL_CHARS_PER_CALL's 24,000-char
//     input budget (24,000 * 1.15 ~= 27,600) leaves ~2,100 chars
//     (~500 tokens, ~7%) of headroom against the 8000-token ceiling.
//     In REAL meetings a spoken utterance runs well under 1500 chars
//     (the per-segment cap), so the 40-segment COUNT cap closes a
//     window long before the char cap ever does — this worst-case
//     margin is the rare tail case, not the common one.
//   - Input side: 40 segments (<=24,000 chars) + a repeated-per-window
//     lexicon (<=CORRECT_MAX_LEXICON_CHARS=4,000 chars) + context
//     (<=4,000 chars, the existing route cap — chunkCorrectSegments'
//     2-adjacent-segment window context tops out at 3,000, comfortably
//     under it) + the ~1,300-char system prompt totals well under
//     10,000 input tokens — far inside any modern context window.
export const CORRECT_MAX_SEGMENTS_PER_CALL = 40;
export const CORRECT_MAX_TOTAL_CHARS_PER_CALL = 24_000;
export const CORRECT_MAX_LEXICON_CHARS = 4_000;

export function totalSegmentChars(segments: { id: string; text: string }[]): number {
  let total = 0;
  for (const s of segments) total += s.text.length;
  return total;
}

export function totalLexiconChars(lexicon: string[]): number {
  let total = 0;
  for (const term of lexicon) total += term.length;
  return total;
}

/** Priority-ordered prefix of `lexicon` that fits under `maxChars` —
 *  mirrors lib/stt/lexicon.ts's capTermsByCountAndBytes discipline
 *  (take a prefix, never reorder; `lexicon` is assumed already
 *  priority-ordered, same contract as MeetingLexicon.terms). Lets a
 *  caller degrade a large personal glossary to "top-N terms worth of
 *  ground truth" instead of every window's request getting rejected
 *  outright by CORRECT_MAX_LEXICON_CHARS. */
export function capLexiconChars(lexicon: string[], maxChars: number): string[] {
  const out: string[] = [];
  let chars = 0;
  for (const term of lexicon) {
    if (chars + term.length > maxChars) break;
    out.push(term);
    chars += term.length;
  }
  return out;
}

export interface CorrectTaskInput {
  apiKey: string;
  model: string;
  provider: LlmProvider;
  baseUrl: string;
  extraBody?: Record<string, unknown>;
  segments: { id: string; text: string }[];
  context: string;
  lexicon: string[];
  meetingTitle?: string;
}

/** A5 (BLOCKER): reject a blank/duplicate id and drop anything the
 *  model returned for an id that wasn't requested. `changed` is never
 *  computed here (or trusted from the model at all — see
 *  CorrectResponse's own doc in types.ts); every consumer computes it
 *  CLIENT-side by diffing this `text` against the ORIGINAL request
 *  text. Moved verbatim in spirit from tasks/translate.ts's own
 *  postFilter, extended with the blank/duplicate-id guard correction
 *  additionally needs. */
function postFilter(
  res: CorrectResponse,
  requestedIds: Set<string>,
): CorrectResponse {
  const seen = new Set<string>();
  const corrections = res.corrections.filter((c) => {
    if (!c.id || seen.has(c.id) || !requestedIds.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  return { corrections };
}

/** Finding 1 fix — defense-in-depth mirror of app/api/correct/route.ts's
 *  zod caps. The desktop/iOS BYOK path (lib/llm/client.ts's
 *  correctViaClient) calls runCorrectTask directly with NO route/zod in
 *  front of it at all, so the SAME per-call caps route.ts enforces via
 *  its BodySchema must also be enforced HERE — "desktop/iOS parity",
 *  one isomorphic enforcement point every path funnels through. Should
 *  never actually trip for a well-behaved caller (chunkCorrectSegments
 *  below already builds every window within these exact caps, and
 *  CorrectionReview.tsx caps its outgoing lexicon the same way) — this
 *  only catches a caller that bypasses that helper or a future
 *  cap-constant drift. */
function assertWithinCallCaps(input: CorrectTaskInput): void {
  if (input.segments.length > CORRECT_MAX_SEGMENTS_PER_CALL) {
    throw new Error(
      `correct: ${input.segments.length} segments exceeds the ${CORRECT_MAX_SEGMENTS_PER_CALL}-per-call cap`,
    );
  }
  if (totalSegmentChars(input.segments) > CORRECT_MAX_TOTAL_CHARS_PER_CALL) {
    throw new Error(
      `correct: segment text exceeds the ${CORRECT_MAX_TOTAL_CHARS_PER_CALL}-char-per-call cap`,
    );
  }
  if (totalLexiconChars(input.lexicon) > CORRECT_MAX_LEXICON_CHARS) {
    throw new Error(`correct: lexicon exceeds the ${CORRECT_MAX_LEXICON_CHARS}-char cap`);
  }
}

export async function runCorrectTask(
  input: CorrectTaskInput,
  call: ProviderCaller,
): Promise<CorrectResponse> {
  assertWithinCallCaps(input);
  const raw = await call({
    apiKey: input.apiKey,
    model: input.model,
    system: CORRECT_SYSTEM_PROMPT,
    user: buildCorrectUserMessage(input.segments, input.lexicon, input.context, input.meetingTitle),
    schema: CorrectResponseSchema,
    maxTokens: 8000,
    provider: input.provider,
    baseUrl: input.baseUrl,
    // The hosted model wraps output in ```json fences and/or a bare
    // top-level array; extractJsonValue + arrayKey already tolerate
    // both (see providerCore.ts).
    arrayKey: "corrections",
    extraBody: input.extraBody,
  });

  return postFilter(raw, new Set(input.segments.map((s) => s.id)));
}

// ---------------------------------------------------------------
// Chunking (Finding 1 fix) — split a whole meeting's segments into
// sequential, bounded windows, each within CORRECT_MAX_SEGMENTS_PER_
// CALL/CORRECT_MAX_TOTAL_CHARS_PER_CALL by construction (so
// assertWithinCallCaps above never actually trips for a caller that
// chunks through this). The actual per-window correctApi() calls +
// sequential loop + fail-soft merge live in CorrectionReview.tsx (the
// one caller of correction in this codebase, itself shared verbatim
// across the web/desktop/iOS bundle) — this module only owns the
// windowing LOGIC, single-sourced, mirroring tasks/summarize.ts's own
// chunkSegments (count+size dual constraint, greedy pack in speaking
// order) but char-budgeted instead of word-budgeted. Each window also
// carries its own adjacent-context slice: unlike the old one-shot
// whole-meeting call (every segment already IN the request, nothing
// "outside" left to disambiguate with), a segment just outside a
// window IS now outside context the model can use.
// ---------------------------------------------------------------

/** How many segments immediately preceding a window are folded into
 *  that window's own `context` — read-only disambiguation, mirrors
 *  buildCorrectUserMessage's CONTEXT field ("transcript surrounding
 *  the segments below, for disambiguation only"); never corrected
 *  themselves and never duplicated into the window's own `segments`. */
const WINDOW_CONTEXT_SEGMENTS = 2;

export interface CorrectWindow {
  segments: { id: string; text: string }[];
  context: string;
}

function adjacentContext(
  all: { id: string; text: string }[],
  windowStart: number,
): string {
  const from = Math.max(0, windowStart - WINDOW_CONTEXT_SEGMENTS);
  return all
    .slice(from, windowStart)
    .map((s) => s.text)
    .join("\n");
}

/** Split `segments` (already in speaking order) into windows, each
 *  obeying CORRECT_MAX_SEGMENTS_PER_CALL/CORRECT_MAX_TOTAL_CHARS_PER_
 *  CALL. A single small meeting still produces exactly one window
 *  (empty context, byte-identical to the pre-chunking whole-meeting
 *  call). */
export function chunkCorrectSegments(
  segments: { id: string; text: string }[],
): CorrectWindow[] {
  const windows: CorrectWindow[] = [];
  let current: { id: string; text: string }[] = [];
  let currentChars = 0;
  let windowStart = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const wouldOverflow =
      current.length > 0 &&
      (current.length >= CORRECT_MAX_SEGMENTS_PER_CALL ||
        currentChars + seg.text.length > CORRECT_MAX_TOTAL_CHARS_PER_CALL);

    if (wouldOverflow) {
      windows.push({ segments: current, context: adjacentContext(segments, windowStart) });
      current = [];
      currentChars = 0;
      windowStart = i;
    }

    current.push(seg);
    currentChars += seg.text.length;
  }

  if (current.length > 0) {
    windows.push({ segments: current, context: adjacentContext(segments, windowStart) });
  }

  return windows;
}
