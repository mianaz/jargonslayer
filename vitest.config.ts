import { defineConfig } from "vitest/config";

// #53 workspace extraction: a single root `npm test` runs the full
// suite across every workspace package — each of packages/core and
// apps/web keeps its own vitest.config.ts (aliases, jsdom opt-in,
// environment defaults), auto-discovered here via Vitest's `projects`
// glob (the current, non-deprecated replacement for the old standalone
// vitest.workspace.ts file).
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
