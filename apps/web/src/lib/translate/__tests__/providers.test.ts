// @vitest-environment jsdom
//
// v0.5 Wave-1 Feature 6 (docs/design-explorations/v05-wave1-blueprint.md
// §1 Feature 6 + §5 A6). jsdom has no Translator at all — that IS the
// "absent"/"unsupported" path every test below that doesn't explicitly
// install a fake one exercises. IS_TAURI-true resolution is covered in
// providers.tauri.test.ts (a separate file — vi.mock is file-scoped/
// hoisted, so it can't be toggled per-test here).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";

vi.mock("../../llm/client", () => ({
  translateApi: vi.fn(),
}));

import { translateApi } from "../../llm/client";
import {
  ChromeTranslatorProvider,
  LlmTranslationProvider,
  SystemTranslatorUnavailableError,
  checkSystemTranslatorAvailability,
  isSystemTranslatorSupported,
  langPairFromSettings,
  resetSystemTranslatorCacheForTests,
  resolveTranslationProvider,
  type TranslatorAvailabilityState,
} from "../providers";

const mockTranslateApi = vi.mocked(translateApi);

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

interface FakeTranslatorApi {
  availability: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
}

function installFakeTranslator(overrides: Partial<FakeTranslatorApi> = {}): FakeTranslatorApi {
  const fake: FakeTranslatorApi = {
    availability: vi.fn().mockResolvedValue("available" satisfies TranslatorAvailabilityState),
    create: vi.fn().mockResolvedValue({ translate: vi.fn(async (t: string) => `zh:${t}`) }),
    ...overrides,
  };
  (window as unknown as { Translator?: unknown }).Translator = fake;
  return fake;
}

function removeFakeTranslator(): void {
  delete (window as unknown as { Translator?: unknown }).Translator;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  removeFakeTranslator();
  resetSystemTranslatorCacheForTests();
});

describe("langPairFromSettings", () => {
  it("derives the source primary subtag from settings.language and the target from explainLanguage", () => {
    expect(langPairFromSettings(makeSettings({ language: "en-US", explainLanguage: "zh" }))).toEqual({
      source: "en",
      target: "zh",
    });
  });

  it("works for any BCP-47 language.value (e.g. en-GB) and explainLanguage: en", () => {
    expect(langPairFromSettings(makeSettings({ language: "en-GB", explainLanguage: "en" }))).toEqual({
      source: "en",
      target: "en",
    });
  });
});

describe("isSystemTranslatorSupported", () => {
  it("false when window.Translator is absent (jsdom's default — the real 'unsupported browser' path)", () => {
    expect(isSystemTranslatorSupported()).toBe(false);
  });

  it("true once a fake Translator is installed on the global window", () => {
    installFakeTranslator();
    expect(isSystemTranslatorSupported()).toBe(true);
  });
});

describe("LlmTranslationProvider", () => {
  beforeEach(() => {
    mockTranslateApi.mockReset();
  });

  it("kind is 'llm'", () => {
    expect(new LlmTranslationProvider(() => makeSettings()).kind).toBe("llm");
  });

  it("prepare() is a harmless no-op (never touches window.Translator, never throws)", () => {
    const provider = new LlmTranslationProvider(() => makeSettings());
    expect(() => provider.prepare({ source: "en", target: "zh" })).not.toThrow();
  });

  it("translate() calls translateApi with {segments,lang} + the CURRENT settings, returning res.translations", async () => {
    mockTranslateApi.mockResolvedValueOnce({ translations: [{ id: "1", text: "你好" }] });
    let settings = makeSettings({ explainLanguage: "zh" });
    const provider = new LlmTranslationProvider(() => settings);

    const result = await provider.translate([{ id: "1", text: "hello" }], "zh");

    expect(result).toEqual([{ id: "1", text: "你好" }]);
    expect(mockTranslateApi).toHaveBeenCalledTimes(1);
    expect(mockTranslateApi.mock.calls[0][0]).toEqual({
      segments: [{ id: "1", text: "hello" }],
      lang: "zh",
    });
    expect(mockTranslateApi.mock.calls[0][1]).toBe(settings);

    // Fresh getSettings — a later call reads whatever settings is NOW,
    // same "always fresh" contract queue.ts already relied on before
    // this provider abstraction existed.
    settings = makeSettings({ explainLanguage: "en" });
    mockTranslateApi.mockResolvedValueOnce({ translations: [] });
    await provider.translate([{ id: "2", text: "hi" }], "en");
    expect(mockTranslateApi.mock.calls[1][1]).toBe(settings);
  });

  it("an error thrown by translateApi (NoKeyError/RateLimitApiError/anything) propagates through UNCHANGED — same instance, not wrapped", async () => {
    class FakeNoKeyError extends Error {}
    const err = new FakeNoKeyError("未配置 API Key");
    mockTranslateApi.mockRejectedValueOnce(err);
    const provider = new LlmTranslationProvider(() => makeSettings());

    await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toBe(err);
  });
});

describe("ChromeTranslatorProvider", () => {
  it("kind is 'system'", () => {
    expect(new ChromeTranslatorProvider().kind).toBe("system");
  });

  it("prepare() calls Translator.create() SYNCHRONOUSLY — call-order spy proves it fires before prepare() itself returns, i.e. before any await", () => {
    const callOrder: string[] = [];
    installFakeTranslator({
      create: vi.fn(() => {
        callOrder.push("Translator.create() called");
        return new Promise(() => {}); // never settles — irrelevant to this ordering assertion
      }),
    });
    const provider = new ChromeTranslatorProvider();

    provider.prepare({ source: "en", target: "zh" });
    callOrder.push("prepare() call site has returned");

    expect(callOrder).toEqual(["Translator.create() called", "prepare() call site has returned"]);
  });

  it("prepare() passes {sourceLanguage,targetLanguage} through to Translator.create()", () => {
    const fake = installFakeTranslator();
    new ChromeTranslatorProvider().prepare({ source: "en", target: "zh" });
    expect(fake.create).toHaveBeenCalledWith({ sourceLanguage: "en", targetLanguage: "zh" });
  });

  it("Translator.create() is cached per language pair — a second prepare() for the SAME pair does not re-call create()", () => {
    const fake = installFakeTranslator();
    const provider = new ChromeTranslatorProvider();
    provider.prepare({ source: "en", target: "zh" });
    provider.prepare({ source: "en", target: "zh" });
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  it("a DIFFERENT language pair gets its own create() call, not the cached one", () => {
    const fake = installFakeTranslator();
    const provider = new ChromeTranslatorProvider();
    provider.prepare({ source: "en", target: "zh" });
    provider.prepare({ source: "en", target: "en" });
    expect(fake.create).toHaveBeenCalledTimes(2);
  });

  it("translate() with no prior prepare() call throws SystemTranslatorUnavailableError('unavailable') — never calls create() itself", async () => {
    const fake = installFakeTranslator();
    const provider = new ChromeTranslatorProvider();
    await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("translate() fails fast with reason 'downloading' while create()'s promise is still pending — never blocks waiting for it", async () => {
    let resolveCreate!: (v: unknown) => void;
    installFakeTranslator({
      create: vi.fn(() => new Promise((res) => { resolveCreate = res; })),
    });
    const provider = new ChromeTranslatorProvider();
    provider.prepare({ source: "en", target: "zh" });

    await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toBeInstanceOf(
      SystemTranslatorUnavailableError,
    );
    await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toMatchObject({
      reason: "downloading",
    });

    // Self-heals once create() actually resolves — no fresh prepare()
    // needed (A6: translate() never re-triggers create()).
    resolveCreate({ translate: vi.fn(async (t: string) => `zh:${t}`) });
    await flush();
    const result = await provider.translate([{ id: "1", text: "hi" }], "zh");
    expect(result).toEqual([{ id: "1", text: "zh:hi" }]);
  });

  it("translate() throws reason 'unavailable' once create() itself rejects — and a LATER prepare() retries (no permanent wedge)", async () => {
    let rejectCreate!: (e: unknown) => void;
    const fake = installFakeTranslator({
      create: vi.fn(() => new Promise((_res, rej) => { rejectCreate = rej; })),
    });
    const provider = new ChromeTranslatorProvider();
    provider.prepare({ source: "en", target: "zh" });
    rejectCreate(new Error("offline"));
    await flush();

    await expect(provider.translate([{ id: "1", text: "hi" }], "zh")).rejects.toMatchObject({
      reason: "unavailable",
    });

    // Retry: a fresh prepare() call re-primes (create() called again)
    // rather than reusing the permanently-failed entry.
    fake.create.mockResolvedValueOnce({ translate: vi.fn(async (t: string) => `zh:${t}`) });
    provider.prepare({ source: "en", target: "zh" });
    expect(fake.create).toHaveBeenCalledTimes(2);
    await flush();
    const result = await provider.translate([{ id: "1", text: "hi" }], "zh");
    expect(result).toEqual([{ id: "1", text: "zh:hi" }]);
  });

  it("translate() rejects when the target lang doesn't match the last prepare()'d pair (e.g. explainLanguage changed live) — never silently mistranslates", async () => {
    installFakeTranslator();
    const provider = new ChromeTranslatorProvider();
    provider.prepare({ source: "en", target: "zh" });
    await flush();

    await expect(provider.translate([{ id: "1", text: "hi" }], "en")).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("translate() translates every item through the resolved session, preserving id/order", async () => {
    installFakeTranslator({
      create: vi.fn().mockResolvedValue({
        translate: vi.fn(async (t: string) => `[zh]${t}`),
      }),
    });
    const provider = new ChromeTranslatorProvider();
    provider.prepare({ source: "en", target: "zh" });
    await flush();

    const result = await provider.translate(
      [
        { id: "a", text: "one" },
        { id: "b", text: "two" },
      ],
      "zh",
    );
    expect(result).toEqual([
      { id: "a", text: "[zh]one" },
      { id: "b", text: "[zh]two" },
    ]);
  });
});

describe("checkSystemTranslatorAvailability", () => {
  it("returns null when the API is absent (distinct from 'unavailable')", async () => {
    await expect(checkSystemTranslatorAvailability({ source: "en", target: "zh" })).resolves.toBeNull();
  });

  it("returns whatever Translator.availability() reports, across all four real states", async () => {
    for (const state of ["unavailable", "downloadable", "downloading", "available"] as const) {
      const fake = installFakeTranslator({ availability: vi.fn().mockResolvedValue(state) });
      await expect(
        checkSystemTranslatorAvailability({ source: "en", target: "zh" }),
      ).resolves.toBe(state);
      expect(fake.availability).toHaveBeenCalledWith({ sourceLanguage: "en", targetLanguage: "zh" });
      removeFakeTranslator();
    }
  });

  it("never triggers create() — a read-only probe", async () => {
    const fake = installFakeTranslator();
    await checkSystemTranslatorAvailability({ source: "en", target: "zh" });
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("returns null (not a throw) when availability() itself rejects", async () => {
    installFakeTranslator({ availability: vi.fn().mockRejectedValue(new Error("boom")) });
    await expect(checkSystemTranslatorAvailability({ source: "en", target: "zh" })).resolves.toBeNull();
  });
});

describe("resolveTranslationProvider — resolution matrix (web platform; IS_TAURI is false in this process)", () => {
  beforeEach(() => {
    mockTranslateApi.mockReset();
  });

  it("translateEngine:'llm' (default) -> LlmTranslationProvider, regardless of Translator presence", () => {
    installFakeTranslator();
    const provider = resolveTranslationProvider(() => makeSettings({ translateEngine: "llm" }));
    expect(provider).toBeInstanceOf(LlmTranslationProvider);
  });

  it("translateEngine:'system' + API present -> ChromeTranslatorProvider", () => {
    installFakeTranslator();
    const provider = resolveTranslationProvider(() => makeSettings({ translateEngine: "system" }));
    expect(provider).toBeInstanceOf(ChromeTranslatorProvider);
  });

  it("translateEngine:'system' + API ABSENT -> silent fallback to LlmTranslationProvider", () => {
    // No installFakeTranslator() — jsdom has none by default.
    const provider = resolveTranslationProvider(() => makeSettings({ translateEngine: "system" }));
    expect(provider).toBeInstanceOf(LlmTranslationProvider);
  });

  it("the resolved LlmTranslationProvider (fallback case) still works — reads live settings via the SAME getter", async () => {
    mockTranslateApi.mockResolvedValueOnce({ translations: [{ id: "1", text: "你好" }] });
    const getSettings = () => makeSettings({ translateEngine: "system", explainLanguage: "zh" });
    const provider = resolveTranslationProvider(getSettings);
    const result = await provider.translate([{ id: "1", text: "hi" }], "zh");
    expect(result).toEqual([{ id: "1", text: "你好" }]);
  });
});
