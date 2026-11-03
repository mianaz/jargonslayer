import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";

const state = { status: "stopped" as string };
vi.mock("@/lib/store", () => ({ useApp: { getState: () => state } }));

const gapFillRunning = { value: false };
vi.mock("../gapfill", () => ({ isGapFillRunning: () => gapFillRunning.value }));

const prepare = vi.fn();
const stopSystemTranslator = vi.fn(async () => {});
vi.mock("../providers", () => ({
  langPairFromSettings: (s: { language: string; explainLanguage: string }) => ({
    source: s.language.split("-")[0],
    target: s.explainLanguage,
  }),
  resolveTranslationProvider: (get: () => { translateEngine: string }) => ({
    kind: get().translateEngine,
    prepare,
    translate: vi.fn(),
  }),
  stopSystemTranslator: () => stopSystemTranslator(),
}));

import { prepareImportTranslator, releaseImportTranslator } from "../importTranslator";

describe("prepareImportTranslator", () => {
  beforeEach(() => {
    prepare.mockClear();
  });

  it("prepares the user's engine synchronously, for the 导入 click's gesture", () => {
    const provider = prepareImportTranslator({ ...DEFAULT_SETTINGS, translateEngine: "system" }, true);
    expect(provider?.kind).toBe("system");
    expect(prepare).toHaveBeenCalledWith({
      source: DEFAULT_SETTINGS.language.split("-")[0],
      target: DEFAULT_SETTINGS.explainLanguage,
    });
  });

  it("returns undefined (and prepares nothing) when the import won't translate", () => {
    expect(prepareImportTranslator(DEFAULT_SETTINGS, false)).toBeUndefined();
    const samePair = { ...DEFAULT_SETTINGS, language: "zh-CN", explainLanguage: "zh" as const };
    expect(prepareImportTranslator(samePair, true)).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("releaseImportTranslator", () => {
  const system = { kind: "system" as const, prepare: vi.fn(), translate: vi.fn() };

  beforeEach(() => {
    stopSystemTranslator.mockClear();
    state.status = "stopped";
    gapFillRunning.value = false;
  });

  it("stops the system translator after an import when nothing else is using it", () => {
    releaseImportTranslator(system);
    expect(stopSystemTranslator).toHaveBeenCalledTimes(1);
  });

  it.each(["connecting", "listening", "paused"])("never stops it under a live meeting (%s)", (status) => {
    state.status = status;
    releaseImportTranslator(system);
    expect(stopSystemTranslator).not.toHaveBeenCalled();
  });

  it("never stops it while 补全翻译 is running", () => {
    gapFillRunning.value = true;
    releaseImportTranslator(system);
    expect(stopSystemTranslator).not.toHaveBeenCalled();
  });

  it("does nothing for non-system engines or no engine", () => {
    releaseImportTranslator(undefined);
    releaseImportTranslator({ kind: "llm", prepare: vi.fn(), translate: vi.fn() });
    expect(stopSystemTranslator).not.toHaveBeenCalled();
  });
});
