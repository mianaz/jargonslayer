import { defineManifest } from "@crxjs/vite-plugin";

import pkg from "./package.json";

// MV3 manifest (PLAN-v0.4 S6, §1C decision): side panel is the whole
// app; the service worker (src/background/service-worker.ts) is a
// stateless coordinator that only sets the toolbar-click-opens-panel
// behavior. No content scripts, no remote code execution — permissions
// stay minimal on purpose (Chrome review friction; see the S6 report).
// "storage" backs the src/storage/savedLookups.ts 收藏 stub; "sidePanel"
// is required to open/configure the panel itself.
//
// v0.6 remote packs: host_permissions scoped to exactly the two
// jargonslayer-dicts catalog hosts (raw.githubusercontent.com and the
// jsDelivr gh mirror), path-prefixed to this project's own repo — not
// the bare host and not <all_urls> — so storage/dictCatalog.ts and
// storage/remotePacks.ts can fetch() the catalog index and pack
// manifests. Both hosts already serve `access-control-allow-origin: *`,
// so this isn't strictly required for the fetch to succeed (ordinary
// CORS already allows it), but it's the honest, least-privilege
// declaration of what this app actually reaches over the network.
export default defineManifest({
  manifest_version: 3,
  name: "JargonSlayer Lite",
  description:
    "Live English captions from your mic + instant Chinese explanations for idioms, jargon, and terms (英文实时黑话详解，无需登录).",
  version: pkg.version,
  icons: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  },
  action: {
    default_title: "JargonSlayer Lite",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  background: {
    service_worker: "src/background/service-worker.ts",
  },
  permissions: ["sidePanel", "storage"],
  host_permissions: [
    "https://raw.githubusercontent.com/mianaz/jargonslayer-dicts/*",
    "https://cdn.jsdelivr.net/gh/mianaz/jargonslayer-dicts@*",
  ],
});
