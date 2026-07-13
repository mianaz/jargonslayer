import { defineManifest } from "@crxjs/vite-plugin";

import pkg from "./package.json";

// MV3 manifest (PLAN-v0.4 S6, §1C decision): side panel is the whole
// app; the service worker (src/background/service-worker.ts) is a
// stateless coordinator that only sets the toolbar-click-opens-panel
// behavior. No content scripts, no host_permissions, no remote code —
// permissions stay minimal on purpose (Chrome review friction; see the
// S6 report). "storage" backs the src/storage/savedLookups.ts 收藏
// stub; "sidePanel" is required to open/configure the panel itself.
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
});
