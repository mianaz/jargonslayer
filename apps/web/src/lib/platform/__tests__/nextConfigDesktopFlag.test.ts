// v0.4 S3 chunk 1 — NEXT_PUBLIC_DESKTOP containment: locks in next.config.
// mjs's env-forwarding EXPRESSION for the desktop-context flag (see that
// file's own comment, and src/lib/platform/desktop.ts's IS_DESKTOP, for
// the full rationale). Mirrors apps/web/src/lib/llm/__tests__/
// nextConfigTransportFlag.test.ts's pattern exactly: dynamically imports
// the real next.config.mjs under controlled process.env combinations.
//
// This does NOT prove webpack's DefinePlugin actually inlines the
// resulting value into the client bundle the same way at build time —
// next.config.mjs only runs through Next's own build tooling, not
// vitest. That empirical half of the verification (build with
// BUILD_TARGET=desktop, then grep apps/web/out/ for the flag value) is
// documented in this chunk's commit body instead, same precedent as the
// two flags this file's sibling test covers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["BUILD_TARGET"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const savedEnv: Partial<Record<EnvKey, string | undefined>> = {};

async function loadConfig(env: Partial<Record<EnvKey, string>>): Promise<{ env: Record<string, string> }> {
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  vi.resetModules();
  const mod = (await import("../../../../next.config.mjs")) as {
    default: { env: Record<string, string> };
  };
  return mod.default;
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.resetModules();
});

describe("next.config.mjs — NEXT_PUBLIC_DESKTOP containment (S3 chunk 1)", () => {
  it('BUILD_TARGET=desktop sets the flag to "1"', async () => {
    const config = await loadConfig({ BUILD_TARGET: "desktop" });
    expect(config.env.NEXT_PUBLIC_DESKTOP).toBe("1");
  });

  it('no BUILD_TARGET (an ordinary hosted-web build) pins the flag to "" (not "1")', async () => {
    const config = await loadConfig({});
    expect(config.env.NEXT_PUBLIC_DESKTOP).toBe("");
  });

  it('BUILD_TARGET set to something other than "desktop" also pins to "", not just an unset BUILD_TARGET', async () => {
    const config = await loadConfig({ BUILD_TARGET: "web" });
    expect(config.env.NEXT_PUBLIC_DESKTOP).toBe("");
  });
});
