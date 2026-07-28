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
  resetSystemTranslateGenerationForTests,
  resetSystemTranslateProbeCacheForTests,
  resolveTranslationProvider,
  stopSystemTranslator,
  warmSystemTranslateProbeForStartup,
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
  resetSystemTranslateGenerationForTests();
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

  // BEHAVIOR CHANGE (v0.7 wave 2A, privacy taste-veto closed deliberately):
  // this used to assert a fall-back to LlmTranslationProvider on
  // osSupported:false — a user who opted into on-device-only translation
  // could have that silently swapped for a cloud LLM call. resolution no
  // longer reads the probe cache AT ALL: NATIVE_SYSTEM_TRANSLATE always
  // resolves to DesktopSystemTranslationProvider now, regardless of probe
  // state — an unsupported OS surfaces through SystemTranslatorUnavailableError
  // once translate() actually runs instead (see providers.ts's own
  // resolveTranslationProvider doc comment).
  it("osSupported:false (macOS < 26) -> STILL resolves to the desktop provider (no silent LLM fallback)", async () => {
    const { invoke } = makeFakeInvoke({
      system_translate_probe: () => ({ osSupported: false, status: "unsupported" }),
    });
    currentInvoke = invoke;
    await probeSystemTranslateSupport({ source: "en", target: "zh" });

    const provider = resolveTranslationProvider(() =>
      makeSettings({ translateEngine: "system", language: "en-US", explainLanguage: "zh" }),
    );
    expect(provider).toBeInstanceOf(DesktopSystemTranslationProvider);
  });

  // BEHAVIOR CHANGE (same taste-veto fix): this used to assert a fall-back
  // to LlmTranslationProvider on a COLD cache (probe never run yet), with a
  // background probe warming the cache for a later call. resolution no
  // longer needs the probe warm at all — it resolves the desktop provider
  // synchronously on the very first call, cold cache or not.
  it("cold cache (no probe run yet) -> STILL resolves to the desktop provider immediately, no probe read/fired by resolution itself", () => {
    expect(getSystemTranslateProbeSnapshot({ source: "en", target: "zh" })).toBeNull();
    const getSettings = () => makeSettings({ translateEngine: "system", language: "en-US", explainLanguage: "zh" });

    const provider = resolveTranslationProvider(getSettings);
    expect(provider).toBeInstanceOf(DesktopSystemTranslationProvider);
  });
});

describe("warmSystemTranslateProbeForStartup (HIGH-1 fix: first-meeting-after-launch warm-up)", () => {
  it("cold cache + hydrated settings with translateEngine 'system' -> fires the probe at startup, and resolveTranslationProvider returns the desktop provider on the very FIRST call once warm", async () => {
    const { invoke, calls } = makeFakeInvoke({
      system_translate_probe: () => ({ osSupported: true, status: "installed" }),
    });
    currentInvoke = invoke;
    const settings = makeSettings({ translateEngine: "system", language: "en-US", explainLanguage: "zh" });

    expect(getSystemTranslateProbeSnapshot(pair)).toBeNull();

    warmSystemTranslateProbeForStartup(settings);
    expect(calls).toEqual([]); // fire-and-forget — not yet, getInvoke() itself is async

    await flush();
    expect(calls).toEqual([{ cmd: "system_translate_probe", args: { source: "en", target: "zh" } }]);
    expect(getSystemTranslateProbeSnapshot(pair)).toEqual({ osSupported: true, status: "installed" });

    // The bug: without the startup warm-up above, this FIRST
    // resolveTranslationProvider call of the session would see a cold
    // cache and silently fall back to LlmTranslationProvider for the
    // whole meeting (only a SECOND call, after resolveTranslationProvider's
    // own background probe settled, would ever get the desktop provider).
    const provider = resolveTranslationProvider(() => settings);
    expect(provider).toBeInstanceOf(DesktopSystemTranslationProvider);
  });

  it("translateEngine:'llm' -> never fires the probe", async () => {
    const { invoke, calls } = makeFakeInvoke({
      system_translate_probe: () => ({ osSupported: true, status: "installed" }),
    });
    currentInvoke = invoke;

    warmSystemTranslateProbeForStartup(makeSettings({ translateEngine: "llm" }));
    await flush();

    expect(calls).toEqual([]);
  });
});

describe("stopSystemTranslator (IS_DESKTOP)", () => {
  it("calls invoke('system_translate_stop') with generation:null before any prepare() ever ran", async () => {
    const { invoke, calls } = makeFakeInvoke({ system_translate_stop: () => undefined });
    currentInvoke = invoke;

    await stopSystemTranslator();

    expect(calls).toEqual([{ cmd: "system_translate_stop", args: { generation: null } }]);
  });

  it("returns its promise now (S1 fix) — awaiting it actually waits for the invoke to settle", async () => {
    let resolveStop!: () => void;
    const { invoke, calls } = makeFakeInvoke({
      system_translate_stop: () => new Promise((res) => { resolveStop = () => res(undefined); }),
    });
    currentInvoke = invoke;

    let settled = false;
    const stopPromise = stopSystemTranslator().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false); // still in flight
    expect(calls).toHaveLength(1);

    resolveStop();
    await stopPromise;
    expect(settled).toBe(true);
  });

  it("swallows an invoke() rejection — best-effort, never throws/rejects", async () => {
    const { invoke } = makeFakeInvoke({
      system_translate_stop: () => {
        throw new Error("already stopped");
      },
    });
    currentInvoke = invoke;

    await expect(stopSystemTranslator()).resolves.toBeUndefined();
  });

  // S1 regression test (v0.6 round-2 review): "a delayed stop from the
  // previous meeting can kill the NEXT meeting's translator" — fails
  // against pre-fix code, where stopSystemTranslator() took no
  // generation argument at all (invoke("system_translate_stop") with no
  // args), so the Rust side had no way to tell an old meeting's stop
  // apart from a fresh one's.
  it("passes the generation the MOST RECENT prepare() call warmed — a second meeting's prepare() changes what a later stop targets", async () => {
    const prepareOk = makeFakeInvoke({ system_translate_prepare: () => 5 });
    currentInvoke = prepareOk.invoke;
    const provider = new DesktopSystemTranslationProvider();
    provider.prepare(pair);
    await flush();

    const stop1 = makeFakeInvoke({ system_translate_stop: () => undefined });
    currentInvoke = stop1.invoke;
    await stopSystemTranslator();
    expect(stop1.calls).toEqual([{ cmd: "system_translate_stop", args: { generation: 5 } }]);

    // A second meeting's own prepare() (possibly for the SAME pair, via
    // a fresh provider instance — mirrors resolveTranslationProvider
    // being called again at the next start()) warms a NEW generation.
    const prepareOk2 = makeFakeInvoke({ system_translate_prepare: () => 6 });
    currentInvoke = prepareOk2.invoke;
    const provider2 = new DesktopSystemTranslationProvider();
    provider2.prepare(pair);
    await flush();

    const stop2 = makeFakeInvoke({ system_translate_stop: () => undefined });
    currentInvoke = stop2.invoke;
    await stopSystemTranslator();
    expect(stop2.calls).toEqual([{ cmd: "system_translate_stop", args: { generation: 6 } }]);
  });
});
