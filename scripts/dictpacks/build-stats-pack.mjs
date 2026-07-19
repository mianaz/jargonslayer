// Compiles a classic inferential-statistics jargon pack from Wikipedia's
// "Glossary of probability and statistics" (https://en.wikipedia.org/
// wiki/Glossary_of_probability_and_statistics, CC BY-SA 4.0) into the
// RemotePackManifest JSON shape that apps/web/src/lib/detect/
// remotePacks.ts validates and loads. Third domain pack — fills the gap
// build-ml-pack.mjs documented in its own header: Google's ML Glossary
// has no classic stats vocabulary (p-value, confidence interval, null
// hypothesis, ANOVA, ...). Same design as the other two build-*-pack.mjs
// scripts: curated headword allowlist, fail-loud cross-check against a
// single cached source, per-entry provenance file.
//
// SOURCE LICENSE — verified by hand before writing this script (fetched
// the live page and grepped the footer): "Text is available under the
// Creative Commons Attribution-ShareAlike 4.0 License; additional terms
// may apply." https://creativecommons.org/licenses/by-sa/4.0/
//
// SOURCE QUIRK (read before extending the curated list): as of this
// build, roughly two-thirds of this glossary's ~190 headwords have an
// EMPTY <dd> — the entry is just a wikilink to the term's own dedicated
// article, with no inline prose definition on the glossary page itself
// (Wikipedia's own glossary-maintenance convention: don't duplicate a
// definition that already lives on the linked article). Every one of
// this pack's EMPTY-<dd> entries below (see EMPTY_DD_KNOWN in comments
// near CURATED_TERMS) therefore sources gloss_en from the LINKED
// article's own lead paragraph instead — still Wikipedia CC BY-SA
// prose, still cited (provenance records source_type +
// en_wiki_url for every term either way), never fabricated. Two terms
// this task named as examples are NOT on this glossary page at all
// under any headword — "R-squared" (aka coefficient of determination)
// and "effect size" have no entry here — and "regression coefficient"
// likewise has no entry of its own (only the broader "regression
// analysis" does). None of those three are in CURATED_TERMS; see the
// task report for the honest gap instead of stretching a fail-loud
// label match.
//
// gloss_zh: enriched via enrich-zh.mjs (Task 2) — follows each term's
// English Wikipedia article (the same one already linked by this
// glossary page, no separate guessing needed) to its Chinese Wikipedia
// counterpart and uses that article's lead as gloss_zh. Terms with no
// zh Wikipedia article keep the same honest placeholder the other two
// packs use ("暂无中文释义"), flagged in provenance + run output, never
// machine-translated.
//
// Run: node scripts/dictpacks/build-stats-pack.mjs [--refresh]
// --refresh re-fetches data/wikipedia-stats-glossary.html AND bypasses
// the wiki-api.mjs response cache (otherwise both are read from the
// cached copies in this directory, so the build is reproducible
// offline).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveArticle, flushWikiApiCache, stripMathArtifacts } from "./wiki-api.mjs";
import { enrichOneTerm, enrichOneTermFromZhTitles, loadCuratedZh } from "./enrich-zh.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "data", "wikipedia-stats-glossary.html");
const OUT_DIR = path.join(__dirname, "out");
const GLOSSARY_URL = "https://en.wikipedia.org/wiki/Glossary_of_probability_and_statistics";
const GLOSSARY_LICENSE = "CC BY-SA 4.0";
const GLOSSARY_LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";
const GLOSSARY_CITATION =
  "Wikipedia contributors. Glossary of probability and statistics. Wikipedia, The Free " +
  "Encyclopedia. " +
  GLOSSARY_URL +
  " (CC BY-SA 4.0).";

const GLOSS_ZH_PLACEHOLDER = "暂无中文释义";
const GLOSS_EN_MAX_LEN = 280;

// Built-in dictionary + the two already-built packs, scanned read-only
// at build time for term-string collisions (see checkCollisions below).
const CORE_DICTIONARY_PATH = path.join(
  __dirname,
  "..",
  "..",
  "packages",
  "core",
  "src",
  "detect",
  "dictionary-data.ts",
);
const EDAM_PACK_PATH = path.join(__dirname, "out", "bioinformatics-edam.pack.json");
const ML_PACK_PATH = path.join(__dirname, "out", "ml-stats.pack.json");

// ---------------------------------------------------------------
// Curated allowlist: label = the glossary's exact anchor `id`
// (case-preserving, e.g. "confidence_interval_(ci)") — stable lookup
// key, same convention as build-ml-pack.mjs's Google-glossary ids.
// term  = display form shown in the app.
// type  = TermType from packages/core/src/types.ts.
//
// NOT included (checked, absent from this glossary under any
// headword — see header comment): R-squared / coefficient of
// determination, effect size, regression coefficient (only the
// broader "regression analysis" entry exists). Also deliberately
// excluded to avoid shipping near-duplicates of ml-stats.pack.json
// entries: PDF/probability density function, CDF, entropy,
// precision/recall/accuracy, outlier detection, selection/
// confirmation bias — the ml-stats pack already covers those (or a
// close variant). "regression analysis" below is a close-but-not-
// identical near-duplicate of ml-stats's "regression"/"linear
// regression"/"logistic regression" entries (different exact term
// string, so the automated collision check won't flag it) — flagged
// here by hand instead, see task report.
const CURATED_TERMS = [
  // ---- hypothesis testing ----
  { term: "p-value", label: "p-value", type: "metric" },
  { term: "null hypothesis", label: "null_hypothesis", type: "other" },
  { term: "alternative hypothesis", label: "alternative_hypothesis", type: "other" },
  { term: "statistical significance", label: "statistical_significance", type: "other" },
  { term: "Type I / Type II error", label: "type_i_and_type_ii_errors", type: "other" },
  { term: "t-test", label: "student's_t-test", type: "tech" },
  { term: "ANOVA", label: "analysis_of_variance", type: "tech" },
  { term: "chi-squared test", label: "chi-squared_test", type: "tech" },
  { term: "statistical power", label: "power", type: "metric" },

  // ---- estimation & intervals ----
  { term: "confidence interval", label: "confidence_interval_(ci)", type: "tech" },
  { term: "confidence level", label: "confidence_level", type: "tech" },
  { term: "estimator", label: "estimator", type: "tech" },
  { term: "maximum likelihood estimation", label: "maximum_likelihood_estimation", type: "tech" },
  { term: "likelihood function", label: "likelihood_function", type: "tech" },
  { term: "degrees of freedom", label: "degrees_of_freedom", type: "other" },

  // ---- Bayesian ----
  { term: "Bayesian inference", label: "bayesian_inference", type: "tech" },
  { term: "prior (probability)", label: "prior_probability", type: "other" },
  { term: "posterior (probability)", label: "posterior_probability", type: "other" },

  // ---- distributions ----
  { term: "normal distribution", label: "normal_distribution", type: "tech" },
  { term: "binomial distribution", label: "binomial_distribution", type: "tech" },
  { term: "chi-squared distribution", label: "chi-squared_distribution", type: "tech" },
  { term: "probability distribution", label: "probability_distribution", type: "tech" },
  { term: "sampling distribution", label: "sampling_distribution", type: "tech" },
  { term: "central limit theorem", label: "central_limit_theorem", type: "other" },
  { term: "law of large numbers", label: "law_of_large_numbers_(lln)", type: "other" },
  { term: "random variable", label: "random_variable", type: "other" },

  // ---- descriptive statistics ----
  { term: "mean", label: "mean", type: "metric" },
  { term: "median", label: "median", type: "metric" },
  { term: "mode (statistics)", label: "mode", type: "metric" },
  { term: "standard deviation", label: "standard_deviation", type: "metric" },
  { term: "standard error", label: "standard_error", type: "metric" },
  { term: "variance", label: "variance", type: "metric" },
  { term: "expected value", label: "expected_value", type: "metric" },
  { term: "range (statistics)", label: "range", type: "metric" },
  { term: "quartile", label: "quartile", type: "metric" },
  { term: "percentile", label: "percentile", type: "metric" },
  { term: "interquartile range (IQR)", label: "interquartile_range_(iqr)", type: "metric" },
  { term: "z-score", label: "standard_score", type: "metric" },
  { term: "skewness", label: "skewness", type: "metric" },
  { term: "kurtosis", label: "kurtosis", type: "metric" },
  // zhDirectTitle override: this glossary's own linked EN article
  // ("Sample mean and covariance") has no zh interwiki link — but zh
  // Wikipedia has a dedicated, on-topic "样本均值" article under a title
  // that just isn't cross-linked back to it (found via the Task 2 zh-
  // Wikipedia retry pass, see a one-off retry pass; content hand-
  // checked before pinning).
  { term: "sample mean", label: "sample_mean", type: "metric", zhDirectTitle: "样本均值" },

  // ---- relationships / study design ----
  { term: "correlation", label: "correlation", type: "metric" },
  { term: "covariance", label: "covariance", type: "metric" },
  { term: "regression analysis", label: "regression_analysis", type: "tech" },
  { term: "confounder", label: "confounder", type: "other" },
  { term: "outlier", label: "outlier", type: "other" },
  { term: "descriptive statistics", label: "descriptive_statistics", type: "other" },
  { term: "statistical inference", label: "statistical_inference", type: "other" },
];

// ---------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------

async function ensureHtml() {
  const refresh = process.argv.includes("--refresh");
  if (!refresh && existsSync(HTML_PATH)) {
    return readFile(HTML_PATH, "utf-8");
  }
  console.log(`Fetching ${GLOSSARY_URL} ...`);
  const res = await fetch(GLOSSARY_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; jargonslayer-dictpack-builder)" },
  });
  if (!res.ok) throw new Error(`Wikipedia glossary fetch failed: ${res.status}`);
  const text = await res.text();
  if (!/Creative Commons Attribution-ShareAlike 4\.0 License/.test(text)) {
    throw new Error(
      "Wikipedia glossary page no longer shows the expected CC BY-SA 4.0 footer notice — " +
        "STOP, do not build against this snapshot until the license is re-verified by hand.",
    );
  }
  await writeFile(HTML_PATH, text, "utf-8");
  return text;
}

// ---------------------------------------------------------------
// Parser — Parsoid-rendered <dl class="glossary"> markup:
//   <dt id="KEBAB-ID"><dfn><a href="//en.wikipedia.org/wiki/Article"
//     title="Article Title">display text</a>[ trailing abbrev]</dfn></dt>
//   [<p class="glossary-hatnote">Also <b>alt name</b>.</p>]  (5 entries
//     on this page carry one of these between dt and dd — "Also
//     confidence coefficient." etc. — MUST be skipped explicitly: an
//     earlier version of this regex let its lazy dtInner group swallow
//     straight through a skipped hatnote into the NEXT entry's dt/dd,
//     silently mislabeling that next entry's real definition under
//     THIS entry's id. Caught by hand-checking confidence_level's
//     output against the live page before shipping — do not remove
//     this clause.)
//   <dd>[definition prose, possibly empty]</dd>
// The <a>'s title attribute is the exact enwiki article title — used
// directly for the zh interwiki lookup (enrich-zh.mjs), no separate
// title-guessing needed since the glossary page already links it.
// ---------------------------------------------------------------

const ENTRY_RE =
  /<dt id="([^"]+)">([\s\S]*?)<\/dt>(?:\s*<p[^>]*class="glossary-hatnote"[\s\S]*?<\/p>)*\s*<dd>([\s\S]*?)<\/dd>/g;
const FIRST_LINK_RE = /<a\b[^>]*\btitle="([^"]+)"[^>]*>/;

function stripHtml(fragment) {
  return stripMathArtifacts(
    fragment
      // Parsoid wraps inline citation markers as <sup class="mw-ref
      // reference">...[3]...</sup> — a plain tag strip below would
      // leave the literal "[3]" glued right onto the end of the
      // preceding sentence with no following space, which broke
      // firstSentenceEnd's boundary detection below (a period glued to
      // "[3]" doesn't look like "followed by whitespace-or-end").
      // Caught by hand-checking "null hypothesis"/"confidence interval"
      // before shipping — drop the whole citation marker instead of
      // just its tags.
      .replace(/<sup\b[^>]*\bclass="[^"]*\breference\b[^"]*"[^>]*>[\s\S]*?<\/sup>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  )
    .replace(/\s+/g, " ")
    .trim();
}

// Abbreviations whose trailing "." is not a sentence boundary — this
// source's prose routinely uses "e.g."/"i.e." parenthetical asides
// mid-sentence (see "confounder"/"null hypothesis" below).
const SENTENCE_ABBREV_RE = /\b(?:e\.g|i\.e|vs|etc)\.$/i;

// Index just past the first real sentence boundary in `text`, or -1 if
// none exists. A "." / "!" / "?" only counts as a boundary when
// followed by whitespace-or-end-of-string (glued punctuation like
// "0.05" isn't one) and isn't a decimal point (digit on both sides) or
// a known abbreviation (above).
function firstSentenceEnd(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "." && c !== "!" && c !== "?") continue;
    const next = text[i + 1];
    if (next !== undefined && next !== " ") continue;
    if (c === "." && /[0-9]/.test(text[i - 1] || "") && /[0-9]/.test(next || "")) continue;
    if (c === "." && SENTENCE_ABBREV_RE.test(text.slice(0, i + 1))) continue;
    return i + 1;
  }
  return -1;
}

// Clamp to the complete FIRST sentence (see firstSentenceEnd above) —
// a gloss that's grammatically whole reads far better than one cut at
// a raw character count. Only falls back to a word-boundary cut + "…"
// when that single sentence itself still exceeds maxLen — rare once
// GLOSS_EN_MAX_LEN is generous (checked by hand against every shipped
// gloss before this fix).
function truncate(text, maxLen) {
  const end = firstSentenceEnd(text);
  const sentence = end === -1 ? text : text.slice(0, end);
  if (sentence.length <= maxLen) return sentence;
  const cut = sentence.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

function parseGlossary(html) {
  const byId = new Map(); // kebab-id -> { id, wikiTitle, definition }
  for (const m of html.matchAll(ENTRY_RE)) {
    const id = m[1];
    const dtInner = m[2];
    const ddInner = m[3];
    const linkMatch = dtInner.match(FIRST_LINK_RE);
    const wikiTitle = linkMatch ? linkMatch[1] : null;
    const definition = stripHtml(ddInner);
    if (!byId.has(id)) {
      byId.set(id, { id, wikiTitle, definition });
    }
  }
  return byId;
}

// Take just the first sentence of a Wikipedia lead extract (plain
// text from the Action API, may run several sentences) — same
// first-sentence convention enrich-zh.mjs uses for gloss_zh, applied
// here to the EN lead-paragraph fallback for empty-<dd> entries. Uses
// the same guarded boundary detection as truncate() above.
function firstSentence(rawText) {
  const text = stripMathArtifacts(rawText).replace(/\s+/g, " ").trim();
  const end = firstSentenceEnd(text);
  return (end === -1 ? text : text.slice(0, end)).trim();
}

// ---------------------------------------------------------------
// Collision check — read-only scan of the built-in dictionary and the
// two already-built packs for exact term-string overlaps. Non-fatal —
// reported so nobody ships a silent dup.
// ---------------------------------------------------------------

async function checkCollisions(statsTerms) {
  const byLower = new Map(statsTerms.map((t) => [t.term.toLowerCase(), t.term]));
  const collisions = [];

  if (existsSync(CORE_DICTIONARY_PATH)) {
    const coreSrc = await readFile(CORE_DICTIONARY_PATH, "utf-8");
    const coreTermRe = /term:\s*"((?:[^"\\]|\\.)*)"/g;
    let cm;
    while ((cm = coreTermRe.exec(coreSrc))) {
      const lower = cm[1].toLowerCase();
      if (byLower.has(lower)) {
        collisions.push({ term: byLower.get(lower), with: "built-in dictionary-data.ts" });
      }
    }
  } else {
    console.warn(`[warn] collision check skipped — not found: ${CORE_DICTIONARY_PATH}`);
  }

  for (const [packPath, label] of [
    [EDAM_PACK_PATH, "bioinformatics-edam pack"],
    [ML_PACK_PATH, "ml-stats pack"],
  ]) {
    if (existsSync(packPath)) {
      const pack = JSON.parse(await readFile(packPath, "utf-8"));
      for (const t of pack.terms ?? []) {
        const lower = t.term.toLowerCase();
        if (byLower.has(lower)) {
          collisions.push({ term: byLower.get(lower), with: label });
        }
      }
    } else {
      console.warn(`[warn] collision check skipped — not found: ${packPath}`);
    }
  }

  return collisions;
}

// ---------------------------------------------------------------
// Build
// ---------------------------------------------------------------

async function main() {
  const html = await ensureHtml();
  const glossary = parseGlossary(html);

  const terms = [];
  const provenance = [];
  const errors = [];
  const zhFlagged = [];

  for (const entry of CURATED_TERMS) {
    const found = glossary.get(entry.label);
    if (!found) {
      errors.push(`No Wikipedia glossary entry found for id "${entry.label}" (term "${entry.term}")`);
      continue;
    }
    // A handful of entries (e.g. "confidence level") are plain-text
    // <dfn> with no wikilink of their own — the glossary covers them
    // as an aside on a sibling entry's article instead. Not fatal on
    // its own as long as the glossary <dd> itself has prose; only
    // fatal in combination with an empty <dd> (nothing to source
    // gloss_en from at all, see below).
    if (!found.wikiTitle && !found.definition) {
      errors.push(
        `Entry "${entry.label}" (term "${entry.term}") has neither a glossary <dd> nor a ` +
          `linked Wikipedia article to fall back to`,
      );
      continue;
    }

    let gloss_en = found.definition;
    let sourceType = "glossary-inline";
    if (!gloss_en) {
      // Empty <dd> — follow the term's own wikilink and use its lead
      // paragraph instead (see header comment). Fail loud if even
      // that comes up empty — a curated label must resolve to real
      // prose by one path or the other, not silently drop.
      const article = await resolveArticle(found.wikiTitle, { lang: "en", withExtract: true });
      if (!article || !article.extract) {
        errors.push(
          `Entry "${entry.label}" (term "${entry.term}") has an empty glossary <dd> AND its ` +
            `linked article "${found.wikiTitle}" had no extractable lead paragraph`,
        );
        continue;
      }
      gloss_en = firstSentence(article.extract);
      sourceType = "linked-article-lead";
    }

    // zhDirectTitle/zhTitle: Task 2 zh-Wikipedia retry overrides (see
    // a one-off retry pass) — a hand-checked direct zh title or a
    // better EN title than this glossary's own linked article. Neither
    // set for most entries, which keep using the glossary's own
    // wikiTitle as before.
    const zh = entry.zhDirectTitle
      ? await enrichOneTermFromZhTitles([entry.zhDirectTitle])
      : entry.zhTitle
        ? await enrichOneTerm([entry.zhTitle])
        : found.wikiTitle
          ? await enrichOneTerm([found.wikiTitle])
          : { ok: false, reason: "term has no dedicated Wikipedia article link on the glossary page" };

    // Task 1 (curated-zh.json): hand-authored, domain-validated (Opus +
    // GPT-5.6-Sol accuracy review) zh glosses. Takes PRECEDENCE over the
    // Wikipedia lookup above: several zh-Wikipedia leads were truncated,
    // wrong-scoped or mis-attributed (e.g. cross-validation, dropout,
    // sample mean, PDB), so a reviewed curated gloss overrides the
    // auto-extracted one. Terms absent from the map fall through to the
    // Wikipedia gloss, then to the placeholder.
    const curated = (await loadCuratedZh())[entry.term] ?? null;

    terms.push({
      term: entry.term,
      type: entry.type,
      gloss_en: truncate(gloss_en, GLOSS_EN_MAX_LEN) || entry.term,
      gloss_zh: curated ? curated.gloss_zh : zh.ok ? zh.gloss_zh : GLOSS_ZH_PLACEHOLDER,
      pack: "stats",
    });

    if (!curated && !zh.ok) zhFlagged.push({ term: entry.term, reason: zh.reason });

    provenance.push({
      term: entry.term,
      source_id: found.id,
      source_type: sourceType,
      en_wiki_title: found.wikiTitle,
      en_wiki_url: found.wikiTitle
        ? `https://en.wikipedia.org/wiki/${encodeURIComponent(found.wikiTitle.replace(/ /g, "_"))}`
        : null,
      definition_en: gloss_en,
      zh: curated
        ? { status: "curated (hand-authored, domain-validated)", note: curated.note }
        : zh.ok
          ? {
              status: "ok",
              zh_wiki_title: zh.zh_title,
              zh_wiki_url: zh.zh_url,
              zh_extract_full: zh.zh_extract_full,
            }
          : { status: "flagged", reason: zh.reason },
    });
  }

  if (errors.length > 0) {
    console.error("Build failed — curated terms didn't resolve cleanly against the glossary:");
    for (const e of errors) console.error(" - " + e);
    process.exit(1);
  }

  const collisions = await checkCollisions(terms);
  await flushWikiApiCache();

  const manifest = {
    id: "stats",
    name: "统计学术语（Wikipedia 概率与统计学词汇表）",
    description:
      "经典推断统计学常用术语，取自 Wikipedia《Glossary of probability and statistics》，填补 " +
      "ml-stats 包（Google ML Glossary）缺失的传统统计学词汇（p 值、置信区间、假设检验等）。中文释义 " +
      "来自对应中文维基百科条目导言（非机器翻译），未收录中文维基条目的术语暂缺中文释义，详见 provenance 文件。",
    version: new Date().toISOString().slice(0, 10), // dated snapshot — the
    // source is a living wiki page with no version number of its own,
    // so the fetch date is the honest version key (same as ml-stats).
    expressions: [],
    terms,
    // Extra fields below aren't read by remotePacks.ts's validateManifest,
    // kept here for human/audit review of source + license.
    license: GLOSSARY_LICENSE,
    licenseUrl: GLOSSARY_LICENSE_URL,
    source: "Wikipedia: Glossary of probability and statistics (en.wikipedia.org)",
    sourceUrl: GLOSSARY_URL,
    citation: GLOSSARY_CITATION,
    compiledAt: new Date().toISOString().slice(0, 10),
    glossZhNote:
      "gloss_zh sourced per-term from the corresponding Chinese Wikipedia article's lead " +
      "paragraph (see enrich-zh.mjs) — real human-written CC BY-SA text, not a machine " +
      `translation. Terms with no zh Wikipedia article keep the placeholder "${GLOSS_ZH_PLACEHOLDER}"; ` +
      "see provenance's per-term zh.status field.",
  };

  await writeFile(
    path.join(OUT_DIR, "stats.pack.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
  await writeFile(
    path.join(OUT_DIR, "stats.provenance.json"),
    JSON.stringify(provenance, null, 2) + "\n",
    "utf-8",
  );

  console.log(`Wrote ${terms.length} terms to out/stats.pack.json`);
  console.log(`Wrote per-entry provenance to out/stats.provenance.json`);

  if (collisions.length > 0) {
    console.warn(`\n[collision report] ${collisions.length} term string(s) shared with existing packs:`);
    for (const c of collisions) console.warn(` - "${c.term}" also present in ${c.with}`);
  } else {
    console.log("\n[collision report] no term-string collisions found against built-in dictionary or other packs.");
  }

  console.log(`\n[gloss_zh report] ${terms.length - zhFlagged.length}/${terms.length} terms got an authoritative zh gloss.`);
  if (zhFlagged.length > 0) {
    console.log(`${zhFlagged.length} flagged (kept placeholder):`);
    for (const f of zhFlagged) console.log(` - "${f.term}": ${f.reason}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
