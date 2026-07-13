import { fileURLToPath } from "node:url";

import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";

import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // permission.html (S7 chunk 3's mic first-grant page, blueprint
      // §2 Decision A) is opened dynamically via chrome.tabs.create —
      // it's never referenced by any manifest field (no "just a page
      // the extension opens itself" slot exists), so CRXJS's own
      // manifest-driven emitFile pipeline (side panel, service worker,
      // icons) never picks it up. Declaring it as an extra rollup
      // input is the standard way to get Vite's normal HTML pipeline
      // (script/CSS processing + hashing) to build and emit it
      // anyway. This is purely additive: CRXJS resolves
      // src/sidepanel/index.html, the service worker, and the
      // manifest/icons through a SEPARATE mechanism regardless of
      // what's listed here.
      input: {
        permission: fileURLToPath(new URL("./src/permission/permission.html", import.meta.url)),
      },
    },
  },
});
