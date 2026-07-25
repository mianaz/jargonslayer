// Extension-side remote dictionary pack loader/store.
//
// PORT, not import, of apps/web/src/lib/detect/remotePacks.ts: that
// file's top-level `import { get, set } from "idb-keyval"` means
// importing ANY of its exports would drag idb-keyval into this app's
// bundle — storage/history.ts's own header rules that out explicitly
// ("v1 ships with zero new npm dependencies"). Everything below that
// does NOT touch idb-keyval in the original — the manifest wire shape,
// every clamp/validate function, the https-only/no-credentials gate,
// origin classification, and the size caps — is ported to match that
// file's behavior (including its zh error copy) field-for-field, so
// this module IS the "reuse the core validation contract" requirement,
// just copy-pasted past the idb-keyval import boundary rather than
// imported. What's genuinely different is persistence: apps/web writes
// through idb-keyval directly; this module writes through its own small
// IndexedDB-backed store (see "Persistence" below) — same idb-keyval-
// shaped get/set surface, and the same "own IndexedDB database, not
// chrome.storage.local" call storage/history.ts already made for this
// exact reason (chrome.storage.local's ~10MB *extension-wide* quota is
// the wrong fit for multi-MB, growing data; see that file's header).
// LoadedRemotePack / setLoadedRemotePacks / getLoadedRemotePacks and
// @jargonslayer/core's own PACKS / DictExpressionEntry / DictTermEntry /
// DomainTag are the PURE, idb-keyval-free slice of the shared contract
// and are imported directly below, never duplicated.
//
// Scope cut vs. the web app's own remotePacks.ts (this app's settings
// surface is deliberately much simpler than SettingsDialog's 词典库
// tab): no file-import (addPackFromManifest), no checkUpdates, no
// manual URL-entry install. addPackSource(url) is the one install
// primitive; the panel's install button calls it with a URL the
// catalog list (dictCatalog.ts) already resolved — see
// sidepanel/renderPacks.ts.

import type { ExpressionCategory, TermType } from "@jargonslayer/core/types";
import {
  DOMAIN_TAGS,
  type DictExpressionEntry,
  type DictSense,
  type DictTermEntry,
  type DomainTag,
} from "@jargonslayer/core/detect/dictionary-data";
import { PACKS } from "@jargonslayer/core/detect/packs";
import {
  setLoadedRemotePacks,
  type LoadedRemotePack,
} from "@jargonslayer/core/detect/remotePacksRegistry";
import pkg from "../../package.json";

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

// Size caps — mirror apps/web/src/lib/detect/remotePacks.ts's own T5/N3
// caps exactly (same numbers, so a pack that's legal to install on the
// web app is also legal here, and vice versa).
export const MAX_PACK_BYTES = 2 * 1024 * 1024; // 2 MB per manifest
const MAX_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB across all installed packs
export const MAX_PACK_COUNT = 20;
const MAX_PACK_SURFACES = 5000; // headword+variants candidate-surface budget per pack

const MAX_NAME_LEN = 80;
const MAX_DESCRIPTION_LEN = 200;

// A manifest id of "__proto__"/"constructor"/"prototype" would turn any
// plain-object lookup keyed by pack id into a prototype access instead
// of a real miss — rejected outright, same as the web app's own gate.
const DANGEROUS_MANIFEST_IDS = new Set(["__proto__", "constructor", "prototype"]);

// The only two URL shapes classifyPackOrigin() below treats as
// "official". `origin` (not just host) also rules out a userinfo-
// bearing lookalike like https://raw.githubusercontent.com@evil.com/...
// since URL.origin never includes userinfo.
const OFFICIAL_RAW_ORIGIN = "https://raw.githubusercontent.com";
const OFFICIAL_RAW_PATH_PREFIX = "/mianaz/jargonslayer-dicts/";
const OFFICIAL_JSDELIVR_ORIGIN = "https://cdn.jsdelivr.net";
const OFFICIAL_JSDELIVR_PATH_PREFIX = "/gh/mianaz/jargonslayer-dicts@";

// ---------------------------------------------------------------
// Manifest shape (wire format — what a pack URL is expected to serve),
// mirrors apps/web's RemotePackManifest 1:1.
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
  pack?: string; // ignored on import — always overwritten with the manifest's own id
}

export interface RemotePackSense {
  senseId?: string;
  gloss_en: string;
  gloss_zh: string;
  type?: TermType;
  domain: DomainTag;
  prior?: number;
}

export interface RemotePackTerm {
  term: string;
  variants?: string[];
  type?: TermType;
  gloss_en?: string;
  gloss_zh: string;
  commonWord?: boolean;
  senses?: RemotePackSense[];
  pack?: string; // ignored on import — always overwritten with the manifest's own id
}

export interface RemotePackManifest {
  id: string;
  name: string;
  description?: string;
  version: string | number;
  expressions?: RemotePackExpression[];
  terms?: RemotePackTerm[];
  // ---- v2 (additive) — attribution/provenance/versioning metadata.
  // Every field below is OPTIONAL; a v1 manifest lacking all of them
  // stays valid. A malformed value is silently dropped (never fails the
  // install) — the ONE exception is minAppVersion, whose gate is the
  // one new FATAL case (see validateManifest).
  schemaVersion?: number;
  license?: string;
  licenseUrl?: string;
  source?: string;
  sourceUrl?: string;
  sourceVersion?: string;
  citation?: string;
  notice?: string;
  homepage?: string;
  updateUrl?: string;
  tags?: string[];
  minAppVersion?: string; // "x.y.z" — refuses the install if greater than APP_VERSION
  generator?: { model?: string; promptHash?: string; builtAt?: string };
  // Advisory only — NEVER trusted for display; parsed here for shape
  // completeness but deliberately not threaded into LoadedRemotePack.
  entryCount?: number;
}

/** "official" = published by this project (mianaz/jargonslayer-dicts),
 *  fetched over https from either raw.githubusercontent.com or the
 *  jsDelivr gh mirror, no embedded credentials; everything else is
 *  "imported". */
export type PackOrigin = "official" | "imported";

export interface RemotePackSource {
  url: string;
  pack: LoadedRemotePack;
  // The url actually REQUESTED for the fetch that produced `url` above
  // (the FINAL, post-redirect url) — only meaningfully different from
  // `url` after a redirect. "official" requires BOTH ends to
  // independently classify official (classifyPackOriginAcrossRedirect
  // below) so a request that merely redirects onto the official host
  // can't get relabeled official.
  requestedUrl?: string;
  // Provenance classification, recomputed on every listPackSources()
  // read (never trusted from storage) — see classifyPackOriginAcrossRedirect.
  origin?: PackOrigin;
}

// ---------------------------------------------------------------
// Validation — lenient: drop malformed entries with a console.warn
// rather than failing the whole pack. Ported field-for-field from
// apps/web/src/lib/detect/remotePacks.ts's own validation (see this
// file's header for why it's a port, not an import).
// ---------------------------------------------------------------

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function clampZh(s: string): string {
  return s.length > MAX_ZH_LEN ? s.slice(0, MAX_ZH_LEN) : s;
}

function clampStr(v: unknown, max: number): string | undefined {
  if (!isNonEmptyString(v)) return undefined;
  const trimmed = v.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Like clampStr, but the value must ALSO parse as an https:// URL —
 *  validated against the FULL (untruncated) string so a >max-length
 *  value can't be silently truncated into a different, shorter URL that
 *  happens to still parse; only THEN clamped for storage. */
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

// bidi/zero-width control characters (RLO/PDF/bidi isolates/zero-width
// chars) stripped from name/description ONLY — the two fields
// renderPacks.ts renders directly adjacent to the 官方/已导入
// provenance badge. Without this, an imported pack's name could
// visually reorder or hide that badge, or splice in a fake "官方"
// substring next to it.
const BIDI_CONTROL_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function stripBidiControls(s: string): string {
  return s.replace(BIDI_CONTROL_RE, "");
}

function clampDisplayStr(v: unknown, max: number): string | undefined {
  if (!isNonEmptyString(v)) return undefined;
  const cleaned = stripBidiControls(v).trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/** tags: <=8 items, <=24 chars each. */
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

/** generator.{model,promptHash,builtAt}: each <=80 chars. */
function clampGenerator(raw: unknown): RemotePackManifest["generator"] {
  if (!raw || typeof raw !== "object") return undefined;
  const g = raw as Record<string, unknown>;
  const model = clampStr(g.model, 80);
  const promptHash = clampStr(g.promptHash, 80);
  const builtAt = clampStr(g.builtAt, 80);
  if (!model && !promptHash && !builtAt) return undefined;
  return { model, promptHash, builtAt };
}

/** Term variants: <=8 items, <=60 chars each, trimmed, non-empty,
 *  deduped CASE-SENSITIVELY (an ALL-CAPS acronym matches
 *  case-sensitively — unlike expression variants below). */
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

/** Term senses: <=6 items; each validated like a term itself —
 *  non-empty gloss_en/gloss_zh required or the SENSE is dropped (not
 *  the whole term); `domain` must be a recognized DomainTag or the
 *  sense is dropped; `prior` clamped 0..1, defaulting 0.5; `senseId`
 *  clamped to <=40 chars, generated from the sense's own index when
 *  absent/empty. */
function clampSenses(raw: unknown): DictSense[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DictSense[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (out.length >= 6) break;
    const item = raw[i];
    if (!item || typeof item !== "object") {
      console.warn("[remotePacks] dropped malformed sense entry", item);
      continue;
    }
    const s = item as Record<string, unknown>;
    if (!isNonEmptyString(s.gloss_en) || !isNonEmptyString(s.gloss_zh)) {
      console.warn("[remotePacks] dropped sense missing required fields", item);
      continue;
    }
    if (typeof s.domain !== "string" || !(DOMAIN_TAGS as readonly string[]).includes(s.domain)) {
      console.warn("[remotePacks] dropped sense with unrecognized domain", item);
      continue;
    }
    const type =
      typeof s.type === "string" && (TERM_TYPES as string[]).includes(s.type)
        ? (s.type as TermType)
        : undefined;
    const prior =
      typeof s.prior === "number" && Number.isFinite(s.prior)
        ? Math.min(1, Math.max(0, s.prior))
        : 0.5;
    const senseId = clampStr(s.senseId, 40) ?? `sense-${i}`;
    out.push({
      gloss_en: s.gloss_en.trim(),
      gloss_zh: clampZh(s.gloss_zh.trim()),
      type,
      domain: s.domain as DomainTag,
      prior,
      senseId,
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Expression variants: <=8 items, <=60 chars each, trimmed, non-empty,
 *  deduped CASE-INSENSITIVELY (an expression match is already
 *  case-insensitive at match time). Also bounds the DoS surface — see
 *  MAX_PACK_SURFACES. */
function clampExpressionVariants(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= 8) break;
    const s = clampStr(item, 60);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.length > 0 ? out : undefined;
}

/** Tiny semver-ish comparator — good enough for plain "x.y.z" strings
 *  (no pre-release/build metadata support). Positive when `a` > `b`,
 *  matching Array.prototype.sort's comparator convention. Missing/
 *  non-numeric parts compare as 0. Exported so renderPacks.ts could
 *  reuse the same real ordering for a future 目录 "已是最新" comparison
 *  instead of a naive string compare, mirroring why apps/web's own
 *  remotePacks.ts exports it. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function validateExpressions(raw: unknown, packId: string): DictExpressionEntry[] {
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
      typeof e.category === "string" && (EXPRESSION_CATEGORIES as string[]).includes(e.category)
        ? (e.category as ExpressionCategory)
        : "other";
    const confidence =
      typeof e.confidence === "number" && Number.isFinite(e.confidence)
        ? Math.min(1, Math.max(0, e.confidence))
        : 0.85;
    const variants = clampExpressionVariants(e.variants);
    out.push({
      expression: e.expression.trim(),
      variants,
      category,
      meaning: isNonEmptyString(e.meaning) ? e.meaning : e.chinese_explanation,
      chinese_explanation: clampZh(e.chinese_explanation.trim()),
      plain_english: isNonEmptyString(e.plain_english) ? e.plain_english : e.expression.trim(),
      tone: isNonEmptyString(e.tone) ? e.tone : "community pack entry",
      confidence,
      // Always the manifest's own id — an entry's own `pack` field is
      // untrusted input and is IGNORED, not merely defaulted, so a
      // malicious/buggy remote entry can't claim `pack: "core"` (or any
      // other id) to become permanently enabled or masquerade as a
      // different installed pack.
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
      senses: clampSenses(t.senses),
      // See validateExpressions above: always the manifest's own id,
      // never trusts the entry's own `pack` field.
      pack: packId,
    });
  }
  return out;
}

/** Validate a raw fetched JSON payload against the lenient manifest
 *  shape. Throws only when the manifest itself is unusable (missing
 *  id/name/version; the id is dangerous or collides with a built-in
 *  pack id; content exceeds the surface budget; or minAppVersion is
 *  newer than this app) — per-entry problems and every other v2 field
 *  are dropped, not fatal. */
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
  if (typeof m.version !== "string" && typeof m.version !== "number") {
    throw new Error("词典包缺少 version 字段");
  }

  const id = m.id.trim();

  if (DANGEROUS_MANIFEST_IDS.has(id)) {
    throw new Error("词典包 id 不合法（不能使用 __proto__ / constructor / prototype）");
  }
  // An id colliding with a BUILT-IN pack id (e.g. "core") would make
  // isPackEnabled() treat it as permanently-on and collide with the
  // built-in pack's own identity everywhere pack id is used as a key.
  // PACKS is @jargonslayer/core's own source of truth, never
  // hand-duplicated here.
  if (PACKS.some((p) => p.id === id)) {
    throw new Error(`词典包 id 与内置词典包冲突（"${id}"），请更换 id`);
  }

  // Everything else in this function is lenient (drop, don't fail), but
  // installing a pack this app version genuinely can't support
  // correctly would be a silent-breakage trap rather than a helpful
  // pack. compareSemver is REAL semver ordering, not a string compare.
  const minAppVersion = clampStr(m.minAppVersion, 16);
  if (minAppVersion && compareSemver(minAppVersion, APP_VERSION) > 0) {
    throw new Error(`此词典需要 JargonSlayer v${minAppVersion} 或更高版本`);
  }

  const name = clampDisplayStr(m.name, MAX_NAME_LEN);
  if (!name) {
    throw new Error("词典包缺少 name 字段");
  }

  const expressions = validateExpressions(m.expressions, id);
  const terms = validateTerms(m.terms, id);
  // Total candidate-surface budget (headword + variants, expressions +
  // terms combined) — bounds scanDictionary's regex-compile cost
  // independent of the byte-size/entry-count caps below.
  const totalSurfaces =
    expressions.reduce((n, e) => n + 1 + (e.variants?.length ?? 0), 0) +
    terms.reduce((n, t) => n + 1 + (t.variants?.length ?? 0), 0);
  if (totalSurfaces > MAX_PACK_SURFACES) {
    throw new Error(`词典包内容过多：单个词典包最多包含 ${MAX_PACK_SURFACES} 个匹配项（含变体）`);
  }

  return {
    id,
    name,
    description: clampDisplayStr(m.description, MAX_DESCRIPTION_LEN),
    version: m.version,
    expressions,
    terms,
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

// ---------------------------------------------------------------
// Origin classification — B1-fixed: the path-PREFIX check alone
// constrains the repo but not the git REF (GitHub forks share one
// object store with upstream — Cross-Fork Object Reference — so a
// commit pushed to ANY fork is fetchable through the UPSTREAM path).
// isOfficialRawRef/isOfficialJsdelivrRef constrain the ref itself to a
// small allowlisted shape — a branch name ("main"), the fully-qualified
// form ("refs/heads/main"), or a release tag ("v<semver>") — and
// explicitly reject everything else, including a 40-hex commit SHA and
// any refs/pull/… path.
// ---------------------------------------------------------------

const SEMVER_TAG_RE = /^v\d+(\.\d+){0,2}$/;

/** `pathAfterPrefix` is everything after OFFICIAL_RAW_PATH_PREFIX, e.g.
 *  "main/pack.json", "refs/heads/main/pack.json", or "v1.2.3/pack.json". */
function isOfficialRawRef(pathAfterPrefix: string): boolean {
  const segments = pathAfterPrefix.split("/");
  if (segments[0] === "main") return true;
  if (segments[0] === "refs" && segments[1] === "heads" && segments[2] === "main") return true;
  return SEMVER_TAG_RE.test(segments[0] ?? "");
}

/** `pathAfterPrefix` is everything after OFFICIAL_JSDELIVR_PATH_PREFIX
 *  (which already includes the "@"), e.g. "main/pack.json" or
 *  "v1.2.3/pack.json" — jsDelivr's gh proxy has no refs/heads/… form. */
function isOfficialJsdelivrRef(pathAfterPrefix: string): boolean {
  const ref = pathAfterPrefix.split("/")[0] ?? "";
  return ref === "main" || SEMVER_TAG_RE.test(ref);
}

/** Classify a pack SOURCE's provenance from its url. "official" iff the
 *  url parses (new URL()), is https:, carries no userinfo (username/
 *  password), its origin+path-prefix match one of the two blessed
 *  mianaz/jargonslayer-dicts hosting shapes below, AND the ref portion
 *  of the path is one of the allowlisted shapes (isOfficialRawRef/
 *  isOfficialJsdelivrRef above) — everything else, including a
 *  lookalike host, a credentialed URL, an http:// downgrade, a
 *  near-miss path, a 40-hex commit SHA, or a refs/pull/… ref, is
 *  "imported". Exported so renderPacks.ts can render an
 *  "official"/"imported" badge. */
export function classifyPackOrigin(url: string): PackOrigin {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "imported";
  }
  if (u.protocol !== "https:" || u.username || u.password) return "imported";
  if (u.origin === OFFICIAL_RAW_ORIGIN && u.pathname.startsWith(OFFICIAL_RAW_PATH_PREFIX)) {
    const rest = u.pathname.slice(OFFICIAL_RAW_PATH_PREFIX.length);
    if (isOfficialRawRef(rest)) return "official";
  }
  if (
    u.origin === OFFICIAL_JSDELIVR_ORIGIN &&
    u.pathname.startsWith(OFFICIAL_JSDELIVR_PATH_PREFIX)
  ) {
    const rest = u.pathname.slice(OFFICIAL_JSDELIVR_PATH_PREFIX.length);
    if (isOfficialJsdelivrRef(rest)) return "official";
  }
  return "imported";
}

/** fetch() follows redirects by default, but classifying/persisting the
 *  ORIGINALLY REQUESTED url would let a redirect off the official host
 *  (or onto it) mis-tag provenance either way. "official" requires BOTH
 *  the requested and the actually-served (post-redirect) url to
 *  independently classify official. */
function classifyPackOriginAcrossRedirect(requestedUrl: string, finalUrl: string): PackOrigin {
  if (classifyPackOrigin(requestedUrl) !== "official") return "imported";
  if (classifyPackOrigin(finalUrl) !== "official") return "imported";
  return "official";
}

/** https-only, no embedded credentials — the one gate fetchManifestRaw
 *  below must apply BEFORE ever calling fetch(). Pure, no I/O. Exported
 *  so tests can assert it directly without a network round-trip. */
export function isAllowedPackUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && !u.username && !u.password;
}

// ---------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------

/** A fetched-but-not-yet-validated manifest, plus the url it was
 *  ACTUALLY served from — may differ from the requested url after a
 *  redirect; falls back to the requested url when the runtime's
 *  Response doesn't populate `.url` (some test doubles). */
interface FetchedManifest {
  raw: unknown;
  finalUrl: string;
}

async function fetchManifestRaw(url: string): Promise<FetchedManifest> {
  if (!isAllowedPackUrl(url)) {
    throw new Error("词典包链接必须是不含账号密码的 https 链接");
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    // AbortSignal.timeout() rejects with a TimeoutError DOMException,
    // not AbortError.
    if (
      err instanceof DOMException &&
      (err.name === "AbortError" || err.name === "TimeoutError")
    ) {
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
  // Checked on the actual wire bytes, before JSON.parse — rejects an
  // oversized manifest without also paying to parse/validate it.
  if (new TextEncoder().encode(text).length > MAX_PACK_BYTES) {
    throw new Error("词典包过大：单个词典包不能超过 2 MB");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("词典包 JSON 格式无效");
  }
  return { raw, finalUrl: res.url || url };
}

// ---------------------------------------------------------------
// Persistence — this app's own small IndexedDB database (single key,
// "sources"), same idb-keyval-shaped get/set surface storage/history.ts
// already established for growing/disk-quota-worthy data. A SEPARATE
// database from history.ts's own "jargonslayer-extension" (rather than
// a second object store in that database) so this module's schema/
// version never has to coordinate with history.ts's.
// ---------------------------------------------------------------

const DB_NAME = "jargonslayer-extension-packs";
const DB_VERSION = 1;
const STORE_NAME = "packs";
const SOURCES_KEY = "sources";

export interface PacksStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      // Same F4a/F4b retry posture as storage/history.ts's own openDb —
      // reset the module-level cache on failure/blocked so the NEXT
      // call opens a fresh connection instead of replaying the same
      // dead promise forever.
      req.onerror = () => {
        dbPromise = null;
        reject(req.error ?? new Error("indexedDB.open failed"));
      };
      req.onblocked = () => {
        dbPromise = null;
        reject(new Error("indexedDB upgrade blocked by another open panel"));
      };
    });
  }
  return dbPromise;
}

async function idbGet(key: string): Promise<unknown> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

const idbStore: PacksStore = { get: idbGet, set: idbSet };

async function readSources(store: PacksStore): Promise<RemotePackSource[]> {
  const list = (await store.get(SOURCES_KEY)) as RemotePackSource[] | undefined;
  return Array.isArray(list) ? list : [];
}

/** Throws on failure (never silently drops a write) so
 *  addPackSource/removePackSource surface it to their own callers,
 *  with a friendlier zh message for the one failure mode a user can
 *  actually act on (free up space). */
async function writeSources(sources: RemotePackSource[], store: PacksStore): Promise<void> {
  try {
    await store.set(SOURCES_KEY, sources);
  } catch (err) {
    console.warn("[remotePacks] writeSources failed", err);
    if (err instanceof DOMException && err.name === "QuotaExceededError") {
      throw new Error("浏览器存储空间不足，无法保存词典", { cause: err });
    }
    throw err;
  }
}

function byteSize(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

/** Refuse to persist `nextSources` (the full array about to be
 *  written) once it would exceed either cap. Checked against what
 *  would actually be STORED (validated packs), not the raw wire
 *  payload. */
function assertWithinTotalCaps(nextSources: RemotePackSource[]): void {
  if (nextSources.length > MAX_PACK_COUNT) {
    throw new Error(`已安装词典包数量将超过上限（最多 ${MAX_PACK_COUNT} 个），请先移除部分词典包`);
  }
  if (byteSize(nextSources) > MAX_TOTAL_BYTES) {
    throw new Error("已安装词典包总大小将超过上限（最多 10 MB），请先移除部分词典包");
  }
}

// ---------------------------------------------------------------
// In-memory registry consumed by @jargonslayer/core's dictionary.ts/
// packs.ts (remotePacksRegistry.ts) — loadPacksIntoRegistry populates
// it via setLoadedRemotePacks(); scanDictionary reads it via
// getLoadedRemotePacks() with no wiring needed on its side.
// ---------------------------------------------------------------

let registryLoaded = false;
let loadingPromise: Promise<void> | null = null;

/** Populate the in-memory registry from persisted sources. Safe to call
 *  multiple times — subsequent calls are no-ops once loaded, unless
 *  `force` is passed (used after install/remove so the registry picks
 *  up the change immediately). main.ts calls this once, unconditionally,
 *  on panel load — before any scan can plausibly happen. */
export async function loadPacksIntoRegistry(
  force = false,
  store: PacksStore = idbStore,
): Promise<void> {
  if (registryLoaded && !force) return;
  if (loadingPromise && !force) return loadingPromise;

  loadingPromise = (async () => {
    const sources = await readSources(store);
    setLoadedRemotePacks(sources.map((s) => s.pack));
    registryLoaded = true;
  })();
  await loadingPromise;
  loadingPromise = null;
}

// ---------------------------------------------------------------
// Write serialization — mirrors savedLookups.ts's own withWriteLock
// idiom exactly (a module-level promise chain, rejection-swallowing
// tail so one failed mutation never wedges the queue): two
// near-simultaneous installs (or an install racing a remove) could
// otherwise both read the same pre-write sources array and silently
// drop one write.
// ---------------------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();

function withSourcesLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

export interface AddPackSourceResult {
  url: string;
  pack: LoadedRemotePack;
}

/** Validate+persist tail, run inside withSourcesLock so concurrent
 *  installs can't clobber each other's write — the network fetch itself
 *  (addPackSource below) happens OUTSIDE the lock so it doesn't
 *  serialize unrelated slow requests. */
async function installValidatedPack(
  raw: unknown,
  requestedUrl: string,
  finalUrl: string,
  store: PacksStore,
): Promise<LoadedRemotePack> {
  return withSourcesLock(async () => {
    const pack = validateManifest(raw);

    const sources = await readSources(store);
    // Replaces any existing source with the same url OR the same
    // manifest id — "last install wins".
    const others = sources.filter((s) => s.url !== finalUrl && s.pack.id !== pack.id);

    const origin = classifyPackOriginAcrossRedirect(requestedUrl, finalUrl);
    const record: RemotePackSource = { url: finalUrl, requestedUrl, pack, origin };
    const next = [...others, record];
    assertWithinTotalCaps(next);
    await writeSources(next, store);
    await loadPacksIntoRegistry(true, store);

    return pack;
  });
}

/** Fetch, validate, and persist a new pack source from a URL. Replaces
 *  any existing source with the same url or the same manifest id. */
export async function addPackSource(
  url: string,
  store: PacksStore = idbStore,
): Promise<AddPackSourceResult> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error("请输入词典包链接");
  }
  const { raw, finalUrl } = await fetchManifestRaw(trimmedUrl);
  const pack = await installValidatedPack(raw, trimmedUrl, finalUrl, store);
  return { url: finalUrl, pack };
}

/** Remove one installed source — matched on `url` when non-empty
 *  (every installed source here always has one; the empty-url,
 *  file-imported case the web app supports doesn't exist in this app),
 *  else `packId`. Returns whether the removal was actually persisted so
 *  the caller can report honestly instead of always claiming success. */
export async function removePackSource(
  url: string,
  packId: string,
  store: PacksStore = idbStore,
): Promise<boolean> {
  return withSourcesLock(async () => {
    const sources = await readSources(store);
    const next = sources.filter((s) => (url ? s.url !== url : s.pack.id !== packId));
    try {
      await writeSources(next, store);
    } catch (err) {
      // A failed REMOVAL is far lower-stakes than a failed install (the
      // pack just stays installed, visible and retriable) — swallow and
      // report false rather than throwing.
      console.warn("[remotePacks] removePackSource: writeSources failed", err);
      return false;
    }
    await loadPacksIntoRegistry(true, store);
    return true;
  });
}

/** All installed pack sources — `origin` is ALWAYS recomputed here,
 *  never trusted from storage (see RemotePackSource.origin's own doc). */
export async function listPackSources(store: PacksStore = idbStore): Promise<RemotePackSource[]> {
  const sources = await readSources(store);
  return sources.map((s) => ({
    ...s,
    origin: classifyPackOriginAcrossRedirect(s.requestedUrl ?? s.url, s.url),
  }));
}
