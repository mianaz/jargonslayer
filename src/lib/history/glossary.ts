// Personal dictionary (user-curated glossary) — persistence + live
// matching. Owned by the lead. Entries survive across meetings and
// participate in live detection with priority over the built-in
// dictionary (source: "custom", never overwritten by LLM hits).

import { del, get, set } from "idb-keyval";
import {
  customEntrySurfaces,
  customEntryToExpression,
  customEntryToTerm,
  type CustomEntry,
  type DetectResponse,
} from "../types";

const GLOSSARY_KEY = "jargonslayer:glossary";

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

// In-memory cache so scanCustomEntries stays synchronous (the
// detection scheduler runs sync per segment). Kept in step by the
// CRUD functions below; hydrated once at app start.
let cache: CustomEntry[] = [];

export function getCachedEntries(): CustomEntry[] {
  return cache;
}

export async function loadCustomEntries(): Promise<CustomEntry[]> {
  if (!hasIndexedDb()) return [];
  try {
    let list = await get<CustomEntry[]>(GLOSSARY_KEY);
    if (!list) {
      // Pre-rename key migration (copy, don't delete).
      const legacy = await get<CustomEntry[]>("meetlingo:glossary");
      if (legacy && legacy.length > 0) {
        await set(GLOSSARY_KEY, legacy);
        list = legacy;
      }
    }
    cache = list ?? [];
  } catch (err) {
    console.warn("[glossary] load failed", err);
    cache = [];
  }
  return cache;
}

async function persist(next: CustomEntry[]): Promise<void> {
  cache = next;
  if (!hasIndexedDb()) return;
  try {
    await set(GLOSSARY_KEY, next);
  } catch (err) {
    console.warn("[glossary] persist failed", err);
  }
}

/** Insert or update (by id). Returns the new list, newest first. */
export async function upsertCustomEntry(
  entry: CustomEntry,
): Promise<CustomEntry[]> {
  const rest = cache.filter((e) => e.id !== entry.id);
  await persist([entry, ...rest]);
  return cache;
}

export async function deleteCustomEntry(id: string): Promise<CustomEntry[]> {
  await persist(cache.filter((e) => e.id !== id));
  return cache;
}

export async function clearGlossary(): Promise<void> {
  cache = [];
  if (!hasIndexedDb()) return;
  try {
    await del(GLOSSARY_KEY);
  } catch (err) {
    console.warn("[glossary] clear failed", err);
  }
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

// ---------------------------------------------------------------
// Live matching — same word-boundary + trailing-inflection approach
// as the built-in dictionary scan.
// ---------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function surfaceToRegex(surface: string): RegExp | null {
  const words = surface.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const parts = words.map((w, i) => {
    const esc = escapeRegExp(w);
    // Let the final word flex on common inflections.
    return i === words.length - 1 ? `${esc}(?:s|es|ed|d|ing)?` : esc;
  });
  try {
    return new RegExp(`\\b${parts.join("\\s+")}\\b`, "i");
  } catch {
    return null;
  }
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Scan free text against the cached personal glossary. Each entry
 *  matches at most once per call. Synchronous by design. */
export function scanCustomEntries(text: string): DetectResponse {
  const res: DetectResponse = { expressions: [], terms: [] };
  if (!text || cache.length === 0) return res;
  const sentences = splitSentences(text);

  for (const entry of cache) {
    let matchedSentence: string | null = null;
    for (const surface of customEntrySurfaces(entry)) {
      const re = surfaceToRegex(surface);
      if (!re) continue;
      const hit = sentences.find((s) => re.test(s)) ?? null;
      if (hit) {
        matchedSentence = hit;
        break;
      }
    }
    if (matchedSentence === null) continue;

    if (entry.kind === "term") {
      res.terms.push(customEntryToTerm(entry));
    } else {
      res.expressions.push(customEntryToExpression(entry, matchedSentence));
    }
  }
  return res;
}
