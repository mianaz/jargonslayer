// Personal-glossary in-memory lookup — the PURE slice of
// history/glossary.ts, split out for #53 core extraction.
//
// history/glossary.ts (apps/web) owns persistence (idb-keyval) for the
// user's personal dictionary — impure, stays in apps/web. But
// detect/dictionary.ts (this package) needs findEntryBySurface()
// synchronously on every scan, to let a personal-glossary entry shadow
// the built-in dictionary (see dictionary.ts's scanDictionary). This
// module is the shared cache: apps/web's glossary.ts calls
// setCachedEntries() after every load/upsert/delete, and re-exports
// getCachedEntries/findEntryBySurface so its own existing call sites
// (and consumers importing from "@/lib/history/glossary") keep working
// unchanged.

import {
  customEntrySurfaces,
  type CustomEntry,
} from "../types";

// In-memory cache so findEntryBySurface stays synchronous (dictionary.ts
// runs scanDictionary synchronously per segment). Kept in step by
// apps/web's glossary.ts CRUD functions via setCachedEntries below.
let cache: CustomEntry[] = [];

export function getCachedEntries(): CustomEntry[] {
  return cache;
}

/** Replace the cache wholesale — called by apps/web's glossary.ts
 *  after load/upsert/delete/clear (see that file). */
export function setCachedEntries(next: CustomEntry[]): void {
  cache = next;
}

/** Case-insensitive duplicate check by headword/variant surface. */
export function findEntryBySurface(text: string): CustomEntry | null {
  const needle = text.trim().toLowerCase();
  if (!needle) return null;
  for (const e of cache) {
    if (customEntrySurfaces(e).some((s) => s.toLowerCase() === needle)) {
      return e;
    }
  }
  return null;
}
