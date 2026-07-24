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
// Exported (adversarial review fix round) so callers that need to
// pre-check BEFORE buffering untrusted content into memory can reuse
// the same numbers instead of hand-duplicating them: SettingsDialog's
// file-picker handler checks File.size before file.text() (N4a), and
// autoExport.ts's restore caps the number of pack rows it will attempt
// (M3).
export const MAX_PACK_BYTES = 2 * 1024 * 1024; // 2 MB per manifest
const MAX_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB across all installed packs
export const MAX_PACK_COUNT = 20;

// N3 fix (adversarial review): total candidate-surface budget (headword
// + variants, expressions + terms combined) for a single manifest —
// bounds scanDictionary's regex-compile cost independent of the byte-
// size/entry-count caps above, which don't account for variant fan-out
// (a legal sub-2MB pack could otherwise carry hundreds of thousands of
// short repeated variants). ~20x the largest existing built-in compiled
// pack (~226 terms, dictionary-packs-compiled.ts) — generous for a real
// pack, tight enough to keep worst-case regex compiles bounded even
// across all MAX_PACK_COUNT installed packs at once.
const MAX_PACK_SURFACES = 5000;

// L4/N5 fix (adversarial review): name/description were the only two
// v2-adjacent display fields with no length clamp at all.
const MAX_NAME_LEN = 80;
const MAX_DESCRIPTION_LEN = 200;

// H3 fix (adversarial review): a manifest id of "__proto__"/
// "constructor"/"prototype" turns any plain-object lookup keyed by pack
// id (e.g. SettingsDialog's packEntryCounts[p.id]) into a prototype
// access instead of a real miss, crashing the render ("Objects are not
// valid as a React child") with no in-app recovery (the only removal UI
// lives inside the section that throws). Mirrors (not imports —
// remotePacks.ts must stay a one-way dependency FROM autoExport.ts, see
// that file's own header) DANGEROUS_OBJECT_KEYS in
// apps/web/src/lib/history/autoExport.ts.
const DANGEROUS_MANIFEST_IDS = new Set(["__proto__", "constructor", "prototype"]);

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
  // N3 fix (adversarial review): capped at install (validateExpressions,
  // via clampExpressionVariants): <=8 items, <=60 chars each, deduped
  // case-insensitively.
  variants?: string[];
  category?: ExpressionCategory;
  meaning?: string;
  chinese_explanation: string;
  plain_english?: string;
  tone?: string;
  confidence?: number;
  pack?: string; // ignored on import — always overwritten with the manifest's own id (see validateExpressions)
}

// v0.6 multi-sense-terms sprint (NOT the "v0.6 T1-T6" labels used
// elsewhere in this file, which name the earlier/unrelated remote-
// packs sprint — variants, commonWord, manifest v2, size caps, catalog
// browse): a community pack term MAY declare `senses` (RemotePackTerm.
// senses below), mirroring DictSense (@jargonslayer/core/detect/
// dictionary-data.ts) on the wire. Validated by clampSenses below —
// same lenient-drop posture as every other field in this module: a
// malformed SENSE is dropped, never the whole term/pack.
export interface RemotePackSense {
  senseId?: string; // optional on the wire — generated from index if absent
  gloss_en: string;
  gloss_zh: string;
  type?: TermType;
  domain: DomainTag;
  prior?: number; // optional on the wire — defaults to 0.5
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
  // v0.6 multi-sense-terms sprint (see RemotePackSense's own doc just
  // above): <=6 items, each validated like a term itself (clampSenses).
  senses?: RemotePackSense[];
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
  // N2 fix (adversarial review): the url actually REQUESTED for the
  // fetch that produced `url` above (which is the FINAL, post-redirect
  // url — see fetchManifestRaw/installValidatedPack) — only meaningfully
  // different from `url` after a redirect; equal to it otherwise (and
  // absent for a file-imported pack). Stored so listPackSources below
  // can re-derive the SAME "official requires BOTH ends to classify
  // official" judgment on every read, not just once at install time —
  // without this, `url` alone (the redirect TARGET) would be all a
  // later read has to go on, silently re-legitimizing a non-official
  // request that happened to redirect onto the official host. This is
  // raw INPUT data, not a trust judgment — classifyPackOriginAcrossRedirect
  // still only ever recomputes "official" when BOTH this field and
  // `url` independently classify official, so a hand-edited value here
  // can only ever make the classification MORE conservative
  // ("imported"), never forge "official".
  requestedUrl?: string;
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

// N5 fix (adversarial review): bidi/zero-width control characters
// (RLO/PDF/bidi isolates/zero-width chars) stripped from name/
// description ONLY — the two fields SettingsDialog renders directly
// adjacent to the 官方/已导入 provenance badge. Without this, an
// imported pack's name could visually reorder or hide that badge, or
// splice in a fake "官方" substring next to it. Every other free-text
// field below is untouched (not a blanket sanitizer — scoped to the
// one badge-adjacent display; SettingsDialog also wraps the rendered
// name in <bdi> as a second, independent layer of defense).
const BIDI_CONTROL_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function stripBidiControls(s: string): string {
  return s.replace(BIDI_CONTROL_RE, "");
}

/** Like clampStr, but also strips bidi/zero-width control characters
 *  first (see BIDI_CONTROL_RE's own doc) — used only for name/
 *  description (L4/N5). A value that's PURELY control characters
 *  collapses to undefined, same as an empty/whitespace-only value. */
function clampDisplayStr(v: unknown, max: number): string | undefined {
  if (!isNonEmptyString(v)) return undefined;
  const cleaned = stripBidiControls(v).trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
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
 *  variants' own handling (clampExpressionVariants below) — a term
 *  headword's case sensitivity is load-bearing (an ALL-CAPS acronym
 *  matches case-sensitively), so this dedupes case-SENSITIVELY. */
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

/** Term senses (v0.6 multi-sense-terms sprint — NOT the "v0.6 T1-T6"
 *  labels used elsewhere in this file, which name the earlier/unrelated
 *  remote-packs sprint): <=6 items; each validated like a term itself —
 *  non-empty gloss_en/gloss_zh required or the SENSE is dropped (not the
 *  whole term); `domain` must be a recognized DomainTag (DOMAIN_TAGS) or
 *  the sense is dropped; `prior` clamped 0..1, defaulting 0.5; `senseId`
 *  clamped to <=40 chars, generated from the sense's own index when
 *  absent/empty. A malformed sense is dropped, never fatal — same
 *  lenient-drop posture as every other field in this module. */
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

/** Expression variants (N3 fix, adversarial review) — used to be fully
 *  uncapped (predating clampTermVariants above); a legal sub-2MB pack
 *  could carry hundreds of thousands of short repeated variants,
 *  meaning hundreds of thousands of regex compiles per scanDictionary
 *  call (M4's cache mitigates the ongoing per-scan cost but does not
 *  bound the input). Same <=8 items/<=60 chars/trimmed/non-empty caps
 *  as clampTermVariants, but deduped CASE-INSENSITIVELY: an expression
 *  match is already case-insensitive at match time (buildExpressionRegex
 *  always builds an "i"-flagged regex), so "Ship It"/"ship it" are the
 *  same surface here, unlike a term headword's own case-sensitive
 *  all-caps rule. NOTE: this is a behavior change for any
 *  already-published v1 pack with >8 expression variants — accepted
 *  trade-off for bounding the DoS surface. */
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

/** Tiny semver-ish comparator (T1) — good enough for plain "x.y.z"
 *  strings (no pre-release/build metadata support, which neither this
 *  app's own package.json version nor any dict-pack's minAppVersion has
 *  ever used). Positive when `a` > `b`, matching Array.prototype.sort's
 *  comparator convention. Missing/non-numeric parts compare as 0, so
 *  e.g. "0.6" vs "0.6.0" compare equal. No new dependency (per T1).
 *  Exported (N6, adversarial review) so SettingsDialog's 词典库 catalog
 *  安装/已安装/更新 comparison can reuse the SAME real ordering instead of
 *  `String(a) === String(b)`, which would present a semver-older
 *  catalog entry as an "update". */
export function compareSemver(a: string, b: string): number {
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
    const variants = clampExpressionVariants(e.variants);
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
      // v0.6 multi-sense-terms sprint — see clampSenses' own doc above.
      // NOTE: this does NOT enforce T1's core-package invariant
      // (senses[0].gloss_en/gloss_zh === the entry's own top-level
      // fields above) — a community pack author can legally submit a
      // sense[0] that diverges from the top-level gloss; scanDictionary
      // always re-ranks from `senses` when present regardless, so the
      // only consumer that would ever observe the mismatch (a caller
      // reading top-level gloss_en/gloss_zh WITHOUT looking at `senses`
      // at all) simply sees whatever this pack's own top-level fields
      // say, same as any other term.
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
 *  pack id; content exceeds the surface budget; or — T1 —
 *  minAppVersion is newer than this app) — per-entry problems and
 *  every other v2 field are dropped, not fatal. */
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

  const id = m.id.trim();

  // H3 fix: see DANGEROUS_MANIFEST_IDS' own doc above.
  if (DANGEROUS_MANIFEST_IDS.has(id)) {
    throw new Error("词典包 id 不合法（不能使用 __proto__ / constructor / prototype）");
  }
  // H4 fix: an id colliding with a BUILT-IN pack id (e.g. "core") makes
  // isPackEnabled() treat it as permanently-on, and SettingsDialog's own
  // toggle list filters built-in ids out of the remote-pack section
  // entirely — no row, no badge, no toggle, always fires, plus a
  // duplicate React key against the real built-in row. PACKS is
  // @jargonslayer/core's own source of truth, never hand-duplicated
  // here.
  if (PACKS.some((p) => p.id === id)) {
    throw new Error(`词典包 id 与内置词典包冲突（"${id}"），请更换 id`);
  }

  // T1 — everything else in this function is lenient (drop, don't
  // fail), but installing a pack this app version genuinely can't
  // support correctly would be a silent-breakage trap rather than a
  // helpful pack. Checked before building the return value below so a
  // too-old app refuses cleanly.
  //
  // N6 (adversarial review): compareSemver is REAL semver ordering, not
  // a string compare — this gate gets TIGHTER as APP_VERSION
  // (package.json) climbs across releases, so a catalog pack declaring
  // the upcoming release's own version as its floor would be refused by
  // that very release if published even slightly ahead of the version
  // bump landing. Bump package.json's version as a deliberate release
  // step, not incidentally while iterating on packs.
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
  // N3 fix: total candidate-surface budget — see MAX_PACK_SURFACES' own
  // doc above.
  const totalSurfaces =
    expressions.reduce((n, e) => n + 1 + (e.variants?.length ?? 0), 0) +
    terms.reduce((n, t) => n + 1 + (t.variants?.length ?? 0), 0);
  if (totalSurfaces > MAX_PACK_SURFACES) {
    throw new Error(`词典包内容过多：单个词典包最多包含 ${MAX_PACK_SURFACES} 个匹配项（含变体）`);
  }

  return {
    id,
    name,
    // N5/L4 fix: was unclamped + un-stripped — see clampDisplayStr's
    // own doc above.
    description: clampDisplayStr(m.description, MAX_DESCRIPTION_LEN),
    version: m.version,
    expressions,
    terms,
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

// B1 fix (BLOCK, adversarial review): the path-PREFIX check alone
// constrains the repo but not the git REF — GitHub forks share one
// object store with upstream (Cross-Fork Object Reference), so a commit
// pushed to ANY fork is fetchable through the UPSTREAM path
// (raw.githubusercontent.com/mianaz/jargonslayer-dicts/<fork-sha>/…),
// classifying "official" and rendering 官方 for attacker-controlled
// content. isOfficialRawRef/isOfficialJsdelivrRef below constrain the
// ref itself to a small allowlisted shape — a branch name ("main"), the
// fully-qualified form ("refs/heads/main"), or a release tag
// ("v<semver>") — and explicitly reject everything else, including a
// 40-hex commit SHA and any refs/pull/… path.
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

/** T4 (B1-fixed): classify a pack SOURCE's provenance from its url.
 *  "official" iff the url parses (new URL()), is https:, carries no
 *  userinfo (username/password), its origin+path-prefix match one of
 *  the two blessed mianaz/jargonslayer-dicts hosting shapes below, AND
 *  (B1) the ref portion of the path is one of the allowlisted shapes
 *  (isOfficialRawRef/isOfficialJsdelivrRef above) — everything else,
 *  including a lookalike host (raw.githubusercontent.com.evil.com), a
 *  credentialed URL, an http:// downgrade, a near-miss path
 *  (/mianaz/jargonslayer-dicts-evil/), a 40-hex commit SHA (reachable
 *  through the upstream path from ANY fork — Cross-Fork Object
 *  Reference), a refs/pull/… ref, or a file-imported pack (no url —
 *  pass ""), is "imported". Exported so UI can render an
 *  "official"/"imported" badge; see RemotePackSource.origin's own doc
 *  for why this must be recomputed on every read rather than trusted
 *  from storage. */
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
  if (u.origin === OFFICIAL_JSDELIVR_ORIGIN && u.pathname.startsWith(OFFICIAL_JSDELIVR_PATH_PREFIX)) {
    const rest = u.pathname.slice(OFFICIAL_JSDELIVR_PATH_PREFIX.length);
    if (isOfficialJsdelivrRef(rest)) return "official";
  }
  return "imported";
}

/** N2 fix (adversarial review): fetch() follows redirects by default,
 *  but a naive implementation classifies/persists the ORIGINALLY
 *  REQUESTED url — a redirect off the official host (or a non-official
 *  url that happens to redirect onto it) would silently mis-tag
 *  provenance either way. "official" requires BOTH the requested and
 *  the actually-served (post-redirect) url to independently classify
 *  official. */
function classifyPackOriginAcrossRedirect(requestedUrl: string, finalUrl: string): PackOrigin {
  if (classifyPackOrigin(requestedUrl) !== "official") return "imported";
  if (classifyPackOrigin(finalUrl) !== "official") return "imported";
  return "official";
}

/** N1 fix (adversarial review): https-only, no embedded credentials —
 *  the one gate every network-fetching entry point (fetchManifestRaw
 *  below) and every backup-restore entry point (autoExport.ts's
 *  sanitizeRestoredPackSource) must agree on. Before this fix the gate
 *  lived ONLY in the UI helper (SettingsDialog.tsx's
 *  resolvePackInstallUrl), so a crafted backup file — which calls
 *  addPackSource directly, never through that helper — could carry a
 *  data:/http:/loopback url straight through to fetch(). Pure, no I/O.
 *  Exported so autoExport.ts can apply the identical rule without
 *  duplicating it (that file already imports from this one — a
 *  one-way edge, see its own header comment). */
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

/** M2 fix (adversarial review): checkUpdates used to write its
 *  refetched `next` array without ever re-checking the total caps — 20
 *  legal 400KB packs each publishing a 1.9MB update is a legal-at-
 *  install-time-but-not-anymore 38MB write in one click. Same checks as
 *  assertWithinTotalCaps, but additionally identifies WHICH pack's
 *  refreshed size pushed the total over (there's no single "the pack
 *  you just tried to install" to blame here — every source was
 *  refetched independently) by walking `next` in array order
 *  accumulating byte size; the first entry whose running total exceeds
 *  the cap is the one named in the error. checkUpdates' own caller
 *  (this function's only caller) must NOT persist `next` when this
 *  throws — the previous (already-valid) array stays in storage. */
function assertWithinTotalCapsForUpdate(next: RemotePackSource[]): void {
  if (next.length > MAX_PACK_COUNT) {
    throw new Error(`已安装词典包数量将超过上限（最多 ${MAX_PACK_COUNT} 个），请先移除部分词典包`);
  }
  let running = 0;
  for (const s of next) {
    running += byteSize(s);
    if (running > MAX_TOTAL_BYTES) {
      throw new Error(
        `更新词典包「${s.pack.name}」后总大小将超过上限（最多 10 MB），已保留更新前的版本`,
      );
    }
  }
}

// ---------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------

/** A fetched-but-not-yet-validated manifest, plus the url it was
 *  ACTUALLY served from (N2 fix) — may differ from the requested url
 *  after a redirect; falls back to the requested url when the runtime's
 *  Response doesn't populate `.url` (some test doubles). */
interface FetchedManifest {
  raw: unknown;
  finalUrl: string;
}

/** Fetch + https-only gate (N1) + size-cap-check (T5) + JSON.parse a
 *  manifest URL, WITHOUT validating its shape yet — split out from
 *  fetchManifest so addPackFromManifest (T6, already-parsed input) can
 *  share the exact same downstream validate+install pipeline via
 *  installValidatedPack below, while this half stays URL-fetch-
 *  specific. This is the ONE network chokepoint every url-based caller
 *  (addPackSource, checkUpdates via fetchManifest, and transitively a
 *  backup restore) routes through, so the https-only/no-credentials
 *  gate lives here rather than duplicated per call site. */
async function fetchManifestRaw(url: string): Promise<FetchedManifest> {
  // N1 fix: reject anything that isn't a plain https:// url BEFORE ever
  // calling fetch() — see isAllowedPackUrl's own doc for why this can't
  // live only in the UI (SettingsDialog's resolvePackInstallUrl).
  if (!isAllowedPackUrl(url)) {
    throw new Error("词典包链接必须是不含账号密码的 https 链接");
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    // N7(c) fix: AbortSignal.timeout() rejects with a TimeoutError
    // DOMException, not AbortError — recognizing only AbortError meant
    // this friendlier message never actually showed on a real timeout.
    if (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError")) {
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
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("词典包 JSON 格式无效");
  }
  return { raw, finalUrl: res.url || url };
}

async function fetchManifest(url: string): Promise<{ pack: LoadedRemotePack; finalUrl: string }> {
  const { raw, finalUrl } = await fetchManifestRaw(url);
  return { pack: validateManifest(raw), finalUrl };
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
// M1 fix (adversarial review): every read-modify-write of the
// persisted sources array (install/remove/checkUpdates) is serialized
// behind this module-level promise chain — mirrors store.ts's own
// pendingSecretWrites (see that file's doc for the exact shape/
// rationale: chaining onto whatever's already in flight, rather than
// racing it, is what actually serializes concurrent callers in enqueue
// order). Without this, two installs landing in the same tick (e.g.
// two 词典库 catalog rows, or an install racing checkUpdates' own
// multi-second refetch window) each read the SAME pre-write sources
// array, so the second writeSources() silently clobbers the first. A
// failed operation never blocks the ones queued after it — the chain
// variable itself always resolves.
// ---------------------------------------------------------------

let pendingSourcesOp: Promise<void> = Promise.resolve();

function enqueueSourcesOp<T>(fn: () => Promise<T>): Promise<T> {
  const result = pendingSourcesOp.then(fn);
  pendingSourcesOp = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

export interface AddPackSourceResult {
  url: string;
  pack: LoadedRemotePack;
}

/** Shared install tail for both addPackSource (url) and
 *  addPackFromManifest (file, T6): validate, dedupe against whatever's
 *  already installed, enforce the total/count caps (T5), persist, and
 *  reload the live registry. `requestedUrl`/`finalUrl` are both
 *  undefined for a file-imported pack; for a url install they're the
 *  url the caller asked for and the url actually served (N2 fix —
 *  differ after a redirect), respectively. The whole read-modify-write
 *  runs inside enqueueSourcesOp (M1 fix) so concurrent installs can't
 *  clobber each other. */
async function installValidatedPack(
  raw: unknown,
  requestedUrl: string | undefined,
  finalUrl: string | undefined,
): Promise<LoadedRemotePack> {
  return enqueueSourcesOp(async () => {
    const pack = validateManifest(raw);

    const sources = await readSources();
    // Replaces any existing source with the same url OR the same
    // manifest id — same "last install wins" precedent as before T6.
    // Deliberately NOT `s.url !== finalUrl` on its own: when finalUrl
    // is undefined (a file import), every OTHER file-imported source
    // also has `s.url === undefined`, which would make them all look
    // like "the same url" and evict each other on every new file import.
    const others = sources.filter((s) => {
      if (finalUrl && s.url === finalUrl) return false;
      if (s.pack.id === pack.id) return false;
      return true;
    });

    // N2 fix: official provenance requires BOTH the requested and the
    // actually-served url to independently classify official — see
    // classifyPackOriginAcrossRedirect's own doc. requestedUrl is
    // persisted alongside `url` (RemotePackSource.requestedUrl's own
    // doc) so listPackSources below can re-derive the SAME judgment on
    // every later read, not just once here.
    const origin =
      requestedUrl && finalUrl
        ? classifyPackOriginAcrossRedirect(requestedUrl, finalUrl)
        : classifyPackOrigin("");
    const record: RemotePackSource = finalUrl
      ? { url: finalUrl, requestedUrl, pack, origin }
      : { url: "", pack, importedAt: Date.now(), origin };
    const next = [...others, record];
    assertWithinTotalCaps(next);
    await writeSources(next);
    await loadRemotePacksIntoRegistry(true);

    return pack;
  });
}

/** Fetch, validate, and persist a new pack source from a URL. Replaces
 *  any existing source with the same url or the same manifest id. */
export async function addPackSource(url: string): Promise<AddPackSourceResult> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error("请输入词典包链接");
  }
  const { raw, finalUrl } = await fetchManifestRaw(trimmedUrl);
  const pack = await installValidatedPack(raw, trimmedUrl, finalUrl);
  return { url: finalUrl, pack };
}

/** T6: install a pack from an already-parsed local file, no URL. Runs
 *  the exact same validateManifest + size-cap pipeline addPackSource
 *  does — NEVER throws (mirrors theme/schema.ts's parseTheme
 *  never-throw posture); every failure (junk JSON, a malformed
 *  manifest, an over-cap pack) comes back as `{ok: false, error}`
 *  instead. */
export async function addPackFromManifest(
  rawJson: unknown,
): Promise<{ ok: true; pack: LoadedRemotePack } | { ok: false; error: string }> {
  try {
    if (byteSize(rawJson) > MAX_PACK_BYTES) {
      throw new Error("词典包过大：单个词典包不能超过 2 MB");
    }
    const pack = await installValidatedPack(rawJson, undefined, undefined);
    return { ok: true, pack };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "词典包导入失败" };
  }
}

/** Remove one installed source. N7(d) fix (adversarial review):
 *  discriminated match, not one overloaded string — a NON-EMPTY `url`
 *  identifies a url-backed source, matched ONLY on `s.url`; an empty
 *  `url` (a file-imported pack has none) identifies a source matched
 *  ONLY on `packId`. The old single-string `s.url || s.pack.id`
 *  comparison meant a pack id that happened to textually equal some
 *  OTHER installed source's url (or vice versa) would remove BOTH.
 *  Every installed source's url (when non-empty) and pack id are each
 *  independently unique across the array (install-time dedup — see
 *  installValidatedPack above), so matching on the single field the
 *  caller actually means is always unambiguous. Returns whether the
 *  removal was actually persisted (was `void`) so the caller can toast
 *  honestly instead of always claiming success (N7(b) fix). */
export async function removePackSource(url: string, packId: string): Promise<boolean> {
  return enqueueSourcesOp(async () => {
    const sources = await readSources();
    const next = sources.filter((s) => (url ? s.url !== url : s.pack.id !== packId));
    try {
      await writeSources(next);
    } catch (err) {
      // T5 made writeSources throw instead of swallowing (closing the
      // silent-data-loss hole on INSTALL) — swallow-and-log here
      // instead (writeSources' own pre-T5 behavior): a failed REMOVAL
      // is far lower-stakes than a failed install (the pack just stays
      // installed, visible and retriable, not silent data loss), and
      // this function's return value now lets the caller report the
      // failure honestly (N7(b)) instead of needing to catch a thrown
      // rejection itself.
      console.warn("[remotePacks] removePackSource: writeSources failed", err);
      return false;
    }
    await loadRemotePacksIntoRegistry(true);
    return true;
  });
}

export async function listPackSources(): Promise<RemotePackSource[]> {
  const sources = await readSources();
  // T4: `origin` is ALWAYS recomputed here, never trusted from storage
  // (see RemotePackSource.origin's own doc) — this is the one read
  // site every UI consumer goes through, so recomputing centrally here
  // means no caller has to think about it itself. N2 fix: recomputed
  // via classifyPackOriginAcrossRedirect(requestedUrl, url) rather than
  // classifyPackOrigin(url) alone — `requestedUrl` falls back to `url`
  // itself when absent (a pre-N2 persisted source, or one that was
  // never redirected), which reduces to the exact same single-url
  // classification as before.
  return sources.map((s) => ({
    ...s,
    origin: classifyPackOriginAcrossRedirect(s.requestedUrl ?? s.url, s.url),
  }));
}

/** Refetch every URL-backed installed source; replace the stored
 *  manifest when its version differs from what's persisted. A
 *  file-imported source (T6, no url) is skipped outright — there is
 *  nothing to refetch it from — rather than attempting a fetch and
 *  relying on that failing gracefully. Returns the ids of packs that
 *  were actually updated. Individual fetch failures are logged and
 *  skipped (one broken source shouldn't block the rest). The whole
 *  read-modify-write runs inside enqueueSourcesOp (M1 fix) so this
 *  can't race a concurrent install/removal over its own multi-second
 *  refetch window. */
export async function checkUpdates(): Promise<string[]> {
  return enqueueSourcesOp(async () => {
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
        const { pack: fresh, finalUrl } = await fetchManifest(source.url);
        if (String(fresh.version) !== String(source.pack.version)) {
          updatedIds.push(fresh.id);
          // N2 fix: persist the FINAL (post-redirect) url AND the url
          // this refetch requested it from, classified against BOTH
          // (see RemotePackSource.requestedUrl's own doc for why the
          // latter must be persisted, not just used once here).
          next.push({
            url: finalUrl,
            requestedUrl: source.url,
            pack: fresh,
            origin: classifyPackOriginAcrossRedirect(source.url, finalUrl),
          });
        } else {
          next.push(source);
        }
      } catch (err) {
        console.warn(`[remotePacks] checkUpdates failed for ${source.url}`, err);
        next.push(source);
      }
    }

    // M2 fix: refetched packs can individually grow past what was
    // legal at install time — re-check the total caps BEFORE writing,
    // and keep the previous (already-valid) array on failure rather
    // than persisting an over-cap write.
    assertWithinTotalCapsForUpdate(next);
    await writeSources(next);
    await loadRemotePacksIntoRegistry(true);
    return updatedIds;
  });
}
