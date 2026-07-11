import { defineConfig } from "vitest/config";

// Pure package — no jsdom, no path aliases (every internal import is
// relative). Mirrors the root vitest.config.ts's non-jsdom defaults
// (see apps/web/vitest.config.ts for the app's own jsdom opt-in
// pattern); this package has no reason to ever opt into jsdom at all.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
