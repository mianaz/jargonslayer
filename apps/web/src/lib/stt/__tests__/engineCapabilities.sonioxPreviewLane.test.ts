// resolveEngineCapability — Soniox preview lane ON (M2 fix, Sol review
// 2026-07-20, v0.5 closeout). PREVIEW_TIER/SONIOX_PREVIEW_LANE are both
// import-time consts (deployTier.ts), so this needs its own file +
// vi.mock rather than a describe block inside engineCapabilities.
// test.ts (ambient PREVIEW_TIER: false there, per that file's own lack
// of a mock) — mirrors engineOptions.sonioxPreviewLane.test.ts's
// established one-file-per-const-combo convention.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/deployTier", () => ({ PREVIEW_TIER: true, SONIOX_PREVIEW_LANE: true }));

import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import { resolveEngineCapability } from "../engineCapabilities";

describe("resolveEngineCapability — tabaudio-cloud on the Soniox preview lane", () => {
  it("a persisted tabAudioCloudProvider:'deepgram' still resolves the Soniox label/bias — mirrors tabAudioCloud.ts's own effectiveProvider FORCE, no dead-tab-tile label lie", () => {
    const cap = resolveEngineCapability("tabaudio-cloud", {
      ...DEFAULT_SETTINGS,
      tabAudioCloudProvider: "deepgram",
    });
    expect(cap).toEqual({
      kind: "tabaudio-cloud",
      label: "标签页音频·云端（Soniox）",
      retentionClass: "cloud-transient",
      biasSupport: "context",
      byokOnly: true,
    });
  });

  it("the default (soniox) settings resolve unchanged on the lane too", () => {
    const cap = resolveEngineCapability("tabaudio-cloud", DEFAULT_SETTINGS);
    expect(cap.label).toBe("标签页音频·云端（Soniox）");
    expect(cap.biasSupport).toBe("context");
  });

  it("every other kind stays a structural no-op on the lane too (only tabaudio-cloud is lane-aware)", () => {
    expect(resolveEngineCapability("soniox", DEFAULT_SETTINGS).label).toBe("Soniox 云端识别");
    expect(resolveEngineCapability("deepgram", DEFAULT_SETTINGS).label).toBe("Deepgram 云端识别");
  });
});
