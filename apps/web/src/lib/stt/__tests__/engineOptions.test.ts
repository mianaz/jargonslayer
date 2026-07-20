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
import type { STTEngineKind } from "@jargonslayer/core/types";
import {
  ENGINE_OPTIONS,
  PREVIEW_LOCKED_TITLE,
  RETENTION_COPY,
  engineOptionGate,
  resolveEngineRetentionClass,
  type EngineOption,
} from "../engineOptions";

describe("ENGINE_OPTIONS (web build, ambient test env)", () => {
  it("keeps webspeech (web never drops it) and tabaudio (D7: desktop-only swaps to appaudio), adds tabaudio-cloud (v0.5 Wave-1 F4: web-only), and lists deepgram alongside soniox (v0.4.7 Lane D: web + desktop, no iOS v1)", () => {
    const values = ENGINE_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["webspeech", "whisper", "tabaudio", "tabaudio-cloud", "soniox", "deepgram"]);
  });

  it("every option carries a zh label, a local/cloud posture, and a matching retentionClass", () => {
    for (const opt of ENGINE_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(["local", "cloud"]).toContain(opt.posture);
      expect(["local", "cloud-transient", "cloud-stored"]).toContain(opt.retentionClass);
      // posture is DERIVED from retentionClass (engineCapabilities.ts's
      // derivePosture) — the two must never disagree on local-vs-cloud.
      expect(opt.posture).toBe(opt.retentionClass === "local" ? "local" : "cloud");
    }
  });

  // v0.5 Wave-1 Feature 4 (docs/design-explorations/v05-wave1-blueprint.
  // md §1 Feature 4 + §5 A4): exact shape, mirrors this file's own
  // osspeech pin in engineOptions.desktop.test.ts — byokOnly (same
  // preview lock as soniox/deepgram), cloud-transient/cloud posture (the
  // DEFAULT provider's static row — engineCapabilities.test.ts covers
  // the provider-aware resolveEngineCapability overlay this projection
  // does NOT yet consume).
  it("tabaudio-cloud: exact shape (byokOnly cloud-transient, DEFAULT-provider label)", () => {
    const tabaudioCloud = ENGINE_OPTIONS.find((o) => o.value === "tabaudio-cloud");
    expect(tabaudioCloud).toEqual({
      value: "tabaudio-cloud",
      label: "标签页音频·云端",
      posture: "cloud",
      retentionClass: "cloud-transient",
      byokOnly: true,
    });
  });
});

// v0.4.7 Lane C — tri-state privacy label (docs/design-explorations/
// stt-provider-wiring-2026-07.md §4, §9 D5-D7 + Lane C addendum).
// RETENTION_COPY pins the three states' label+hint+color byte-for-byte;
// resolveEngineRetentionClass pins the D7 runtime narrowing (webspeech
// on-device) — the ONE function StatusLine's privacy segment and
// Header's EnginePostureChip both call, so they can never disagree.
// No live engine occupies cloud-stored yet (Deepgram resolves to
// cloud-transient per D7's unconditional mip_opt_out=true) — pinned
// directly here since no ENGINE_OPTIONS entry can reach it through
// StatusLine/Header's own rendering path.
describe("RETENTION_COPY — tri-state label+hint table", () => {
  it("all three states carry a non-empty label/hint and the green/amber/red color idiom, doc §4 wording verbatim", () => {
    expect(RETENTION_COPY.local).toEqual({
      label: "本地",
      hint: "本地处理 · 音频不出设备",
      textClass: "text-lab-green",
      borderClass: "border-lab-green/30",
    });
    expect(RETENTION_COPY["cloud-transient"]).toEqual({
      label: "云端·不留存",
      hint: "云端 · 处理后不留存",
      textClass: "text-warn-soft",
      borderClass: "border-warn-soft/30",
    });
    expect(RETENTION_COPY["cloud-stored"]).toEqual({
      label: "云端·可能留存",
      hint: "云端 · 可能留存/需配置",
      textClass: "text-lab-red",
      borderClass: "border-lab-red/30",
    });
  });

  it("every state's textClass/borderClass share the same color token (no green border with amber text, etc.)", () => {
    for (const copy of Object.values(RETENTION_COPY)) {
      const token = copy.textClass.replace("text-", "");
      expect(copy.borderClass).toBe(`border-${token}/30`);
    }
  });
});

describe("resolveEngineRetentionClass — D7 runtime resolution", () => {
  it("demo is hard-pinned local regardless of sttEngineMode (no audio exists at all)", () => {
    expect(resolveEngineRetentionClass("demo", null)).toBe("local");
    expect(resolveEngineRetentionClass("demo", "cloud")).toBe("local");
  });

  it("an engine absent from ENGINE_OPTIONS (e.g. import, or a future unrecognized value) falls back to cloud-transient — never local", () => {
    expect(resolveEngineRetentionClass("import", null)).toBe("cloud-transient");
    expect(resolveEngineRetentionClass("future-engine" as unknown as STTEngineKind, null)).toBe(
      "cloud-transient",
    );
  });

  it("a local static engine (whisper) ignores sttEngineMode entirely", () => {
    expect(resolveEngineRetentionClass("whisper", "on-device")).toBe("local");
    expect(resolveEngineRetentionClass("whisper", null)).toBe("local");
  });

  it("a cloud static engine (soniox) ignores sttEngineMode too — the on-device overlay is webspeech-only", () => {
    expect(resolveEngineRetentionClass("soniox", "on-device")).toBe("cloud-transient");
  });

  it("webspeech + sttEngineMode:'on-device' narrows the cloud-transient static default to local", () => {
    expect(resolveEngineRetentionClass("webspeech", "on-device")).toBe("local");
  });

  it("webspeech + sttEngineMode:'cloud' or null stays at the cloud-transient static default", () => {
    expect(resolveEngineRetentionClass("webspeech", "cloud")).toBe("cloud-transient");
    expect(resolveEngineRetentionClass("webspeech", null)).toBe("cloud-transient");
  });
});

describe("engineOptionGate — preview-tier + macOS-floor gate", () => {
  const whisper: EngineOption = {
    value: "whisper",
    label: "本地 Whisper",
    posture: "local",
    retentionClass: "local",
    sidecarOnly: true,
  };
  const appaudio: EngineOption = {
    value: "appaudio",
    label: "系统/App 音频",
    posture: "local",
    retentionClass: "local",
    sidecarOnly: true,
  };
  const osspeech: EngineOption = {
    value: "osspeech",
    label: "系统识别 · 开箱即用",
    posture: "local",
    retentionClass: "local",
  };
  const webspeech: EngineOption = {
    value: "webspeech",
    label: "浏览器识别",
    posture: "cloud",
    retentionClass: "cloud-transient",
  };

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

  // S11 (v0.4.3): osspeech's own macOS-26 floor, gated via the SAME
  // function's optional 3rd (osspeechCaps) argument — additive, so
  // every call site above that only ever passes 2 args keeps compiling
  // AND keeps working (osspeech simply never floor-locks for them).
  describe("osspeech macOS-26 floor (3rd, optional argument)", () => {
    it("osspeech below the floor (caps.supported:false): disabled, title = caps.reason", () => {
      const osspeechCaps = { supported: false, reason: "需要 macOS 26 或更高版本", locales: [], installedLocales: [] };
      expect(engineOptionGate(osspeech, null, osspeechCaps)).toEqual({ disabled: true, title: osspeechCaps.reason });
    });

    it("osspeech at/above the floor (caps.supported:true): not locked", () => {
      const osspeechCaps = { supported: true, reason: null, locales: ["en_US"], installedLocales: ["en_US"] };
      expect(engineOptionGate(osspeech, null, osspeechCaps)).toEqual({ disabled: false, title: undefined });
    });

    it("omitting the 3rd argument entirely (a caller not yet updated for S11) never locks osspeech — additive/backward-compatible", () => {
      expect(engineOptionGate(osspeech, null)).toEqual({ disabled: false, title: undefined });
    });

    it("a null osspeechCaps (not-yet-resolved) never locks — fail-open", () => {
      expect(engineOptionGate(osspeech, null, null)).toEqual({ disabled: false, title: undefined });
    });

    it("the osspeech floor gate is a structural no-op for every OTHER engine value, including appaudio's own floor staying independent", () => {
      const osspeechCaps = { supported: false, reason: "需要 macOS 26 或更高版本", locales: [], installedLocales: [] };
      const appaudioCaps = { appAudioSupported: true, reason: null };
      expect(engineOptionGate(appaudio, appaudioCaps, osspeechCaps)).toEqual({ disabled: false, title: undefined });
    });
  });
});
