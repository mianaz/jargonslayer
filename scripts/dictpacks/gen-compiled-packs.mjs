// Compiles the 3 built-in domain packs (out/*.pack.json — owned by the
// build-*.mjs scripts in this directory) into a typed TS module that
// packages/core/src/detect/dictionary.ts imports as a third built-in
// term source (alongside BASE_TERM_DICTIONARY and EXTRA_TERMS).
//
// This script only READS scripts/dictpacks/out/*.pack.json — it does not
// build/enrich pack data itself (that's build-*.mjs / enrich-zh.mjs).
// Re-run this after those scripts regenerate the source JSON.
//
// Run: node scripts/dictpacks/gen-compiled-packs.mjs

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "out");
const DEST_PATH = path.join(
  __dirname,
  "..",
  "..",
  "packages",
  "core",
  "src",
  "detect",
  "dictionary-packs-compiled.ts",
);

// Stable order: stats, then ml-stats, then bioinformatics-edam.
const SOURCE_PACKS = ["stats", "ml-stats", "bioinformatics-edam"];

// Everyday-English headwords that also happen to be domain terms. They
// fire on casual speech ("I mean...", "pay attention", "recall that...")
// under the default all-on state, so scanDictionary keeps them opt-in
// (matched only once the user has actively customized their pack
// selection). Flagged here with commonWord:true in the compiled output.
// See dictionary.ts's term loop and DictTermEntry.commonWord.
const COMMON_WORDS = new Set([
  "mean",
  "prior",
  "attention",
  "precision",
  "recall",
  "accuracy",
  "token",
  "variance",
  "epoch",
  "embedding",
]);

const VALID_TYPES = new Set([
  "acronym",
  "company",
  "product",
  "tech",
  "metric",
  "person",
  "other",
]);

function jsString(s) {
  return JSON.stringify(s);
}

async function main() {
  const perPackTerms = new Map();

  for (const packId of SOURCE_PACKS) {
    const packPath = path.join(OUT_DIR, `${packId}.pack.json`);
    const raw = await readFile(packPath, "utf-8");
    const pack = JSON.parse(raw);

    for (const term of pack.terms ?? []) {
      if (!VALID_TYPES.has(term.type)) {
        throw new Error(
          `[${packId}] invalid type "${term.type}" for term ${jsString(term.term)}`,
        );
      }
      if (term.pack !== pack.id) {
        throw new Error(
          `[${packId}] term ${jsString(term.term)} has pack ${jsString(term.pack)}, ` +
            `expected ${jsString(pack.id)}`,
        );
      }
      if (!term.gloss_en || !term.gloss_en.trim()) {
        throw new Error(`[${packId}] empty gloss_en for term ${jsString(term.term)}`);
      }
      if (!term.gloss_zh || !term.gloss_zh.trim()) {
        throw new Error(`[${packId}] empty gloss_zh for term ${jsString(term.term)}`);
      }
    }

    perPackTerms.set(packId, pack.terms ?? []);
  }

  const allTerms = SOURCE_PACKS.flatMap((packId) => perPackTerms.get(packId));

  const entriesSrc = allTerms
    .map(
      (t) =>
        `  {\n` +
        `    term: ${jsString(t.term)},\n` +
        `    type: ${jsString(t.type)},\n` +
        `    gloss_en: ${jsString(t.gloss_en)},\n` +
        `    gloss_zh: ${jsString(t.gloss_zh)},\n` +
        `    pack: ${jsString(t.pack)},\n` +
        (COMMON_WORDS.has(t.term) ? `    commonWord: true,\n` : ``) +
        `  },`,
    )
    .join("\n");

  const fileSrc =
    `// GENERATED FILE — do not edit by hand. Regenerate: node scripts/dictpacks/gen-compiled-packs.mjs\n` +
    `//\n` +
    `// Compiled from 3 built-in domain packs (scripts/dictpacks/out/*.pack.json):\n` +
    `//   - stats.pack.json               (id "stats")               — CC BY-SA 4.0\n` +
    `//   - ml-stats.pack.json             (id "ml-stats")            — CC BY 4.0\n` +
    `//   - bioinformatics-edam.pack.json  (id "bioinformatics-edam") — CC BY-SA 4.0\n` +
    `// Full attribution (source, citation, license URL) for each pack lives in the\n` +
    `// repo NOTICE file.\n` +
    `\n` +
    `import type { DictTermEntry } from "./dictionary-data";\n` +
    `\n` +
    `export const COMPILED_PACK_TERMS: DictTermEntry[] = [\n` +
    `${entriesSrc}\n` +
    `];\n`;

  await writeFile(DEST_PATH, fileSrc, "utf-8");

  console.log("Wrote packages/core/src/detect/dictionary-packs-compiled.ts");
  let total = 0;
  for (const packId of SOURCE_PACKS) {
    const n = perPackTerms.get(packId).length;
    total += n;
    console.log(`  ${packId}: ${n} terms`);
  }
  console.log(`  TOTAL: ${total} terms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
