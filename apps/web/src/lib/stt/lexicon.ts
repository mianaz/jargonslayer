// v0.4.7 Lane B — glossary -> recognizer bias (docs/design-explorations/
// stt-provider-wiring-2026-07.md §3, decision record D1/D3/D8).
// Generalizes S11/Q11's glossary-only osSpeech.ts contextualStrings
// builder (osSpeech.ts's own buildContextualJson, now migrated onto
// this shared module) into the tiered lexicon every biasable engine
// draws from.
//
// D8: buildMeetingLexicon is PURE — no store reads. The ONE snapshot
// it's built from is gathered once at the meeting-start callsite
// (apps/web/src/hooks/useMeeting.ts's attachEngine) and passed
// explicitly into engine.start(); adapters never read the store for
// lexicon purposes themselves.
//
// D6: lives in apps/web (not packages/core) — this file owns zero zh
// strings itself, but it's the natural sibling of every adapter it
// feeds (osSpeech.ts/wsTransport.ts/sonioxTransport.ts), and desktop/
// iOS both wrap the same apps/web bundle.
//
// D1 (default-on for free mechanisms): this module has no on/off
// switch of its own — see useMeeting.ts's attachEngine for the ONE
// extension-point comment marking where a future 术语偏置 Settings
// toggle would gate the whole build+pass step.
//
// v0.5 Wave-1 Feature 8 (named custom dictionary packs, blueprint §1
// F8 + §5 A7) — the ONE exception to D8's "no store reads" purity:
// isCustomPackEnabled reads glossary.ts's own synchronous, already-
// loaded pack registry (NOT the zustand store — same category of read
// packTermsForBias already does against core's built-in pack table).
// Needed because useMeeting.ts's snapshot still passes the FULL
// customEntries list (unfiltered, since store.ts's own customEntries
// state must stay unfiltered for the management UI) — filtering
// happens HERE, the shared seam, so both the live-session lexicon and
// upload.ts's already-pack-aware getCachedEntries() end up correct.

import { termNormKey } from "@jargonslayer/core/detect/dedupe";
import { packTermsForBias } from "@jargonslayer/core/detect/dictionary";
import type { LearnRecord } from "@jargonslayer/core/learn/types";
import type { CustomEntry, MeetingLexicon } from "@jargonslayer/core/types";
import { isCustomPackEnabled } from "../history/glossary";

// D3: per-entry ceiling on GLOSSARY VARIANTS once headwords are
// exhausted — "headwords first, variants backfilled with a per-entry
// ceiling" (a glossary entry with 20 variants must not crowd out every
// OTHER entry's own headword).
const GLOSSARY_VARIANT_CEILING = 3;

// Belt cap on the raw canonical list itself — comfortably above every
// adapter's own per-adapter projection cap below (osspeech/soniox 100,
// whisper 200), so it is never the binding constraint under normal
// use; only guards a pathological glossary+packs+learnset combination
// from growing this array without bound before per-adapter caps ever
// see it.
const LEXICON_MAX_TERMS = 500;

export interface BuildMeetingLexiconInput {
  customEntries: CustomEntry[];
  enabledPacks: string[] | null;
  learnset: Record<string, LearnRecord>;
}

function pushUnique(target: string[], seen: Set<string>, surface: string): void {
  const trimmed = surface.trim();
  if (!trimmed) return;
  const key = termNormKey(trimmed);
  if (seen.has(key)) return;
  seen.add(key);
  target.push(trimmed);
}

/** D3 Sol F3: round-robins pack candidates ACROSS packs (one term per
 *  pack per round) so a null enabledPacks default (every pack on,
 *  including the large generic business packs) can't let those crowd
 *  out a smaller tech/domain pack's own terms before per-adapter caps
 *  ever get to them — every enabled pack gets a fair, interleaved
 *  share of the budget instead of first-come-first-served by table
 *  order. */
function roundRobinByPack(items: { term: string; pack: string }[]): string[] {
  const byPack = new Map<string, string[]>();
  for (const item of items) {
    const bucket = byPack.get(item.pack);
    if (bucket) bucket.push(item.term);
    else byPack.set(item.pack, [item.term]);
  }
  const packIds = [...byPack.keys()];
  const out: string[] = [];
  for (let round = 0; ; round++) {
    let addedAny = false;
    for (const id of packIds) {
      const bucket = byPack.get(id)!;
      if (round < bucket.length) {
        out.push(bucket[round]);
        addedAny = true;
      }
    }
    if (!addedAny) break;
  }
  return out;
}

/** D8 pure builder: ONE tiered, normalized (termNormKey — reused, not
 *  reinvented; same normalizer the detector's own dedupe already
 *  keys terms by), deduped, priority-ordered (highest priority FIRST)
 *  term list from an explicit input snapshot.
 *
 *  D3 tier order:
 *   1. user glossary — every entry's headword, THEN every entry's
 *      variants backfilled up to GLOSSARY_VARIANT_CEILING each.
 *   2. enabled packs — round-robin allocated across packs (Sol F3).
 *   3. suppressed learn-set terms, ranked LAST — still eligible (Opus
 *      over Sol's filter-out): suppression is detector policy ("don't
 *      re-explain"), while the recognizer still mis-hears exactly
 *      those terms. Ranked-last means they only fill leftover slots
 *      and never displace a card-producing term.
 *
 *  Per-adapter caps apply at PROJECTION (see projectFor* below), not
 *  here — this list carries only the generous LEXICON_MAX_TERMS belt
 *  cap. */
export function buildMeetingLexicon(input: BuildMeetingLexiconInput): MeetingLexicon {
  const terms: string[] = [];
  const seen = new Set<string>();

  // v0.5 Wave-1 F8: a disabled custom pack's entries never contribute
  // bias terms — see the header note above.
  const enabledEntries = input.customEntries.filter((e) => isCustomPackEnabled(e.packId));

  for (const entry of enabledEntries) {
    pushUnique(terms, seen, entry.headword);
  }
  for (const entry of enabledEntries) {
    for (const variant of entry.variants.slice(0, GLOSSARY_VARIANT_CEILING)) {
      pushUnique(terms, seen, variant);
    }
  }

  const packCandidates = packTermsForBias(input.enabledPacks);
  for (const term of roundRobinByPack(packCandidates)) {
    pushUnique(terms, seen, term);
  }

  for (const record of Object.values(input.learnset)) {
    if (!record.suppressed) continue;
    pushUnique(terms, seen, record.surface);
  }

  return { terms: terms.slice(0, LEXICON_MAX_TERMS) };
}

// ---------------------------------------------------------------
// Per-adapter projection — shared cap logic, adapter-specific shape.
// ---------------------------------------------------------------

/** Selects the highest-priority PREFIX of `terms` that fits within
 *  `maxTerms` count AND `maxBytes` of UTF-8 JSON-array-encoded size —
 *  a CJK-heavy list can blow past a byte budget well under a
 *  term-count cap (the exact dual-cap discipline S11/Q11's own
 *  buildContextualJson already established; extracted here so every
 *  adapter shares it). `terms` is assumed already priority-ordered
 *  (highest first) — this only ever takes a prefix, never reorders. */
function capTermsByCountAndBytes(terms: string[], maxTerms: number, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let bytes = 2; // "[" + "]"
  for (const term of terms) {
    if (out.length >= maxTerms) break;
    // +1 for the joining comma once this wouldn't be the first element.
    const extra = encoder.encode(JSON.stringify(term)).length + (out.length > 0 ? 1 : 0);
    if (bytes + extra > maxBytes) break;
    out.push(term);
    bytes += extra;
  }
  return out;
}

// osspeech: S11/Q11's own caps, unchanged (doc §3: "keeping Q11's ~8KB
// size discipline") — packs are now IN the candidate list feeding this
// cap (previously glossary-only), everything else about the wire value
// is byte-identical.
export const OSSPEECH_MAX_CONTEXTUAL_TERMS = 100;
export const OSSPEECH_MAX_CONTEXTUAL_BYTES = 8 * 1024;

/** Projects onto osSpeech.ts's `contextualJson` wire value — a
 *  JSON-stringified term array, or null (the wire's own "no bias"
 *  value) when nothing survives the cap. */
export function projectForOsSpeechContextualJson(lexicon: MeetingLexicon): string | null {
  const terms = capTermsByCountAndBytes(
    lexicon.terms,
    OSSPEECH_MAX_CONTEXTUAL_TERMS,
    OSSPEECH_MAX_CONTEXTUAL_BYTES,
  );
  return terms.length > 0 ? JSON.stringify(terms) : null;
}

// soniox: doc §3 — "verified limit ≈8,000 tokens / ~10,000 chars total
// context — cap conservatively (Sol F10)". Well under that verified
// ceiling, same dual-cap discipline as osspeech.
export const SONIOX_MAX_CONTEXT_TERMS = 100;
export const SONIOX_MAX_CONTEXT_BYTES = 4 * 1024;

/** Projects onto SonioxConfigMessage's `context.terms` field — a plain
 *  term array (empty when nothing survives the cap; sonioxTransport.ts
 *  omits the `context` field entirely in that case). */
export function projectForSonioxContext(lexicon: MeetingLexicon): string[] {
  return capTermsByCountAndBytes(lexicon.terms, SONIOX_MAX_CONTEXT_TERMS, SONIOX_MAX_CONTEXT_BYTES);
}

// whisper/tabaudio/appaudio (faster-whisper sidecar): generous but
// bounded — faster-whisper's own get_prompt() truncates the tokenized
// prompt to its LAST (max_length // 2 - 1) tokens (verified against
// the installed faster-whisper==1.2.1 source, transcribe.py's
// get_prompt: self.max_length is 448, so the real ceiling is exactly
// 223 tokens — doc §3/D3's "LAST 223 prompt tokens" claim, source-
// pinned). Sizing this cap to exactly 223 TOKENS would require a real
// tokenizer this layer doesn't have; these term/byte counts are sized
// comfortably ABOVE what 223 tokens can hold (short jargon terms, not
// prose) so the sidecar's own truncation — not this cap — is what
// decides the final cutoff. The ORDER (see projectForInitialPrompt
// below) is what actually matters here.
export const WHISPER_PROMPT_MAX_TERMS = 200;
export const WHISPER_PROMPT_MAX_BYTES = 4 * 1024;

/** Projects onto the sidecar's `initial_prompt` config field — D3's
 *  "projection subtlety" (Sol F14): faster-whisper keeps the prompt's
 *  LAST 223 tokens, so the highest-priority terms must land at the
 *  END of the emitted string, not the front. Returns undefined (the
 *  wire's "omit the field" value) when nothing survives the cap. */
export function projectForInitialPrompt(lexicon: MeetingLexicon): string | undefined {
  const terms = capTermsByCountAndBytes(lexicon.terms, WHISPER_PROMPT_MAX_TERMS, WHISPER_PROMPT_MAX_BYTES);
  if (terms.length === 0) return undefined;
  // Reverse: lexicon.terms is highest-priority-FIRST; the emitted
  // prompt string must be highest-priority-LAST so faster-whisper's
  // own last-223-tokens truncation keeps exactly those.
  return [...terms].reverse().join(", ");
}
