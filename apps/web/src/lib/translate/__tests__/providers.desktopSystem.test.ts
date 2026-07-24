// @vitest-environment jsdom
//
// v0.6 Apple on-device translate (macOS 26+, desktop-only) —
// DesktopSystemTranslationProvider + resolveTranslationProvider's own
// IS_DESKTOP branch + stopSystemTranslator. IS_DESKTOP is a module-scope
// import-time const (vi.mock is hoisted/file-scoped), so this needs its
// own file — mirrors providers.tauri.test.ts's own split (IS_TAURI) and
// osspeechCaps.test.ts's own tauriApi-mocking idiom (getInvoke faked via
// a reassignable `currentInvoke`, calls recorded through a local
// makeFakeInvoke helper — each __tests__ dir keeps its own same-shaped
// copy per that file's own header comment, rather than reaching across
// directories).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import type { InvokeFn } from "../../desktop/tauriApi";

vi.mock("../../platform/desktop", () => ({ IS_DESKTOP: true }));
vi.mock("../../llm/client", () => ({ translateApi: vi.fn() }));

let currentInvoke!: InvokeFn;
vi.mock("../../desktop/tauriApi", () => ({
  getInvoke: () => Promise.resolve(currentInvoke),
}));

import {
  DesktopSystemTranslationProvider,
  LlmTranslationProvider,
  SystemTranslatorUnavailableError,
  getSystemTranslateProbeSnapshot,
  probeSystemTranslateSupport,
  resetSystemTranslateProbeCacheForTests,
  resolveTranslationProvider,
  stopSystemTranslator,
} from "../providers";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

interface FakeInvokeCall {
  cmd: string;
  args?: Record<string, unknown>;
}

/** Local copy of the desktop/__tests__ convention (osspeechCaps.test.ts's
 *  own header comment) — records every invoke() call and dispatches to a
 *  handlers map, throwing on an unexpected command so a wiring mistake
 *  fails loudly instead of silently resolving undefined. */
function makeFakeInvoke(handlers: Record<string, (args?: Record<string, unknown>) => unknown>): {
  invoke: InvokeFn;
  calls: FakeInvokeCall[];
} {
  const calls: FakeInvokeCall[] = [];
  const invoke: InvokeFn = (async <T>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (!(cmd in handlers)) throw new Error(`unexpected invoke("${cmd}")`);
    return (await handlers[cmd](args)) as T;
  }) as InvokeFn;
  return { invoke, calls };
}

async function flush(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

const pair = { source: "en", target: "zh" };

afterEach(() => {
  resetSystemTranslateProbeCacheForTests();
});

describe("DesktopSystemTranslationProvider", () => {
  it("kind is 'system'", () => {
    expect(new DesktopSystemTranslationProvider().kind).toBe("system");
  });

  it("prepare() returns synchronously (never awaits the native call itself) — the invoke only actually fires after a flush", async () => {
    const { invoke, calls } = makeFakeInvoke({ system_translate_prepare: () => undefined });
    currentInvoke = invoke;
    const provider = new DesktopSystemTranslationProvider();

    provider.prepare(pair);
    expect(calls).toEqual([]); // not yet — getInvoke() itself is async

    await flush();
    expect(calls).toEqual([{ cmd: "system_translate_prepare", args: { source: "en", target: "zh" } }]);
  });

  it("translate() before any prepare() call throws 'unavailable' and never calls invoke", async () => {
    const { invoke, calls } = makeFakeInvoke({ system_translate: () => [] });
    currentInvoke = invoke;
    const provider = new DesktopSystemTranslationProvider();

    await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(calls).toEqual([]);
  });

  it("translate() rejects when the target lang doesn't match the last prepare()'d pair", async () => {
    const { invoke } = makeFakeInvoke({ system_translate_prepare: () => undefined });
    currentInvoke = invoke;
    const provider = new DesktopSystemTranslationProvider();
    provider.prepare(pair);
    await flush();

    await expect(provider.translate([{ id: "1", text: "hi" }], "en")).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("a FAILED prepare() marks the provider unavailable — translate() throws without even calling system_translate", async () => {
    const { invoke, calls } = makeFakeInvoke({
      system_translate_prepare: () => {
        throw new Error("child spawn failed");
      },
    });
    currentInvoke = invoke;
    const provider = new DesktopSystemTranslationProvider();
    provider.prepare(pair);
    await flush();

    await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(calls.map((c) => c.cmd)).toEqual(["system_translate_prepare"]);
  });

  it("a LATER prepare() call retries — a fresh success clears the earlier failure's latch", async () => {
    const fail = makeFakeInvoke({
      system_translate_prepare: () => {
        throw new Error("offline");
      },
    });
    currentInvoke = fail.invoke;
    const provider = new DesktopSystemTranslationProvider();
    provider.prepare(pair);
    await flush();
    await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toMatchObject({
      reason: "unavailable",
    });

    const ok = makeFakeInvoke({
      system_translate_prepare: () => undefined,
      system_translate: () => [{ id: "1", text: "你好" }],
    });
    currentInvoke = ok.invoke;
    provider.prepare(pair);
    await flush();

    const result = await provider.translate([{ id: "1", text: "hi" }], "zh");
    expect(result).toEqual([{ id: "1", text: "你好" }]);
  });

  it("translate() sends {items,source,target} and maps the response back BY ID, not array position — a missing id just drops that one item", async () => {
    const { invoke, calls } = makeFakeInvoke({
      system_translate_prepare: () => undefined,
      // Deliberately out-of-order AND missing "b" — proves the mapping
      // is id-keyed, not a positional zip.
      system_translate: () => [
        { id: "c", text: "C" },
        { id: "a", text: "A" },
      ],
    });
    currentInvoke = invoke;
    const provider = new DesktopSystemTranslationProvider();
    provider.prepare(pair);
    await flush();

    const items = [
      { id: "a", text: "one" },
      { id: "b", text: "two" },
      { id: "c", text: "three" },
    ];
    const result = await provider.translate(items, "zh");

    expect(calls).toContainEqual({
      cmd: "system_translate",
      args: { items, source: "en", target: "zh" },
    });
    // Original item ORDER (a, b, c), "b" simply absent — not a
    // whole-batch failure.
    expect(result).toEqual([
      { id: "a", text: "A" },
      { id: "c", text: "C" },
    ]);
  });

  it("a native error containing 'not-installed' maps to reason 'downloading' (queue.ts's self-healing branch)", async () => {
    const { invoke } = makeFakeInvoke({
      system_translate_prepare: () => undefined,
      system_translate: () => {
        throw new Error("language pair not-installed");
      },
    });
    currentInvoke = invoke;
    const provider = new DesktopSystemTranslationProvider();
    provider.prepare(pair);
    await flush();

    await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toBeInstanceOf(
      SystemTranslatorUnavailableError,
    );
    await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toMatchObject({
      reason: "downloading",
    });
  });

  it("any OTHER native translate error (child dead, IPC failure, etc.) maps to reason 'unavailable'", async () => {
    const { invoke } = makeFakeInvoke({
      system_translate_prepare: () => undefined,
      system_translate: () => {
        throw new Error("child process exited unexpectedly");
      },
    });
    currentInvoke = invoke;
    const provider = new DesktopSystemTranslationProvider();
    provider.prepare(pair);
    await flush();

    await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toMatchObject({
      reason: "unavailable",
    });
  });
});

describe("probeSystemTranslateSupport / getSystemTranslateProbeSnapshot", () => {
  it("caches a successful probe, readable synchronously afterward", async () => {
    const { invoke, calls } = makeFakeInvoke({
      system_translate_probe: () => ({ osSupported: true, status: "installed" }),
    });
    currentInvoke = invoke;

    expect(getSystemTranslateProbeSnapshot(pair)).toBeNull();
    const result = await probeSystemTranslateSupport(pair);

    expect(result).toEqual({ osSupported: true, status: "installed" });
    expect(getSystemTranslateProbeSnapshot(pair)).toEqual({ osSupported: true, status: "installed" });
    expect(calls).toEqual([{ cmd: "system_translate_probe", args: { source: "en", target: "zh" } }]);

    // A second call reuses the cache — no second invoke.
    await probeSystemTranslateSupport(pair);
    expect(calls).toHaveLength(1);
  });

  it("single-flights concurrent callers for the SAME pair", async () => {
    let resolveProbe!: (v: unknown) => void;
    const { invoke, calls } = makeFakeInvoke({
      system_translate_probe: () => new Promise((res) => { resolveProbe = res; }),
    });
    currentInvoke = invoke;

    const p1 = probeSystemTranslateSupport(pair);
    const p2 = probeSystemTranslateSupport(pair);
    // getInvoke()/invoke() are both async indirection layers — resolveProbe
    // isn't assigned until p1's own IIFE resumes past its first await.
    await flush();
    resolveProbe({ osSupported: true, status: "supported" });

    await expect(p1).resolves.toEqual({ osSupported: true, status: "supported" });
    await expect(p2).resolves.toEqual({ osSupported: true, status: "supported" });
    expect(calls).toHaveLength(1);
  });

  it("an invoke() rejection resolves the fail-closed shape WITHOUT caching it — a later call retries for real", async () => {
    const { invoke } = makeFakeInvoke({
      system_translate_probe: () => {
        throw new Error("ipc failure");
      },
    });
    currentInvoke = invoke;

    const result = await probeSystemTranslateSupport(pair);
    expect(result).toEqual({ osSupported: false, status: "unsupported" });
    expect(getSystemTranslateProbeSnapshot(pair)).toBeNull();
  });
});

describe("resolveTranslationProvider on IS_DESKTOP (macOS 26+)", () => {
  beforeEach(() => {
    resetSystemTranslateProbeCacheForTests();
  });

  it("translateEngine:'llm' -> LlmTranslationProvider, no probe fired", () => {
    const provider = resolveTranslationProvider(() => makeSettings({ translateEngine: "llm" }));
    expect(provider).toBeInstanceOf(LlmTranslationProvider);
  });

  it("a cached 'installed' probe resolves to the desktop provider", async () => {
    const { invoke } = makeFakeInvoke({
      system_translate_probe: () => ({ osSupported: true, status: "installed" }),
    });
    currentInvoke = invoke;
    await probeSystemTranslateSupport({ source: "en", target: "zh" });

    const provider = resolveTranslationProvider(() =>
      makeSettings({ translateEngine: "system", language: "en-US", explainLanguage: "zh" }),
    );
    expect(provider).toBeInstanceOf(DesktopSystemTranslationProvider);
  });

  it("a cached 'supported' probe (pair not downloaded yet) STILL resolves to the desktop provider — translate()'s own runtime error is what surfaces 'downloading', not resolution", async () => {
    const { invoke } = makeFakeInvoke({
      system_translate_probe: () => ({ osSupported: true, status: "supported" }),
    });
    currentInvoke = invoke;
    await probeSystemTranslateSupport({ source: "en", target: "zh" });

    const provider = resolveTranslationProvider(() =>
      makeSettings({ translateEngine: "system", language: "en-US", explainLanguage: "zh" }),
    );
    expect(provider).toBeInstanceOf(DesktopSystemTranslationProvider);
  });

  it("osSupported:false (macOS < 26) -> falls back to LlmTranslationProvider, never crashes", async () => {
    const { invoke } = makeFakeInvoke({
      system_translate_probe: () => ({ osSupported: false, status: "unsupported" }),
    });
    currentInvoke = invoke;
    await probeSystemTranslateSupport({ source: "en", target: "zh" });

    const provider = resolveTranslationProvider(() =>
      makeSettings({ translateEngine: "system", language: "en-US", explainLanguage: "zh" }),
    );
    expect(provider).toBeInstanceOf(LlmTranslationProvider);
  });

  it("cold cache (no probe run yet) -> falls back to LlmTranslationProvider for THIS call, and fires a background probe that warms the cache for the NEXT one", async () => {
    const { invoke } = makeFakeInvoke({
      system_translate_probe: () => ({ osSupported: true, status: "installed" }),
    });
    currentInvoke = invoke;

    expect(getSystemTranslateProbeSnapshot({ source: "en", target: "zh" })).toBeNull();
    const getSettings = () => makeSettings({ translateEngine: "system", language: "en-US", explainLanguage: "zh" });
    const first = resolveTranslationProvider(getSettings);
    expect(first).toBeInstanceOf(LlmTranslationProvider);

    await flush();
    expect(getSystemTranslateProbeSnapshot({ source: "en", target: "zh" })).toEqual({
      osSupported: true,
      status: "installed",
    });

    const second = resolveTranslationProvider(getSettings);
    expect(second).toBeInstanceOf(DesktopSystemTranslationProvider);
  });
});

describe("stopSystemTranslator (IS_DESKTOP)", () => {
  it("calls invoke('system_translate_stop')", async () => {
    const { invoke, calls } = makeFakeInvoke({ system_translate_stop: () => undefined });
    currentInvoke = invoke;

    stopSystemTranslator();
    await flush();

    expect(calls).toEqual([{ cmd: "system_translate_stop", args: undefined }]);
  });

  it("swallows an invoke() rejection — best-effort, never throws", async () => {
    const { invoke } = makeFakeInvoke({
      system_translate_stop: () => {
        throw new Error("already stopped");
      },
    });
    currentInvoke = invoke;

    expect(() => stopSystemTranslator()).not.toThrow();
    await flush();
  });
});
