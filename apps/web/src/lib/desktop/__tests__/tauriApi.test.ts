// v0.4 S3 chunk 5 — outside a Tauri build (NEXT_PUBLIC_DESKTOP/
// NEXT_PUBLIC_IOS both unset in the test env, same default every other
// build-flag test in this codebase relies on — see e.g. llmTransport.
// test.ts's own "false by default" case), every getter must throw
// SYNCHRONOUSLY before ever reaching its `import()` — no @tauri-apps/*
// package needs to exist or resolve for this file's own tests to pass.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAddPluginListener, getAppVersion, getInvoke, getListen, getOpener, getTauriFetch } from "../tauriApi";

describe("tauriApi — outside a Tauri build", () => {
  it("getInvoke throws synchronously, never returns a pending promise", () => {
    expect(() => getInvoke()).toThrow(/Tauri build/);
  });

  it("getListen throws synchronously", () => {
    expect(() => getListen()).toThrow(/Tauri build/);
  });

  it("getTauriFetch throws synchronously", () => {
    expect(() => getTauriFetch()).toThrow(/Tauri build/);
  });

  // S10 field-fix, Chunk A
  it("getOpener throws synchronously", () => {
    expect(() => getOpener()).toThrow(/Tauri build/);
  });

  it("getAppVersion throws synchronously", () => {
    expect(() => getAppVersion()).toThrow(/Tauri build/);
  });

  // S13 (docs/design-explorations/s13-ios-blueprint.md, §6)
  it("getAddPluginListener throws synchronously", () => {
    expect(() => getAddPluginListener()).toThrow(/Tauri build/);
  });
});

// S13 (§6 D4) — TAURI_BUILD gate: NEXT_PUBLIC_IOS=1 (with
// NEXT_PUBLIC_DESKTOP unset) must ALSO pass the gate, not just
// NEXT_PUBLIC_DESKTOP=1 — this is the whole reason D4 exists (an iOS
// build sets NEXT_PUBLIC_IOS, not NEXT_PUBLIC_DESKTOP; every getter
// above would otherwise throw on every invoke()/listen()/fetch() call).
// TAURI_BUILD is read from a module-level literal at import time (same
// as IS_DESKTOP/IS_IOS), so this needs a fresh dynamic import under
// vi.resetModules() — mirrors platform/__tests__/nextConfigDesktopFlag.
// test.ts's own pattern for next.config.mjs. `@tauri-apps/*` packages
// ARE present in node_modules (real deps of this app), so the getters'
// own dynamic import()s resolve for real here — this test only checks
// the SYNCHRONOUS gate, never awaits/uses the resolved invoke/listen/
// fetch functions themselves (calling them for real would require an
// actual Tauri runtime).
describe("tauriApi — TAURI_BUILD gate accepts NEXT_PUBLIC_IOS=1", () => {
  const ENV_KEYS = ["NEXT_PUBLIC_DESKTOP", "NEXT_PUBLIC_IOS"] as const;
  type EnvKey = (typeof ENV_KEYS)[number];
  const savedEnv: Partial<Record<EnvKey, string | undefined>> = {};

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

  it("getInvoke does not throw when only NEXT_PUBLIC_IOS=1 is set", async () => {
    delete process.env.NEXT_PUBLIC_DESKTOP;
    process.env.NEXT_PUBLIC_IOS = "1";
    vi.resetModules();
    const mod = await import("../tauriApi");
    expect(() => mod.getInvoke()).not.toThrow();
  });

  it("getAddPluginListener does not throw when only NEXT_PUBLIC_IOS=1 is set", async () => {
    delete process.env.NEXT_PUBLIC_DESKTOP;
    process.env.NEXT_PUBLIC_IOS = "1";
    vi.resetModules();
    const mod = await import("../tauriApi");
    expect(() => mod.getAddPluginListener()).not.toThrow();
  });
});
