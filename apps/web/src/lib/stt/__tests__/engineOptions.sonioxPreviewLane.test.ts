// Soniox preview lane ON (hosted trial, SONIOX_PREVIEW_LANE) —
// PREVIEW_TIER/SONIOX_PREVIEW_LANE are both import-time consts
// (deployTier.ts), so this needs its own file + vi.mock rather than a
// describe block inside engineOptions.test.ts (ambient PREVIEW_TIER:
// false there, per that file's own header comment) or engineOptions.
// deriveEngineForMode.test.ts (same ambient limitation — that file's
// own sanitize-pass calls never exercise a true isPreview either).
// Mirrors engineOptions.desktop.test.ts's one-file-per-const-combo
// convention. The "lane off" contrast (PREVIEW_TIER:true, SONIOX_
// PREVIEW_LANE:false — today's existing byokOnly lock, unchanged) lives
// in engineOptions.sonioxPreviewLaneOff.test.ts.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/deployTier", () => ({ PREVIEW_TIER: true, SONIOX_PREVIEW_LANE: true }));

import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import {
  deriveEngineForMode,
  engineOptionGate,
  PREVIEW_LOCKED_TITLE,
  SONIOX_PREVIEW_TRIAL_TITLE,
  type EngineOption,
} from "../engineOptions";

describe("engineOptionGate — soniox preview lane ON", () => {
  const whisper: EngineOption = {
    value: "whisper",
    label: "本地 Whisper",
    posture: "local",
    retentionClass: "local",
    sidecarOnly: true,
  };
  const soniox: EngineOption = {
    value: "soniox",
    label: "Soniox 云端识别",
    posture: "cloud",
    retentionClass: "cloud-transient",
    byokOnly: true,
  };
  const deepgram: EngineOption = {
    value: "deepgram",
    label: "Deepgram 云端识别",
    posture: "cloud",
    retentionClass: "cloud-transient",
    byokOnly: true,
  };
  const tabAudioCloud: EngineOption = {
    value: "tabaudio-cloud",
    label: "标签页音频·云端",
    posture: "cloud",
    retentionClass: "cloud-transient",
    byokOnly: true,
  };

  it("soniox is unlocked with the honest trial title instead of the 「本地版功能」 lock", () => {
    expect(engineOptionGate(soniox, null)).toEqual({ disabled: false, title: SONIOX_PREVIEW_TRIAL_TITLE });
  });

  // BYOK preview (docs/design-explorations/byok-preview-blueprint.md
  // D3): tabaudio-cloud no longer gets the trial title — its runtime
  // provider is now an honest reflection of Settings.
  // tabAudioCloudProvider (tabAudioCloud.ts's own effectiveProvider),
  // which may resolve to Deepgram (no trial at all), so a blanket
  // "预览体验" hint on the OPTION itself would be wrong half the time.
  it("tabaudio-cloud is unlocked but carries NO trial title — its provider isn't necessarily Soniox anymore", () => {
    expect(engineOptionGate(tabAudioCloud, null)).toEqual({ disabled: false, title: undefined });
  });

  it("every OTHER byokOnly engine (deepgram) is ALSO unlocked now — D3 dropped byokOnly from the lock condition entirely, not just for soniox/tabaudio-cloud", () => {
    expect(engineOptionGate(deepgram, null)).toEqual({ disabled: false, title: undefined });
  });

  it("sidecarOnly (whisper) stays locked regardless — the lane only ever touched byokOnly, never sidecarOnly", () => {
    expect(engineOptionGate(whisper, null)).toEqual({ disabled: true, title: PREVIEW_LOCKED_TITLE });
  });
});

describe("deriveEngineForMode — soniox preview lane ON", () => {
  it("web mic, engine already soniox with NO key at all -> respected (BYOK preview D3: first-class on preview even keyless)", () => {
    const settings = { ...DEFAULT_SETTINGS, engine: "soniox" as const, sonioxKey: "" };
    expect(deriveEngineForMode("mic", { isDesktop: false, isIos: false }, settings)).toBe("soniox");
  });

  it("web tab, no keys at all -> tabaudio-cloud (D3: PREVIEW_TIER alone makes it derivable, no lane/key required)", () => {
    const settings = { ...DEFAULT_SETTINGS, sonioxKey: "", deepgramKey: "" };
    expect(deriveEngineForMode("tab", { isDesktop: false, isIos: false }, settings)).toBe("tabaudio-cloud");
  });
});
