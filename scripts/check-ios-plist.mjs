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
console.log("check-ios-plist: privacy usage strings present");
