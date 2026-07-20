// @vitest-environment jsdom
//
// resolveTranslationProvider on a Tauri shell (desktop OR iOS) — A6:
// "system hidden/fallback on Tauri desktop + iOS". vi.mock is hoisted/
// file-scoped, so this needs its own file (mirrors lib/stt/__tests__/
// engineOptions.desktop.test.ts's own "vi.mock(...IS_DESKTOP: true)"
// per-file pattern) rather than a describe block inside providers.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";

vi.mock("../../platform/ios", () => ({ IS_TAURI: true }));
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
  it("translateEngine:'system' still resolves to LlmTranslationProvider — Chrome Translator is never used on a Tauri shell, even when the API happens to be present", () => {
    installFakeTranslator();
    const provider = resolveTranslationProvider(() => makeSettings({ translateEngine: "system" }));
    expect(provider).toBeInstanceOf(LlmTranslationProvider);
    expect(provider).not.toBeInstanceOf(ChromeTranslatorProvider);
  });

  it("translateEngine:'llm' resolves to LlmTranslationProvider as usual", () => {
    const provider = resolveTranslationProvider(() => makeSettings({ translateEngine: "llm" }));
    expect(provider).toBeInstanceOf(LlmTranslationProvider);
  });
});
