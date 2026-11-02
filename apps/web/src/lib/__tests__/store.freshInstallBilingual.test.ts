// Out-of-box defaults: store.ts's runFreshInstallBilingualDefault and its
// hydrate() wiring. Mocks lib/translate/providers.ts the same way
// store.translateEngineMigration.test.ts does (store.ts dynamic-imports
// it to dodge the llm/client.ts cycle), so no real Translator or
// system_translate_probe call ever runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockProbe = vi.fn();
const mockChromeAvailability = vi.fn();
vi.mock("../translate/providers", () => ({
  probeSystemTranslateSupport: (pair: unknown) => mockProbe(pair),
  checkSystemTranslatorAvailability: (pair: unknown) => mockChromeAvailability(pair),
  langPairFromSettings: (settings: { language: string; explainLanguage: string }) => ({
    source: settings.language.split("-")[0],
    target: settings.explainLanguage,
  }),
}));

import { runFreshInstallBilingualDefault, useApp } from "../store";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import * as storageModule from "../history/storage";

const NATIVE = true;
const WEB = false;

describe("runFreshInstallBilingualDefault — pure function", () => {
  beforeEach(() => {
    mockProbe.mockReset();
    mockChromeAvailability.mockReset();
  });

  it("native: turns bilingual on when Apple's language pack is already installed", async () => {
    mockProbe.mockResolvedValue({ osSupported: true, status: "installed" });
    await expect(runFreshInstallBilingualDefault(DEFAULT_SETTINGS, NATIVE)).resolves.toEqual({
      bilingualTranscript: true,
    });
    expect(mockProbe).toHaveBeenCalledWith({ source: "en", target: "zh" });
    expect(mockChromeAvailability).not.toHaveBeenCalled();
  });

  it('native: leaves it off when the pack is only "supported" (still needs a manual download)', async () => {
    mockProbe.mockResolvedValue({ osSupported: true, status: "supported" });
    await expect(runFreshInstallBilingualDefault(DEFAULT_SETTINGS, NATIVE)).resolves.toEqual({});
  });

  it("native: leaves it off when the OS can't translate at all", async () => {
    mockProbe.mockResolvedValue({ osSupported: false, status: "unsupported" });
    await expect(runFreshInstallBilingualDefault(DEFAULT_SETTINGS, NATIVE)).resolves.toEqual({});
  });

  it.each(["available", "downloadable", "downloading"] as const)(
    'web: turns bilingual on when Chrome\'s Translator reports "%s"',
    async (state) => {
      mockChromeAvailability.mockResolvedValue(state);
      await expect(runFreshInstallBilingualDefault(DEFAULT_SETTINGS, WEB)).resolves.toEqual({
        bilingualTranscript: true,
      });
      expect(mockProbe).not.toHaveBeenCalled();
    },
  );

  it('web: leaves it off when the pair is "unavailable"', async () => {
    mockChromeAvailability.mockResolvedValue("unavailable");
    await expect(runFreshInstallBilingualDefault(DEFAULT_SETTINGS, WEB)).resolves.toEqual({});
  });

  it("web: leaves it off when the browser has no Translator API (Safari/Firefox)", async () => {
    mockChromeAvailability.mockResolvedValue(null);
    await expect(runFreshInstallBilingualDefault(DEFAULT_SETTINGS, WEB)).resolves.toEqual({});
  });

  it("never throws: a rejecting probe leaves it off", async () => {
    mockProbe.mockRejectedValue(new Error("boom"));
    await expect(runFreshInstallBilingualDefault(DEFAULT_SETTINGS, NATIVE)).resolves.toEqual({});
  });

  it("no probe when bilingual is already on, the engine isn't system, or the pair is en->en", async () => {
    const cases: Partial<Settings>[] = [
      { bilingualTranscript: true },
      { translateEngine: "deepl" },
      { explainLanguage: "en" },
    ];
    for (const overrides of cases) {
      await expect(
        runFreshInstallBilingualDefault({ ...DEFAULT_SETTINGS, ...overrides }, NATIVE),
      ).resolves.toEqual({});
    }
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockChromeAvailability).not.toHaveBeenCalled();
  });
});

// This vitest process is a plain web build, so hydrate() takes the
// Chrome-Translator branch.
describe("hydrate() — fresh-install bilingual default", () => {
  beforeEach(() => {
    mockProbe.mockReset();
    mockChromeAvailability.mockReset();
    useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false, toast: null, status: "idle" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false, toast: null, status: "idle" });
  });

  it("a fresh install (no saved blob) turns bilingual on and persists it", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue(null);
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    mockChromeAvailability.mockResolvedValue("available");

    await useApp.getState().hydrate();
    await vi.waitFor(() => {
      expect(useApp.getState().settings.bilingualTranscript).toBe(true);
    });
    await vi.waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ bilingualTranscript: true }));
    });
  });

  it("a fresh install on a browser with no on-device translator stays English-only", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue(null);
    vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    mockChromeAvailability.mockResolvedValue(null);

    await useApp.getState().hydrate();
    await new Promise((r) => setTimeout(r, 10));

    expect(mockChromeAvailability).toHaveBeenCalled();
    expect(useApp.getState().settings.bilingualTranscript).toBe(false);
  });

  it("a returning user's saved bilingualTranscript:false is never touched, and nothing is probed", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue({ ...DEFAULT_SETTINGS, bilingualTranscript: false });
    vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    mockChromeAvailability.mockResolvedValue("available");

    await useApp.getState().hydrate();
    await new Promise((r) => setTimeout(r, 10));

    expect(mockChromeAvailability).not.toHaveBeenCalled();
    expect(useApp.getState().settings.bilingualTranscript).toBe(false);
  });
});
