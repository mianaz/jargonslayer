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
import type { DomainTag } from "@jargonslayer/core/detect/dictionary-data";
import { PACK_DOMAINS } from "@jargonslayer/core/detect/packs";
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

// FT-1c: >=100 glossary headwords used to leave the strict-concatenation
// tiers below (glossary, THEN packs) with a PREFIX that was 100% glossary
// — any cap taking a prefix of that concatenation saw zero pack terms,
// no matter how the pack tier was internally balanced. Sharing the
// budget at every prefix length (not just at the full, uncapped list)
// is what actually fixes it — see interleaveByShare below.
const GLOSSARY_BUDGET_SHARE = 0.6;

const EMPTY_ACTIVE_DOMAINS: ReadonlySet<DomainTag> = new Set();

export interface BuildMeetingLexiconInput {
  customEntries: CustomEntry[];
  enabledPacks: string[] | null;
  learnset: Record<string, LearnRecord>;
  /** FT-1c: the SHIPPED meeting-domain signal. Empty/omitted => even split. */
  activeDomains?: ReadonlySet<DomainTag>;
}

function pushUnique(target: string[], seen: Set<string>, surface: string): void {
  const trimmed = surface.trim();
  if (!trimmed) return;
  const key = termNormKey(trimmed);
  if (seen.has(key)) return;
  seen.add(key);
  target.push(trimmed);
}

/** Deterministic share-interleave: primary takes `share` of every
 *  prefix, secondary the rest; when either runs dry the other takes
 *  everything. Order WITHIN each stream is never disturbed. */
function interleaveByShare(primary: string[], secondary: string[], share: number): string[] {
  const out: string[] = [];
  let i = 0,
    j = 0;
  while (i < primary.length || j < secondary.length) {
    const wantPrimary = i < (out.length + 1) * share;
    if (i < primary.length && (wantPrimary || j >= secondary.length)) out.push(primary[i++]);
    else out.push(secondary[j++]);
  }
  return out;
}

// ponytail: flat weight, per-domain tuning if the field says so
const DOMAIN_PACK_WEIGHT = 4;

// Bias-path only. PACK_DOMAINS gives each pack ONE primary tag, which is
// right for sense scoring but too narrow here: a talk tagged `biomed`
// should still bias toward the pharma and genomics packs, since no pack
// carries `biomed` at all.
const DOMAIN_ADJACENT: Partial<Record<DomainTag, readonly DomainTag[]>> = {
  biomed: ["pharma", "genomics"],
  clinical: ["pharma"],
};

/** True when `pack`'s own PACK_DOMAINS tag is active, or is reachable
 *  from an active tag via DOMAIN_ADJACENT above. */
function isInDomain(pack: string, active: ReadonlySet<DomainTag>): boolean {
  const domain = PACK_DOMAINS[pack];
  if (!domain) return false;
  if (active.has(domain)) return true;
  for (const d of active) {
    if (DOMAIN_ADJACENT[d]?.includes(domain)) return true;
  }
  return false;
}

/** D3 Sol F3: round-robins pack candidates ACROSS packs so a null
 *  enabledPacks default (every pack on, including the large generic
 *  business packs) can't let those crowd out a smaller tech/domain
 *  pack's own terms before per-adapter caps ever get to them — every
 *  enabled pack gets a fair, interleaved share of the budget instead of
 *  first-come-first-served by table order.
 *
 *  FT-1c: a pack whose PACK_DOMAINS tag is active this meeting (directly
 *  or via DOMAIN_ADJACENT) gets DOMAIN_PACK_WEIGHT consecutive terms per
 *  cycle instead of 1 — packs still visited in unchanged first-
 *  appearance order, loop still terminating when a full cycle emits
 *  nothing. `activeDomains` empty => every weight 1 => byte-identical to
 *  the un-weighted round-robin this replaces. */
function roundRobinByPack(
  items: { term: string; pack: string }[],
  activeDomains: ReadonlySet<DomainTag>,
): string[] {
  const byPack = new Map<string, string[]>();
  for (const item of items) {
    const bucket = byPack.get(item.pack);
    if (bucket) bucket.push(item.term);
    else byPack.set(item.pack, [item.term]);
  }
  const packIds = [...byPack.keys()];
  const cursors = new Map<string, number>();
  const out: string[] = [];
  for (;;) {
    let addedAny = false;
    for (const id of packIds) {
      const bucket = byPack.get(id)!;
      let cursor = cursors.get(id) ?? 0;
      if (cursor >= bucket.length) continue;
      const weight = isInDomain(id, activeDomains) ? DOMAIN_PACK_WEIGHT : 1;
      for (let k = 0; k < weight && cursor < bucket.length; k++, cursor++) {
        out.push(bucket[cursor]);
        addedAny = true;
      }
      cursors.set(id, cursor);
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
 *   1. user glossary (headwords, THEN variants backfilled up to
 *      GLOSSARY_VARIANT_CEILING each) INTERLEAVED with enabled packs
 *      (round-robin allocated across packs, Sol F3) at GLOSSARY_BUDGET_
 *      SHARE — FT-1c: a strict glossary-then-packs concatenation let
 *      a >=100-headword glossary alone fill every adapter's prefix
 *      cap, leaving zero room for pack terms no matter how the pack
 *      tier itself was balanced. Sharing the budget at every prefix
 *      length (interleaveByShare), not just across the full uncapped
 *      list, is what actually fixes that.
 *   2. suppressed learn-set terms, ranked LAST — still eligible (Opus
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

  const glossaryStream: string[] = [];
  for (const entry of enabledEntries) {
    glossaryStream.push(entry.headword);
  }
  for (const entry of enabledEntries) {
    for (const variant of entry.variants.slice(0, GLOSSARY_VARIANT_CEILING)) {
      glossaryStream.push(variant);
    }
  }

  const activeDomains = input.activeDomains ?? EMPTY_ACTIVE_DOMAINS;
  const packCandidates = packTermsForBias(input.enabledPacks);
  const packStream = roundRobinByPack(packCandidates, activeDomains);

  for (const term of interleaveByShare(glossaryStream, packStream, GLOSSARY_BUDGET_SHARE)) {
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

// elevenlabs (Scribe realtime, v0.6 round 2): the `keyterms` query param
// docs (elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-
// text-realtime, verified 2026-07-24) declare NO count/byte limit at
// all — "List of keyterms the model is biased towards", plain string
// array, no maxItems/maxLength in the AsyncAPI schema. Default-on (same
// D1 "free mechanism" posture as soniox's own context.terms above,
// NOT deepgram's billed opt-in-only keyterms — nothing in ElevenLabs'
// docs prices this as a paid add-on the way Deepgram's own keyterm
// prompting is).
// ponytail: with no documented ceiling to size against, these mirror
// soniox's own conservative cap (same order of magnitude as a
// verified-safe sibling engine) rather than a number derived from any
// ElevenLabs-specific limit — upgrade path: tighten or loosen once a
// real ceiling is ever documented or field-tested against a live 429/
// chunk_size_exceeded response.
export const ELEVENLABS_MAX_KEYTERMS_TERMS = 100;
export const ELEVENLABS_MAX_KEYTERMS_BYTES = 4 * 1024;

/** Projects onto the realtime websocket's repeated `keyterms` query
 *  param (one value per term, capTermsByCountAndBytes returning [] when
 *  nothing survives the cap — elevenLabsTransport.ts's buildElevenLabsUrl
 *  simply appends zero params in that case, same "omit rather than send
 *  empty" posture as every other adapter here). */
export function projectForElevenLabsKeyterms(lexicon: MeetingLexicon): string[] {
  return capTermsByCountAndBytes(lexicon.terms, ELEVENLABS_MAX_KEYTERMS_TERMS, ELEVENLABS_MAX_KEYTERMS_BYTES);
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
