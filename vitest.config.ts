import { defineConfig } from "vitest/config";

// #53 workspace extraction: a single root `npm test` runs the full
// suite across every workspace package — each of packages/core and
// apps/web keeps its own vitest.config.ts (aliases, jsdom opt-in,
// environment defaults), auto-discovered here via Vitest's `projects`
// glob (the current, non-deprecated replacement for the old standalone
// vitest.workspace.ts file).
export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "apps/*",
      // scripts/ has no package.json of its own, so it can't be picked up
      // by the directory globs above — without this inline project a test
      // under scripts/__tests__/ would sit there green-looking and never
      // execute (which is exactly what happened to the sidecar suite
      // before v0.7.5 wired it into CI).
      {
        test: {
          name: "scripts",
          environment: "node",
          include: ["scripts/**/__tests__/**/*.test.mjs"],
        },
      },
    ],
  },
});
