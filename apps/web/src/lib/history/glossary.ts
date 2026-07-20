// Personal dictionary (user-curated glossary) — persistence + live
// matching. Owned by the lead. Entries survive across meetings and
// participate in live detection with priority over the built-in
// dictionary (source: "custom", never overwritten by LLM hits).
//
// #53 core extraction: the in-memory cache + findEntryBySurface() are
// pure and live in @jargonslayer/core's history/glossaryLookup.ts
// (detect/dictionary.ts needs findEntryBySurface synchronously on
// every scan). This file owns persistence (idb-keyval, impure) and
// keeps that shared cache in step via setCachedEntries() below;
// findEntryBySurface is re-exported so existing callers of
// "@/lib/history/glossary" keep working unchanged. getCachedEntries is
// NO LONGER a bare re-export — see the v0.5 Wave-1 note below.
//
// v0.5 Wave-1 Feature 8 (named custom dictionary packs, docs/design-
// explorations/v05-wave1-blueprint.md §1 F8 + §5 A7 "path-complete
// registry"): this file also owns the pack registry (its own IDB
// slice, mirroring the entry storage above) and makes every scan path
// pack-aware — see the registry section below.

import { del, get, set } from "idb-keyval";
import {
  customEntrySurfaces,
  customEntryToExpression,
  customEntryToTerm,
  newId,
  type CustomEntry,
  type CustomPack,
  type DetectResponse,
} from "@jargonslayer/core/types";
import {
  findEntryBySurface,
  getCachedEntries as getRawCachedEntries,
  setCachedEntries,
} from "@jargonslayer/core/history/glossaryLookup";

export { findEntryBySurface };

const GLOSSARY_KEY = "jargonslayer:glossary";

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

export async function loadCustomEntries(): Promise<CustomEntry[]> {
  if (!hasIndexedDb()) {
    await loadCustomPacks();
    return [];
  }
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
    setCachedEntries(list ?? []);
  } catch (err) {
    console.warn("[glossary] load failed", err);
    setCachedEntries([]);
  }
  // v0.5 Wave-1 F8/A7: load (and normalize every cached entry's
  // packId) right after entries so the live-detection scan path
  // (store.ts's addFinal -> scanCustomEntries) is pack-aware from app
  // boot — hydrate() already awaits THIS function, so no separate
  // store.ts call site is needed for the pack registry either.
  await loadCustomPacks();
  return getRawCachedEntries();
}

async function persist(next: CustomEntry[]): Promise<void> {
  setCachedEntries(next);
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
  const rest = getRawCachedEntries().filter((e) => e.id !== entry.id);
  await persist([entry, ...rest]);
  return getRawCachedEntries();
}

export async function deleteCustomEntry(id: string): Promise<CustomEntry[]> {
  await persist(getRawCachedEntries().filter((e) => e.id !== id));
  return getRawCachedEntries();
}

export async function clearGlossary(): Promise<void> {
  setCachedEntries([]);
  if (!hasIndexedDb()) return;
  try {
    await del(GLOSSARY_KEY);
  } catch (err) {
    console.warn("[glossary] clear failed", err);
  }
}

// ---------------------------------------------------------------
// v0.5 Wave-1 Feature 8 — named custom dictionary pack registry.
// Own IDB slice (mirrors the entry storage above), NOT a Settings
// field — named-pack management lives entirely in GlossaryPanel (A9's
// last sentence), never touches the settings save/restore path.
// "personal" is the always-present, non-deletable pack every pre-F8
// entry (and any entry with a missing/unknown packId) normalizes onto.
//
// Atomic registry (A7): cachedPacks + the derived enabledPackIds
// snapshot are always replaced TOGETHER (setCachedPacks below), so a
// scan mid-update never sees one without the other.
// ---------------------------------------------------------------

const PACKS_KEY = "jargonslayer:custom-packs";
export const PERSONAL_PACK_ID = "personal";

function personalPack(now: number): CustomPack {
  return { id: PERSONAL_PACK_ID, name: "个人词库", enabled: true, createdAt: now };
}

let cachedPacks: CustomPack[] = [personalPack(0)];
let enabledPackIds: Set<string> = new Set([PERSONAL_PACK_ID]);

function setCachedPacks(next: CustomPack[]): void {
  cachedPacks = next;
  enabledPackIds = new Set(next.filter((p) => p.enabled).map((p) => p.id));
}

async function persistPacks(next: CustomPack[]): Promise<void> {
  setCachedPacks(next);
  if (!hasIndexedDb()) return;
  try {
    await set(PACKS_KEY, next);
  } catch (err) {
    console.warn("[glossary] persistPacks failed", err);
  }
}

/** Registry-aware predicate — the ONE thing every scan/lexicon path
 *  consults: this file's own getCachedEntries below (and, through it,
 *  scanCustomEntries + upload.ts's currentUploadLexicon), plus
 *  lib/stt/lexicon.ts's buildMeetingLexicon (the Wave-0 seam). */
export function isCustomPackEnabled(packId: string): boolean {
  return enabledPackIds.has(packId);
}

/** Synchronous snapshot for pack-management UI (GlossaryPanel). */
export function getCustomPacks(): CustomPack[] {
  return cachedPacks;
}

/** Load packs from IDB (auto-creating "personal" if missing) and
 *  normalize every cached entry's packId onto a pack that actually
 *  exists (missing/unknown -> "personal"), persisting the fix.
 *  Idempotent — safe to call repeatedly: loadCustomEntries above calls
 *  it at app hydrate, and GlossaryPanel also calls it on mount so its
 *  own pack tabs are correct even before/without a hydrate cycle. */
export async function loadCustomPacks(): Promise<CustomPack[]> {
  let packs: CustomPack[] = [];
  if (hasIndexedDb()) {
    try {
      packs = (await get<CustomPack[]>(PACKS_KEY)) ?? [];
    } catch (err) {
      console.warn("[glossary] loadCustomPacks failed", err);
      packs = [];
    }
  }
  if (!packs.some((p) => p.id === PERSONAL_PACK_ID)) {
    packs = [personalPack(Date.now()), ...packs];
    if (hasIndexedDb()) {
      try {
        await set(PACKS_KEY, packs);
      } catch (err) {
        console.warn("[glossary] loadCustomPacks personal-pack persist failed", err);
      }
    }
  }
  setCachedPacks(packs);

  const validIds = new Set(packs.map((p) => p.id));
  const rawEntries = getRawCachedEntries();
  let touched = false;
  const normalized = rawEntries.map((e) => {
    if (validIds.has(e.packId)) return e;
    touched = true;
    return { ...e, packId: PERSONAL_PACK_ID };
  });
  if (touched) await persist(normalized);

  return cachedPacks;
}

/** Create a named pack. Trimmed names are unique (case-insensitive);
 *  new packs start enabled. */
export async function createCustomPack(name: string): Promise<CustomPack[]> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("词包名称不能为空");
  if (cachedPacks.some((p) => p.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    throw new Error("词包名称已存在");
  }
  const pack: CustomPack = { id: newId(), name: trimmed, enabled: true, createdAt: Date.now() };
  await persistPacks([...cachedPacks, pack]);
  return cachedPacks;
}

/** Rename an existing pack (unique-name check excludes itself). */
export async function renameCustomPack(id: string, name: string): Promise<CustomPack[]> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("词包名称不能为空");
  if (!cachedPacks.some((p) => p.id === id)) throw new Error("词包不存在");
  if (
    cachedPacks.some((p) => p.id !== id && p.name.trim().toLowerCase() === trimmed.toLowerCase())
  ) {
    throw new Error("词包名称已存在");
  }
  await persistPacks(cachedPacks.map((p) => (p.id === id ? { ...p, name: trimmed } : p)));
  return cachedPacks;
}

/** Toggle a pack's enabled state — gates whether its entries
 *  participate in scanCustomEntries/buildMeetingLexicon (see
 *  isCustomPackEnabled above). */
export async function setCustomPackEnabled(id: string, enabled: boolean): Promise<CustomPack[]> {
  if (!cachedPacks.some((p) => p.id === id)) throw new Error("词包不存在");
  await persistPacks(cachedPacks.map((p) => (p.id === id ? { ...p, enabled } : p)));
  return cachedPacks;
}

/** Delete a pack. "personal" can never be deleted. Deleting any other
 *  pack always orphans its entries, so this refuses unless the caller
 *  explicitly passes confirmCascade:true (the UI does so only after
 *  its own confirm step). Entries themselves are NOT touched here —
 *  GlossaryPanel (the caller) owns moving them to personal via the
 *  existing updateCustomEntry store action, so the zustand
 *  customEntries state (which this module doesn't own) stays the
 *  single source of truth for entry data/UI sync. */
export async function deleteCustomPack(
  id: string,
  confirmCascade: boolean,
): Promise<CustomPack[]> {
  if (id === PERSONAL_PACK_ID) throw new Error("个人词库不能删除");
  if (!cachedPacks.some((p) => p.id === id)) throw new Error("词包不存在");
  if (!confirmCascade) throw new Error("删除词包需要先确认词条会移动到个人词库");
  await persistPacks(cachedPacks.filter((p) => p.id !== id));
  return cachedPacks;
}

/** Upsert a pack by id, bypassing the create/rename unique-name check
 *  — used by autoExport.ts's restoreFullBackup, which treats a
 *  backup's pack list as trusted-once-validated input the same way
 *  restored glossary entries are (overwritten by id, no dedupe-by-name
 *  check). */
export async function upsertCustomPack(pack: CustomPack): Promise<CustomPack[]> {
  const rest = cachedPacks.filter((p) => p.id !== pack.id);
  await persistPacks([pack, ...rest]);
  return cachedPacks;
}

/** Enabled-pack-filtered view — the registry-aware accessor every SCAN
 *  path consumes: this file's own scanCustomEntries below AND
 *  lib/stt/upload.ts's currentUploadLexicon (imports this exact named
 *  export from "../history/glossary", unchanged — see A7 "path-
 *  complete registry"). CRUD/list-sync above uses getRawCachedEntries()
 *  directly so a disabled pack's entries stay persisted/manageable in
 *  the zustand customEntries state, never silently dropped. */
export function getCachedEntries(): CustomEntry[] {
  return getRawCachedEntries().filter((e) => isCustomPackEnabled(e.packId));
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

/** Scan free text against the cached personal glossary — pack-aware
 *  (see getCachedEntries above): a disabled pack's entries never
 *  match. Each entry matches at most once per call. Synchronous by
 *  design. */
export function scanCustomEntries(text: string): DetectResponse {
  const res: DetectResponse = { expressions: [], terms: [] };
  const cache = getCachedEntries();
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
