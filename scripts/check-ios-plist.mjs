// S13 review fix S4 (Sol HIGH, empirically reproduced): the generated
// gen/apple/jargonslayer_iOS/Info.plist is OWNED by XcodeGen/project.yml
// and the config-dir Info.ios.plist auto-merge does NOT fire at
// `tauri ios init` — so a regen can silently drop the privacy usage
// strings. A missing NSMicrophoneUsageDescription is a hard process-kill
// the moment the app touches the mic, with zero signal at build time.
// This guard runs before every iOS app build (package.json dev:ios /
// build:ios-app) and fails loudly instead. Layered with the same keys in
// gen/apple/project.yml info.properties (survives XcodeGen regens); this
// script catches full `tauri ios init` re-runs that rewrite project.yml.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plist = join(root, "apps/desktop/src-tauri/gen/apple/jargonslayer_iOS/Info.plist");
const REQUIRED = ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"];

let text;
try {
  text = readFileSync(plist, "utf8");
} catch {
  console.error(`check-ios-plist: ${plist} missing — run \`npx tauri ios init\` first, then re-add the privacy keys (see gen/apple/project.yml info.properties).`);
  process.exit(1);
}
const missing = REQUIRED.filter((k) => !text.includes(`<key>${k}</key>`));
if (missing.length) {
  console.error(`check-ios-plist: ${missing.join(", ")} missing from ${plist} — a tauri ios init/XcodeGen regen dropped the privacy strings (S13 blueprint §6). Restore them from gen/apple/project.yml info.properties before building; shipping without them kills the process at first mic access.`);
  process.exit(1);
}

// TestFlight round hardening (empirically caught 2026-07-25): the build
// consumes THIS generated plist directly — `tauri ios build` re-runs
// neither XcodeGen nor the config-dir merge, so project.yml's version
// bump never flows here on its own, and the app shipped stamped 1.0.0
// while every other surface said 0.6.0. The version's single source is
// Cargo.toml [package] (drives the desktop DMG too); this guard now
// fails the build on drift instead of trusting the release-train memo.
const cargo = readFileSync(join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8");
const cargoVersion = cargo.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
const plistVersion = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
if (!cargoVersion || !plistVersion || !plistVersion.startsWith(cargoVersion)) {
  console.error(`check-ios-plist: CFBundleShortVersionString "${plistVersion}" ≠ Cargo.toml package version "${cargoVersion}" — edit gen/apple/jargonslayer_iOS/Info.plist (the file the build actually uses) AND gen/apple/project.yml (the regen template) together. CFBundleVersion may carry a .N suffix for re-uploads of the same version.`);
  process.exit(1);
}

// Export-compliance key: keeps every TestFlight upload from asking the
// 出口合规 questionnaire (HTTPS/system TLS only → exempt → false).
if (!text.includes("<key>ITSAppUsesNonExemptEncryption</key>")) {
  console.error(`check-ios-plist: ITSAppUsesNonExemptEncryption missing from ${plist} — restore it (see gen/apple/project.yml info.properties) or every ASC upload re-asks export compliance.`);
  process.exit(1);
}

console.log(`check-ios-plist: privacy strings present; version ${plistVersion} matches Cargo.toml ${cargoVersion}; export-compliance key present`);
