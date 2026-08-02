// The sidecar's ~7,100 lines of Python tests had no runner: no pytest
// config, no npm script, no CI step, no doc. Every sidecar/test_*.py is
// a plain-assert script that stubs its own heavy backends, prints a
// pass/fail summary and exits non-zero on failure, so all it takes to
// gate them is this script plus a pip install and two lines in ci.yml.
//
// That pip install is not optional, and this comment used to claim it
// was. The first version of this script went in asserting the tests
// "need no pinned runner deps" because all ten passed locally — they
// only did because this machine already had numpy. The first CI run
// after wiring them up failed 7 of 10 at import. The real set is in
// sidecar/requirements-test.txt, derived in a clean venv rather than
// inferred, and it is three packages: numpy, websockets, tqdm.
//
// Still deliberately NOT requirements-sidecar.txt — see that file's own
// header for why installing faster-whisper would test the wrong thing.
//
// Set PYTHON to point at a specific interpreter (the CI job does not
// need to; a venv on PATH is enough).
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
