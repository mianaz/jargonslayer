// Thin chrome.storage.local wrapper for the extension's 收藏 (save)
// affordance — S6's stub shapes for the fuller history/glossary
// surface that lands in S7/S8. Deliberately its OWN local shape, not
// core's CustomEntry (packages/core/src/types.ts): CustomEntry carries
// web-app/meeting-specific bookkeeping (mastered, reviewCount, SRS
// review timestamps, category/tone/termType, etc.) that's premature
// here — S6 is a one-shot paste-and-scan, not a tracked session. Field
// names below still mirror CustomEntry's naming (headword,
// chinese_explanation, kind) on purpose, so a future shared-shape
// unification (syncing extension saves into the same glossary) stays
// a straightforward field mapping instead of a redesign. `kind` reuses
// core's own CustomEntryKind type directly — see the S6 report for the
// full reasoning on why core wasn't touched for this.

import { newId } from "@jargonslayer/core/types";
import type { CustomEntryKind } from "@jargonslayer/core/types";

// F6 (doc-only stance, codex v04-integration review): every SavedLookup
// below is LOCAL-ONLY — chrome.storage.local on this device/profile,
// never synced anywhere (no server, no chrome.storage.sync, no
// analytics/telemetry pipeline). source_sentence intentionally stores
// the VERBATIM sentence a card was matched in — this is CORRECT product
// behavior, matching the web app's own local-first history/glossary
// (CustomEntry.context in packages/core/src/types.ts plays the exact
// same "original capture-time sentence" role, persisted the same
// browser-local way via idb-keyval — see apps/web/src/lib/history/
// glossary.ts), not an oversight to strip or minimize on a future pass.
export interface SavedLookup {
  id: string;
  kind: CustomEntryKind; // "expression" | "term"
  headword: string;
  chinese_explanation: string; // chinese_explanation for expressions, gloss_zh for terms
  source_sentence?: string; // expression only — the sentence it was matched in
  savedAt: number;
}

const STORAGE_KEY = "jargonslayer.savedLookups";

export async function getSavedLookups(): Promise<SavedLookup[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const list = result[STORAGE_KEY];
  return Array.isArray(list) ? (list as SavedLookup[]) : [];
}

// ---------------------------------------------------------------
// Write serialization (F5, codex v04-integration review): saveLookup/
// removeSavedLookup below both do a read-modify-write against the SAME
// chrome.storage.local key — two near-simultaneous 收藏 clicks (or a
// save racing a remove) could both read the same pre-write list, and
// whichever set() call lands second would silently drop the other's
// change. Every mutation here is already async, so a simple module-
// level promise chain is enough to serialize without a real lock:
// queue this call behind whatever's currently running, so by the time
// its body actually executes, the previous call's set() has already
// landed and getSavedLookups() sees fresh state. Same idea as the web
// app's per-learnKey lock (apps/web/src/lib/store.ts's
// withLearnKeyLock) — simplified to a single chain rather than a
// Map<key, Promise> since every mutation here already contends on the
// ONE shared storage key, not a per-entry key.
// ---------------------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  // Rejection-swallowing tail so one failed mutation never
  // permanently wedges the queue for every write after it — the real
  // result (including any rejection) still flows to THIS call's own
  // returned promise via `run` above.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Appends a new saved-lookup record and persists the whole list —
 *  minimal but REAL end-to-end persistence: a fresh call to
 *  getSavedLookups() after this (e.g. on panel reopen) sees it. */
export async function saveLookup(
  entry: Omit<SavedLookup, "id" | "savedAt">,
): Promise<SavedLookup> {
  return withWriteLock(async () => {
    const existing = await getSavedLookups();
    const record: SavedLookup = { ...entry, id: newId(), savedAt: Date.now() };
    await chrome.storage.local.set({ [STORAGE_KEY]: [...existing, record] });
    return record;
  });
}

export async function removeSavedLookup(id: string): Promise<void> {
  return withWriteLock(async () => {
    const existing = await getSavedLookups();
    const next = existing.filter((e) => e.id !== id);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  });
}

/** Case/whitespace-insensitive membership check so the panel can grey
 *  out an already-saved card's 收藏 button after a re-scan. */
export function isAlreadySaved(list: SavedLookup[], headword: string): boolean {
  const needle = headword.trim().toLowerCase();
  return list.some((e) => e.headword.trim().toLowerCase() === needle);
}
