// Translation-rework wave 1 — store.ts's probe-gated one-shot
// translateEngine migration (runTranslateEngineMigration) + its
// hydrate() wiring. Mocks lib/translate/providers.ts (store.ts
// dynamic-imports it to avoid a real cycle through llm/client.ts's own
// `useApp` import — see runTranslateEngineMigration's own doc comment)
// so these tests never touch a real Translator.availability()/
// system_translate_probe call. The REAL (unmocked) providers.ts "no
// native probe outside Tauri" path is covered separately in
// store.translateEngineMigration.webProbe.test.ts — vi.mock is
// file-scoped, so that seam needs its own file, mirroring store.
// setLookup.test.ts's own precedent for exactly this class of split.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockProbe = vi.fn();
vi.mock("../translate/providers", () => ({
  probeSystemTranslateSupport: (pair: unknown) => mockProbe(pair),
  langPairFromSettings: (settings: { language: string; explainLanguage: string }) => ({
    source: settings.language.split("-")[0],
    target: settings.explainLanguage,
  }),
}));

import { runTranslateEngineMigration, TRANSLATE_ENGINE_MIGRATION_TOAST, useApp } from "../store";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import * as storageModule from "../history/storage";

function llmSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, translateEngine: "llm", translateEngineMigrated: false, ...overrides };
}

describe("runTranslateEngineMigration — pure function", () => {
  beforeEach(() => {
    mockProbe.mockReset();
  });

  it('no-op when translateEngine is not "llm" (a fresh install already defaults to "system")', async () => {
    const result = await runTranslateEngineMigration({ ...DEFAULT_SETTINGS, translateEngine: "system" });
    expect(result).toEqual({ patch: {} });
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('no-op for the third engine option ("deepl") too — the guard is engine === "llm", not engine !== "system"', async () => {
    const result = await runTranslateEngineMigration({ ...DEFAULT_SETTINGS, translateEngine: "deepl" });
    expect(result).toEqual({ patch: {} });
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('no-op when already migrated, even if translateEngine is still "llm"', async () => {
    const result = await runTranslateEngineMigration(llmSettings({ translateEngineMigrated: true }));
    expect(result).toEqual({ patch: {} });
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('flips to "system" and returns the one-time toast only when the probe reports "installed"', async () => {
    mockProbe.mockResolvedValue({ osSupported: true, status: "installed" });
    const result = await runTranslateEngineMigration(llmSettings());
    expect(result.patch).toEqual({ translateEngine: "system", translateEngineMigrated: true });
    expect(result.toast).toBe(TRANSLATE_ENGINE_MIGRATION_TOAST);
  });

  it('marker-only, no flip, no toast — probe reports "supported" (not yet downloaded)', async () => {
    mockProbe.mockResolvedValue({ osSupported: true, status: "supported" });
    const result = await runTranslateEngineMigration(llmSettings());
    expect(result).toEqual({ patch: { translateEngineMigrated: true } });
  });

  it('marker-only, no flip, no toast — probe reports "unsupported"', async () => {
    mockProbe.mockResolvedValue({ osSupported: false, status: "unsupported" });
    const result = await runTranslateEngineMigration(llmSettings());
    expect(result).toEqual({ patch: { translateEngineMigrated: true } });
  });

  it("marker-only, no flip, no throw — the probe itself rejects", async () => {
    mockProbe.mockRejectedValue(new Error("boom"));
    await expect(runTranslateEngineMigration(llmSettings())).resolves.toEqual({
      patch: { translateEngineMigrated: true },
    });
  });
});

describe("hydrate() — wires runTranslateEngineMigration end to end", () => {
  beforeEach(() => {
    mockProbe.mockReset();
    useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false, toast: null, status: "idle" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false, toast: null, status: "idle" });
  });

  it('a persisted translateEngine:"llm" blob flips to "system" and toasts once the probe confirms "installed"', async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue(llmSettings());
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    mockProbe.mockResolvedValue({ osSupported: true, status: "installed" });

    await useApp.getState().hydrate();
    await vi.waitFor(() => {
      expect(useApp.getState().settings.translateEngine).toBe("system");
    });

    expect(useApp.getState().settings.translateEngineMigrated).toBe(true);
    expect(useApp.getState().toast).toBe(TRANSLATE_ENGINE_MIGRATION_TOAST);
    await vi.waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ translateEngine: "system", translateEngineMigrated: true }),
      );
    });
  });

  it('stays on "llm" but stamps the marker when the probe reports anything short of "installed" — no toast', async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue(llmSettings());
    vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    mockProbe.mockResolvedValue({ osSupported: false, status: "unsupported" });

    await useApp.getState().hydrate();
    await vi.waitFor(() => {
      expect(useApp.getState().settings.translateEngineMigrated).toBe(true);
    });

    expect(useApp.getState().settings.translateEngine).toBe("llm");
    expect(useApp.getState().toast).toBeNull();
  });

  it("Finding 2 (adversarial review): a user's own explicit engine pick landing mid-probe wins — the probe-confirmed flip/marker are skipped once translateEngine is no longer \"llm\"", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue(llmSettings());
    vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    let resolveProbe!: (v: unknown) => void;
    mockProbe.mockReturnValue(
      new Promise((res) => {
        resolveProbe = res;
      }),
    );

    // hydrate() itself resolves before the fire-and-forget migration
    // probe does — this is exactly the window the race opens up.
    await useApp.getState().hydrate();

    // The user picks a DIFFERENT engine (BYOK "deepl") while the probe
    // is still in flight — per Finding 1, this also stamps the marker
    // on their own patch.
    useApp.getState().updateSettings({ translateEngine: "deepl" });
    expect(useApp.getState().settings.translateEngineMigrated).toBe(true);

    // Now the probe confirms "installed" — the migration's own apply
    // must see translateEngine is no longer "llm" and skip entirely.
    resolveProbe({ osSupported: true, status: "installed" });
    await new Promise((r) => setTimeout(r, 10));

    expect(useApp.getState().settings.translateEngine).toBe("deepl");
    expect(useApp.getState().toast).toBeNull();
  });

  it("Finding 2 (adversarial review): an active meeting (status other than idle/stopped) defers the migration entirely — no flip, no marker, no toast, so it retries next launch once idle", async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue(llmSettings());
    vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    mockProbe.mockResolvedValue({ osSupported: true, status: "installed" });

    await useApp.getState().hydrate();
    // A meeting goes live in the window between hydrate() resolving and
    // the fire-and-forget migration probe settling — the 内容不离开设备
    // toast must never land mid-meeting.
    useApp.getState().setStatus("listening");
    await new Promise((r) => setTimeout(r, 10));

    expect(useApp.getState().settings.translateEngine).toBe("llm");
    expect(useApp.getState().settings.translateEngineMigrated).toBe(false);
    expect(useApp.getState().toast).toBeNull();
  });

  it('a fresh/already-"system" settings blob never calls the probe at all', async () => {
    vi.spyOn(storageModule, "loadSettings").mockResolvedValue(null);

    await useApp.getState().hydrate();
    await Promise.resolve(); // let any stray fire-and-forget microtask settle

    expect(mockProbe).not.toHaveBeenCalled();
    expect(useApp.getState().settings.translateEngine).toBe("system");
  });
});
