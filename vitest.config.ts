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
    // v0.7.9 coverage pass: coverage is a ROOT concern (projects can't
    // carry their own), opt-in via `npm run test:coverage` (plain `npm
    // test` stays uninstrumented for speed). `include` lists the product
    // source trees EXPLICITLY — Vitest 4 otherwise reports only files a
    // test happened to load, which is how 14 files (page.tsx, the whole
    // extension side panel…) stayed invisible at "85% overall" before
    // this pass. scripts/ is deliberately not included: it's build
    // orchestration where a 0% file is usually correct, and folding it in
    // would turn the floor into noise. Thresholds sit a few points under
    // the measured 2026-08 baselines (stmts 81.1 / br 77.6 / fn 77.1 /
    // lines 82.3, include-all denominators) — a landing PR that drops a
    // big dark module fails; routine refactors don't. Re-baseline the
    // floors upward deliberately as the dark spots close, never downward
    // to make a red run pass.
    coverage: {
      provider: "v8",
      include: [
        "packages/core/src/**/*.ts",
        "apps/web/src/**/*.{ts,tsx}",
        "apps/extension/src/**/*.ts",
      ],
      exclude: ["**/__tests__/**", "**/*.test.*", "**/*.d.ts"],
      reporter: ["text-summary"],
      thresholds: {
        statements: 77,
        branches: 72,
        functions: 73,
        lines: 79,
      },
    },
  },
});
