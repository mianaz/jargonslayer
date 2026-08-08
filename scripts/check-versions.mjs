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
//
// The extraction/comparison logic is exported (and the side-effecting run
// gated behind an is-main check) so scripts/__tests__/check-versions.test.mjs
// can pin the regexes and the exact-vs-startsWith site rules — the whole
// script IS those few patterns, and before the test the only guard on them
// was "CI happened to pass today".
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

/** The `[package]` section's own version from Cargo.toml text — the single
 *  source every other site is compared against. */
export function extractCargoPackageVersion(cargoToml) {
  return cargoToml.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
}

/** `SomeKey: value` / `SomeKey: "value"` from XcodeGen's project.yml. */
export function extractProjectYmlVersion(projectYml, key) {
  return projectYml.match(new RegExp(`${key}:\\s*"?([^"\\s]+)"?`))?.[1];
}

/** `<key>SomeKey</key><string>value</string>` from a generated Info.plist. */
export function extractPlistVersion(plist, key) {
  return plist.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`),
  )?.[1];
}

/** Compare every site against the Cargo.toml source version. `exact` sites
 *  must match verbatim; `shortVersionSites` likewise (they're marketing
 *  versions); `buildVersionSites` only have to START WITH the source —
 *  CFBundleVersion may carry a trailing .N for a re-upload of the same
 *  release (check-ios-plist.mjs documents the same convention). A missing
 *  value (extraction came back undefined) is its own loud error, never a
 *  silent pass. */
export function collectVersionErrors(source, { exact = {}, shortVersionSites = {}, buildVersionSites = {} }) {
  const errors = [];
  for (const [site, version] of Object.entries(exact)) {
    if (version !== source) {
      errors.push(`${site}: "${version}" !== Cargo.toml "${source}"`);
    }
  }
  for (const [site, version] of Object.entries(shortVersionSites)) {
    if (!version) {
      errors.push(`${site}: not found`);
    } else if (version !== source) {
      errors.push(`${site}: "${version}" !== Cargo.toml "${source}"`);
    }
  }
  for (const [site, version] of Object.entries(buildVersionSites)) {
    if (!version) {
      errors.push(`${site}: not found`);
    } else if (!version.startsWith(source)) {
      errors.push(`${site}: "${version}" does not start with Cargo.toml "${source}"`);
    }
  }
  return errors;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const path = (p) => join(root, p);
  const readJSON = (p) => JSON.parse(readFileSync(path(p), "utf8"));

  const cargoToml = readFileSync(path("apps/desktop/src-tauri/Cargo.toml"), "utf8");
  const source = extractCargoPackageVersion(cargoToml);
  if (!source) {
    console.error("check-versions: could not read [package] version from apps/desktop/src-tauri/Cargo.toml");
    process.exit(1);
  }

  // Exact match required: these are all plain version strings with no build-
  // number convention of their own.
  const exact = {
    "apps/web/package.json": readJSON("apps/web/package.json").version,
    "packages/core/package.json": readJSON("packages/core/package.json").version,
    "apps/extension/package.json": readJSON("apps/extension/package.json").version,
    "apps/desktop/package.json": readJSON("apps/desktop/package.json").version,
    "apps/desktop/src-tauri/tauri.conf.json": readJSON("apps/desktop/src-tauri/tauri.conf.json").version,
  };

  // project.yml is the XcodeGen regen template for the generated Info.plist;
  // tauri ios build rewrites Info.plist's CFBundleShortVersionString from
  // tauri.conf.json on every build, so this entry is a template copy that
  // drifts silently unless checked (see the comment beside it in project.yml).
  const projectYml = readFileSync(path("apps/desktop/src-tauri/gen/apple/project.yml"), "utf8");
  const plist = readFileSync(path("apps/desktop/src-tauri/gen/apple/jargonslayer_iOS/Info.plist"), "utf8");

  const shortVersionSites = {
    "apps/desktop/src-tauri/gen/apple/project.yml (CFBundleShortVersionString)":
      extractProjectYmlVersion(projectYml, "CFBundleShortVersionString"),
    "apps/desktop/src-tauri/gen/apple/jargonslayer_iOS/Info.plist (CFBundleShortVersionString)":
      extractPlistVersion(plist, "CFBundleShortVersionString"),
  };

  // CFBundleVersion is the build number, not the marketing version — see
  // collectVersionErrors' doc comment for the startsWith convention.
  const buildVersionSites = {
    "apps/desktop/src-tauri/gen/apple/project.yml (CFBundleVersion)":
      extractProjectYmlVersion(projectYml, "CFBundleVersion"),
    "apps/desktop/src-tauri/gen/apple/jargonslayer_iOS/Info.plist (CFBundleVersion)":
      extractPlistVersion(plist, "CFBundleVersion"),
  };

  const errors = collectVersionErrors(source, { exact, shortVersionSites, buildVersionSites });

  if (errors.length) {
    console.error(`check-versions: version drift against Cargo.toml [package] "${source}":`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error("Stamp every site to the same version before tagging a release.");
    process.exit(1);
  }

  console.log(`check-versions: all version sites agree on ${source}`);
}
