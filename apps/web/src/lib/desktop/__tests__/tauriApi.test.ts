// v0.4 S3 chunk 5 — outside a Tauri build (NEXT_PUBLIC_DESKTOP/
// NEXT_PUBLIC_IOS both unset in the test env, same default every other
// build-flag test in this codebase relies on — see e.g. llmTransport.
// test.ts's own "false by default" case), every getter must throw
// SYNCHRONOUSLY before ever reaching its `import()` — no @tauri-apps/*
// package needs to exist or resolve for this file's own tests to pass.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAddPluginListener,
  getAppVersion,
  getInvoke,
  getListen,
  getOpener,
  getProxiedTauriFetch,
  getTauriFetch,
  type TauriFetchFn,
} from "../tauriApi";

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

// W2 desktop proxy support — getProxiedTauriFetch is a plain function
// (no @tauri-apps/* import, no TAURI_BUILD gate of its own), so unlike
// every getter above it needs neither an env stub nor a real Tauri
// runtime: `fetchFn` and `getProxyUrl` are both injected fakes.
describe("getProxiedTauriFetch", () => {
  function makeFakeFetch(): { fetchFn: TauriFetchFn; calls: Array<[URL | Request | string, RequestInit | undefined]> } {
    const calls: Array<[URL | Request | string, RequestInit | undefined]> = [];
    const fetchFn = (async (input: URL | Request | string, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response(null, { status: 200 });
    }) as TauriFetchFn;
    return { fetchFn, calls };
  }

  it("injects proxy.all for a remote URL when proxyUrl is set", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const proxied = getProxiedTauriFetch(fetchFn, () => "http://127.0.0.1:7890");

    await proxied("https://api.anthropic.com/v1/messages", { method: "POST" });

    expect(calls).toHaveLength(1);
    const [, init] = calls[0];
    expect(init).toMatchObject({
      method: "POST",
      proxy: { all: { url: "http://127.0.0.1:7890", noProxy: "localhost,127.0.0.0/8,::1" } },
    });
  });

  it("does NOT inject proxy for a loopback target even when proxyUrl is set", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const proxied = getProxiedTauriFetch(fetchFn, () => "http://127.0.0.1:7890");

    await proxied("http://127.0.0.1:8765/health");
    await proxied("http://localhost:8765/health");
    await proxied("http://[::1]:8765/health");

    expect(calls).toHaveLength(3);
    for (const [, init] of calls) {
      expect(init).toBeUndefined();
    }
  });

  // F6 fix (field-test batch C, Sol M5): the old PROXY_LOOPBACK_HOSTNAMES
  // exact-set only ever matched the ONE conventional 127.0.0.1 address —
  // any other 127/8 alias (e.g. a local LLM server deliberately bound to
  // 127.0.0.2 to avoid colliding with something else on .1) fell through
  // to "not loopback" and got proxied anyway.
  it("does NOT inject proxy for any other 127.0.0.0/8 loopback alias", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const proxied = getProxiedTauriFetch(fetchFn, () => "http://127.0.0.1:7890");

    await proxied("http://127.0.0.2:8765/health");
    await proxied("http://127.99.1.1:8765/health");

    expect(calls).toHaveLength(2);
    for (const [, init] of calls) {
      expect(init).toBeUndefined();
    }
  });

  // A plain (non-loopback) host must still go through the proxy — the
  // widened 127/8 match must not accidentally swallow real hosts.
  it("still proxies an ordinary remote host", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const proxied = getProxiedTauriFetch(fetchFn, () => "http://127.0.0.1:7890");

    await proxied("https://api.anthropic.com/v1/messages");

    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      proxy: { all: { url: "http://127.0.0.1:7890", noProxy: "localhost,127.0.0.0/8,::1" } },
    });
  });

  it("is a passthrough with no proxy option when proxyUrl is empty", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const proxied = getProxiedTauriFetch(fetchFn, () => "");

    await proxied("https://api.anthropic.com/v1/messages", { method: "POST" });

    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ method: "POST" });
  });

  it("reads getProxyUrl fresh on every call — a change mid-session takes effect on the very next call", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    let proxyUrl = "";
    const proxied = getProxiedTauriFetch(fetchFn, () => proxyUrl);

    await proxied("https://api.anthropic.com/v1/messages");
    proxyUrl = "socks5://127.0.0.1:1080";
    await proxied("https://api.anthropic.com/v1/messages");

    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toBeUndefined();
    expect(calls[1][1]).toMatchObject({
      proxy: { all: { url: "socks5://127.0.0.1:1080", noProxy: "localhost,127.0.0.0/8,::1" } },
    });
  });
});
