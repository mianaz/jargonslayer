// Copies the ffmpeg.wasm runtime trio out of node_modules into
// public/ffmpeg (gitignored) so the browser loads them SAME-ORIGIN.
// Why not CDN + toBlobURL (the ffmpeg.wasm README pattern): a Worker
// constructed from a blob: URL cannot dynamically import() anything
// (null base/origin) — load() hangs forever with zero console output;
// found by live E2E 2026-07-06 after two dead ends (bundler-mangled
// internal worker URL, then blob classWorkerURL). Same-origin real
// URLs make the class worker a normal module worker whose
// import(coreURL) is plain same-origin ESM. Versions are pinned exact
// in package.json; this script runs on postinstall so dev, CI, and
// the oracle deploy all stay in sync.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "ffmpeg");
mkdirSync(out, { recursive: true });

const files = [
  // worker.js statically imports ./const.js and ./errors.js — a module
  // worker whose imports 404 dies at graph-load time with a bare
  // `error` event the FFmpeg class never handles (load() hangs).
  ["node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js", "worker.js"],
  ["node_modules/@ffmpeg/ffmpeg/dist/esm/const.js", "const.js"],
  ["node_modules/@ffmpeg/ffmpeg/dist/esm/errors.js", "errors.js"],
  ["node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js", "ffmpeg-core.js"],
  ["node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm", "ffmpeg-core.wasm"],
];
for (const [src, dst] of files) {
  copyFileSync(join(root, src), join(out, dst));
}
console.log("[copy-ffmpeg-assets] public/ffmpeg ready (worker.js + core js/wasm)");
