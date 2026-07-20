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
//   2. SIGINT/SIGTERM handlers that forward the signal to the `next
//      build` child and wait for it to actually exit before restoring.
//      This needs the child spawned ASYNCHRONOUSLY (plain `spawn`, not
//      `spawnSync`): a blocking spawnSync call prevents Node from
//      running ANY JS signal handler until the child exits on its own,
//      so a signal delivered to just this parent process (e.g. a CI
//      runner enforcing a job timeout) would go unhandled long enough
//      that the runner's follow-up SIGKILL — which can't be caught at
//      all — kills everything mid-build with the rename never undone.
//      Async `spawn` keeps the event loop free so the handler below can
//      respond immediately instead of blocking on the whole build.
//   3. The normal try/finally, for every other exit path (success,
//      `next build` failing on its own, an unexpected throw).
// S13 (docs/design-explorations/s13-ios-blueprint.md §D5/F4) — iOS static
// export hits the exact same app/api-under-output:"export" wall as desktop
// (see the header above), so this wrapper is parameterized by BUILD_TARGET
// instead of forking a second script: default "desktop" is byte-identical
// to pre-S13 behavior; "ios" runs the same strip/build/restore flow but
// forwards BUILD_TARGET=ios to the child build so next.config.mjs emits
// NEXT_PUBLIC_IOS instead of NEXT_PUBLIC_DESKTOP (Lane C). Any other/unset
// value falls back to "desktop" rather than propagating an unrecognized
// target string into the child env.
import { existsSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const buildTarget = process.env.BUILD_TARGET === "ios" ? "ios" : "desktop";

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

// Set once the build child is spawned; used by onSignal to decide
// whether there's a live child to forward the signal to, and by
// runBuild's own close handler so onSignal never mistakes a child that
// already exited for one that's still running.
let child = null;
let childClosed = false;

function runBuild() {
  return new Promise((resolve, reject) => {
    child = spawn("npm", ["run", "build", "-w", "apps/web"], {
      stdio: "inherit",
      env: {
        ...process.env,
        BUILD_TARGET: buildTarget,
        // Same client-side callProvider transport on both targets — neither
        // has an /api/* to fall back to (see next.config.mjs's dual-target
        // hook comment).
        NEXT_PUBLIC_LLM_TRANSPORT: "client",
      },
    });
    child.once("error", (err) => {
      childClosed = true;
      reject(err);
    });
    child.once("close", (code, signal) => {
      childClosed = true;
      resolve({ code, signal });
    });
  });
}

// Set as soon as a signal arrives, so the `await runBuild()` continuation
// below knows the (eventual, possibly signal-caused) child exit was one
// we asked for, and restores + exits with the conventional 128+signum
// code instead of treating it as a plain build failure.
let shuttingDownSignal = null;

function onSignal(signal) {
  if (shuttingDownSignal) return;
  shuttingDownSignal = signal;
  if (child && !childClosed) {
    console.log(
      `\n[build-desktop] ${signal} received — forwarding to the build and waiting for it to exit before restoring apps/web/src/app/api`
    );
    child.kill(signal);
    return;
  }
  // No live child (signal arrived before spawn, or after it already
  // closed) — nothing to wait on, restore and exit right away.
  console.log(`\n[build-desktop] ${signal} received — restoring apps/web/src/app/api before exiting`);
  restoreOnce();
  process.exit(signal === "SIGINT" ? 130 : 143);
}
process.once("SIGINT", () => onSignal("SIGINT"));
process.once("SIGTERM", () => onSignal("SIGTERM"));

try {
  renameSync(apiDir, disabledDir);
  console.log(
    `[build-desktop] apps/web/src/app/api -> _api_disabled (temporary, restored after this build) [BUILD_TARGET=${buildTarget}]`
  );

  const { code, signal } = await runBuild();
  if (shuttingDownSignal) {
    console.log(`[build-desktop] build exited after ${shuttingDownSignal} — restoring apps/web/src/app/api`);
    restoreOnce();
    process.exit(shuttingDownSignal === "SIGINT" ? 130 : 143);
  }
  process.exitCode = signal ? 1 : code ?? 1;
} finally {
  restoreOnce();
}
