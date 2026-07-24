// Remote dictionary theme packs — lets users install community-authored
// packs from a URL (GitHub raw / jsDelivr) alongside the built-in
// PACKS registry. OWNER: this worker (#20). v0.6 (T1-T6): manifest v2
// (attribution/provenance metadata + minAppVersion gate), term
// variants, official-vs-imported classification, size caps, and
// file-imported (no-url) packs — see each section below.
//
// Storage: idb-keyval "jargonslayer:remote-packs" = Array<{ url, pack,
// importedAt?, origin? }> — url is "" (never undefined — see
// RemotePackSource's own doc for why) for a file-imported pack (see
// addPackFromManifest); pack = the validated+normalized manifest,
// refetched wholesale on checkUpdates() (url-backed sources only).
// Loaded packs also populate remotePacksRegistry.ts's (@jargonslayer/
// core) in-memory registry that dictionary.ts's scanDictionary()
// consults so remote entries participate in live detection exactly
// like EXTRA_EXPRESSIONS/TERMS, filtered by isPackEnabled() under
// their own manifest id. #53 core extraction: this file owns the
// fetch + idb-keyval load (impure, browser-only); the registry itself
// is pure and lives in @jargonslayer/core so dictionary.ts/packs.ts
// can read it without depending on this file.

import { get, set } from "idb-keyval";
import type { ExpressionCategory, TermType } from "@jargonslayer/core/types";
import type { DictExpressionEntry, DictTermEntry } from "@jargonslayer/core/detect/dictionary-data";
import { PACKS, materializeEnabledPacks } from "@jargonslayer/core/detect/packs";
import {
  setLoadedRemotePacks,
  type LoadedRemotePack,
} from "@jargonslayer/core/detect/remotePacksRegistry";
// Same pkg.version read apps/web's diag/report.ts already uses for the
// copyable diagnostics bundle — reused here for the minAppVersion gate
// (T1) so both places agree on "what version is this app" by construction.
import pkg from "../../../package.json";

const REMOTE_PACKS_KEY = "jargonslayer:remote-packs";
const FETCH_TIMEOUT_MS = 10_000;
const APP_VERSION = pkg.version;

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

// v0.6 T5 — size caps: a single manifest is capped independently of
// how many are already installed (protects against one huge pack); the
// total/count caps are then re-checked against what would actually get
// PERSISTED (the validated pack, not the raw wire payload) once this
// one is added. See assertWithinTotalCaps/fetchManifestRaw below.
const MAX_PACK_BYTES = 2 * 1024 * 1024; // 2 MB per manifest
const MAX_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB across all installed packs
const MAX_PACK_COUNT = 20;

// v0.6 T4 — the only two URL shapes classifyPackOrigin() treats as
// "official" (see that function). `origin` (not just host) also rules
// out a userinfo-bearing lookalike like https://raw.githubusercontent.com@evil.com/...
// since URL.origin never includes userinfo.
const OFFICIAL_RAW_ORIGIN = "https://raw.githubusercontent.com";
const OFFICIAL_RAW_PATH_PREFIX = "/mianaz/jargonslayer-dicts/";
const OFFICIAL_JSDELIVR_ORIGIN = "https://cdn.jsdelivr.net";
const OFFICIAL_JSDELIVR_PATH_PREFIX = "/gh/mianaz/jargonslayer-dicts@";

// ---------------------------------------------------------------
// Manifest shape (wire format — what a pack URL/file is expected to
// serve)
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
  pack?: string; // ignored on import — always overwritten with the manifest's own id (see validateExpressions)
}

export interface RemotePackTerm {
  term: string;
  // v0.6 T2: alternate surfaces, matched alongside `term` itself — see
  // dictionary.ts's term loop. Capped at install (validateTerms): <=8
  // items, <=60 chars each, deduped.
  variants?: string[];
  type?: TermType;
  gloss_en?: string;
  gloss_zh: string;
  // v0.6 T2: passed through as-is (see DictTermEntry.commonWord) — an
  // author flags an entry that's also an everyday English word so it
  // stays opt-in (only matches once the user has actively customized
  // their pack selection), same as the compiled built-in domain packs.
  commonWord?: boolean;
  pack?: string; // ignored on import — always overwritten with the manifest's own id (see validateTerms)
}

export interface RemotePackManifest {
  id: string;
  name: string;
  description?: string;
  version: string | number;
  expressions?: RemotePackExpression[];
  terms?: RemotePackTerm[];
  // ---- v2 (T1, additive) — attribution/provenance/versioning
  // metadata. Every field below is OPTIONAL; a v1 manifest lacking all
  // of them stays valid. A malformed value is silently dropped (never
  // fails the install) — the ONE exception is minAppVersion, whose
  // gate is the one new FATAL case (see validateManifest).
  schemaVersion?: number;
  license?: string;
  licenseUrl?: string; // must parse as an https URL, else dropped
  source?: string;
  sourceUrl?: string; // https only
  sourceVersion?: string;
  citation?: string;
  notice?: string;
  homepage?: string; // https only
  updateUrl?: string; // https only
  tags?: string[];
  minAppVersion?: string; // "x.y.z" — refuses the install if greater than APP_VERSION
  generator?: { model?: string; promptHash?: string; builtAt?: string };
  // Advisory only — NEVER trusted for display (real counts always come
  // from expressions.length/terms.length post-validation). Parsed here
  // for documentation completeness but deliberately NOT threaded into
  // LoadedRemotePack/validateManifest's return value.
  entryCount?: number;
}

// LoadedRemotePack (the validated, normalized pack shape — entries
// have `pack` forced to the manifest's own id, see validateExpressions/
// validateTerms below) now lives in @jargonslayer/core's
// remotePacksRegistry.ts (#53 core extraction — dictionary.ts/packs.ts
// need the type and this file needs to populate instances of it).

/** "official" = published by this project (mianaz/jargonslayer-dicts,
 *  fetched over https from either raw.githubusercontent.com or the
 *  jsDelivr gh mirror, no embedded credentials); everything else,
 *  including a file-imported pack (no url at all), is "imported". */
export type PackOrigin = "official" | "imported";

export interface RemotePackSource {
  // "" (empty string, not undefined) for a file-imported pack (T6,
  // addPackFromManifest below) — there is nothing to refetch/
  // check-update for those; checkUpdates skips any source with a falsy
  // url, and removePackSource/backup restore key off `pack.id` instead
  // in that case. Deliberately `string`, not `string | undefined`:
  // SettingsDialog.tsx (out of scope for this worker — a later worker
  // owns that file) already pins `useState<RemotePackSource[]>` and
  // passes `s.url` straight into a `(url: string) => …` handler, so an
  // optional type here would break that file's typecheck for no
  // functional gain — every check in this module already treats a
  // falsy url (`""` or `undefined`) identically via `if (!source.url)`.
  url: string;
  pack: LoadedRemotePack;
  // Only set for a file-imported pack — when it was installed, since
  // there's no url/version history to infer that from otherwise.
  importedAt?: number;
  // T4 provenance classification, computed by classifyPackOrigin() at
  // install/update time and stored here FOR CONVENIENCE ONLY (e.g. a
  // quick IDB inspection). Every real read site (listPackSources below)
  // RECOMPUTES it fresh rather than trusting this persisted copy — a
  // hand-edited IDB entry (or a future change to the official-host
  // allowlist) must never be able to masquerade as "official" after
  // the fact just because that was true (or claimed) at install time.
  origin?: PackOrigin;
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

/** Generic optional-string field: non-empty + trimmed + length-clamped,
 *  or undefined if the raw value isn't a usable string. Used by every
 *  v2 attribution/provenance field below (T1) — same lenient-drop
 *  posture as the rest of this module (a malformed optional field is
 *  silently omitted, never a fatal error). */
function clampStr(v: unknown, max: number): string | undefined {
  if (!isNonEmptyString(v)) return undefined;
  const trimmed = v.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Like clampStr, but the value must ALSO parse as an https:// URL —
 *  validated against the FULL (untruncated) string so a >max-length
 *  value can't be silently truncated into a different, shorter URL
 *  that happens to still parse; only THEN clamped for storage (T1:
 *  licenseUrl/sourceUrl/homepage/updateUrl). Anything else (http://,
 *  a non-URL string, missing) is dropped, not fatal. */
function clampHttpsUrl(v: unknown, max: number): string | undefined {
  if (!isNonEmptyString(v)) return undefined;
  const trimmed = v.trim();
  try {
    if (new URL(trimmed).protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** tags: <=8 items, <=24 chars each (T1). */
function clampTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (out.length >= 8) break;
    const s = clampStr(item, 24);
    if (s) out.push(s);
  }
  return out.length > 0 ? out : undefined;
}

/** generator.{model,promptHash,builtAt}: each <=80 chars (T1). */
function clampGenerator(raw: unknown): RemotePackManifest["generator"] {
  if (!raw || typeof raw !== "object") return undefined;
  const g = raw as Record<string, unknown>;
  const model = clampStr(g.model, 80);
  const promptHash = clampStr(g.promptHash, 80);
  const builtAt = clampStr(g.builtAt, 80);
  if (!model && !promptHash && !builtAt) return undefined;
  return { model, promptHash, builtAt };
}

/** Term variants (T2, new field) — <=8 items, <=60 chars each,
 *  trimmed, non-empty, deduped. Deliberately separate from expression
 *  variants' own (uncapped) handling in validateExpressions below: that
 *  field predates this cap, and already-published v1 packs must keep
 *  installing unchanged — retrofitting a cap onto it is out of scope. */
function clampTermVariants(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= 8) break;
    const s = clampStr(item, 60);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.length > 0 ? out : undefined;
}

/** Tiny semver-ish comparator (T1) — good enough for plain "x.y.z"
 *  strings (no pre-release/build metadata support, which neither this
 *  app's own package.json version nor any dict-pack's minAppVersion has
 *  ever used). Positive when `a` > `b`, matching Array.prototype.sort's
 *  comparator convention. Missing/non-numeric parts compare as 0, so
 *  e.g. "0.6" vs "0.6.0" compare equal. No new dependency (per T1). */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
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
      // Always the manifest's own id — an entry's own `pack` field is
      // untrusted input and is ignored, not merely defaulted, so a
      // malicious/buggy remote entry can't claim `pack: "core"` (or
      // any other id) to become permanently enabled or masquerade as
      // a different installed pack.
      pack: packId,
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
      variants: clampTermVariants(t.variants),
      type,
      gloss_en: isNonEmptyString(t.gloss_en) ? t.gloss_en : "",
      gloss_zh: clampZh(t.gloss_zh.trim()),
      commonWord: typeof t.commonWord === "boolean" ? t.commonWord : undefined,
      // See validateExpressions above: always the manifest's own id,
      // never trusts the entry's own `pack` field.
      pack: packId,
    });
  }
  return out;
}

/** Validate a raw fetched JSON payload against the lenient manifest
 *  shape. Throws only when the manifest itself is unusable (missing
 *  id/name/version, or — T1 — minAppVersion is newer than this app) —
 *  per-entry problems and every other v2 field are dropped, not fatal. */
function validateManifest(raw: unknown): LoadedRemotePack {
  if (!raw || typeof raw !== "object") {
    throw new Error("词典包格式不正确：不是有效的 JSON 对象");
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

  // T1 — the one new FATAL case: everything else in this function is
  // lenient (drop, don't fail), but installing a pack this app version
  // genuinely can't support correctly would be a silent-breakage trap
  // rather than a helpful pack. Checked before building the return
  // value below so a too-old app refuses cleanly.
  const minAppVersion = clampStr(m.minAppVersion, 16);
  if (minAppVersion && compareSemver(minAppVersion, APP_VERSION) > 0) {
    throw new Error(`此词典需要 JargonSlayer v${minAppVersion} 或更高版本`);
  }

  const id = m.id.trim();
  return {
    id,
    name: m.name.trim(),
    description: isNonEmptyString(m.description) ? m.description.trim() : undefined,
    version: m.version,
    expressions: validateExpressions(m.expressions, id),
    terms: validateTerms(m.terms, id),
    // v2 attribution/provenance (T1, additive) — every field optional,
    // a malformed one is silently dropped above (clampStr/clampHttpsUrl/
    // clampTags/clampGenerator all return undefined rather than throw).
    // `entryCount` is intentionally NOT included — see its own doc on
    // RemotePackManifest above.
    schemaVersion: typeof m.schemaVersion === "number" ? m.schemaVersion : undefined,
    license: clampStr(m.license, 80),
    licenseUrl: clampHttpsUrl(m.licenseUrl, 300),
    source: clampStr(m.source, 120),
    sourceUrl: clampHttpsUrl(m.sourceUrl, 300),
    sourceVersion: clampStr(m.sourceVersion, 60),
    citation: clampStr(m.citation, 300),
    notice: clampStr(m.notice, 600),
    homepage: clampHttpsUrl(m.homepage, 300),
    updateUrl: clampHttpsUrl(m.updateUrl, 300),
    tags: clampTags(m.tags),
    minAppVersion,
    generator: clampGenerator(m.generator),
  };
}

/** T4: classify a pack SOURCE's provenance from its url. "official" iff
 *  the url parses (new URL()), is https:, carries no userinfo
 *  (username/password), AND its origin+path-prefix exactly match one of
 *  the two blessed mianaz/jargonslayer-dicts hosting shapes below —
 *  everything else, including a lookalike host
 *  (raw.githubusercontent.com.evil.com), a credentialed URL, an http://
 *  downgrade, a near-miss path (/mianaz/jargonslayer-dicts-evil/), or a
 *  file-imported pack (no url — pass "" ), is "imported". Exported so
 *  UI can render an "official"/"imported" badge; see RemotePackSource.
 *  origin's own doc for why this must be recomputed on every read
 *  rather than trusted from storage. */
export function classifyPackOrigin(url: string): PackOrigin {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "imported";
  }
  if (u.protocol !== "https:" || u.username || u.password) return "imported";
  if (u.origin === OFFICIAL_RAW_ORIGIN && u.pathname.startsWith(OFFICIAL_RAW_PATH_PREFIX)) {
    return "official";
  }
  if (u.origin === OFFICIAL_JSDELIVR_ORIGIN && u.pathname.startsWith(OFFICIAL_JSDELIVR_PATH_PREFIX)) {
    return "official";
  }
  return "imported";
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

/** T5 fix: this used to swallow a write failure behind a console.warn
 *  — silent data loss (an install looked like it worked, then vanished
 *  on reload). Now THROWS so addPackSource/checkUpdates surface the
 *  failure to their own callers, with a friendlier zh message for the
 *  one failure mode a user can actually act on (free up space).
 *  removePackSource's own caller (SettingsDialog) does not wrap it in
 *  a try/catch, so THAT call site catches this itself instead of
 *  letting it propagate — see removePackSource below. */
async function writeSources(sources: RemotePackSource[]): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await set(REMOTE_PACKS_KEY, sources);
  } catch (err) {
    console.warn("[remotePacks] writeSources failed", err);
    if (err instanceof DOMException && err.name === "QuotaExceededError") {
      throw new Error("浏览器存储空间不足，无法保存词典", { cause: err });
    }
    throw err;
  }
}

/** UTF-8 byte size of a value's JSON serialization — used by both the
 *  per-manifest and total-installed caps (T5). */
function byteSize(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

/** T5: refuse to persist `nextSources` (the full array about to be
 *  written) once it would exceed either cap. Checked against what
 *  would actually be STORED (validated packs), not the raw wire
 *  payload — a pack that shrinks a lot during validation shouldn't be
 *  penalized for its original size, and this is also what
 *  writeSources actually persists. */
function assertWithinTotalCaps(nextSources: RemotePackSource[]): void {
  if (nextSources.length > MAX_PACK_COUNT) {
    throw new Error(`已安装词典包数量将超过上限（最多 ${MAX_PACK_COUNT} 个），请先移除部分词典包`);
  }
  if (byteSize(nextSources) > MAX_TOTAL_BYTES) {
    throw new Error("已安装词典包总大小将超过上限（最多 10 MB），请先移除部分词典包");
  }
}

// ---------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------

/** Fetch + size-cap-check (T5) + JSON.parse a manifest URL, WITHOUT
 *  validating its shape yet — split out from fetchManifest so
 *  addPackFromManifest (T6, already-parsed input) can share the exact
 *  same downstream validate+install pipeline via installValidatedPack
 *  below, while this half stays URL-fetch-specific. */
async function fetchManifestRaw(url: string): Promise<unknown> {
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
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new Error("词典包 JSON 格式无效");
  }
  // T5: checked on the actual wire bytes, before JSON.parse — rejects
  // an oversized manifest without also paying to parse/validate it.
  if (new TextEncoder().encode(text).length > MAX_PACK_BYTES) {
    throw new Error("词典包过大：单个词典包不能超过 2 MB");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("词典包 JSON 格式无效");
  }
}

async function fetchManifest(url: string): Promise<LoadedRemotePack> {
  return validateManifest(await fetchManifestRaw(url));
}

// ---------------------------------------------------------------
// In-memory registry consumed by dictionary.ts/packs.ts — lives in
// @jargonslayer/core's remotePacksRegistry.ts (#53 core extraction),
// since scanDictionary runs synchronously per transcript segment and
// must read remote packs without an async round-trip on every scan
// call, but core can't itself fetch/idb-keyval. loadRemotePacksIntoRegistry()
// below populates that shared cache via setLoadedRemotePacks();
// dictionary.ts/packs.ts read it via getLoadedRemotePacks().
// ---------------------------------------------------------------

let registryLoaded = false;
let loadingPromise: Promise<void> | null = null;

/** Populate the in-memory registry from persisted sources. Safe to
 *  call multiple times — subsequent calls are no-ops once loaded,
 *  unless `force` is passed (used after add/remove/checkUpdates so the
 *  registry picks up the change immediately without a page reload).
 *  Triggered by SettingsDialog's mount effect, unconditionally of
 *  whether the dialog is open (see that file — it is always mounted by
 *  page.tsx), so the registry is warm before any live scanDictionary()
 *  call can plausibly happen. */
export async function loadRemotePacksIntoRegistry(force = false): Promise<void> {
  if (registryLoaded && !force) return;
  if (loadingPromise && !force) return loadingPromise;

  loadingPromise = (async () => {
    const sources = await readSources();
    setLoadedRemotePacks(sources.map((s) => s.pack));
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

/** T3 wiring: this module cannot read/write live Settings itself (that
 *  would mean importing the zustand store, which risks a cycle — this
 *  file is imported early, at app-mount, by SettingsDialog), so both
 *  halves of the enabledPacks materialization are injected by the
 *  caller instead. */
export interface AddPackSourceOptions {
  /** The caller's CURRENT Settings.enabledPacks (e.g.
   *  `useApp.getState().settings.enabledPacks`). Defaults to `null` —
   *  DEFAULT_SETTINGS.enabledPacks' own default, i.e. exactly what a
   *  caller that doesn't pass this would have anyway. */
  currentEnabledPacks?: string[] | null;
  /** Called once, synchronously, right after a successful install with
   *  the freshly materialized enabledPacks list (see
   *  materializeEnabledPacks, @jargonslayer/core/detect/packs) — the
   *  caller is responsible for actually persisting it (e.g.
   *  `useApp.getState().updateSettings({ enabledPacks })`). Default: a
   *  no-op, so any caller that doesn't pass this (every call site that
   *  predates T3) keeps the exact old behavior — the list is computed
   *  but never written anywhere, i.e. the commonWord-suppression bug
   *  this exists to fix stays exactly as unfixed as before for that
   *  caller. */
  onEnabledPacksChange?: (enabledPacks: string[]) => void;
}

/** Shared install tail for both addPackSource (url) and
 *  addPackFromManifest (file, T6): validate, dedupe against whatever's
 *  already installed, enforce the total/count caps (T5), persist,
 *  reload the live registry, and materialize enabledPacks (T3).
 *  `sourceUrl` is undefined for a file-imported pack. */
async function installValidatedPack(
  raw: unknown,
  sourceUrl: string | undefined,
  opts: AddPackSourceOptions,
): Promise<LoadedRemotePack> {
  const pack = validateManifest(raw);

  const sources = await readSources();
  // Replaces any existing source with the same url OR the same
  // manifest id — same "last install wins" precedent as before T6.
  // Deliberately NOT `s.url !== sourceUrl` on its own: when sourceUrl
  // is undefined (a file import), every OTHER file-imported source
  // also has `s.url === undefined`, which would make them all look
  // like "the same url" and evict each other on every new file import.
  const others = sources.filter((s) => {
    if (sourceUrl && s.url === sourceUrl) return false;
    if (s.pack.id === pack.id) return false;
    return true;
  });

  const origin = classifyPackOrigin(sourceUrl ?? "");
  const record: RemotePackSource = sourceUrl
    ? { url: sourceUrl, pack, origin }
    : { url: "", pack, importedAt: Date.now(), origin };
  const next = [...others, record];
  assertWithinTotalCaps(next);
  await writeSources(next);
  await loadRemotePacksIntoRegistry(true);

  const allBuiltInIds = PACKS.map((p) => p.id);
  const installedIds = others.map((s) => s.pack.id);
  const nextEnabled = materializeEnabledPacks(
    opts.currentEnabledPacks ?? null,
    allBuiltInIds,
    installedIds,
    pack.id,
  );
  opts.onEnabledPacksChange?.(nextEnabled);

  return pack;
}

/** Fetch, validate, and persist a new pack source from a URL. Replaces
 *  any existing source with the same url or the same manifest id. */
export async function addPackSource(
  url: string,
  opts: AddPackSourceOptions = {},
): Promise<AddPackSourceResult> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error("请输入词典包链接");
  }
  const raw = await fetchManifestRaw(trimmedUrl);
  const pack = await installValidatedPack(raw, trimmedUrl, opts);
  return { url: trimmedUrl, pack };
}

/** T6: install a pack from an already-parsed local file, no URL. Runs
 *  the exact same validateManifest + size-cap + materializeEnabledPacks
 *  pipeline addPackSource does — NEVER throws (mirrors theme/schema.ts's
 *  parseTheme never-throw posture); every failure (junk JSON, a
 *  malformed manifest, an over-cap pack) comes back as `{ok: false,
 *  error}` instead. */
export async function addPackFromManifest(
  rawJson: unknown,
  opts: AddPackSourceOptions = {},
): Promise<{ ok: true; pack: LoadedRemotePack } | { ok: false; error: string }> {
  try {
    if (byteSize(rawJson) > MAX_PACK_BYTES) {
      throw new Error("词典包过大：单个词典包不能超过 2 MB");
    }
    const pack = await installValidatedPack(rawJson, undefined, opts);
    return { ok: true, pack };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "词典包导入失败" };
  }
}

/** Remove one installed source, identified by its url (URL-backed
 *  packs) or its manifest id (T6: a file-imported pack's url is ""
 *  — see RemotePackSource.url's own doc — so the UI worker should pass
 *  `pack.id` for those instead). */
export async function removePackSource(identifier: string): Promise<void> {
  const sources = await readSources();
  // `||`, not `??` — a file-imported source's url is "" (falsy but not
  // nullish), which must also fall through to matching by pack.id.
  const next = sources.filter((s) => (s.url || s.pack.id) !== identifier);
  try {
    await writeSources(next);
  } catch (err) {
    // T5 made writeSources throw instead of swallowing (closing the
    // silent-data-loss hole on INSTALL) — but this function's only
    // caller (SettingsDialog's handleRemovePackSource) does not wrap it
    // in a try/catch, so letting this propagate would turn into an
    // unhandled rejection. Swallow-and-log here instead (writeSources'
    // own pre-T5 behavior) — a failed REMOVAL is far lower-stakes than
    // a failed install: the pack just stays installed, which is
    // visible and retriable, not silent data loss.
    console.warn("[remotePacks] removePackSource: writeSources failed", err);
    return;
  }
  await loadRemotePacksIntoRegistry(true);
}

export async function listPackSources(): Promise<RemotePackSource[]> {
  const sources = await readSources();
  // T4: `origin` is ALWAYS recomputed here, never trusted from storage
  // (see RemotePackSource.origin's own doc) — this is the one read
  // site every UI consumer goes through, so recomputing centrally here
  // means no caller has to think about it itself.
  return sources.map((s) => ({ ...s, origin: classifyPackOrigin(s.url) }));
}

/** Refetch every URL-backed installed source; replace the stored
 *  manifest when its version differs from what's persisted. A
 *  file-imported source (T6, no url) is skipped outright — there is
 *  nothing to refetch it from — rather than attempting a fetch and
 *  relying on that failing gracefully. Returns the ids of packs that
 *  were actually updated. Individual fetch failures are logged and
 *  skipped (one broken source shouldn't block the rest). */
export async function checkUpdates(): Promise<string[]> {
  const sources = await readSources();
  if (sources.length === 0) return [];

  const updatedIds: string[] = [];
  const next: RemotePackSource[] = [];

  for (const source of sources) {
    if (!source.url) {
      next.push(source);
      continue;
    }
    try {
      const fresh = await fetchManifest(source.url);
      if (String(fresh.version) !== String(source.pack.version)) {
        updatedIds.push(fresh.id);
        next.push({ url: source.url, pack: fresh, origin: classifyPackOrigin(source.url) });
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
