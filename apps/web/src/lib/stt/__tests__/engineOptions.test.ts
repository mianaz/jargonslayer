// ENGINE_OPTIONS/engineOptionGate — extracted out of Header.tsx (S10
// field-fix wave 2). IS_DESKTOP/PREVIEW_TIER are import-time consts
// (platform/desktop.ts, deployTier.ts) no runtime vi.stubEnv can flip
// once this module has already been imported — see SettingsDialog.
// test.tsx's own "更换模型" describe block for the identical, already-
// documented limitation. This suite therefore only exercises the
// ambient test env's actual values (IS_DESKTOP=false, PREVIEW_TIER=
// false, i.e. the ordinary web/full-tier build) plus the macOS-floor
// gate, which needs no build-time const at all.

import { describe, expect, it } from "vitest";
import { ENGINE_OPTIONS, PREVIEW_LOCKED_TITLE, engineOptionGate, type EngineOption } from "../engineOptions";

describe("ENGINE_OPTIONS (web build, ambient test env)", () => {
  it("keeps webspeech (web never drops it) and tabaudio (D7: desktop-only swaps to appaudio)", () => {
    const values = ENGINE_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["webspeech", "whisper", "tabaudio", "soniox"]);
  });

  it("every option carries a zh label and a local/cloud posture", () => {
    for (const opt of ENGINE_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(["local", "cloud"]).toContain(opt.posture);
    }
  });
});

describe("engineOptionGate — preview-tier + macOS-floor gate", () => {
  const whisper: EngineOption = { value: "whisper", label: "本地 Whisper", posture: "local", sidecarOnly: true };
  const appaudio: EngineOption = { value: "appaudio", label: "系统/App 音频", posture: "local", sidecarOnly: true };
  const webspeech: EngineOption = { value: "webspeech", label: "浏览器识别", posture: "cloud" };

  it("full tier (PREVIEW_TIER false here), caps not yet resolved: never locked", () => {
    expect(engineOptionGate(whisper, null)).toEqual({ disabled: false, title: undefined });
  });

  it("appaudio below the macOS floor (caps.appAudioSupported:false): disabled, title = caps.reason", () => {
    const caps = { appAudioSupported: false, reason: "需要 macOS 14.4 或更高版本" };
    expect(engineOptionGate(appaudio, caps)).toEqual({ disabled: true, title: caps.reason });
  });

  it("appaudio at/above the macOS floor (caps.appAudioSupported:true): not locked", () => {
    const caps = { appAudioSupported: true, reason: null };
    expect(engineOptionGate(appaudio, caps)).toEqual({ disabled: false, title: undefined });
  });

  it("the floor gate is a structural no-op for every other engine value", () => {
    const caps = { appAudioSupported: false, reason: "需要 macOS 14.4 或更高版本" };
    expect(engineOptionGate(webspeech, caps)).toEqual({ disabled: false, title: undefined });
  });

  it("PREVIEW_LOCKED_TITLE stays reason-agnostic (covers both sidecarOnly and byokOnly)", () => {
    expect(PREVIEW_LOCKED_TITLE).toBe("本地版功能：体验版暂未开放");
  });
});
