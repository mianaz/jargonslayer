// The sidecar's ~7,100 lines of Python tests had no runner: no pytest
// config, no npm script, no CI step, no doc. ci.yml excluded them on the
// grounds that there were "no pinned runner deps" — but they need none.
// Every sidecar/test_*.py is a plain-assert script that stubs its own
// heavy imports, prints a pass/fail summary and exits non-zero on
// failure, so a bare interpreter runs all ten green. Wiring them up is
// this script plus two lines in ci.yml.
//
// Deliberately NOT installing requirements-sidecar.txt: the files that
// have optional-import sections (test_model_registry, test_download)
// print SKIP and continue, so the install would buy a little extra
// coverage at the cost of pulling faster-whisper + its torch stack into
// every CI run. Add it if that coverage is ever worth the minutes.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const sidecar = join(dirname(dirname(fileURLToPath(import.meta.url))), "sidecar");
const python = process.env.PYTHON ?? "python3";

const files = readdirSync(sidecar)
  .filter((f) => f.startsWith("test_") && f.endsWith(".py"))
  .sort();

if (files.length === 0) {
  console.error("test-sidecar: no sidecar/test_*.py found — did the path move?");
  process.exit(1);
}

const failed = [];
for (const file of files) {
  process.stdout.write(`${file.padEnd(32)} `);
  try {
    execFileSync(python, [file], { cwd: sidecar, stdio: ["ignore", "pipe", "pipe"] });
    console.log("ok");
  } catch (err) {
    console.log("FAIL");
    // The assert output is the whole diagnostic — show it, don't summarize.
    process.stderr.write(String(err.stdout ?? "") + String(err.stderr ?? ""));
    failed.push(file);
  }
}

if (failed.length) {
  console.error(`\ntest-sidecar: ${failed.length}/${files.length} failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\ntest-sidecar: ${files.length} files ok`);
