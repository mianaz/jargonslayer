// Shared gloss_zh enrichment step, called by all three build-*-pack.mjs
// scripts (Task 2 of the dictpack prototype work). Owner ruling: zh
// glosses must come from an authoritative online source, NOT a machine
// translation.
//
// Method: for each English term, resolve its English Wikipedia article
// (candidate titles supplied by the caller — the curated list's own
// `wikiTitle`/`term`/`label`, in the order the caller wants them tried),
// follow that article's interwiki link to the Chinese Wikipedia article,
// and take the zh article's lead paragraph as gloss_zh. Real human-
// written CC BY-SA text, cited (zh title + URL recorded per term) — not
// a translation of the English gloss_en.
//
// If no candidate title resolves to a real (non-disambiguation) English
// article, or that article has no zh interwiki link, or the zh article
// has no extractable lead text: the term is FLAGGED and left for the
// caller to keep its placeholder gloss_zh. Never invented, never
// machine-translated as a fallback — see task brief.
//
// All network access goes through wiki-api.mjs's cachedGet, so this
// whole step is reproducible offline once data/wiki-api-cache.json is
// populated (same --refresh convention as the rest of scripts/dictpacks).

import { resolveArticle, fetchZhLanglink, wikiArticleUrl, stripMathArtifacts } from "./wiki-api.mjs";

// Same clamp the app's own validator applies (apps/web/src/lib/detect/
// remotePacks.ts MAX_ZH_LEN) — trimmed here at a clause boundary rather
// than relying on the app's blunt mid-string slice.
const MAX_ZH_LEN = 60;

function normalizeWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

// A zh Wikipedia lead almost always opens "术语（英语：Foo，Bar）是……" —
// naming the term and its English/alt names in a parenthetical aside
// ("术语（英语：Foo，又译作Bar）是……") BEFORE the actual defining clause.
// A first version of this clamp cut the RAW sentence (parens still in
// place) at MAX_ZH_LEN, which broke two ways on a second review pass
// across all three packs' shipped output (~16+ instances): (1) the cut
// landing INSIDE that aside left a dangling "术语（英语：Foo…" with no
// closing bracket; (2) even after fixing the bracket, a long alt-name
// list ("邏輯斯諦迴歸（英语：…，又译作…、…、…、…）") ate the ENTIRE
// character budget before the real "是……" clause even started, so the
// result was a real-but-empty naming clause. Fix: strip every balanced
// parenthetical aside FIRST, so the character budget measures actual
// Chinese defining prose, not English/alt-name clutter — the aside
// itself isn't worth the space in a 60-char excerpt anyway.
function stripParentheticals(s) {
  return s.replace(/（[^（）]*）/g, "").replace(/\([^()]*\)/g, "").replace(/\s+/g, " ").trim();
}

// A stray, never-closed （/( can still remain (e.g. the source's own
// prose is missing a closing bracket, or a bracket happens to sit right
// at the clause-boundary cut point) — walks the string tracking depth
// and cuts back to the start of whichever group never closed, so a
// dangling "（英语：Foo" never ships.
function trimUnbalancedParen(s) {
  let depth = 0;
  let unclosedStart = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "（" || c === "(") {
      if (depth === 0) unclosedStart = i;
      depth++;
    } else if (c === "）" || c === ")") {
      depth = Math.max(0, depth - 1);
    }
  }
  return depth > 0 && unclosedStart !== null ? s.slice(0, unclosedStart).trimEnd() : s;
}

// Stripping parentheticals fixes the common case, but a term-naming
// clause can still be all that's left without any parens at all (e.g.
// "支持向量机在机器学习中" — a lead-in phrase plus the bare name, no
// predicate) — a char-count floor alone doesn't catch this. Requires a
// defining verb/pattern to actually appear (是/指/为/用于/用来/定义/属于
// — covers this corpus's actual lead-sentence shapes: "X是……"/"X指……"/
// "X用于……"/"X定义了……"/"X属于……", checked against every shipped gloss
// before this fix). "又称"/"或称" (pure alt-naming) deliberately do NOT
// count on their own.
// ponytail: a keyword check, not real parsing — good enough here;
// revisit only if the validator passes turn up more of either failure
// mode.
const MIN_DEFINITION_CHARS = 6;
function hasRealDefinition(s) {
  const bare = s.replace(/[，,、：:；;\s]/g, "");
  return bare.length >= MIN_DEFINITION_CHARS && /是|指|为|用于|用来|定义|属于/.test(s);
}

// Take the first sentence (ending in 。！？ or, failing that, the whole
// extract), strip parenthetical asides, then clamp to MAX_ZH_LEN
// characters at the nearest clause punctuation (，、,) at or before the
// cap rather than cutting mid-word/mid-clause. Mirrors the
// truncate()/firstChunk() helpers in the two existing build scripts,
// adapted for Chinese punctuation. Returns "" (caller keeps the
// placeholder) if what's left after cleanup isn't an actual definition
// — see stripParentheticals/trimUnbalancedParen/hasRealDefinition above.
function clampZhGloss(rawExtract) {
  const text = normalizeWhitespace(stripMathArtifacts(rawExtract));
  if (!text) return "";

  const sentenceMatch = text.match(/^[\s\S]*?[。！？]/);
  let rawSentence = sentenceMatch ? sentenceMatch[0] : text;
  // Drop the trailing full stop — matches this codebase's house style
  // for gloss/explanation strings (see dictionary-data.ts entries),
  // which don't carry a trailing 。.
  rawSentence = rawSentence.replace(/[。]$/, "");
  const sentence = stripParentheticals(rawSentence) || rawSentence;

  if (sentence.length <= MAX_ZH_LEN) {
    // Not a clamp-induced cut (this is the genuine, complete first
    // sentence) — but a lead whose first "sentence" is nothing but the
    // term-naming clause (e.g. "四分位距（英语：IQR）" with the actual
    // definition starting only in the next sentence) is just as useless
    // a gloss as a mid-parenthetical truncation; same check applies.
    return hasRealDefinition(sentence) ? sentence : "";
  }

  const cut = sentence.slice(0, MAX_ZH_LEN);
  // A clause-boundary cut is only accepted if it falls at least
  // halfway into the window — a boundary earlier than that throws away
  // most of the excerpt for little gain (e.g. "在统计学中，[50+ chars
  // with no further comma before the cap]" has its only "，" at index
  // 6, which would otherwise clamp the whole gloss down to "在统计学
  // 中…" — caught by hand-checking ml-stats's output before shipping).
  // Below that threshold, prefer a hard cut at MAX_ZH_LEN over a
  // technically-real but far-too-early clause break.
  const minAcceptablePos = MAX_ZH_LEN / 2;
  // Ideographic clause punctuation (，、) is a real Chinese clause
  // boundary wherever it falls. A bare ASCII space is not — Chinese
  // prose doesn't use spaces between words, so any space in the cut
  // window is almost always internal to an embedded Latin term/acronym
  // (e.g. an extract starting "Peak calling是一种…" has a space after
  // "Peak" at index 4 — treating that as "the" clause boundary cut the
  // gloss down to just "Peak…", also caught by hand-checking before
  // shipping) — held to the same halfway-or-later threshold.
  let cutAt = Math.max(cut.lastIndexOf("，"), cut.lastIndexOf("、"));
  if (cutAt < minAcceptablePos) {
    const spaceCut = Math.max(cut.lastIndexOf(","), cut.lastIndexOf(" "));
    cutAt = spaceCut >= minAcceptablePos ? spaceCut : -1;
  }
  let trimmed = (cutAt > 0 ? cut.slice(0, cutAt) : cut).trimEnd();
  trimmed = trimUnbalancedParen(trimmed).trimEnd();
  // (c) never cut immediately after the bare term name: if trimming the
  // unbalanced parenthetical (or the clause cut itself) left nothing but
  // the naming clause, there's no real definition to ship.
  return hasRealDefinition(trimmed) ? trimmed + "…" : "";
}

/**
 * @param {string[]} candidateEnTitles - English Wikipedia titles to try,
 *   in order (first confident, non-disambiguation match wins).
 * @returns {Promise<
 *   | { ok: true, gloss_zh: string, zh_title: string, zh_url: string,
 *       en_title: string, en_url: string, zh_extract_full: string }
 *   | { ok: false, reason: string }
 * >}
 */
export async function enrichOneTerm(candidateEnTitles) {
  const tried = [];
  for (const candidate of candidateEnTitles.filter(Boolean)) {
    if (tried.includes(candidate)) continue;
    tried.push(candidate);

    const enArticle = await resolveArticle(candidate, { lang: "en" });
    if (!enArticle) continue; // missing or disambiguation — try next candidate

    const zhTitle = await fetchZhLanglink(enArticle.title);
    if (!zhTitle) {
      // A REAL (non-disambiguation) English article exists for this
      // candidate — almost certainly the right topic, especially for
      // deriveEnCandidates' deliberately-ordered, more-specific-first
      // candidates. It simply has no Chinese counterpart. Do NOT fall
      // through to a later, less specific/more generic candidate here:
      // that was the exact shape of two real bugs caught by hand
      // before shipping — "stochastic gradient descent" (no zh link)
      // falling through to the bare acronym candidate "SGD", which
      // resolved to the unrelated "Singapore dollar" article (SGD is
      // also a currency code); and "Embedding (machine learning)" (no
      // zh link) falling through to bare "Embedding", which resolved
      // to the unrelated mathematics topic. Only a candidate that
      // FAILS to resolve at all (missing/disambiguation, above) is
      // safe to move past — a confident real match that merely lacks
      // translation should end the search, not degrade to a riskier
      // guess.
      return {
        ok: false,
        reason: `candidate "${candidate}" resolved to English Wikipedia article "${enArticle.title}" but it has no zh interwiki link`,
      };
    }

    const zhArticle = await resolveArticle(zhTitle, { lang: "zh", withExtract: true });
    if (!zhArticle || !zhArticle.extract) {
      return {
        ok: false,
        reason: `candidate "${candidate}" -> en:"${enArticle.title}" -> zh:"${zhTitle}" had no extractable zh lead text`,
      };
    }

    const gloss_zh = clampZhGloss(zhArticle.extract);
    if (!gloss_zh) {
      return {
        ok: false,
        reason: `candidate "${candidate}" -> en:"${enArticle.title}" -> zh:"${zhArticle.title}" had no usable definition after clamping (empty lead, or nothing left but the term-naming clause)`,
      };
    }

    return {
      ok: true,
      gloss_zh,
      zh_title: zhArticle.title,
      zh_url: wikiArticleUrl(zhArticle.title, "zh"),
      en_title: enArticle.title,
      en_url: wikiArticleUrl(enArticle.title, "en"),
      zh_extract_full: normalizeWhitespace(zhArticle.extract),
    };
  }

  return {
    ok: false,
    reason:
      tried.length === 0
        ? "no candidate English Wikipedia title supplied"
        : `no candidate resolved to a real (non-disambiguation) English Wikipedia article: ${tried.join(", ")}`,
  };
}

/**
 * Derive candidate English Wikipedia titles for a curated term that has
 * no wikilink of its own on its source page (build-ml-pack.mjs's Google
 * ML Glossary, build-edam-pack.mjs's EDAM.tsv — unlike build-stats-pack
 * .mjs, which already has the exact enwiki title from its source's own
 * <a href>). Best-effort, ORDER MATTERS (first candidate tried first by
 * enrichOneTerm): a curated entry's own "display term" string is usually
 * the right title, but two shapes need unwrapping first —
 *   - "full phrase (ACRONYM)" (trailing abbreviation, e.g. "stochastic
 *     gradient descent (SGD)") -> try the phrase before the acronym.
 *   - "ACRONYM (full phrase)" (leading acronym, e.g. "PDF (probability
 *     density function)") -> try the phrase INSIDE the parens first —
 *     the bare acronym alone is far more likely to collide with an
 *     unrelated Wikipedia topic/disambiguation page.
 * `label` (this pack's own internal lookup key, e.g. Google glossary's
 * kebab-case anchor id) is tried last, lightly cleaned up, as a final
 * fallback candidate.
 *
 * This is a heuristic, not a manual per-term mapping — every resolved
 * en_title actually used is recorded in provenance specifically so a
 * human/agent pass can audit for a wrong-topic match (a real risk for
 * short, polysemous terms; see task report).
 */
export function deriveEnCandidates(term, label) {
  const candidates = [];
  const trailingParen = term.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (trailingParen) {
    const base = trailingParen[1].trim();
    const inner = trailingParen[2].trim();
    const baseLooksLikeAcronym = /^[A-Za-z0-9][A-Za-z0-9.\-]*$/.test(base) && base.length <= 8;
    // Only the full descriptive phrase is used — deliberately never
    // the bare acronym half of either shape (whichever side that is).
    // A short acronym looked up on its own is exactly the shape that
    // collided with an unrelated real (non-disambiguation) Wikipedia
    // article before shipping: "SGD" -> "Singapore dollar" for
    // "stochastic gradient descent (SGD)". enrichOneTerm no longer
    // falls through past a confident real match anyway (see its doc
    // comment), so a risky acronym candidate would actively cost a
    // correct match rather than merely being redundant.
    candidates.push(baseLooksLikeAcronym && inner.includes(" ") ? inner : base);
  } else {
    // Disambiguated-qualifier candidate tried BEFORE the bare term:
    // for a short/generic English word (e.g. "attention", "embedding",
    // "prior", "temperature"), Wikipedia's unqualified article is
    // often a different, unrelated but very real (so not caught by
    // resolveArticle's disambiguation check) general topic — caught
    // by hand-checking these before shipping ("attention" -> the
    // psychology topic; "embedding" -> a mathematics topic). Harmless
    // for the many unambiguous multi-word terms: the qualified guess
    // just fails to resolve and falls through to the bare term.
    candidates.push(`${term} (machine learning)`, term);
  }

  if (label) {
    const words = label.replace(/[()]/g, "").split(/[-\s]+/).filter(Boolean);
    const termLower = term.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (words.length > 1) {
      if (words[words.length - 1].toLowerCase() === termLower) words.pop();
      else if (words[0].toLowerCase() === termLower) words.shift();
      const phrase = words.join(" ");
      if (phrase) candidates.push(phrase);
    } else if (words.length === 1 && words[0].toLowerCase() !== termLower) {
      candidates.push(words[0]);
    }
  }

  // A bare acronym/short-code term with no space of its own (e.g. "SAM",
  // "BAM", "BED" — file-format headwords from build-edam-pack.mjs's
  // curated list) is checked last: in practice these are almost always
  // Wikipedia disambiguation pages (correctly skipped by resolveArticle
  // already), so trying the plain acronym before this fallback hasn't
  // shown the same wrong-topic risk the ML pack's bare English words
  // did — but it's still the least specific candidate, so it stays
  // last. "X (file format)" is a common enough disambiguation
  // convention on Wikipedia to be worth trying (cheap and safe: if the
  // page doesn't exist it just fails to resolve, same as now).
  if (!term.includes(" ") && !term.includes("(")) {
    candidates.push(`${term} (file format)`);
  }

  const seen = new Set();
  return candidates.filter((c) => {
    const k = c.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
