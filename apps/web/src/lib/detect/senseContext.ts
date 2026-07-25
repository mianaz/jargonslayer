// v0.6 multi-sense-terms sprint (T5) — pure derivation of core's
// SenseContextInput (dictionary.ts's setSenseContext) from this app's
// own store state: the meeting's inferred domain(s), the user's pack
// selection, and the terms already detected this meeting. Kept as a
// standalone, framework-free function (no store/hook imports) so it's
// directly unit-testable — the actual wiring (subscribing to the right
// store slices and calling setSenseContext on change) lives in
// useMeeting.ts, which just calls this.

import type { SenseContextInput } from "@jargonslayer/core/detect/dictionary";
import { DOMAIN_TAGS, type DomainTag } from "@jargonslayer/core/detect/dictionary-data";
import { PACK_DOMAINS } from "@jargonslayer/core/detect/packs";

// Inferred-context domains outrank an enabled pack's own domain hint —
// the user is IN this meeting right now; a pack toggle is a standing
// preference that predates it.
const INFERRED_DOMAIN_WEIGHT = 1.0;
const ENABLED_PACK_DOMAIN_WEIGHT = 0.5;

/** Type guard (not just a boolean check) so TS actually narrows
 *  `string` -> `DomainTag` at each call site below — a plain
 *  `.includes()` check alone doesn't narrow, since Array.includes isn't
 *  typed as a predicate. */
function isDomainTag(value: string): value is DomainTag {
  return (DOMAIN_TAGS as readonly string[]).includes(value);
}

export interface SenseContextDerivationInput {
  /** InferContextResponse.domains for this meeting, already narrowed to
   *  the real enum (see store.ts's inferredDomains / sanitizeDomains) —
   *  possibly the keyless keyword-fallback's guess instead (see
   *  domainKeywords.ts), the caller decides which to pass. */
  inferredDomains: DomainTag[];
  /** Settings.enabledPacks, unchanged — null = every pack on (no
   *  explicit selection to draw a domain hint from). */
  enabledPacks: string[] | null;
  /** This meeting's detected terms so far (store.ts's `terms`) — only
   *  each term's CHOSEN sense's domain matters here (senses[0], per
   *  dictionary.ts's scanDictionary doc: "ranked, chosen first"). A
   *  term with no `senses` at all (not multi-sense, or an LLM-sourced
   *  term) contributes to the denominator but no domain's numerator.
   *  `domain` is loosely `string` here, matching DetectedTerm.senses[]
   *  in @jargonslayer/core/types (that file is a dependency-free leaf,
   *  so it can't reference the real DomainTag union) — validated
   *  against DOMAIN_TAGS below before ever being used as a Record key. */
  terms: { senses?: { domain: string }[] }[];
}

/** domainWeights: inferred domains at 1.0, PACK_DOMAINS' domain for
 *  each EXPLICITLY-enabled pack at 0.5 (never downgrading an inferred
 *  1.0 — Math.max, not overwrite). cooccurrence: fraction of `terms`
 *  whose chosen sense carries each domain, out of ALL detected terms
 *  (including senseless ones, which dilute the fraction but never
 *  contribute to any domain's count). Missing/never-seen domains are
 *  simply absent from the returned maps — T3's scoring formula already
 *  treats an absent weight as 0. */
export function deriveSenseContext(input: SenseContextDerivationInput): SenseContextInput {
  const domainWeights: Partial<Record<DomainTag, number>> = {};
  for (const domain of input.inferredDomains) {
    domainWeights[domain] = INFERRED_DOMAIN_WEIGHT;
  }
  if (input.enabledPacks !== null) {
    for (const packId of input.enabledPacks) {
      const domain = PACK_DOMAINS[packId];
      if (!domain) continue;
      domainWeights[domain] = Math.max(domainWeights[domain] ?? 0, ENABLED_PACK_DOMAIN_WEIGHT);
    }
  }

  const cooccurrence: Partial<Record<DomainTag, number>> = {};
  const total = input.terms.length;
  if (total > 0) {
    const counts: Partial<Record<DomainTag, number>> = {};
    for (const term of input.terms) {
      const domain = term.senses?.[0]?.domain;
      // Defensive re-validation against the real enum — see this
      // field's own doc above for why the TYPE alone can't guarantee
      // it (types.ts's DetectedTerm.senses[].domain is loosely string).
      if (!domain || !isDomainTag(domain)) continue;
      counts[domain] = (counts[domain] ?? 0) + 1;
    }
    for (const domain of Object.keys(counts) as DomainTag[]) {
      cooccurrence[domain] = (counts[domain] ?? 0) / total;
    }
  }

  return { domainWeights, cooccurrence };
}
