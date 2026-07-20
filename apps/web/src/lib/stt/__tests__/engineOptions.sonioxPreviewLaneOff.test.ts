// Soniox preview lane OFF contrast (PREVIEW_TIER:true, SONIOX_PREVIEW_
// LANE:false) — proves the FLAG itself, not merely PREVIEW_TIER, gates
// soniox's unlock: today's existing byokOnly lock must survive
// unchanged when the deploy is on preview tier but hasn't turned the
// hosted Soniox trial on (NEXT_PUBLIC_SONIOX_PREVIEW unset/not "1").
// See engineOptions.sonioxPreviewLane.test.ts's own header for why this
// is a separate file (one-file-per-const-combo, mirrors engineOptions.
// desktop.test.ts — vi.mock is file-scoped/hoisted, so the ON and OFF
// combos can't share one file without a resetModules+dynamic-import
// workaround this repo's own tests deliberately avoid, see
// SettingsDialog.test.tsx's 更换模型 describe block).

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/deployTier", () => ({ PREVIEW_TIER: true, SONIOX_PREVIEW_LANE: false }));

import { engineOptionGate, PREVIEW_LOCKED_TITLE, type EngineOption } from "../engineOptions";

describe("engineOptionGate — soniox preview lane OFF (preview tier, trial flag not set)", () => {
  const soniox: EngineOption = {
    value: "soniox",
    label: "Soniox 云端识别",
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

  it("soniox stays locked exactly like every other byokOnly engine — the trial flag, not the tier alone, gates the unlock", () => {
    expect(engineOptionGate(soniox, null)).toEqual({ disabled: true, title: PREVIEW_LOCKED_TITLE });
  });

  it("tabaudio-cloud also stays locked — its own carve-out is equally gated on the trial flag, not the tier alone", () => {
    expect(engineOptionGate(tabAudioCloud, null)).toEqual({ disabled: true, title: PREVIEW_LOCKED_TITLE });
  });
});
