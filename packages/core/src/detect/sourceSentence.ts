// Keeps card context compact when ASR or an LLM supplies a long run-on.
// This module is intentionally dependency-free because both the pure core
// merger and the web LLM post-filter use the exact same narrowing rule.

export const MAX_SOURCE_SENTENCE_CHARS = 240;

function trimRange(text: string, start: number, end: number): string {
  return text.slice(start, end).trim();
}

function sentenceRange(text: string, matchStart: number, matchEnd: number): [number, number] {
  let start = 0;
  for (let i = matchStart - 1; i >= 0; i--) {
    if (/[.?!]/.test(text[i])) {
      start = i + 1;
      break;
    }
  }

  let end = text.length;
  for (let i = matchEnd; i < text.length; i++) {
    if (/[.?!]/.test(text[i])) {
      end = i + 1;
      break;
    }
  }
  return [start, end];
}

function clauseRange(
  text: string,
  sentenceStart: number,
  sentenceEnd: number,
  matchStart: number,
  matchEnd: number,
): [number, number] {
  let start = sentenceStart;
  for (let i = matchStart - 1; i >= sentenceStart; i--) {
    if (text[i] === "," || text[i] === ";") {
      start = i + 1;
      break;
    }
  }

  let end = sentenceEnd;
  for (let i = matchEnd; i < sentenceEnd; i++) {
    if (text[i] === "," || text[i] === ";") {
      end = i + 1;
      break;
    }
  }
  return [start, end];
}

function boundedRange(
  text: string,
  start: number,
  end: number,
  matchStart: number,
  matchEnd: number,
): [number, number] {
  const budget = Math.max(MAX_SOURCE_SENTENCE_CHARS, matchEnd - matchStart);
  if (end - start <= budget) return [start, end];

  const matchLength = matchEnd - matchStart;
  const before = Math.max(0, Math.floor((budget - matchLength) / 2));
  let boundedStart = Math.max(start, matchStart - before);
  let boundedEnd = Math.min(end, boundedStart + budget);
  if (boundedEnd - boundedStart < budget) {
    boundedStart = Math.max(start, boundedEnd - budget);
  }

  // Keep the entire matched surface and move cuts to whitespace, never
  // through a word. The small resulting under-run is preferable to a
  // truncated token on a study card.
  while (boundedStart > start && boundedStart < matchStart && !/\s/.test(text[boundedStart - 1])) boundedStart++;
  while (boundedEnd < end && boundedEnd > matchEnd && !/\s/.test(text[boundedEnd])) boundedEnd--;
  return [boundedStart, boundedEnd];
}

/** Return the sentence containing `match`, falling back to its comma/semicolon
 * clause and then a word-safe window for long ASR run-ons. If the caller's
 * text does not contain the match, preserve it unchanged rather than inventing
 * a context. */
export function narrowSourceSentence(text: string, match: string): string {
  const source = text.trim();
  const needle = match.trim();
  if (!source || !needle) return source;

  const matchStart = source.toLowerCase().indexOf(needle.toLowerCase());
  if (matchStart < 0) return source;
  const matchEnd = matchStart + needle.length;
  const [sentenceStart, sentenceEnd] = sentenceRange(source, matchStart, matchEnd);
  if (sentenceEnd - sentenceStart <= MAX_SOURCE_SENTENCE_CHARS) {
    return trimRange(source, sentenceStart, sentenceEnd);
  }

  const [clauseStart, clauseEnd] = clauseRange(
    source,
    sentenceStart,
    sentenceEnd,
    matchStart,
    matchEnd,
  );
  const [start, end] = boundedRange(source, clauseStart, clauseEnd, matchStart, matchEnd);
  return trimRange(source, start, end);
}
