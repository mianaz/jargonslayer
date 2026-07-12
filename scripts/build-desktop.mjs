// v0.4 S3 chunk 1 (docs/design-explorations/s3-tauri-uv-blueprint.md) —
// desktop web build: produces the static-export bundle Tauri's webview
// loads (apps/web/out/), via BUILD_TARGET=desktop + NEXT_PUBLIC_LLM_
// TRANSPORT=client (S2's client-side callProvider path — a desktop
// build has no /api/* to fall back to at all, see next.config.mjs's
// own dual-target-hook comment).
//
// next's output:"export" (static export) cannot coexist with app/api/*
// route handlers (server-only code, no static params) — see next.
// config.mjs's dual-target hook comment. This script works around that
// by TEMPORARILY renaming apps/web/src/app/api out of the app dir for
// the duration of the `next build` call, then renaming it back.
//
// Signal-safety is the whole point of this file (the blueprint's own
// "gotcha" callout): a bare try/finally does NOT run on SIGINT/SIGTERM
// the way it does on a normal thrown error — without an explicit signal
// handler, Ctrl-C (or a CI job killed mid-build) leaves `_api_disabled`
// renamed on disk. Left renamed, that would 404 the very next PLAIN
// `npm run build` (app/api routes silently missing from the app dir)
// and every future desktop build, until someone notices and renames it
// back by hand. Three layers guard against that:
//   1. A stale-rename check BEFORE doing anything else: if a previous
//      run crashed (kill -9, power loss) between rename-out and
//      rename-back, `_api_disabled` is restored first, so this run
//      always starts from a clean, known state.
//   2. SIGINT/SIGTERM handlers that restore before exiting.
//   3. The normal try/finally, for every other exit path (success,
//      `next build` failing on its own, an unexpected throw).
import { existsSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps", "web", "src", "app");
const apiDir = join(appDir, "api");
const disabledDir = join(appDir, "_api_disabled");

function restoreApiDir() {
  if (existsSync(disabledDir) && !existsSync(apiDir)) {
    renameSync(disabledDir, apiDir);
    console.log("[build-desktop] restored apps/web/src/app/api");
  }
}

// Stale-rename detection: restore before doing anything else, so a
// crashed previous run can never wedge every subsequent build (desktop
// OR plain web).
if (existsSync(disabledDir)) {
  if (existsSync(apiDir)) {
    // Both exist — genuinely unexpected (manual tampering, or a
    // rename that somehow partially duplicated the tree). Refuse to
    // guess which one is authoritative rather than silently deleting
    // either.
    console.error(
      "[build-desktop] both apps/web/src/app/api and apps/web/src/app/_api_disabled " +
        "exist — resolve manually (compare + remove the stale one) before running this script again."
    );
    process.exit(1);
  }
  console.log("[build-desktop] found a stale _api_disabled from a previous crashed run — restoring it first");
  restoreApiDir();
}

let restored = false;
function restoreOnce() {
  if (restored) return;
  restored = true;
  restoreApiDir();
}

function onSignal(signal) {
  console.log(`\n[build-desktop] ${signal} received — restoring apps/web/src/app/api before exiting`);
  restoreOnce();
  process.exit(signal === "SIGINT" ? 130 : 143);
}
process.once("SIGINT", () => onSignal("SIGINT"));
process.once("SIGTERM", () => onSignal("SIGTERM"));

try {
  renameSync(apiDir, disabledDir);
  console.log("[build-desktop] apps/web/src/app/api -> _api_disabled (temporary, restored after this build)");

  const result = spawnSync("npm", ["run", "build", "-w", "apps/web"], {
    stdio: "inherit",
    env: {
      ...process.env,
      BUILD_TARGET: "desktop",
      NEXT_PUBLIC_LLM_TRANSPORT: "client",
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  restoreOnce();
}
