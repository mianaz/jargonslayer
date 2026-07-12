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
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
