// v0.4 S3 chunk 2 (docs/design-explorations/s3-tauri-uv-blueprint.md) —
// downloads the pinned uv release binary Tauri bundles as a sidecar
// (architecture decision 3: "uv = the ONLY provisioning tool"), and
// writes it to apps/desktop/src-tauri/binaries/uv-<target-triple> —
// the exact naming Tauri's `bundle.externalBin` requires (see that
// config's own comment / docs/develop/sidecar.mdx: a configured
// `"binaries/uv"` entry needs an actual file named `binaries/uv-
// $TARGET_TRIPLE` on disk). binaries/ is gitignored — every machine
// (dev or CI) runs this script for itself.
//
// Idempotent: if a correctly-versioned binary is already present, this
// is a fast no-op (checked by literally running `uv --version` and
// comparing against UV_VERSION, not just checking file existence).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned uv release — latest stable at S3 chunk-2 implementation time
// (2026-07-11), verified against the GitHub release's own sha256.sum
// manifest and a real `uv venv` + `uv pip install` smoke run. Bump
// deliberately; re-verify the checksum + re-run this script when you
// do (it re-downloads automatically once UV_VERSION no longer matches
// the cached binary's own `--version` output).
const UV_VERSION = "0.11.28";
const UV_RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binariesDir = join(root, "apps", "desktop", "src-tauri", "binaries");

function log(msg) {
  console.log(`[fetch-uv] ${msg}`);
}

function targetTriple() {
  // Matches the blueprint's own instruction ("triple via rustc -Vv") —
  // portable across Rust versions (rustc 1.84+'s `--print host-tuple`
  // is more direct, but parsing `-Vv`'s `host:` line works everywhere).
  const out = execFileSync("rustc", ["-Vv"], { encoding: "utf8" });
  const match = out.match(/^host:\s*(\S+)$/m);
  if (!match) {
    throw new Error("could not determine target triple from `rustc -Vv` output");
  }
  return match[1];
}

function uvAssetName(triple) {
  const ext = process.platform === "win32" ? "zip" : "tar.gz";
  return `uv-${triple}.${ext}`;
}

function sha256Hex(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function isAlreadyCorrect(binPath) {
  if (!existsSync(binPath)) return false;
  try {
    const out = execFileSync(binPath, ["--version"], { encoding: "utf8" });
    return out.includes(UV_VERSION);
  } catch {
    // Present but not executable / not actually a working uv binary —
    // treat as absent and re-fetch.
    return false;
  }
}

async function main() {
  const triple = targetTriple();
  const exe = process.platform === "win32" ? ".exe" : "";
  const binPath = join(binariesDir, `uv-${triple}${exe}`);

  if (isAlreadyCorrect(binPath)) {
    log(`binaries/uv-${triple}${exe} already present at ${UV_VERSION} — skipping download`);
    return;
  }

  mkdirSync(binariesDir, { recursive: true });

  const assetName = uvAssetName(triple);
  const assetUrl = `${UV_RELEASE_BASE}/${assetName}`;
  const checksumUrl = `${assetUrl}.sha256`;

  log(`downloading ${assetName} (uv ${UV_VERSION}, ${triple})`);
  const [archive, checksumFile] = await Promise.all([download(assetUrl), download(checksumUrl)]);

  const expectedHash = checksumFile.toString("utf8").trim().split(/\s+/)[0];
  if (!expectedHash) {
    throw new Error(`could not parse expected sha256 from ${checksumUrl}`);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "jargonslayer-fetch-uv-"));
  try {
    const archivePath = join(tmpDir, assetName);
    writeFileSync(archivePath, archive);

    const actualHash = sha256Hex(archivePath);
    if (actualHash !== expectedHash) {
      throw new Error(
        `sha256 mismatch for ${assetName}: expected ${expectedHash}, got ${actualHash} — refusing to install`
      );
    }
    log(`sha256 verified (${actualHash})`);

    // `tar -xf` (no explicit -z) auto-detects gzip vs zip via libarchive
    // on macOS/Linux (bsdtar) and on Windows 10 1803+'s built-in tar.exe
    // (also bsdtar) — one extraction call works for every platform's
    // asset format. The archive extracts to a `uv-<triple>/` subfolder
    // containing `uv` (+ `uvx`, unused here).
    execFileSync("tar", ["-xf", archivePath, "-C", tmpDir]);
    const extractedBin = join(tmpDir, `uv-${triple}`, `uv${exe}`);
    if (!existsSync(extractedBin)) {
      throw new Error(`expected ${extractedBin} after extracting ${assetName}, but it's missing`);
    }

    renameSync(extractedBin, binPath);
    chmodSync(binPath, 0o755);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const version = execFileSync(binPath, ["--version"], { encoding: "utf8" }).trim();
  log(`installed ${binPath} (${version})`);
}

main().catch((err) => {
  console.error(`[fetch-uv] ${err.stack || err}`);
  process.exit(1);
});
