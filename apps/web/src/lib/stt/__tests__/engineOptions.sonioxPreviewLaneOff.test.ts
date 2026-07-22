// Soniox preview lane OFF contrast (PREVIEW_TIER:true, SONIOX_PREVIEW_
// LANE:false) — BYOK preview (docs/design-explorations/byok-preview-
// blueprint.md D3) made byokOnly's preview unlock unconditional on the
// TIER alone, no trial flag required: this file now proves the INVERSE
// of what it used to (the trial flag, not the tier, used to gate the
// byokOnly unlock — that's gone). What the trial flag still exclusively
// gates: the honest SONIOX_PREVIEW_TRIAL_TITLE hint on the soniox
// option, and the mint path itself (tabAudioCloud.ts/soniox.ts, out of
// this pure-gate function's scope). sidecarOnly (whisper) stays locked
// here too — unaffected by either flag, always was. See engineOptions.
// sonioxPreviewLane.test.ts's own header for why this is a separate
// file (one-file-per-const-combo, mirrors engineOptions.desktop.test.ts
// — vi.mock is file-scoped/hoisted, so the ON and OFF combos can't
// share one file without a resetModules+dynamic-import workaround this
// repo's own tests deliberately avoid, see SettingsDialog.test.tsx's
// 更换模型 describe block).

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/deployTier", () => ({ PREVIEW_TIER: true, SONIOX_PREVIEW_LANE: false }));

import { engineOptionGate, PREVIEW_LOCKED_TITLE, type EngineOption } from "../engineOptions";

describe("engineOptionGate — soniox preview lane OFF (preview tier, trial flag not set)", () => {
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

  it("soniox is unlocked even WITHOUT the trial flag — D3 gates byokOnly on PREVIEW_TIER alone — but carries no trial title (no funded trial to advertise)", () => {
    expect(engineOptionGate(soniox, null)).toEqual({ disabled: false, title: undefined });
  });

  it("deepgram is equally unlocked — never had a trial to begin with, same unconditional D3 unlock as soniox", () => {
    expect(engineOptionGate(deepgram, null)).toEqual({ disabled: false, title: undefined });
  });

  it("tabaudio-cloud is equally unlocked, no title either", () => {
    expect(engineOptionGate(tabAudioCloud, null)).toEqual({ disabled: false, title: undefined });
  });

  it("sidecarOnly (whisper) stays locked — unaffected by either preview-tier flag, the hosted build genuinely has no sidecar", () => {
    expect(engineOptionGate(whisper, null)).toEqual({ disabled: true, title: PREVIEW_LOCKED_TITLE });
  });
});
