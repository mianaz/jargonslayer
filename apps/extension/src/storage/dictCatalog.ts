// Extension-side port of apps/web/src/lib/detect/dictCatalog.ts — this
// half has ZERO idb-keyval (or any) dependency in the web original, so
// it's ported verbatim (same behavior, same URLs, same caps) rather
// than reimplemented; see storage/remotePacks.ts's own header for why
// its sibling file (which DOES import idb-keyval) can't just be
// imported directly instead. Fetches the jargonslayer-dicts catalog
// index so the side panel's 词典库 section can render an installable
// list instead of requiring a hand-typed manifest URL.

const FETCH_TIMEOUT_MS = 10_000;
// The catalog is a small index, not pack content — capped far below
// remotePacks.ts's own 2MB per-manifest cap so a hostile/misconfigured
// index can't force an unbounded res.text() buffer.
const MAX_CATALOG_BYTES = 512 * 1024;
// Also bounds how many rows a hostile catalog can force the panel to
// render/keep in memory — generous relative to any real catalog size.
const MAX_CATALOG_ROWS = 200;

/** Both catalog index URLs in ONE place so they're greppable —
 *  raw.githubusercontent.com access from mainland China is unreliable,
 *  so the jsDelivr gh mirror fallback below is required, not optional.
 *  Primary tried first; fallback only on ANY failure of the primary
 *  (see fetchDictCatalog). Same two hosts manifest.config.ts's
 *  host_permissions scopes fetches to. */
export const DICT_CATALOG_URLS = {
  primary: "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/main/index.json",
  fallback: "https://cdn.jsdelivr.net/gh/mianaz/jargonslayer-dicts@main/index.json",
} as const;

export interface CatalogPackEntry {
  id: string;
  name: string;
  description?: string;
  version: string | number;
  entryCount?: number;
  license?: string;
  source?: string;
  tags?: string[];
  url: string;
  noticeUrl?: string;
  bytes?: number;
}

export interface DictCatalog {
  schemaVersion?: number;
  updatedAt?: string;
  packs: CatalogPackEntry[];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Lenient row validation: drop a malformed row, never throw — a
 *  catalog with some broken entries should still show every good one.
 *  id/name/url/version are the only required fields; everything else
 *  is advisory display metadata. */
function validateRow(raw: unknown): CatalogPackEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r.id) || !isNonEmptyString(r.name) || !isNonEmptyString(r.url)) return null;
  if (typeof r.version !== "string" && typeof r.version !== "number") return null;
  return {
    id: r.id.trim(),
    name: r.name.trim(),
    description: isNonEmptyString(r.description) ? r.description.trim() : undefined,
    version: r.version,
    entryCount: typeof r.entryCount === "number" ? r.entryCount : undefined,
    license: isNonEmptyString(r.license) ? r.license.trim() : undefined,
    source: isNonEmptyString(r.source) ? r.source.trim() : undefined,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => isNonEmptyString(t)) : undefined,
    url: r.url.trim(),
    noticeUrl: isNonEmptyString(r.noticeUrl) ? r.noticeUrl.trim() : undefined,
    bytes: typeof r.bytes === "number" ? r.bytes : undefined,
  };
}

/** Fetch + size-cap-check + parse + shape-validate ONE catalog index
 *  url — everything that can go wrong (network error, non-2xx,
 *  oversized response, invalid JSON, or a semantically-broken shape
 *  like `{}`/`[]`/`{packs:"bad"}`) throws, so fetchDictCatalog below can
 *  treat "reachable but garbage" exactly like "unreachable" and fall
 *  back to the mirror instead of silently presenting a bogus empty
 *  catalog as success. Row-level leniency (dropping an individual
 *  malformed row) is unaffected — see validateRow above. */
async function fetchIndex(url: string): Promise<DictCatalog> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`获取词典目录失败（${res.status}）`);
  const text = await res.text();
  if (new TextEncoder().encode(text).length > MAX_CATALOG_BYTES) {
    throw new Error("词典目录过大");
  }
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("词典目录格式不正确");
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.packs)) {
    throw new Error("词典目录格式不正确");
  }
  const packs = r.packs
    .slice(0, MAX_CATALOG_ROWS)
    .map(validateRow)
    .filter((p): p is CatalogPackEntry => p !== null);
  return {
    schemaVersion: typeof r.schemaVersion === "number" ? r.schemaVersion : undefined,
    updatedAt: isNonEmptyString(r.updatedAt) ? r.updatedAt : undefined,
    packs,
  };
}

/** Fetch the catalog index — DICT_CATALOG_URLS.primary first,
 *  DICT_CATALOG_URLS.fallback on ANY failure (timeout, non-2xx, network
 *  error, bad/oversized JSON, or a semantically-invalid shape — see
 *  fetchIndex above). Throws only once BOTH have failed; the caller
 *  (renderPacks.ts, via main.ts) shows one fixed honest-failure message
 *  regardless of the underlying cause. */
export async function fetchDictCatalog(): Promise<DictCatalog> {
  try {
    return await fetchIndex(DICT_CATALOG_URLS.primary);
  } catch {
    return await fetchIndex(DICT_CATALOG_URLS.fallback);
  }
}
