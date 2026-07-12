// F2 (codex v04-integration review) — flag containment: apps/web/
// next.config.mjs must never forward the ambient NEXT_PUBLIC_LLM_
// TRANSPORT env var into a non-desktop build (see that file's own
// comment for the full rationale — a shared CI env var must never
// silently flip the hosted web app off its /api/* path). This locks
// in the env-forwarding EXPRESSION itself by dynamically importing the
// real next.config.mjs under controlled process.env combinations.
//
// This does NOT prove webpack's DefinePlugin actually inlines the
// resulting value into the client bundle the same way at build time —
// next.config.mjs only runs through Next's own build tooling, not
// vitest. That empirical half of the verification (build with
// NEXT_PUBLIC_LLM_TRANSPORT=client and no BUILD_TARGET, then grep the
// output bundle for the flag value) is documented in this fix's commit
// body instead, mirroring this file's own precedent for
// NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT ("verified empirically —
// bundle inspection").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["BUILD_TARGET", "NEXT_PUBLIC_LLM_TRANSPORT"] as const;
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

describe("next.config.mjs — NEXT_PUBLIC_LLM_TRANSPORT containment (F2)", () => {
  it("BUILD_TARGET=desktop forwards the ambient NEXT_PUBLIC_LLM_TRANSPORT value through unchanged", async () => {
    const config = await loadConfig({ BUILD_TARGET: "desktop", NEXT_PUBLIC_LLM_TRANSPORT: "client" });
    expect(config.env.NEXT_PUBLIC_LLM_TRANSPORT).toBe("client");
  });

  it('no BUILD_TARGET (an ordinary hosted-web build) pins the flag to "server", even when the ambient env var says "client"', async () => {
    const config = await loadConfig({ NEXT_PUBLIC_LLM_TRANSPORT: "client" });
    expect(config.env.NEXT_PUBLIC_LLM_TRANSPORT).toBe("server");
  });

  it('BUILD_TARGET set to something other than "desktop" also pins to "server", not just an unset BUILD_TARGET', async () => {
    const config = await loadConfig({ BUILD_TARGET: "web", NEXT_PUBLIC_LLM_TRANSPORT: "client" });
    expect(config.env.NEXT_PUBLIC_LLM_TRANSPORT).toBe("server");
  });

  it('no BUILD_TARGET and no ambient NEXT_PUBLIC_LLM_TRANSPORT at all still pins explicitly to "server" (not an empty string)', async () => {
    const config = await loadConfig({});
    expect(config.env.NEXT_PUBLIC_LLM_TRANSPORT).toBe("server");
  });

  it("BUILD_TARGET=desktop with NO ambient NEXT_PUBLIC_LLM_TRANSPORT still forwards through to an empty string (desktop builds that forgot to set it keep today's inert default, not a hardcoded server/client)", async () => {
    const config = await loadConfig({ BUILD_TARGET: "desktop" });
    expect(config.env.NEXT_PUBLIC_LLM_TRANSPORT).toBe("");
  });
});
