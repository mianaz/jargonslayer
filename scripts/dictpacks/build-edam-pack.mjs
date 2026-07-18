// Compiles a bioinformatics/comp-bio dictionary pack from the EDAM
// ontology (https://edamontology.org, CC BY-SA 4.0) into the
// RemotePackManifest JSON shape that apps/web/src/lib/detect/
// remotePacks.ts validates and loads (Settings > 词典包 > 添加来源,
// paste a URL/local file serving this JSON). See packages/core/src/
// detect/remotePacksRegistry.ts + dictionary-data.ts for the schema
// this must match: { id, name, description?, version, expressions?,
// terms? } with terms[] = { term, type?, gloss_en?, gloss_zh, pack? }.
//
// gloss_zh is a REQUIRED, non-empty field in that validator
// (validateTerms drops any entry without one) — but the task's source
// (EDAM) is English-only, and the brief says "do not machine-translate;
// leave zh empty rather than guess". Those two constraints conflict:
// an actually-empty gloss_zh gets silently dropped by the app's own
// loader, which would mean zero entries load. Resolution used here:
// gloss_zh gets an honest placeholder ("暂无中文释义") rather than a
// guessed translation — satisfies the schema without fabricating
// content. Flagged in the run output; revisit if a human translation
// pass is done later.
//
// Run: node scripts/dictpacks/build-edam-pack.mjs [--refresh]
// --refresh re-fetches data/EDAM.tsv from upstream before building
// (otherwise the cached copy already in this directory is used, so
// the build is reproducible offline).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flushWikiApiCache } from "./wiki-api.mjs";
import { enrichOneTerm, deriveEnCandidates } from "./enrich-zh.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSV_PATH = path.join(__dirname, "data", "EDAM.tsv");
const OUT_DIR = path.join(__dirname, "out");
const EDAM_URL =
  "https://raw.githubusercontent.com/edamontology/edamontology/master/releases/EDAM.tsv";
const EDAM_VERSION = "1.25"; // matches owl:versionInfo in releases/EDAM.owl as of this build
const EDAM_LICENSE = "CC BY-SA 4.0";
const EDAM_CITATION =
  "Ison, J. et al. EDAM: an ontology of bioinformatics operations, types of data, topics, and formats. Bioinformatics 29(10), 2013.";

const GLOSS_ZH_PLACEHOLDER = "暂无中文释义";
const GLOSS_EN_MAX_LEN = 180;

// ---------------------------------------------------------------
// Generic quoted-delimited parser (handles embedded newlines/quotes
// inside quoted fields — EDAM's Definitions column has both).
// ---------------------------------------------------------------
function parseDelimited(text, delimiter = "\t") {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------
// Curated allowlist: EDAM's ~3400 classes include many ultra-generic
// (single common English words like "Data", "Format", "Report") or
// ultra-fine-grained obsolete-branch entries that would either
// false-positive constantly in unrelated meetings or never plausibly
// come up in speech. This is a hand-picked subset of terms a
// bioinformatics/comp-bio meeting would actually say out loud, cross-
// checked against real EDAM records below (build fails loud if a
// label doesn't match or is marked obsolete, rather than silently
// dropping it).
//
// label = EDAM's exact Preferred Label (case-insensitive lookup key).
// term  = display form shown in the app (stylistic only).
// type  = TermType from packages/core/src/types.ts.
const CURATED_TERMS = [
  // ---- file formats ----
  { term: "FASTA", label: "FASTA", type: "acronym" },
  { term: "FASTQ", label: "FASTQ", type: "acronym" },
  { term: "SAM", label: "SAM", type: "acronym" },
  { term: "BAM", label: "BAM", type: "acronym" },
  { term: "CRAM", label: "CRAM", type: "acronym" },
  { term: "VCF", label: "VCF", type: "acronym" },
  { term: "GFF3", label: "GFF3", type: "acronym" },
  { term: "GTF", label: "GTF", type: "acronym" },
  { term: "BED", label: "BED", type: "acronym" },
  { term: "PDB", label: "PDB", type: "acronym" },
  { term: "mmCIF", label: "mmCIF", type: "acronym" },
  { term: "HDF5", label: "HDF5", type: "acronym" },
  { term: "MAF", label: "MAF", type: "acronym" },
  { term: "Newick format", label: "newick", type: "tech" },
  { term: "ClustalW format", label: "ClustalW format", type: "tech" },
  { term: "PLINK PED/MAP", label: "PED/MAP", type: "tech" },
  { term: "K-mer countgraph", label: "K-mer countgraph", type: "tech" },

  // ---- core data types ----
  { term: "Sequence alignment", label: "Sequence alignment", type: "tech" },
  {
    term: "Multiple sequence alignment",
    label: "Multiple sequence alignment",
    type: "tech",
  },
  { term: "Phylogenetic tree", label: "Phylogenetic tree", type: "tech" },
  { term: "Gene expression", label: "Gene expression", type: "tech" },
  { term: "Sequence assembly", label: "Sequence assembly", type: "tech" },
  { term: "Codon usage table", label: "Codon usage table", type: "tech" },
  {
    term: "Nucleic acid sequence",
    label: "Nucleic acid sequence",
    type: "tech",
  },
  { term: "Protein sequence", label: "Protein sequence", type: "tech" },

  // ---- operations (things you'd say "we ran X") ----
  { term: "Genome assembly", label: "Genome assembly", type: "tech" },
  { term: "Variant calling", label: "Variant calling", type: "tech" },
  {
    term: "Gene expression profiling",
    label: "Gene expression profiling",
    type: "tech",
  },
  {
    term: "Differential gene expression analysis",
    label: "Differential gene expression profiling",
    type: "tech",
  },
  { term: "Phylogenetic inference", label: "Phylogenetic inference", type: "tech" },
  {
    term: "Phylogenetic reconstruction",
    label: "Phylogenetic reconstruction",
    type: "tech",
  },
  { term: "Read mapping", label: "Read mapping", type: "tech" },
  { term: "Sequence trimming", label: "Sequence trimming", type: "tech" },
  { term: "Sequence clustering", label: "Sequence clustering", type: "tech" },
  { term: "Structure prediction", label: "Structure prediction", type: "tech" },
  {
    term: "Protein structure prediction",
    label: "Protein structure prediction",
    type: "tech",
  },
  { term: "Homology modelling", label: "Protein modelling", type: "tech" },
  { term: "Molecular docking", label: "Molecular docking", type: "tech" },
  {
    term: "Gene set enrichment analysis",
    label: "Gene-set enrichment analysis",
    type: "tech",
  },
  { term: "Enrichment analysis", label: "Enrichment analysis", type: "tech" },
  {
    term: "Structural variation detection",
    label: "Structural variation detection",
    type: "tech",
  },
  {
    term: "Copy number variation detection",
    label: "Copy number variation detection",
    type: "tech",
  },
  { term: "Genotyping", label: "Genotyping", type: "tech" },
  { term: "Peak calling", label: "Peak calling", type: "tech" },
  {
    term: "Sequence motif discovery",
    label: "Sequence motif discovery",
    type: "tech",
  },
  { term: "PCR primer design", label: "PCR primer design", type: "tech" },
  { term: "Local alignment", label: "Local alignment", type: "tech" },
  { term: "Global alignment", label: "Global alignment", type: "tech" },
  // zhSkip: EN "Sequence similarity search" itself redirects to "Sequence
  // alignment" — no distinct article for the search/database-lookup
  // operation (as opposed to the pairwise alignment technique itself);
  // flagged rather than reuse a gloss for a different concept.
  {
    term: "Sequence similarity search",
    label: "Sequence similarity search",
    type: "tech",
    zhSkip: true,
  },
  {
    term: "Sequence database search",
    label: "Sequence database search",
    type: "tech",
  },
  {
    term: "Taxonomic classification",
    label: "Taxonomic classification",
    type: "tech",
  },
  // zhTitle override: auto-resolution's bare "Scaffolding" candidate
  // lands on the general-construction "Scaffolding" article — wrong
  // topic (caught by hand-auditing before shipping). The correct EN
  // article ("Scaffolding (bioinformatics)") is real but has no zh
  // interwiki link of its own; pin it directly so the term is honestly
  // flagged/placeholder rather than silently mismatched.
  { term: "Scaffolding", label: "Scaffolding", type: "tech", zhTitle: "Scaffolding (bioinformatics)" },
  { term: "K-mer counting", label: "k-mer counting", type: "tech" },
  {
    term: "Sequence read processing",
    label: "Sequence read processing",
    type: "tech",
  },
  { term: "SNP detection", label: "SNP detection", type: "tech" },
  { term: "Variant effect prediction", label: "Variant effect prediction", type: "tech" },
  { term: "Variant classification", label: "Variant classification", type: "tech" },
  { term: "Variant prioritisation", label: "Variant prioritisation", type: "tech" },

  // ---- topics (fields/sub-disciplines people name-drop) ----
  { term: "Genomics", label: "Genomics", type: "other" },
  { term: "Proteomics", label: "Proteomics", type: "other" },
  { term: "Transcriptomics", label: "Transcriptomics", type: "other" },
  { term: "Metabolomics", label: "Metabolomics", type: "other" },
  { term: "Metagenomics", label: "Metagenomics", type: "other" },
  { term: "Phylogenetics", label: "Phylogenetics", type: "other" },
  { term: "Phylogeny", label: "Phylogeny", type: "other" },
  { term: "Sequence analysis", label: "Sequence analysis", type: "other" },
  {
    term: "Genotype and phenotype",
    label: "Genotype and phenotype",
    type: "other",
  },
  { term: "Structural biology", label: "Structural biology", type: "other" },
  {
    term: "Molecular interactions, pathways and networks",
    label: "Molecular interactions, pathways and networks",
    type: "other",
  },
  { term: "Epigenomics", label: "Epigenomics", type: "other" },
  { term: "Systems biology", label: "Systems biology", type: "other" },
  { term: "Population genomics", label: "Population genomics", type: "other" },
  { term: "RNA-Seq", label: "RNA-Seq", type: "tech" },
  { term: "ChIP-seq", label: "ChIP-seq", type: "tech" },
  {
    term: "Whole genome sequencing",
    label: "Whole genome sequencing",
    type: "tech",
  },
  { term: "Exome sequencing", label: "Exome sequencing", type: "tech" },
  { term: "DNA polymorphism", label: "DNA polymorphism", type: "other" },
];

// ---------------------------------------------------------------
// Build
// ---------------------------------------------------------------

async function ensureTsv() {
  const refresh = process.argv.includes("--refresh");
  if (!refresh && existsSync(TSV_PATH)) {
    return readFile(TSV_PATH, "utf-8");
  }
  console.log(`Fetching ${EDAM_URL} ...`);
  const res = await fetch(EDAM_URL);
  if (!res.ok) throw new Error(`EDAM.tsv fetch failed: ${res.status}`);
  const text = await res.text();
  await writeFile(TSV_PATH, text, "utf-8");
  return text;
}

// EDAM's Definitions column joins multiple definition/comment values
// with "|" (BioPortal TSV export convention) — take the first one, not
// "first sentence" (definitions are full of "e.g."/"i.e." abbreviations
// that a period-based sentence splitter would wrongly cut on).
function firstChunk(def, maxLen) {
  const first = def.split("|")[0].trim().replace(/\s+/g, " ");
  if (!first) return "";
  if (first.length <= maxLen) return first;
  const truncated = first.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trimEnd() + "…";
}

async function main() {
  const tsvText = await ensureTsv();
  const rows = parseDelimited(tsvText, "\t");
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const dataRows = rows.slice(1);

  const byLabel = new Map(); // lowercased label -> array of records
  for (const r of dataRows) {
    const label = (r[idx["Preferred Label"]] ?? "").trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key).push(r);
  }

  const terms = [];
  const provenance = [];
  const errors = [];
  const zhFlagged = [];

  for (const entry of CURATED_TERMS) {
    const edamCandidates = byLabel.get(entry.label.toLowerCase());
    if (!edamCandidates || edamCandidates.length === 0) {
      errors.push(`No EDAM class found for label "${entry.label}" (term "${entry.term}")`);
      continue;
    }
    const nonObsolete = edamCandidates.filter(
      (r) => (r[idx["Obsolete"]] ?? "").trim().toUpperCase() !== "TRUE",
    );
    if (nonObsolete.length === 0) {
      errors.push(`All EDAM classes for label "${entry.label}" are obsolete (term "${entry.term}")`);
      continue;
    }
    if (edamCandidates.length > 1) {
      console.warn(
        `[warn] "${entry.label}" matched ${edamCandidates.length} EDAM classes, using the first non-obsolete one (${nonObsolete[0][idx["Class ID"]]})`,
      );
    }
    const r = nonObsolete[0];
    const classId = r[idx["Class ID"]];
    const definition = (r[idx["Definitions"]] ?? "").trim();

    // Task 2 (zh enrichment): EDAM has no wikilink or Chinese gloss of
    // its own — candidate EN Wikipedia titles are derived from the
    // entry's own term/label text, see deriveEnCandidates' doc comment.
    // A curated entry's own zhTitle (hand-verified correct EN article,
    // for the rare case auto-derivation lands on a real-but-wrong
    // topic — see "Scaffolding" above) or zhSkip (auto-derivation's
    // only candidates are confirmed wrong-topic/wrong-scope and no
    // better EN article exists to pin instead — see "Sequence
    // similarity search" above) overrides the heuristic.
    const zh = entry.zhSkip
      ? { ok: false, reason: "manually flagged: auto-resolved candidate(s) confirmed wrong-topic/wrong-scope, no better EN article known" }
      : await enrichOneTerm(entry.zhTitle ? [entry.zhTitle] : deriveEnCandidates(entry.term, entry.label));
    if (!zh.ok) zhFlagged.push({ term: entry.term, reason: zh.reason });

    terms.push({
      term: entry.term,
      type: entry.type,
      gloss_en: firstChunk(definition, GLOSS_EN_MAX_LEN) || entry.term,
      gloss_zh: zh.ok ? zh.gloss_zh : GLOSS_ZH_PLACEHOLDER,
      pack: "bioinformatics-edam",
    });
    provenance.push({
      term: entry.term,
      edam_label: r[idx["Preferred Label"]],
      edam_id: classId,
      definition,
      obsolete: false,
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
    console.error("Build failed — curated terms didn't resolve cleanly against EDAM.tsv:");
    for (const e of errors) console.error(" - " + e);
    process.exit(1);
  }

  await flushWikiApiCache();

  const manifest = {
    id: "bioinformatics-edam",
    name: "生物信息学术语（EDAM Ontology）",
    description:
      "生物信息学常用操作、数据类型、文件格式与研究主题术语，取自 EDAM Ontology。中文释义来自对应中文维基百科条目导言（非机器翻译），部分术语未找到可信中文维基条目，暂缺中文释义。",
    version: EDAM_VERSION,
    expressions: [],
    terms,
    // Extra fields below aren't read by remotePacks.ts's validateManifest
    // (it only picks id/name/description/version/expressions/terms), so
    // they're inert for the app — kept here for human/audit review of
    // source + license, per the task's per-pack attribution requirement.
    license: EDAM_LICENSE,
    source: "EDAM Ontology (https://edamontology.org)",
    sourceUrl: EDAM_URL,
    sourceVersion: EDAM_VERSION,
    citation: EDAM_CITATION,
    compiledAt: new Date().toISOString().slice(0, 10),
    glossZhNote:
      "gloss_zh is enriched per-term via enrich-zh.mjs — follows this entry's derived " +
      "English Wikipedia title (EDAM itself has no Chinese gloss and no wikilink of its " +
      "own) to its Chinese Wikipedia interwiki counterpart and uses that article's lead " +
      "paragraph, real human-written CC BY-SA text, never a machine translation. Terms " +
      `with no confident match keep the placeholder "${GLOSS_ZH_PLACEHOLDER}"; see ` +
      "provenance's per-term zh.status field (and the task report for terms flagged as " +
      "too ambiguous to auto-resolve safely).",
  };

  await writeFile(
    path.join(OUT_DIR, "bioinformatics-edam.pack.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
  await writeFile(
    path.join(OUT_DIR, "bioinformatics-edam.provenance.json"),
    JSON.stringify(provenance, null, 2) + "\n",
    "utf-8",
  );

  console.log(`Wrote ${terms.length} terms to out/bioinformatics-edam.pack.json`);
  console.log(`Wrote per-entry provenance to out/bioinformatics-edam.provenance.json`);

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
