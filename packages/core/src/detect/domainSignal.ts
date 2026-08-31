import type { DetectResponse } from "../types";
import { DOMAIN_TAGS, type DomainTag } from "./dictionary-data";
import { PACK_DOMAINS } from "./packs";

/**
 * Two distinct unambiguous headwords were enough in the field corpus:
 * the cachexia talk's one Q&A-side "random forest" must not activate
 * ML, while the cell-painting talk had two-plus ML terms and must.
 */
export const DOMAIN_ACTIVATION_THRESHOLD = 2;

export interface DomainTracker {
  /** Observe the result of one dictionary scan, in segment order. */
  observe(result: Pick<DetectResponse, "terms">): void;
  /** Snapshot of domains active for subsequent scans. */
  activeDomains(): ReadonlySet<DomainTag>;
}

/** Creates meeting-scoped, monotonic domain evidence. Domain-pack
 * common words are suppressed until their domain is already active, so
 * every emitted term from an inactive domain is unambiguous evidence.
 * Once a domain is active, its later terms need not be counted.
 *
 * A term's qualifying domains come from its own entry-level `domains`
 * hint when present (v0.7.9 detection audit — entries in a
 * deliberately-unmapped cross-domain pack like modern-usage carry
 * their evidence per entry; scanDictionary only ever emits the field
 * for NON-common entries, preserving the invariant above), falling
 * back to the pack-level PACK_DOMAINS map otherwise. The wire field is
 * loosely string[] (types.ts is a dependency-free leaf), so values are
 * re-validated against the real DomainTag enum here. */
export function createDomainTracker(): DomainTracker {
  const active = new Set<DomainTag>();
  const headwordsByDomain = new Map<DomainTag, Set<string>>();

  const count = (domain: DomainTag, headword: string) => {
    if (active.has(domain)) return;
    let headwords = headwordsByDomain.get(domain);
    if (!headwords) {
      headwords = new Set<string>();
      headwordsByDomain.set(domain, headwords);
    }
    headwords.add(headword);
    if (headwords.size >= DOMAIN_ACTIVATION_THRESHOLD) active.add(domain);
  };

  return {
    observe(result) {
      for (const term of result.terms) {
        const headword = term.term.trim().toLowerCase();
        const entryDomains = (term.domains ?? []).filter((d): d is DomainTag =>
          (DOMAIN_TAGS as readonly string[]).includes(d),
        );
        if (entryDomains.length > 0) {
          for (const domain of entryDomains) count(domain, headword);
          continue;
        }
        const domain = term.pack ? PACK_DOMAINS[term.pack] : undefined;
        if (domain) count(domain, headword);
      }
    },
    activeDomains() {
      return new Set(active);
    },
  };
}
