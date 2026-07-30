import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Keep Vitest on this worktree's core source, matching the
      // TypeScript path mapping. Without this, a linked node_modules
      // workspace can resolve @jargonslayer/core from a sibling checkout.
      "@jargonslayer/core": path.resolve(__dirname, "../../packages/core/src"),
    },
  },
  // tsconfig.json's jsx:"preserve" is for Next.js's own compiler —
  // vite/vitest's own transform (oxc, this vite version's default)
  // otherwise inherits that "preserve" setting and leaves raw JSX
  // unparsed. No new dependency: oxc ships with vite/vitest already.
  oxc: {
    jsx: { runtime: "automatic" },
  },
  test: {
    environment: "node",
    // .tsx only exists for a component render test that needs JSX
    // (see components/__tests__/TranscriptPanel.render.test.tsx) —
    // that file opts into jsdom itself via a `// @vitest-environment
    // jsdom` docblock, same pattern as lib/theme/__tests__; the
    // project-wide default here stays "node" for everything else.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
