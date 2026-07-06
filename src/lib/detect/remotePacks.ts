// Remote dictionary theme packs — lets users install community-authored
// packs from a URL (GitHub raw / jsDelivr) alongside the built-in
// PACKS registry. OWNER: this worker (#20).
//
// Storage: idb-keyval "jargonslayer:remote-packs" = Array<{ url, pack }>
// (pack = the validated+normalized manifest, refetched wholesale on
// checkUpdates()). Loaded packs also populate an in-memory registry
// that dictionary.ts's scanDictionary() consults so remote entries
// participate in live detection exactly like EXTRA_EXPRESSIONS/TERMS,
// filtered by isPackEnabled() under their own manifest id.

import { get, set } from "idb-keyval";
import type { ExpressionCategory, TermType } from "../types";
import type { DictExpressionEntry, DictTermEntry } from "./dictionary-data";

const REMOTE_PACKS_KEY = "jargonslayer:remote-packs";
const FETCH_TIMEOUT_MS = 10_000;

const EXPRESSION_CATEGORIES: readonly ExpressionCategory[] = [
  "idiom",
  "slang",
  "phrase",
  "metaphor",
  "indirect",
  "other",
];

const TERM_TYPES: readonly TermType[] = [
  "acronym",
  "company",
  "product",
  "tech",
  "metric",
  "person",
  "other",
];

const MAX_ZH_LEN = 60; // lenient clamp — built-in tables target <=40, but
// community packs shouldn't hard-fail on slightly longer copy.

// ---------------------------------------------------------------
// Manifest shape (wire format — what a pack URL is expected to serve)
// ---------------------------------------------------------------

export interface RemotePackExpression {
  expression: string;
  variants?: string[];
  category?: ExpressionCategory;
  meaning?: string;
  chinese_explanation: string;
  plain_english?: string;
  tone?: string;
  confidence?: number;
  pack?: string; // optional — defaults to the manifest's own id
}

export interface RemotePackTerm {
  term: string;
  type?: TermType;
  gloss_en?: string;
  gloss_zh: string;
  pack?: string; // optional — defaults to the manifest's own id
}

export interface RemotePackManifest {
  id: string;
  name: string;
  description?: string;
  version: string | number;
  expressions?: RemotePackExpression[];
  terms?: RemotePackTerm[];
}

/** A validated, normalized pack ready to feed into the dictionary
 *  registry — entries have `pack` filled in (= manifest.id when the
 *  entry itself omitted it) and match DictExpressionEntry/DictTermEntry
 *  exactly, so scanDictionary's matching logic can treat them
 *  identically to EXTRA_EXPRESSIONS/EXTRA_TERMS. */
export interface LoadedRemotePack {
  id: string;
  name: string;
  description?: string;
  version: string | number;
  expressions: DictExpressionEntry[];
  terms: DictTermEntry[];
}

export interface RemotePackSource {
  url: string;
  pack: LoadedRemotePack;
}

// ---------------------------------------------------------------
// Validation — lenient: drop malformed entries with a console.warn
// rather than failing the whole pack.
// ---------------------------------------------------------------

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function clampZh(s: string): string {
  return s.length > MAX_ZH_LEN ? s.slice(0, MAX_ZH_LEN) : s;
}

function validateExpressions(
  raw: unknown,
  packId: string,
): DictExpressionEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DictExpressionEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      console.warn("[remotePacks] dropped malformed expression entry", item);
      continue;
    }
    const e = item as Record<string, unknown>;
    if (!isNonEmptyString(e.expression) || !isNonEmptyString(e.chinese_explanation)) {
      console.warn("[remotePacks] dropped expression missing required fields", item);
      continue;
    }
    const category =
      typeof e.category === "string" &&
      (EXPRESSION_CATEGORIES as string[]).includes(e.category)
        ? (e.category as ExpressionCategory)
        : "other";
    const confidence =
      typeof e.confidence === "number" && Number.isFinite(e.confidence)
        ? Math.min(1, Math.max(0, e.confidence))
        : 0.85;
    const variants = Array.isArray(e.variants)
      ? e.variants.filter((v): v is string => isNonEmptyString(v))
      : undefined;
    out.push({
      expression: e.expression.trim(),
      variants,
      category,
      meaning: isNonEmptyString(e.meaning) ? e.meaning : e.chinese_explanation,
      chinese_explanation: clampZh(e.chinese_explanation.trim()),
      plain_english: isNonEmptyString(e.plain_english)
        ? e.plain_english
        : e.expression.trim(),
      tone: isNonEmptyString(e.tone) ? e.tone : "community pack entry",
      confidence,
      pack: isNonEmptyString(e.pack) ? e.pack : packId,
    });
  }
  return out;
}

function validateTerms(raw: unknown, packId: string): DictTermEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DictTermEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      console.warn("[remotePacks] dropped malformed term entry", item);
      continue;
    }
    const t = item as Record<string, unknown>;
    if (!isNonEmptyString(t.term) || !isNonEmptyString(t.gloss_zh)) {
      console.warn("[remotePacks] dropped term missing required fields", item);
      continue;
    }
    const type =
      typeof t.type === "string" && (TERM_TYPES as string[]).includes(t.type)
        ? (t.type as TermType)
        : "other";
    out.push({
      term: t.term.trim(),
      type,
      gloss_en: isNonEmptyString(t.gloss_en) ? t.gloss_en : "",
      gloss_zh: clampZh(t.gloss_zh.trim()),
      pack: isNonEmptyString(t.pack) ? t.pack : packId,
    });
  }
  return out;
}

/** Validate a raw fetched JSON payload against the lenient manifest
 *  shape. Throws only when the manifest itself is unusable (missing
 *  id/name/version) — per-entry problems are dropped, not fatal. */
function validateManifest(raw: unknown): LoadedRemotePack {
  if (!raw || typeof raw !== "object") {
    throw new Error("词典包格式不正确：不是合法 JSON 对象");
  }
  const m = raw as Record<string, unknown>;
  if (!isNonEmptyString(m.id)) {
    throw new Error("词典包缺少 id 字段");
  }
  if (!isNonEmptyString(m.name)) {
    throw new Error("词典包缺少 name 字段");
  }
  if (
    typeof m.version !== "string" &&
    typeof m.version !== "number"
  ) {
    throw new Error("词典包缺少 version 字段");
  }

  const id = m.id.trim();
  return {
    id,
    name: m.name.trim(),
    description: isNonEmptyString(m.description) ? m.description.trim() : undefined,
    version: m.version,
    expressions: validateExpressions(m.expressions, id),
    terms: validateTerms(m.terms, id),
  };
}

// ---------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

async function readSources(): Promise<RemotePackSource[]> {
  if (!hasIndexedDb()) return [];
  try {
    const list = await get<RemotePackSource[]>(REMOTE_PACKS_KEY);
    return list ?? [];
  } catch (err) {
    console.warn("[remotePacks] readSources failed", err);
    return [];
  }
}

async function writeSources(sources: RemotePackSource[]): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await set(REMOTE_PACKS_KEY, sources);
  } catch (err) {
    console.warn("[remotePacks] writeSources failed", err);
  }
}

// ---------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------

async function fetchManifest(url: string): Promise<LoadedRemotePack> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("获取词典包超时");
    }
    throw new Error("获取词典包失败，请检查链接或网络");
  }
  if (!res.ok) {
    throw new Error(`获取词典包失败（${res.status}）`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("词典包不是合法 JSON");
  }
  return validateManifest(json);
}

// ---------------------------------------------------------------
// In-memory registry consumed by dictionary.ts — mirrors the
// setEnabledPacks() module-level cache pattern in dictionary.ts (see
// that file's comment): scanDictionary runs synchronously per
// transcript segment, so remote packs must be available without an
// async round-trip on every scan call. loadRemotePacksIntoRegistry()
// populates this cache; dictionary.ts reads it via getLoadedRemotePacks().
// ---------------------------------------------------------------

let registry: LoadedRemotePack[] = [];
let registryLoaded = false;
let loadingPromise: Promise<void> | null = null;

/** All packs currently loaded into the live-detection registry. */
export function getLoadedRemotePacks(): LoadedRemotePack[] {
  return registry;
}

/** Populate the in-memory registry from persisted sources. Safe to
 *  call multiple times — subsequent calls are no-ops once loaded,
 *  unless `force` is passed (used after add/remove/checkUpdates so the
 *  registry picks up the change immediately without a page reload).
 *  Called lazily: once from dictionary.ts's first scan, and once from
 *  SettingsDialog's mount effect — see those files' comments for why
 *  store.hydrate() isn't used (this worker doesn't own store.ts). */
export async function loadRemotePacksIntoRegistry(force = false): Promise<void> {
  if (registryLoaded && !force) return;
  if (loadingPromise && !force) return loadingPromise;

  loadingPromise = (async () => {
    const sources = await readSources();
    registry = sources.map((s) => s.pack);
    registryLoaded = true;
  })();
  await loadingPromise;
  loadingPromise = null;
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

export interface AddPackSourceResult {
  url: string;
  pack: LoadedRemotePack;
}

/** Fetch, validate, and persist a new pack source. Replaces any
 *  existing source with the same url or the same manifest id. */
export async function addPackSource(url: string): Promise<AddPackSourceResult> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error("请输入词典包链接");
  }
  const pack = await fetchManifest(trimmedUrl);

  const sources = await readSources();
  const next = sources.filter((s) => s.url !== trimmedUrl && s.pack.id !== pack.id);
  next.push({ url: trimmedUrl, pack });
  await writeSources(next);
  await loadRemotePacksIntoRegistry(true);

  return { url: trimmedUrl, pack };
}

export async function removePackSource(url: string): Promise<void> {
  const sources = await readSources();
  const next = sources.filter((s) => s.url !== url);
  await writeSources(next);
  await loadRemotePacksIntoRegistry(true);
}

export async function listPackSources(): Promise<RemotePackSource[]> {
  return readSources();
}

/** Refetch every installed source; replace the stored manifest when
 *  its version differs from what's persisted. Returns the ids of
 *  packs that were actually updated. Individual fetch failures are
 *  logged and skipped (one broken source shouldn't block the rest). */
export async function checkUpdates(): Promise<string[]> {
  const sources = await readSources();
  if (sources.length === 0) return [];

  const updatedIds: string[] = [];
  const next: RemotePackSource[] = [];

  for (const source of sources) {
    try {
      const fresh = await fetchManifest(source.url);
      if (String(fresh.version) !== String(source.pack.version)) {
        updatedIds.push(fresh.id);
        next.push({ url: source.url, pack: fresh });
      } else {
        next.push(source);
      }
    } catch (err) {
      console.warn(`[remotePacks] checkUpdates failed for ${source.url}`, err);
      next.push(source);
    }
  }

  await writeSources(next);
  await loadRemotePacksIntoRegistry(true);
  return updatedIds;
}
