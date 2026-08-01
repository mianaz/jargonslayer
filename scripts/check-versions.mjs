// Finding 9 (release-workflow review): the tag-vs-Cargo.toml check in
// release.yml and check-ios-plist.mjs's Cargo.toml-vs-Info.plist check each
// cover ONE pair of version sites. Nothing compared ALL of them, and
// apps/desktop/src-tauri/tauri.conf.json in particular carries its own
// "version" that is never checked — while the release DMG is renamed from
// Cargo.toml's version regardless of what the bundle itself was actually
// stamped with. (This project has shipped a build stamped 1.0.0 while every
// other surface said 0.6.0.) This script is the single place all version
// sites are cross-checked; run it locally before stamping a release and in
// CI so a drifted site fails loudly instead of producing a mislabelled
// artifact.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const path = (p) => join(root, p);
const readJSON = (p) => JSON.parse(readFileSync(path(p), "utf8"));

const cargoToml = readFileSync(path("apps/desktop/src-tauri/Cargo.toml"), "utf8");
const source = cargoToml.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
if (!source) {
  console.error("check-versions: could not read [package] version from apps/desktop/src-tauri/Cargo.toml");
  process.exit(1);
}

const errors = [];
// Exact match required: these are all plain version strings with no build-
// number convention of their own.
const exact = {
  "apps/web/package.json": readJSON("apps/web/package.json").version,
  "packages/core/package.json": readJSON("packages/core/package.json").version,
  "apps/extension/package.json": readJSON("apps/extension/package.json").version,
  "apps/desktop/package.json": readJSON("apps/desktop/package.json").version,
  "apps/desktop/src-tauri/tauri.conf.json": readJSON("apps/desktop/src-tauri/tauri.conf.json").version,
};
for (const [site, version] of Object.entries(exact)) {
  if (version !== source) {
    errors.push(`${site}: "${version}" !== Cargo.toml "${source}"`);
  }
}

// project.yml is the XcodeGen regen template for the generated Info.plist;
// tauri ios build rewrites Info.plist's CFBundleShortVersionString from
// tauri.conf.json on every build, so this entry is a template copy that
// drifts silently unless checked (see the comment beside it in project.yml).
const projectYml = readFileSync(path("apps/desktop/src-tauri/gen/apple/project.yml"), "utf8");
const plist = readFileSync(path("apps/desktop/src-tauri/gen/apple/jargonslayer_iOS/Info.plist"), "utf8");

const shortVersionSites = {
  "apps/desktop/src-tauri/gen/apple/project.yml (CFBundleShortVersionString)":
    projectYml.match(/CFBundleShortVersionString:\s*"?([^"\s]+)"?/)?.[1],
  "apps/desktop/src-tauri/gen/apple/jargonslayer_iOS/Info.plist (CFBundleShortVersionString)":
    plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1],
};
for (const [site, version] of Object.entries(shortVersionSites)) {
  if (!version) {
    errors.push(`${site}: not found`);
  } else if (version !== source) {
    errors.push(`${site}: "${version}" !== Cargo.toml "${source}"`);
  }
}

// CFBundleVersion is the build number, not the marketing version — it may
// carry a trailing .N for a re-upload of the same release (check-ios-plist.mjs
// documents the same convention), so it only has to START WITH the source
// version rather than match it exactly.
const buildVersionSites = {
  "apps/desktop/src-tauri/gen/apple/project.yml (CFBundleVersion)":
    projectYml.match(/CFBundleVersion:\s*"?([^"\s]+)"?/)?.[1],
  "apps/desktop/src-tauri/gen/apple/jargonslayer_iOS/Info.plist (CFBundleVersion)":
    plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1],
};
for (const [site, version] of Object.entries(buildVersionSites)) {
  if (!version) {
    errors.push(`${site}: not found`);
  } else if (!version.startsWith(source)) {
    errors.push(`${site}: "${version}" does not start with Cargo.toml "${source}"`);
  }
}

if (errors.length) {
  console.error(`check-versions: version drift against Cargo.toml [package] "${source}":`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error("Stamp every site to the same version before tagging a release.");
  process.exit(1);
}

console.log(`check-versions: all version sites agree on ${source}`);
