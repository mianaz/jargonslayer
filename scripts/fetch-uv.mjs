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
// Idempotent: if a binary is already present AND its sha256 matches the
// digest recorded in binaries/.uv-<triple>.sha256 from a previous
// verified install of the CURRENT UV_VERSION, this is a fast no-op. The
// binary itself is never executed to check this (see the UV_SHA256 /
// sidecar-file trust-chain note below) — file existence + a hash
// comparison only.
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
// do — UV_SHA256 below is keyed to this exact version, so a stale
// entry (or a missing one for a new triple) fails the download loudly
// rather than silently trusting whatever the release server returns.
const UV_VERSION = "0.11.28";
const UV_RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;

// Sha256 of each release archive for UV_VERSION, pinned IN THIS REPO
// rather than fetched alongside the archive at install time — fetching
// `<asset>.sha256` from the same GitHub release/CDN as `<asset>` itself
// only catches transport corruption, not a compromised release (an
// attacker able to swap the archive can swap its checksum file too).
// This map is the actual supply-chain pin.
//
// Obtained 2026-07-12 by downloading
// https://github.com/astral-sh/uv/releases/download/0.11.28/<asset>.sha256
// for each triple below and cross-checking every value against that
// same release's aggregate `sha256.sum` manifest (both agreed). Covers
// this app's desktop build targets (macOS arm64 + x64, Windows x64,
// Linux x64 glibc) — fetch-uv.mjs refuses to install (see main()) for
// any triple without an entry here rather than falling back to an
// unpinned download. Add an entry the same way (and re-verify all of
// them) before building for a new triple, and regenerate every entry
// here when UV_VERSION bumps.
const UV_SHA256 = {
  "aarch64-apple-darwin": "33540eb7c883ab857eff79bd5ac2aa31fe27b595abecb4a9c003a2c998447232",
  "x86_64-apple-darwin": "2ad79983127ffca7d77b77ce6a24278d7e4f7b817a1acf72fea5f8124b4aac5e",
  "x86_64-pc-windows-msvc": "0a23463216d09c6a72ff80ef5dc5a795f07dc1575cb84d24596c2f124a441b7b",
  "x86_64-unknown-linux-gnu": "e490a6464492183c5d4534a5527fb4440f7f2bb2f228162ad7e4afe076dc0224",
};

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

// binaries/.uv-<triple>.sha256 — a machine-local record of the LAST
// verified install, written only after a freshly-downloaded archive has
// already passed the UV_SHA256 check below. Trust chain: repo-pinned
// archive digest (UV_SHA256) -> verified archive (hash-checked before
// extraction) -> recorded binary digest (this file, so a later run can
// confirm the installed binary is untouched WITHOUT executing it — the
// UV_SHA256 pin is of the ARCHIVE, not the extracted binary, so it
// can't be reused directly to check the installed file). Line 1 is the
// UV_VERSION it was installed from (so a version bump invalidates a
// stale sidecar even though the binary file on disk hasn't changed);
// line 2 is the binary's own sha256.
function sidecarHashPath(triple) {
  return join(binariesDir, `.uv-${triple}.sha256`);
}

function isAlreadyCorrect(triple, binPath) {
  const sidecarPath = sidecarHashPath(triple);
  if (!existsSync(binPath) || !existsSync(sidecarPath)) return false;
  try {
    const [recordedVersion, recordedHash] = readFileSync(sidecarPath, "utf8")
      .trim()
      .split("\n")
      .map((s) => s.trim());
    return recordedVersion === UV_VERSION && recordedHash === sha256Hex(binPath);
  } catch {
    // Sidecar present but unreadable/malformed — treat as absent and
    // re-verify from scratch rather than trusting a binary we can't
    // confirm.
    return false;
  }
}

async function main() {
  const triple = targetTriple();
  const exe = process.platform === "win32" ? ".exe" : "";
  const binPath = join(binariesDir, `uv-${triple}${exe}`);

  if (isAlreadyCorrect(triple, binPath)) {
    log(`binaries/uv-${triple}${exe} already present at ${UV_VERSION} (binary sha256 matches recorded sidecar digest) — skipping download`);
    return;
  }

  const expectedHash = UV_SHA256[triple];
  if (!expectedHash) {
    throw new Error(
      `no pinned sha256 for triple "${triple}" (uv ${UV_VERSION}) in UV_SHA256 (scripts/fetch-uv.mjs) — ` +
        `download ${UV_RELEASE_BASE}/${uvAssetName(triple)}.sha256, verify it against that release's ` +
        `sha256.sum manifest, and add it before building on this platform`
    );
  }

  mkdirSync(binariesDir, { recursive: true });

  const assetName = uvAssetName(triple);
  const assetUrl = `${UV_RELEASE_BASE}/${assetName}`;

  log(`downloading ${assetName} (uv ${UV_VERSION}, ${triple})`);
  const archive = await download(assetUrl);

  const tmpDir = mkdtempSync(join(tmpdir(), "jargonslayer-fetch-uv-"));
  try {
    const archivePath = join(tmpDir, assetName);
    writeFileSync(archivePath, archive);

    const actualHash = sha256Hex(archivePath);
    if (actualHash !== expectedHash) {
      throw new Error(
        `sha256 mismatch for ${assetName}: expected ${expectedHash} (pinned in scripts/fetch-uv.mjs), got ${actualHash} — refusing to install`
      );
    }
    log(`sha256 verified against pinned digest (${actualHash})`);

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

  const binaryHash = sha256Hex(binPath);
  writeFileSync(sidecarHashPath(triple), `${UV_VERSION}\n${binaryHash}\n`);
  log(`installed ${binPath} (uv ${UV_VERSION}, sha256 ${binaryHash})`);
}

main().catch((err) => {
  console.error(`[fetch-uv] ${err.stack || err}`);
  process.exit(1);
});
