// resolveEngineCapability — Soniox preview lane (D3 BYOK preview, docs/
// design-explorations/byok-preview-blueprint.md): the M2-era (Sol
// review 2026-07-20, v0.5 closeout) lane force is GONE — this function
// is a pure function of `settings` alone now, so the lane changes
// nothing about its output. PREVIEW_TIER/SONIOX_PREVIEW_LANE are still
// import-time consts (deployTier.ts) needing their own vi.mock — kept
// as a dedicated file (mirrors engineOptions.sonioxPreviewLane.test.ts's
// established one-file-per-const-combo convention) so this NEGATIVE
// claim ("the lane changes nothing here") is pinned against a REAL
// mocked-true lane, not just the ambient-false one engineCapabilities.
// test.ts already exercises.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/deployTier", () => ({ PREVIEW_TIER: true, SONIOX_PREVIEW_LANE: true }));

import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import { resolveEngineCapability } from "../engineCapabilities";

describe("resolveEngineCapability — tabaudio-cloud on the Soniox preview lane (D3: honest selection, no lane force)", () => {
  it("a persisted tabAudioCloudProvider:'deepgram' resolves the Deepgram label/bias even on the lane — no more force onto Soniox", () => {
    const cap = resolveEngineCapability("tabaudio-cloud", {
      ...DEFAULT_SETTINGS,
      tabAudioCloudProvider: "deepgram",
    });
    expect(cap).toEqual({
      kind: "tabaudio-cloud",
      label: "标签页音频·云端（Deepgram）",
      retentionClass: "cloud-transient",
      biasSupport: "keyterms",
      byokOnly: true,
    });
  });

  it("the default (soniox) settings resolve unchanged on the lane too", () => {
    const cap = resolveEngineCapability("tabaudio-cloud", DEFAULT_SETTINGS);
    expect(cap.label).toBe("标签页音频·云端（Soniox）");
    expect(cap.biasSupport).toBe("context");
  });

  it("every other kind stays a structural no-op on the lane too (lane-independence is universal now, not tabaudio-cloud-specific)", () => {
    expect(resolveEngineCapability("soniox", DEFAULT_SETTINGS).label).toBe("Soniox 云端识别");
    expect(resolveEngineCapability("deepgram", DEFAULT_SETTINGS).label).toBe("Deepgram 云端识别");
  });
});
