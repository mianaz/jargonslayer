// In-memory registry of loaded remote dictionary packs — the PURE
// slice of detect/remotePacks.ts, split out for #53 core extraction.
//
// remotePacks.ts (apps/web) owns fetching manifests over the network
// and persisting them via idb-keyval — both fundamentally impure and
// DOM/browser-dependent, so that file stays in apps/web. But
// dictionary.ts and packs.ts (this package) need to READ whatever is
// currently loaded, synchronously, on every scan/render — exactly the
// same "module-level cache" pattern dictionary.ts already uses for
// enabledPacks (see that file's setEnabledPacks comment). This module
// is that shared cache: apps/web's remotePacks.ts calls
// setLoadedRemotePacks() once its async fetch+idb-keyval load
// resolves; dictionary.ts/packs.ts call getLoadedRemotePacks() to
// read it. Neither side needs to know the other's storage mechanism.

import type { DictExpressionEntry, DictTermEntry } from "./dictionary-data";

/** A validated, normalized pack ready to feed into the dictionary
 *  registry — entries have `pack` forced to the manifest's own id and
 *  match DictExpressionEntry/DictTermEntry exactly, so scanDictionary's
 *  matching logic can treat them identically to EXTRA_EXPRESSIONS/
 *  EXTRA_TERMS. Validation/fetching lives in apps/web's remotePacks.ts
 *  (this type is the wire-shape contract between the two). */
export interface LoadedRemotePack {
  id: string;
  name: string;
  description?: string;
  version: string | number;
  expressions: DictExpressionEntry[];
  terms: DictTermEntry[];
}

let registry: LoadedRemotePack[] = [];

/** All packs currently loaded into the live-detection registry. */
export function getLoadedRemotePacks(): LoadedRemotePack[] {
  return registry;
}

/** Replace the registry wholesale — called by apps/web's remotePacks.ts
 *  after a successful load/add/remove/checkUpdates (see that file). */
export function setLoadedRemotePacks(packs: LoadedRemotePack[]): void {
  registry = packs;
}
