// v0.4 S9.1 (docs/design-explorations/s9-app-audio-tap-blueprint.md) —
// builds the jargonslayer-audiocap Swift package (apps/desktop/
// src-tauri/audiocap-helper/) and stages the product as apps/desktop/
// src-tauri/binaries/jargonslayer-audiocap-<triple> — the exact naming
// Tauri's `bundle.externalBin` requires (see tauri.conf.json's own
// externalBin entry and scripts/fetch-uv.mjs's own comment for the
// general "binaries/<name>-$TARGET_TRIPLE" convention this mirrors).
// binaries/ is gitignored — every machine (dev or CI) runs this script
// for itself, same as fetch-uv.mjs.
//
// Unlike fetch-uv.mjs, this script builds FROM SOURCE (there's no
// upstream release archive to download + verify a pinned checksum
// against) via `swift build`, which is already incremental/cached on
// its own — this script doesn't need its own skip-if-unchanged logic
// on top of that; it always invokes `swift build` (a fast no-op when
// nothing changed) and always re-copies the resulting product.
//
// macOS + Apple Silicon only for now, matching this slice's explicit
// scope (`swift build -c release --arch arm64` — no x86_64/Rosetta
// target yet) and the helper's own technical floor (CoreAudio process
// taps, macOS 14.2+, docs/design-explorations/s9-app-audio-tap-
// blueprint.md's D1). Every other platform/architecture is a clear,
// early, actionable skip rather than a confusing downstream failure.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_TRIPLE = "aarch64-apple-darwin";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const helperDir = join(root, "apps", "desktop", "src-tauri", "audiocap-helper");
const binariesDir = join(root, "apps", "desktop", "src-tauri", "binaries");

function log(msg) {
  console.log(`[build-audiocap] ${msg}`);
}

function verifyPlatform() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(
      `jargonslayer-audiocap only builds on macOS/arm64 today (this slice's own explicit scope — see this ` +
        `script's own header comment); got platform="${process.platform}" arch="${process.arch}". Skip this ` +
        "script (and the app-audio-capture feature) on other platforms/architectures."
    );
  }
}

// Clear, actionable error if the Swift toolchain isn't installed —
// mirrors fetch-uv.mjs's own UV_SHA256-missing-triple error in spirit
// (fail loudly with the exact next step, not a bare ENOENT stack).
function verifySwiftToolchain() {
  try {
    execFileSync("swift", ["--version"], { stdio: "pipe" });
  } catch (err) {
    throw new Error(
      "swift toolchain not found (`swift --version` failed) — install Xcode or the Xcode Command Line Tools " +
        "(`xcode-select --install`) and re-run. jargonslayer-audiocap (apps/desktop/src-tauri/audiocap-helper) " +
        `needs \`swift build\` to compile.\n\nunderlying error: ${err.message}`
    );
  }
}

async function main() {
  verifyPlatform();
  verifySwiftToolchain();

  log(`building jargonslayer-audiocap (release, arm64) in ${helperDir}`);
  execFileSync("swift", ["build", "-c", "release", "--arch", "arm64"], {
    cwd: helperDir,
    stdio: "inherit",
  });

  // `--show-bin-path` is a fast query (verified: no rebuild work, just
  // resolves and prints SwiftPM's own per-triple output directory) —
  // reading the product path this way rather than assuming a fixed
  // ".build/arm64-apple-macosx/release/" layout keeps this script
  // robust to SwiftPM's own internal build-directory conventions.
  const binPath = execFileSync("swift", ["build", "-c", "release", "--arch", "arm64", "--show-bin-path"], {
    cwd: helperDir,
    encoding: "utf8",
  }).trim();
  const builtBinary = join(binPath, "jargonslayer-audiocap");
  if (!existsSync(builtBinary)) {
    throw new Error(`expected ${builtBinary} to exist after \`swift build\`, but it's missing`);
  }

  mkdirSync(binariesDir, { recursive: true });
  const stagedPath = join(binariesDir, `jargonslayer-audiocap-${TARGET_TRIPLE}`);
  // No codesign here — the tauri bundler signs externalBins itself
  // during bundling (same posture as the uv sidecar; see uv.rs's
  // UV_SIDECAR_PROGRAM doc comment).
  copyFileSync(builtBinary, stagedPath);
  chmodSync(stagedPath, 0o755);
  log(`staged ${stagedPath}`);
}

main().catch((err) => {
  console.error(`[build-audiocap] ${err.stack || err}`);
  process.exit(1);
});
