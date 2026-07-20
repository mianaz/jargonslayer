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

  it("tabaudio-cloud joins the SAME carve-out — its own start() always forces the minted-Soniox path on this lane", () => {
    expect(engineOptionGate(tabAudioCloud, null)).toEqual({ disabled: false, title: SONIOX_PREVIEW_TRIAL_TITLE });
  });

  it("every OTHER byokOnly engine (deepgram) stays locked — the carve-out is soniox/tabaudio-cloud-specific, not a blanket preview unlock", () => {
    expect(engineOptionGate(deepgram, null)).toEqual({ disabled: true, title: PREVIEW_LOCKED_TITLE });
  });
});

describe("deriveEngineForMode — soniox preview lane ON", () => {
  it("web mic, engine already soniox with NO key at all -> respected (the trial needs no BYOK key)", () => {
    const settings = { ...DEFAULT_SETTINGS, engine: "soniox" as const, sonioxKey: "" };
    expect(deriveEngineForMode("mic", { isDesktop: false, isIos: false }, settings)).toBe("soniox");
  });

  it("web tab, no keys at all -> tabaudio-cloud (tabAudioCloud.ts's own start() forces the soniox+mint path on this lane)", () => {
    const settings = { ...DEFAULT_SETTINGS, sonioxKey: "", deepgramKey: "" };
    expect(deriveEngineForMode("tab", { isDesktop: false, isIos: false }, settings)).toBe("tabaudio-cloud");
  });
});
