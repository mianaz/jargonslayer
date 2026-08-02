import path from "node:path";
import { defineConfig } from "vitest/config";

// Same non-jsdom, node-env posture as packages/core (see that
// package's vitest.config.ts): every test here is either pure logic
// (translate/availability.ts's reducer) or a chrome.storage.local
// mock — none of it needs a real DOM. The panel's actual DOM
// rendering (sidepanel/render.ts) is verified manually via
// load-unpacked + the `vite build` gate instead (see the PLAN-v0.4 S6
// report for why: no real Chrome 138+ builtin-AI globals or side
// panel host exist under vitest/node either way).
export default defineConfig({
  resolve: {
    alias: {
      // Same guard apps/web already carries, and this workspace needs it
      // for the same reason: seven test files here import
      // @jargonslayer/core, tsconfig.json maps it to ../../packages/core/src,
      // and vitest did not. With no node_modules in a linked worktree,
      // resolution walks up to the PARENT checkout's symlink and the tests
      // silently exercise a different checkout's core.
      "@jargonslayer/core": path.resolve(__dirname, "../../packages/core/src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
