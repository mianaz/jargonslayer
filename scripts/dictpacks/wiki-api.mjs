// Shared MediaWiki Action API helper — used by build-stats-pack.mjs (to
// fill in English glossary entries whose <dd> is empty, see that file's
// header comment) and by enrich-zh.mjs (to follow an English Wikipedia
// article's interwiki link to its Chinese counterpart for gloss_zh, per
// all three build-*-pack.mjs scripts). One module so the caching +
// license-verification logic isn't copy-pasted three times.
//
// Every response is cached to data/wiki-api-cache.json (single JSON
// dict keyed by request URL) so the build is reproducible offline,
// same --refresh convention as the rest of scripts/dictpacks. Cache
// hits are silent; only genuine network fetches are logged.
//
// LICENSE: both en.wikipedia.org and zh.wikipedia.org serve their
// article text under CC BY-SA 4.0 — verified by hand against the live
// page footer for both (P-value on en, P值 on zh) before writing this
// module: en footer reads "Text is available under the Creative
// Commons Attribution-ShareAlike 4.0 License"; zh footer reads "本站的
// 全部文字在知识共享 署名-相同方式共享 4.0协议之条款下提供" (linking
// Wikipedia:CC_BY-SA_4.0协议文本). The Action API (api.php) serves the
// same article text as the page itself, just pre-parsed — same
// license applies, it is not a separate "API license".

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, "data", "wiki-api-cache.json");
const USER_AGENT =
  "jargonslayer-dictpack-builder/0.1 (prototype, not distributed; contact miana.zeng@gmail.com)";

export const EN_WIKI_LICENSE = "CC BY-SA 4.0";
export const EN_WIKI_LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";

let cache = null;
let cacheDirty = false;
const REFRESH = process.argv.includes("--refresh");

async function loadCache() {
  if (cache) return cache;
  if (!REFRESH && existsSync(CACHE_PATH)) {
    cache = JSON.parse(await readFile(CACHE_PATH, "utf-8"));
  } else {
    cache = {};
  }
  return cache;
}

/** Flush the in-memory cache to disk. Call once at the end of a build
 *  script's main() — every helper below only mutates the in-memory
 *  copy so a single write covers a whole run. */
export async function flushWikiApiCache() {
  if (!cacheDirty) return;
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n", "utf-8");
  cacheDirty = false;
}

let fetchesSinceFlush = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cachedGet(url) {
  const c = await loadCache();
  if (Object.prototype.hasOwnProperty.call(c, url)) {
    return c[url];
  }
  console.log(`  [wiki-api] fetching ${url}`);
  // Anonymous requests to the Action API are rate-limited — this build
  // makes hundreds of them (multiple candidate titles per curated
  // term x 3 packs), so 429s are expected, not exceptional. Retry with
  // backoff (honoring Retry-After when the API sends one) rather than
  // failing the whole build over a transient throttle.
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.status !== 429 || attempt >= 5) break;
    const retryAfterSec = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : 2000 * 2 ** attempt;
    console.log(`  [wiki-api] 429 rate-limited, waiting ${waitMs}ms (attempt ${attempt + 1})`);
    await sleep(waitMs);
  }
  if (!res.ok) throw new Error(`Wikipedia API fetch failed (${res.status}): ${url}`);
  const json = await res.json();
  c[url] = json;
  cacheDirty = true;

  // Flush periodically (not just at the very end) so a mid-run crash —
  // e.g. an unrelated 5xx after minutes of progress — doesn't throw
  // away everything already fetched; the next run resumes from cache.
  fetchesSinceFlush++;
  if (fetchesSinceFlush >= 20) {
    fetchesSinceFlush = 0;
    await flushWikiApiCache();
  }

  // Be a polite anonymous client — a short gap between real (non-cache-
  // hit) requests, well under anything that would meaningfully slow a
  // ~100-term build, but enough to avoid tripping the rate limit again
  // immediately after backing off from one.
  await sleep(150);
  return json;
}

function firstPage(apiResponse) {
  const pages = apiResponse?.query?.pages;
  if (!pages) return null;
  const list = Object.values(pages);
  return list.length > 0 ? list[0] : null;
}

/** Resolve `title` against a wiki's Action API (default en), following
 *  redirects. Returns null if the title doesn't exist or resolves to a
 *  disambiguation page (both treated as "no confident article" by
 *  callers) — otherwise { title, pageid, extract? }. */
export async function resolveArticle(title, { lang = "en", withExtract = false } = {}) {
  const params = new URLSearchParams({
    action: "query",
    titles: title,
    redirects: "1",
    prop: withExtract ? "pageprops|extracts" : "pageprops",
    format: "json",
  });
  if (withExtract) {
    params.set("exintro", "1");
    params.set("explaintext", "1");
    if (lang === "zh") params.set("variant", "zh-cn"); // force Simplified output
  }
  const url = `https://${lang}.wikipedia.org/w/api.php?${params.toString()}`;
  const json = await cachedGet(url);
  const page = firstPage(json);
  if (!page || page.missing !== undefined) return null;
  if (page.pageprops && "disambiguation" in page.pageprops) return null;
  return {
    title: page.title,
    pageid: page.pageid,
    extract: withExtract ? (page.extract ?? "").trim() : undefined,
  };
}

/** Given an English Wikipedia article title, return its Chinese
 *  interwiki title (or null if there isn't one). */
export async function fetchZhLanglink(enTitle) {
  const params = new URLSearchParams({
    action: "query",
    titles: enTitle,
    redirects: "1",
    prop: "langlinks",
    lllang: "zh",
    format: "json",
  });
  const url = `https://en.wikipedia.org/w/api.php?${params.toString()}`;
  const json = await cachedGet(url);
  const page = firstPage(json);
  const link = page?.langlinks?.[0];
  return link ? link["*"] : null;
}

export function wikiArticleUrl(title, lang = "en") {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/** Wikipedia's exintro/explaintext lead extracts render inline <math>
 *  elements as a garbled Unicode/whitespace "visual" layout immediately
 *  followed by the raw TeX source wrapped in "{\displaystyle ...}"
 *  (braces can nest, e.g. "{\displaystyle H_{0}}", so a lazy regex
 *  would stop at the first inner "}" and leave a stray brace behind —
 *  this walks brace depth instead). Neither form is readable prose;
 *  strip the TeX-source half so a stats-heavy gloss excerpt (t-test,
 *  chi-squared, standard deviation, ...) doesn't show raw LaTeX. */
export function stripMathArtifacts(text) {
  const NEEDLE = "{\\displaystyle";
  let out = "";
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(NEEDLE, i);
    if (start === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, start);
    let depth = 0;
    let j = start;
    for (; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    i = j;
  }
  return out;
}
