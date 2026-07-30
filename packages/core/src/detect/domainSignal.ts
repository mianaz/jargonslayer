import type { DetectResponse } from "../types";
import type { DomainTag } from "./dictionary-data";
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
 * Once a domain is active, its later terms need not be counted. */
export function createDomainTracker(): DomainTracker {
  const active = new Set<DomainTag>();
  const headwordsByDomain = new Map<DomainTag, Set<string>>();

  return {
    observe(result) {
      for (const term of result.terms) {
        const domain = term.pack ? PACK_DOMAINS[term.pack] : undefined;
        if (!domain || active.has(domain)) continue;

        let headwords = headwordsByDomain.get(domain);
        if (!headwords) {
          headwords = new Set<string>();
          headwordsByDomain.set(domain, headwords);
        }
        headwords.add(term.term.trim().toLowerCase());
        if (headwords.size >= DOMAIN_ACTIVATION_THRESHOLD) active.add(domain);
      }
    },
    activeDomains() {
      return new Set(active);
    },
  };
}
