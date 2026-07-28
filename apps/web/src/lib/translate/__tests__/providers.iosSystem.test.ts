// @vitest-environment jsdom
//
// Native system-translate on iOS (S13) — resolveTranslationProvider's own
// NATIVE_SYSTEM_TRANSLATE branch + stopSystemTranslator, exercised with
// IS_IOS true/IS_DESKTOP false instead of providers.desktopSystem.test.ts's
// own IS_DESKTOP true. Same 4-invoke-command surface either way (this
// module's own DesktopSystemTranslationProvider class serves both — see
// its own doc comment for why the name didn't change), so this file only
// re-covers the platform GATE itself, not the class's full behavior
// (already covered by providers.desktopSystem.test.ts). IS_IOS/IS_TAURI
// are both module-scope import-time consts from the SAME "../../platform/
// ios" module — mocking that module replaces BOTH exports, so this file
// sets them explicitly rather than relying on ios.ts's own real
// IS_TAURI = IS_DESKTOP || IS_IOS computation (mirrors providers.
// desktopSystem.test.ts's own per-file vi.mock split for the identical
// module-scope-const constraint).

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import type { InvokeFn } from "../../desktop/tauriApi";

vi.mock("../../platform/desktop", () => ({ IS_DESKTOP: false }));
vi.mock("../../platform/ios", () => ({ IS_IOS: true, IS_TAURI: true }));
vi.mock("../../llm/client", () => ({ translateApi: vi.fn() }));

let currentInvoke!: InvokeFn;
vi.mock("../../desktop/tauriApi", () => ({
  getInvoke: () => Promise.resolve(currentInvoke),
}));

import {
  DesktopSystemTranslationProvider,
  getSystemTranslateProbeSnapshot,
  probeSystemTranslateSupport,
  resetSystemTranslateGenerationForTests,
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

const pair = { source: "en", target: "zh" };

afterEach(() => {
  resetSystemTranslateProbeCacheForTests();
  resetSystemTranslateGenerationForTests();
});

describe("resolveTranslationProvider on iOS (IS_IOS true, IS_DESKTOP false)", () => {
  it("a cached 'installed' probe resolves to the native system provider", async () => {
    const { invoke } = makeFakeInvoke({
      system_translate_probe: () => ({ osSupported: true, status: "installed" }),
    });
    currentInvoke = invoke;
    await probeSystemTranslateSupport(pair);

    const provider = resolveTranslationProvider(() =>
      makeSettings({ translateEngine: "system", language: "en-US", explainLanguage: "zh" }),
    );
    expect(provider).toBeInstanceOf(DesktopSystemTranslationProvider);
  });

  // BEHAVIOR CHANGE (v0.7 wave 2A, privacy taste-veto closed deliberately):
  // this used to assert a fall-back to LlmTranslationProvider on a COLD
  // probe cache, with a background probe warming it for a later call —
  // a user who opted into on-device-only translation could have that
  // silently swapped for a cloud LLM call. resolution no longer reads the
  // probe cache AT ALL, so it resolves the native provider synchronously
  // on the very first call regardless of probe state (see providers.ts's
  // own resolveTranslationProvider doc comment).
  it("cold cache (no probe run yet) -> STILL resolves to the native provider immediately, no probe read/fired by resolution itself", () => {
    expect(getSystemTranslateProbeSnapshot(pair)).toBeNull();
    const getSettings = () => makeSettings({ translateEngine: "system", language: "en-US", explainLanguage: "zh" });

    const provider = resolveTranslationProvider(getSettings);
    expect(provider).toBeInstanceOf(DesktopSystemTranslationProvider);
  });

  it("osSupported:false -> STILL resolves to the native provider (no silent LLM fallback) — an unsupported OS/device surfaces via SystemTranslatorUnavailableError at translate() time instead", async () => {
    const { invoke } = makeFakeInvoke({
      system_translate_probe: () => ({ osSupported: false, status: "unsupported" }),
    });
    currentInvoke = invoke;
    await probeSystemTranslateSupport(pair);

    const provider = resolveTranslationProvider(() =>
      makeSettings({ translateEngine: "system", language: "en-US", explainLanguage: "zh" }),
    );
    expect(provider).toBeInstanceOf(DesktopSystemTranslationProvider);
  });
});

describe("stopSystemTranslator on iOS", () => {
  it("invokes system_translate_stop (no longer a desktop-only no-op)", async () => {
    const { invoke, calls } = makeFakeInvoke({ system_translate_stop: () => undefined });
    currentInvoke = invoke;

    await stopSystemTranslator();

    expect(calls).toEqual([{ cmd: "system_translate_stop", args: { generation: null } }]);
  });
});
