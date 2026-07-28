// @vitest-environment jsdom
//
// resolveTranslationProvider with IS_TAURI true but NATIVE_SYSTEM_TRANSLATE
// (IS_DESKTOP||IS_IOS) false — a combination this file's own vi.mock below
// decouples ARTIFICIALLY (platform/ios.ts's real IS_TAURI is always exactly
// IS_DESKTOP||IS_IOS, so in a real build this state is unreachable; both
// real Tauri shells are already fully covered by providers.desktopSystem.
// test.ts/providers.iosSystem.test.ts's own NATIVE_SYSTEM_TRANSLATE:true
// cases). vi.mock is hoisted/file-scoped, so this needs its own file
// (mirrors lib/stt/__tests__/engineOptions.desktop.test.ts's own
// "vi.mock(...IS_DESKTOP: true)" per-file pattern) rather than a describe
// block inside providers.test.ts.
//
// BEHAVIOR CHANGE (v0.7 wave 2A, privacy taste-veto closed deliberately):
// resolveTranslationProvider used to gate ChromeTranslatorProvider on
// `!IS_TAURI` specifically (on top of NATIVE_SYSTEM_TRANSLATE), so this
// synthetic combination fell through to a silent LlmTranslationProvider
// fallback. That extra guard is gone now — "system" always resolves to
// NATIVE_SYSTEM_TRANSLATE ? DesktopSystemTranslationProvider :
// ChromeTranslatorProvider, full stop, so this file's own test below now
// documents that ChromeTranslatorProvider is what a hypothetical
// IS_TAURI-but-non-native build would get (harmless in practice: no real
// build reaches this state, and ChromeTranslatorProvider's own translate()
// throws SystemTranslatorUnavailableError when window.Translator is
// genuinely absent, same self-healing path as everywhere else).

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";

// IS_IOS: false — this file exercises the generic "any Tauri shell"
// IS_TAURI gate alone (providers.ts's ChromeTranslatorProvider branch);
// providers.iosSystem.test.ts covers the IS_IOS-specific NATIVE_SYSTEM_
// TRANSLATE gate providers.ts also reads from this SAME module now.
vi.mock("../../platform/ios", () => ({ IS_TAURI: true, IS_IOS: false }));
vi.mock("../../llm/client", () => ({ translateApi: vi.fn() }));

import { ChromeTranslatorProvider, LlmTranslationProvider, resolveTranslationProvider } from "../providers";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

interface FakeTranslatorApi {
  availability: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
}

function installFakeTranslator(): FakeTranslatorApi {
  const fake: FakeTranslatorApi = {
    availability: vi.fn().mockResolvedValue("available"),
    create: vi.fn().mockResolvedValue({ translate: vi.fn(async (t: string) => t) }),
  };
  (window as unknown as { Translator?: unknown }).Translator = fake;
  return fake;
}

afterEach(() => {
  delete (window as unknown as { Translator?: unknown }).Translator;
});

describe("resolveTranslationProvider on IS_TAURI (desktop/iOS)", () => {
  it("translateEngine:'system' resolves to ChromeTranslatorProvider when NATIVE_SYSTEM_TRANSLATE is false — resolution no longer special-cases IS_TAURI on its own (see this file's own header comment)", () => {
    installFakeTranslator();
    const provider = resolveTranslationProvider(() => makeSettings({ translateEngine: "system" }));
    expect(provider).toBeInstanceOf(ChromeTranslatorProvider);
  });

  it("translateEngine:'llm' resolves to LlmTranslationProvider as usual", () => {
    const provider = resolveTranslationProvider(() => makeSettings({ translateEngine: "llm" }));
    expect(provider).toBeInstanceOf(LlmTranslationProvider);
  });
});
