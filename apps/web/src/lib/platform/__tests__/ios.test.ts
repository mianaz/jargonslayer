// S13 (docs/design-explorations/s13-ios-blueprint.md, §6 D4) — IS_IOS/
// IS_TAURI derivation. Both consts are real import-time values baked
// from process.env at module-load time (same as IS_DESKTOP — see
// platform/desktop.ts's own header comment), so exercising every env
// combination needs a fresh dynamic import under vi.resetModules(),
// mirroring lib/platform/__tests__/nextConfigDesktopFlag.test.ts's own
// pattern for next.config.mjs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["NEXT_PUBLIC_DESKTOP", "NEXT_PUBLIC_IOS"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const savedEnv: Partial<Record<EnvKey, string | undefined>> = {};

async function loadFlags(env: Partial<Record<EnvKey, string>>) {
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  vi.resetModules();
  const [ios, desktop] = await Promise.all([import("../ios"), import("../desktop")]);
  return { ...ios, ...desktop };
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

describe("platform/ios — IS_IOS / IS_TAURI derivation", () => {
  it("ambient (neither var set): IS_IOS false, IS_DESKTOP false, IS_TAURI false", async () => {
    const flags = await loadFlags({});
    expect(flags.IS_IOS).toBe(false);
    expect(flags.IS_DESKTOP).toBe(false);
    expect(flags.IS_TAURI).toBe(false);
  });

  it("NEXT_PUBLIC_IOS=1: IS_IOS true, IS_DESKTOP stays false, IS_TAURI true", async () => {
    const flags = await loadFlags({ NEXT_PUBLIC_IOS: "1" });
    expect(flags.IS_IOS).toBe(true);
    expect(flags.IS_DESKTOP).toBe(false);
    expect(flags.IS_TAURI).toBe(true);
  });

  it("NEXT_PUBLIC_DESKTOP=1 alone: IS_IOS false, IS_DESKTOP true, IS_TAURI true (macOS desktop is still a Tauri shell)", async () => {
    const flags = await loadFlags({ NEXT_PUBLIC_DESKTOP: "1" });
    expect(flags.IS_IOS).toBe(false);
    expect(flags.IS_DESKTOP).toBe(true);
    expect(flags.IS_TAURI).toBe(true);
  });

  it("both set: IS_IOS true, IS_DESKTOP true, IS_TAURI true", async () => {
    const flags = await loadFlags({ NEXT_PUBLIC_DESKTOP: "1", NEXT_PUBLIC_IOS: "1" });
    expect(flags.IS_IOS).toBe(true);
    expect(flags.IS_DESKTOP).toBe(true);
    expect(flags.IS_TAURI).toBe(true);
  });
});
