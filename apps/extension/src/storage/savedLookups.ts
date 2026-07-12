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

/** Appends a new saved-lookup record and persists the whole list —
 *  minimal but REAL end-to-end persistence: a fresh call to
 *  getSavedLookups() after this (e.g. on panel reopen) sees it. */
export async function saveLookup(
  entry: Omit<SavedLookup, "id" | "savedAt">,
): Promise<SavedLookup> {
  const existing = await getSavedLookups();
  const record: SavedLookup = { ...entry, id: newId(), savedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEY]: [...existing, record] });
  return record;
}

export async function removeSavedLookup(id: string): Promise<void> {
  const existing = await getSavedLookups();
  const next = existing.filter((e) => e.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

/** Case/whitespace-insensitive membership check so the panel can grey
 *  out an already-saved card's 收藏 button after a re-scan. */
export function isAlreadySaved(list: SavedLookup[], headword: string): boolean {
  const needle = headword.trim().toLowerCase();
  return list.some((e) => e.headword.trim().toLowerCase() === needle);
}
