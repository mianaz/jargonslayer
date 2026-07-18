// Compiles a machine-learning / statistics jargon pack from the Google
// Machine Learning Glossary (https://developers.google.com/machine-learning/
// glossary) into the RemotePackManifest JSON shape that apps/web/src/lib/
// detect/remotePacks.ts validates and loads. Second domain pack, built by
// replicating build-edam-pack.mjs's exact design: curated term allowlist,
// fail-loud cross-check against a single cached source, honest gloss_zh
// placeholder, per-entry provenance file.
//
// SOURCE LICENSE — verified by hand before writing this script (fetched the
// live page and grepped the footer, do not take this on faith): the page's
// footer reads "the content of this page is licensed under the Creative
// Commons Attribution 4.0 License [...] and code samples are licensed under
// the Apache 2.0 License." We only take prose glossary definitions (never
// code samples), so CC BY 4.0 is the applicable license. https://
// creativecommons.org/licenses/by/4.0/
//
// COVERAGE GAP (read before extending the curated list): Google's glossary
// is ML-engineering-flavored (TensorFlow/Keras crash-course vocabulary), not
// a general statistics glossary. Classic inferential-stats terms a stats
// class would use — p-value, confidence interval, null hypothesis, standard
// deviation, normal distribution, standardization, ANOVA, t-test — have NO
// entry on this page (confirmed: no `id="p-value"`, no `id="confidence-
// interval"`, etc. in the cached HTML). Two mainstream ML terms are also
// surprisingly absent as their own headword: "transformer" (only appears
// inside "BERT"/"GPT" expansions, not its own entry) and "F1 score" (not
// present at all, only "Character N-gram F-score (ChrF)"). Per the fail-
// loud design below, none of those are in CURATED_TERMS — they are NOT
// silently faked. If a human wants those covered, the honest fix is a
// second source pass (the task's own specified fallback — Wikipedia's
// "Glossary of probability and statistics", CC BY-SA 4.0) merged in later,
// not stretching this source's coverage.
//
// gloss_zh: same placeholder approach as build-edam-pack.mjs — the app's
// validateTerms drops any entry with an empty gloss_zh, but this source is
// English-only and the brief disallows machine-translating a guess. Every
// entry's gloss_zh is the literal placeholder used by the EDAM pack
// ("暂无中文释义"), not a fabricated translation.
//
// Run: node scripts/dictpacks/build-ml-pack.mjs [--refresh]
// --refresh re-fetches data/google-ml-glossary.html from upstream before
// building (otherwise the cached copy in this directory is used, so the
// build is reproducible offline).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flushWikiApiCache } from "./wiki-api.mjs";
import { enrichOneTerm, deriveEnCandidates } from "./enrich-zh.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "data", "google-ml-glossary.html");
const OUT_DIR = path.join(__dirname, "out");
const GLOSSARY_URL = "https://developers.google.com/machine-learning/glossary";
const GLOSSARY_LICENSE = "CC BY 4.0";
const GLOSSARY_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
const GLOSSARY_CITATION =
  "Google. Machine Learning Glossary. Google for Developers. " +
  GLOSSARY_URL +
  " (CC BY 4.0; code samples on that page are Apache 2.0 and are not used here).";

const GLOSS_ZH_PLACEHOLDER = "暂无中文释义";
const GLOSS_EN_MAX_LEN = 180;

// Built-in dictionary + the already-built EDAM pack, scanned read-only at
// build time for term-string collisions (see checkCollisions below). This
// script only ever reads these files — it does not write outside out/.
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

// ---------------------------------------------------------------
// Curated allowlist: Google's glossary runs to 700+ headwords, most of
// them either Google/TensorFlow-internal engineering minutiae (SavedModel,
// tf.keras, TPU Pod variants) or LLM-agent-tooling neologisms (agentic-loop,
// vibe-coding) that wouldn't come up as "jargon" in a bilingual academic
// ML/stats meeting. This is a hand-picked subset of terms that would
// plausibly get said out loud, cross-checked against real glossary entries
// below (build fails loud if a label doesn't resolve, rather than silently
// dropping it).
//
// label = the glossary's exact anchor `id` (kebab-case, stable lookup key —
//         more reliable than the display text, which sometimes wraps
//         mid-phrase across lines for long parenthetical expansions).
// term  = display form shown in the app (stylistic only, same convention as
//         build-edam-pack.mjs's term vs label split).
// type  = TermType from packages/core/src/types.ts.
const CURATED_TERMS = [
  // ---- learning paradigms ----
  { term: "machine learning", label: "machine-learning", type: "other" },
  { term: "supervised learning", label: "supervised-machine-learning", type: "tech" },
  { term: "unsupervised learning", label: "unsupervised-machine-learning", type: "tech" },
  { term: "semi-supervised learning", label: "semi-supervised-learning", type: "tech" },
  { term: "reinforcement learning", label: "reinforcement-learning-rl", type: "tech" },
  { term: "self-supervised learning", label: "self-supervised-learning", type: "tech" },
  { term: "transfer learning", label: "transfer-learning", type: "tech" },
  { term: "few-shot learning", label: "few-shot-learning", type: "tech" },
  { term: "zero-shot learning", label: "zero-shot-learning", type: "tech" },
  { term: "fine-tuning", label: "fine-tuning", type: "tech" },
  { term: "pretraining", label: "pre-training", type: "tech" },

  // ---- model fitting & evaluation setup ----
  { term: "overfitting", label: "overfitting", type: "tech" },
  // no distinct zh article (EN "Underfitting" itself redirects to
  // "Overfitting" — same 過適 article, confirmed by hand); flagged rather than
  // reuse the overfitting gloss for a different term
  { term: "underfitting", label: "underfitting", type: "tech", zhSkip: true },
  // zhSkip: auto-resolution landed on a real-but-wrong-topic EN article
  // ("Machine learning" itself — too broad/generic to be "generalization"
  // specifically; no dedicated "Generalization (learning)" article
  // exists to try instead) — caught by hand-auditing before shipping;
  // kept flagged/placeholder rather than ship a misleadingly broad gloss.
  { term: "generalization", label: "generalization", type: "tech", zhSkip: true },
  { term: "cross-validation", label: "cross-validation", type: "tech" },
  // only a combined "Training, validation, and test data sets" article exists
  // — flagged per owner review rather than reuse one shared gloss for three
  // distinct terms
  { term: "validation set", label: "validation-set", type: "tech", zhSkip: true },
  // see "validation set" above — same combined article, same call
  { term: "test set", label: "test-set", type: "tech", zhSkip: true },
  { term: "imbalanced dataset", label: "imbalanced-dataset", type: "tech" },
  // EN "Data augmentation" article's actual lead is the statistical
  // MLE-from-incomplete-data technique (Tanner–Wong), not the common ML sense
  // (image/text transform augmentation) — confirmed by reading the lead
  // before shipping; no separate ML-specific article exists
  { term: "data augmentation", label: "data-augmentation", type: "tech", zhSkip: true },

  // ---- regression & regularization ----
  // NOTE: "regression" is a genuine, reportable term COLLISION — the
  // built-in business/tech dictionary (packages/core/src/detect/
  // dictionary-data.ts) already has a bare term "regression" meaning
  // software-regression/regression-testing (a reintroduced bug), while this
  // pack's "regression" means the statistical/ML technique. Same string,
  // two unrelated meanings — kept (it's real, load-bearing ML vocabulary),
  // not silently duplicated. See run output / task report.
  { term: "regression", label: "regression-model", type: "tech" },
  { term: "linear regression", label: "linear-regression", type: "tech" },
  { term: "logistic regression", label: "logistic-regression", type: "tech" },
  { term: "regularization", label: "regularization", type: "tech" },
  { term: "dropout", label: "dropout-regularization", type: "tech" },
  { term: "early stopping", label: "early-stopping", type: "tech" },

  // ---- optimization / training internals ----
  { term: "gradient descent", label: "gradient-descent", type: "tech" },
  {
    term: "stochastic gradient descent (SGD)",
    label: "stochastic-gradient-descent-sgd",
    type: "tech",
  },
  { term: "learning rate", label: "learning-rate", type: "tech" },
  { term: "loss function", label: "loss-function", type: "tech" },
  { term: "cross-entropy", label: "cross-entropy", type: "tech" },
  { term: "mean squared error (MSE)", label: "mean-squared-error-mse", type: "metric" },
  { term: "backpropagation", label: "backpropagation", type: "tech" },
  {
    term: "vanishing gradient problem",
    label: "vanishing-gradient-problem",
    type: "tech",
  },
  { term: "batch normalization", label: "batch-normalization", type: "tech" },
  { term: "hyperparameter", label: "hyperparameter", type: "tech" },
  { term: "batch size", label: "batch-size", type: "tech" },
  // no dedicated ML-sense article ("Epoch (machine learning)" does not exist)
  // — auto-resolution's only match is the calendar/historical-era "Epoch",
  // nonsensical here
  { term: "epoch", label: "epoch", type: "tech", zhSkip: true },

  // ---- activation functions ----
  { term: "activation function", label: "activation-function", type: "tech" },
  { term: "sigmoid function", label: "sigmoid-function", type: "tech" },
  { term: "softmax", label: "softmax", type: "tech" },
  { term: "ReLU", label: "rectified-linear-unit-relu", type: "acronym" },

  // ---- architectures ----
  {
    term: "convolutional neural network (CNN)",
    label: "convolutional-neural-network",
    type: "tech",
  },
  { term: "recurrent neural network (RNN)", label: "recurrent-neural-network", type: "tech" },
  { term: "LSTM", label: "long-short-term-memory-lstm", type: "acronym" },
  { term: "deep neural network", label: "deep-neural-network", type: "tech" },
  { term: "autoencoder", label: "autoencoder", type: "tech" },
  { term: "GAN", label: "generative-adversarial-network-gan", type: "acronym" },
  {
    term: "support vector machine (SVM)",
    label: "kernel-support-vector-machines-ksvms",
    type: "tech",
  },
  // auto-resolution's bare "Decision tree" candidate lands on the general
  // decision-theory article, not the ML sense — pin the correct EN article
  // directly (real, has zh interwiki, lead genuinely defines it)
  { term: "decision tree", label: "decision-tree", type: "tech", zhTitle: "Decision tree learning" },
  { term: "random forest", label: "random-forest", type: "tech" },
  { term: "gradient boosting", label: "gradient-boosting", type: "tech" },
  { term: "k-means", label: "k-means", type: "tech" },

  // ---- clustering / ensembles ----
  { term: "clustering", label: "clustering", type: "tech" },
  { term: "ensemble", label: "ensemble", type: "tech" },
  { term: "bagging", label: "bagging", type: "tech" },
  { term: "boosting", label: "boosting", type: "tech" },

  // ---- NLP / LLM ----
  { term: "attention", label: "attention", type: "tech" },
  {
    term: "self-attention",
    label: "self-attention-also-called-self-attention-layer",
    type: "tech",
  },
  { term: "embedding", label: "embedding-vector", type: "tech" },
  { term: "word embedding", label: "word-embedding", type: "tech" },
  { term: "latent space", label: "latent-space", type: "tech" },
  { term: "encoder", label: "encoder", type: "tech" },
  { term: "decoder", label: "decoder", type: "tech" },
  { term: "language model", label: "language-model", type: "tech" },
  { term: "LLM", label: "large-language-model", type: "acronym" },
  { term: "token", label: "token", type: "tech" },
  { term: "tokenizer", label: "tokenizer", type: "tech" },
  { term: "prompt engineering", label: "prompt-engineering", type: "tech" },
  { term: "few-shot prompting", label: "few-shot-prompting", type: "tech" },
  {
    term: "chain-of-thought prompting",
    label: "chain-of-thought-prompting",
    type: "tech",
  },
  // zhSkip: auto-resolution's only real candidate is the bare
  // "Temperature" article — general physics, wrong topic. No dedicated
  // "Temperature (machine learning)" article exists to try instead
  // (checked by hand before shipping). Kept flagged/placeholder rather
  // than ship a wrong-domain gloss.
  { term: "temperature (sampling)", label: "temperature", type: "tech", zhSkip: true },
  { term: "perplexity", label: "perplexity", type: "metric" },

  // ---- evaluation metrics ----
  { term: "precision", label: "precision", type: "metric" },
  { term: "recall", label: "recall", type: "metric" },
  // no dedicated ML-classification-sense article ("Accuracy (machine
  // learning)" does not exist) — auto-resolution's only match is the general
  // metrology "Accuracy and precision"
  { term: "accuracy", label: "accuracy", type: "metric", zhSkip: true },
  { term: "confusion matrix", label: "confusion-matrix", type: "tech" },
  {
    term: "ROC curve",
    label: "roc-receiver-operating-characteristic-curve",
    type: "tech",
  },
  { term: "AUC", label: "auc-area-under-the-roc-curve", type: "acronym" },
  { term: "mAP@k", label: "mean-average-precision-at-k-mapk", type: "metric" },
  { term: "true positive rate (TPR)", label: "true-positive-rate-tpr", type: "metric" },
  { term: "false positive rate (FPR)", label: "false-positive-rate-fpr", type: "metric" },
  { term: "R-squared", label: "r-squared", type: "metric" },
  // no dedicated article — only resolves (via redirect) to the shared
  // "Decision tree learning" page, whose lead describes decision trees
  // generally, not Gini impurity specifically
  { term: "Gini impurity", label: "gini-impurity", type: "metric", zhSkip: true },
  // the correct-topic EN article ("Information gain (decision tree)") is real
  // but has no zh interwiki link — auto-resolution's fallback landed on the
  // unrelated "Kullback–Leibler divergence" instead, now suppressed
  { term: "information gain", label: "information-gain", type: "metric", zhSkip: true },
  // auto-resolution's bare "entropy" candidate lands on the
  // thermodynamic-entropy article — pin the correct information-theory EN
  // article directly (real, has zh interwiki)
  { term: "entropy", label: "entropy", type: "tech", zhTitle: "Entropy (information theory)" },
  { term: "decision threshold", label: "decision-threshold", type: "tech" },

  // ---- probability / Bayesian / dimensionality ----
  // no dedicated article — EN "Bayesian neural network" itself redirects to
  // the generic "Neural network (machine learning)", losing the
  // Bayesian-specific meaning
  { term: "Bayesian neural network", label: "bayesian-neural-network", type: "tech", zhSkip: true },
  { term: "Bayesian optimization", label: "bayesian-optimization", type: "tech" },
  // zhTitle override: auto-resolution's bare "prior" candidate lands on
  // the general-philosophy "Belief" article — wrong topic (caught by
  // hand-auditing before shipping). The correct EN article is known
  // (same one build-stats-pack.mjs's "prior (probability)" entry
  // already uses via its source's own wikilink), so pin it directly
  // rather than rely on a guessed candidate.
  { term: "prior", label: "prior-belief", type: "tech", zhTitle: "Prior probability" },
  { term: "CDF", label: "cumulative-distribution-function-cdf", type: "acronym" },
  {
    term: "PDF (probability density function)",
    label: "probability-density-function",
    type: "tech",
  },
  { term: "outlier detection", label: "outlier-detection", type: "tech" },
  // no article distinguishes "feature vector" from plain "feature" — EN
  // "Feature vector" itself redirects to "Feature (machine learning)", whose
  // lead defines the general concept, not the vector-representation specific
  // term
  { term: "feature vector", label: "feature-vector", type: "tech", zhSkip: true },
  { term: "dimensionality reduction", label: "dimension-reduction", type: "tech" },

  // ---- misc ----
  // no dedicated ML-inference-sense article — EN "Inference (machine
  // learning)" itself redirects to "Statistical inference"
  // (hypothesis-testing sense), a different concept from the Google
  // glossary's "running a trained model" sense
  { term: "inference", label: "inference", type: "tech", zhSkip: true },
  { term: "quantization", label: "quantization", type: "tech" },
  { term: "knowledge distillation", label: "distillation", type: "tech" },
  // no dedicated ML-sense article — the only correct-topic page
  // ("Oversampling and undersampling in data analysis") has no zh interwiki;
  // auto-resolution's bare-term fallback is the unrelated signal-processing
  // sense
  { term: "oversampling", label: "oversampling", type: "tech", zhSkip: true },
  // see "oversampling" above — same missing-zh correct article, same
  // DSP-sense mismatch on the bare-term fallback
  { term: "downsampling", label: "downsampling", type: "tech", zhSkip: true },
  { term: "selection bias", label: "selection-bias", type: "other" },
  { term: "confirmation bias", label: "confirmation-bias", type: "other" },
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
  if (!res.ok) throw new Error(`Google ML Glossary fetch failed: ${res.status}`);
  const text = await res.text();
  if (!/Creative Commons Attribution 4\.0 License/.test(text)) {
    throw new Error(
      "Google ML Glossary page no longer shows the expected CC BY 4.0 footer notice — " +
        "STOP, do not build against this snapshot until the license is re-verified by hand.",
    );
  }
  await writeFile(HTML_PATH, text, "utf-8");
  return text;
}

// ---------------------------------------------------------------
// Parser — devsite glossary markup is a flat run of
//   <p><a class="glossary-anchor" name="..."></a>
//   <h2 ... id="KEBAB-ID" ... data-text="...">DISPLAY TEXT</h2>
//   [<div class="glossary-icon-container">...</div>]</p>
//
//   <p>first definition paragraph...</p>
//   <p>(more paragraphs, examples, links...)</p>
// for every headword, back to back with no closing marker between entries
// other than the next entry's own anchor. So: locate every anchor+h2 match,
// slice from the end of one match to the start of the next as that entry's
// block, find that block's first "</p>" (which always closes the header
// wrapper, whether or not it had an icon div), and take the first real
// <p>...</p> after it as the definition.
// ---------------------------------------------------------------

const ANCHOR_RE =
  /<a class="glossary-anchor" name="[^"]+"><\/a>\s*<h2[^>]*id="([^"]+)"[^>]*data-text="[^"]*"[^>]*>\s*([^<]*)<\/h2>/g;

function stripHtml(fragment) {
  return fragment
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Same truncation convention as build-edam-pack.mjs's firstChunk: cut at
// the last whole word inside the length cap, append an ellipsis.
function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

function parseGlossary(html) {
  const matches = [...html.matchAll(ANCHOR_RE)];
  const byId = new Map(); // kebab-id -> { id, displayText, definition }
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const id = m[1];
    const displayText = m[2].trim().replace(/\s+/g, " ");
    const blockStart = m.index + m[0].length;
    const blockEnd = i + 1 < matches.length ? matches[i + 1].index : html.length;
    const block = html.slice(blockStart, blockEnd);

    const wrapperCloseIdx = block.indexOf("</p>");
    if (wrapperCloseIdx === -1) continue; // malformed entry, no definition to find
    const rest = block.slice(wrapperCloseIdx + "</p>".length);
    const paraMatch = rest.match(/<p>([\s\S]*?)<\/p>/);
    if (!paraMatch) continue;

    const definition = stripHtml(paraMatch[1]);
    if (!byId.has(id)) {
      byId.set(id, { id, displayText, definition });
    }
  }
  return byId;
}

// ---------------------------------------------------------------
// Collision check — read-only scan of the built-in dictionary and the
// already-built EDAM pack for exact term-string overlaps with this pack's
// curated terms. Non-fatal (a shared word can be legitimate, e.g.
// "regression" above) — reported so nobody ships a silent dup.
// ---------------------------------------------------------------

async function checkCollisions(mlTerms) {
  const mlByLower = new Map(mlTerms.map((t) => [t.term.toLowerCase(), t.term]));
  const collisions = [];

  if (existsSync(CORE_DICTIONARY_PATH)) {
    const coreSrc = await readFile(CORE_DICTIONARY_PATH, "utf-8");
    const coreTermRe = /term:\s*"((?:[^"\\]|\\.)*)"/g;
    let cm;
    while ((cm = coreTermRe.exec(coreSrc))) {
      const lower = cm[1].toLowerCase();
      if (mlByLower.has(lower)) {
        collisions.push({ term: mlByLower.get(lower), with: "built-in dictionary-data.ts" });
      }
    }
  } else {
    console.warn(`[warn] collision check skipped — not found: ${CORE_DICTIONARY_PATH}`);
  }

  if (existsSync(EDAM_PACK_PATH)) {
    const edamPack = JSON.parse(await readFile(EDAM_PACK_PATH, "utf-8"));
    for (const t of edamPack.terms ?? []) {
      const lower = t.term.toLowerCase();
      if (mlByLower.has(lower)) {
        collisions.push({ term: mlByLower.get(lower), with: "bioinformatics-edam pack" });
      }
    }
  } else {
    console.warn(`[warn] collision check skipped — not found: ${EDAM_PACK_PATH}`);
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
      errors.push(`No Google ML Glossary entry found for id "${entry.label}" (term "${entry.term}")`);
      continue;
    }
    if (!found.definition) {
      errors.push(`Entry "${entry.label}" resolved but had no extractable definition paragraph`);
      continue;
    }

    // Task 2 (zh enrichment): this source has no wikilink of its own, so
    // candidate EN Wikipedia titles are derived from the entry's own
    // term/label text — see deriveEnCandidates' doc comment for the
    // known wrong-topic risk on short/generic terms. A curated entry's
    // own zhTitle (hand-verified correct EN article, for the rare case
    // auto-derivation lands on a real-but-wrong topic) or zhSkip
    // (auto-derivation's only candidates are confirmed wrong-topic and
    // no correct EN article is known to pin instead) overrides the
    // heuristic — see the CURATED_TERMS entries that set them.
    const zh = entry.zhSkip
      ? { ok: false, reason: "manually flagged: auto-resolved candidate(s) confirmed wrong-topic, no better EN article known" }
      : await enrichOneTerm(entry.zhTitle ? [entry.zhTitle] : deriveEnCandidates(entry.term, entry.label));
    if (!zh.ok) zhFlagged.push({ term: entry.term, reason: zh.reason });

    terms.push({
      term: entry.term,
      type: entry.type,
      gloss_en: truncate(found.definition, GLOSS_EN_MAX_LEN) || entry.term,
      gloss_zh: zh.ok ? zh.gloss_zh : GLOSS_ZH_PLACEHOLDER,
      pack: "ml-stats",
    });
    provenance.push({
      term: entry.term,
      source_id: found.id,
      source_display_text: found.displayText,
      definition: found.definition,
      zh: zh.ok
        ? {
            status: "ok",
            en_title_used: zh.en_title,
            en_url: zh.en_url,
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
    id: "ml-stats",
    name: "机器学习与统计学术语（Google ML Glossary）",
    description:
      "机器学习工程与统计学常用术语，取自 Google Machine Learning Glossary。中文释义来自对应中文维基百科条目导言（非机器翻译），部分术语未找到可信中文维基条目，暂缺中文释义。经典统计学词汇（如 p 值、置信区间）在该来源中未收录，详见 provenance 文件与构建脚本注释。",
    version: new Date().toISOString().slice(0, 10), // dated snapshot — the
    // source is a living webpage with no version number of its own (unlike
    // EDAM's owl:versionInfo), so the fetch date is the honest version key.
    expressions: [],
    terms,
    // Extra fields below aren't read by remotePacks.ts's validateManifest
    // (it only picks id/name/description/version/expressions/terms), kept
    // here for human/audit review of source + license, same as the EDAM
    // pack's manifest.
    license: GLOSSARY_LICENSE,
    licenseUrl: GLOSSARY_LICENSE_URL,
    source: "Google Machine Learning Glossary (developers.google.com/machine-learning/glossary)",
    sourceUrl: GLOSSARY_URL,
    citation: GLOSSARY_CITATION,
    compiledAt: new Date().toISOString().slice(0, 10),
    glossZhNote:
      "gloss_zh is enriched per-term via enrich-zh.mjs — follows this entry's derived " +
      "English Wikipedia title (the Google ML Glossary itself has no Chinese gloss and " +
      "no wikilink of its own) to its Chinese Wikipedia interwiki counterpart and uses " +
      "that article's lead paragraph, real human-written CC BY-SA text, never a machine " +
      `translation. Terms with no confident match keep the placeholder "${GLOSS_ZH_PLACEHOLDER}"; ` +
      "see provenance's per-term zh.status field (and the task report for terms flagged " +
      "as too ambiguous to auto-resolve safely, e.g. short/generic English words).",
  };

  await writeFile(
    path.join(OUT_DIR, "ml-stats.pack.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
  await writeFile(
    path.join(OUT_DIR, "ml-stats.provenance.json"),
    JSON.stringify(provenance, null, 2) + "\n",
    "utf-8",
  );

  console.log(`Wrote ${terms.length} terms to out/ml-stats.pack.json`);
  console.log(`Wrote per-entry provenance to out/ml-stats.provenance.json`);

  if (collisions.length > 0) {
    console.warn(`\n[collision report] ${collisions.length} term string(s) shared with existing packs:`);
    for (const c of collisions) console.warn(` - "${c.term}" also present in ${c.with}`);
  } else {
    console.log("\n[collision report] no term-string collisions found against built-in dictionary or EDAM pack.");
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
