// EngineCapability contract (v0.4.7 STT provider wiring, Lane A —
// docs/design-explorations/stt-provider-wiring-2026-07.md, §9 D5/D6/D7).
// engineOptions.test.ts/.desktop.test.ts/.ios.test.ts already pin
// ENGINE_OPTIONS' exact byte-for-byte shape per platform — those keep
// passing unmodified as the "projection reproduces today's gating
// byte-for-byte" check (§2 Migration) now that ALL_ENGINE_OPTIONS/
// IOS_ENGINE_OPTIONS are generated off ENGINE_CAPABILITIES. This file
// covers the NEW table itself: the D5 shape, the D7 static/runtime
// split, and the D5 cross-invariant test (capability gate ×
// tier-coercion consistency, closing Sol F6's persisted-engine-
// survives-into-preview hole).

import { describe, expect, it } from "vitest";
import {
  derivePosture,
  ENGINE_CAPABILITIES,
  resolveEngineCapability,
  resolveTabAudioCloudProvider,
  resolveWebspeechRetentionClass,
  type EngineCapability,
} from "../engineCapabilities";
import { applyPlatformEngineDefaults, applyTierDefaults } from "@/lib/store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";

describe("ENGINE_CAPABILITIES — D5 contract shape", () => {
  it("keys the Record by each entry's own `kind` (no drift between the map key and the row)", () => {
    for (const [key, cap] of Object.entries(ENGINE_CAPABILITIES)) {
      expect(cap.kind).toBe(key);
    }
  });

  it("every entry carries a non-empty zh label and a valid retentionClass/biasSupport", () => {
    for (const cap of Object.values(ENGINE_CAPABILITIES)) {
      expect(cap.label.length).toBeGreaterThan(0);
      expect(["local", "cloud-transient", "cloud-stored"]).toContain(cap.retentionClass);
      expect(["none", "initial_prompt", "keyterms", "context"]).toContain(cap.biasSupport);
    }
  });

  it("no `requires` array and no CUT fields survive on any entry (D5: 7 fields only)", () => {
    const allowedKeys = new Set([
      "kind",
      "label",
      "retentionClass",
      "biasSupport",
      "sidecarOnly",
      "byokOnly",
      "osFloor",
    ]);
    for (const cap of Object.values(ENGINE_CAPABILITIES)) {
      // Every actual key must be one of the 7 allowed ones — this
      // subsumes checking for a stray `requires` (or any other CUT
      // field): it would show up here as a key not in allowedKeys.
      for (const key of Object.keys(cap)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    }
  });

  it("soniox: one full example entry, exact shape (byokOnly cloud-transient, context bias)", () => {
    const soniox: EngineCapability = ENGINE_CAPABILITIES.soniox;
    expect(soniox).toEqual({
      kind: "soniox",
      label: "Soniox 云端识别",
      retentionClass: "cloud-transient",
      biasSupport: "context",
      byokOnly: true,
    });
  });

  it("deepgram (v0.4.7 Lane D): one full example entry, exact shape (byokOnly cloud-transient — mip_opt_out sent unconditionally per D7 — keyterms bias)", () => {
    const deepgram: EngineCapability = ENGINE_CAPABILITIES.deepgram;
    expect(deepgram).toEqual({
      kind: "deepgram",
      label: "Deepgram 云端识别",
      retentionClass: "cloud-transient",
      biasSupport: "keyterms",
      byokOnly: true,
    });
  });

  it("appaudio/osspeech carry their declarative osFloor tag (macos144/macos26) — inert metadata only, engineOptionGate does not read it (D5: array-subsumption REJECTED)", () => {
    expect(ENGINE_CAPABILITIES.appaudio.osFloor).toBe("macos144");
    expect(ENGINE_CAPABILITIES.osspeech.osFloor).toBe("macos26");
    expect(ENGINE_CAPABILITIES.whisper.osFloor).toBeUndefined();
  });

  it("whisper/tabaudio/appaudio all resolve initial_prompt bias (Sol F15: ALL faster-whisper-backed capture sources, not just the whisper mic slot)", () => {
    expect(ENGINE_CAPABILITIES.whisper.biasSupport).toBe("initial_prompt");
    expect(ENGINE_CAPABILITIES.tabaudio.biasSupport).toBe("initial_prompt");
    expect(ENGINE_CAPABILITIES.appaudio.biasSupport).toBe("initial_prompt");
  });
});

describe("derivePosture — D5: posture is DERIVED from retentionClass, never stored", () => {
  it("local retentionClass derives local posture", () => {
    expect(derivePosture("local")).toBe("local");
  });

  it("both cloud retentionClasses derive cloud posture", () => {
    expect(derivePosture("cloud-transient")).toBe("cloud");
    expect(derivePosture("cloud-stored")).toBe("cloud");
  });

  it("every table entry's derived posture matches its own local/cloud intent", () => {
    expect(derivePosture(ENGINE_CAPABILITIES.whisper.retentionClass)).toBe("local");
    expect(derivePosture(ENGINE_CAPABILITIES.appaudio.retentionClass)).toBe("local");
    expect(derivePosture(ENGINE_CAPABILITIES.tabaudio.retentionClass)).toBe("local");
    expect(derivePosture(ENGINE_CAPABILITIES.osspeech.retentionClass)).toBe("local");
    expect(derivePosture(ENGINE_CAPABILITIES.webspeech.retentionClass)).toBe("cloud");
    expect(derivePosture(ENGINE_CAPABILITIES.soniox.retentionClass)).toBe("cloud");
  });
});

describe("resolveWebspeechRetentionClass — D7 two-layer truth, runtime overlay", () => {
  it("on-device engineMode overrides the cloud-transient static default to local", () => {
    expect(resolveWebspeechRetentionClass("cloud-transient", "on-device")).toBe("local");
  });

  it("cloud engineMode leaves the static default untouched", () => {
    expect(resolveWebspeechRetentionClass("cloud-transient", "cloud")).toBe("cloud-transient");
  });

  it("no engineMode signal (not yet reported this session) falls back to the static default — fail-open, same posture as the other runtime probes in this module", () => {
    expect(resolveWebspeechRetentionClass("cloud-transient")).toBe("cloud-transient");
  });
});

// D5 cross-invariant test: "every preview-ineligible engine appears in
// BOTH the gate and applyTierDefaults/applyPlatformEngineDefaults
// coercion (closes Sol F6's persisted-deepgram-survives-into-preview
// hole)". engineOptionGate's own PREVIEW_TIER branch can't be flipped
// live (import-time const — see engineOptions.test.ts's header comment
// for the established, repeatedly-documented reason this codebase
// never vi.mocks lib/deployTier for it, e.g. SettingsDialog.test.tsx's
// "PREVIEW_TIER/IS_DESKTOP are import-time consts" block), so the
// "gate" half is exercised via the EXACT boolean expression the gate
// itself evaluates (`sidecarOnly || byokOnly`) — this is what actually
// walks the FULL live table (unlike the gate's own tests, which only
// exercise hand-picked EngineOption literals), so a future engine
// (Lane D's "deepgram") added to ENGINE_CAPABILITIES with byokOnly:true
// but never added to store.ts's coercion lists fails HERE, at the data
// level, not just when someone happens to also write a picker test for
// it. The "coercion" half runs the REAL applyPlatformEngineDefaults ->
// applyTierDefaults pipeline migrateSettings itself composes.
describe("cross-invariant: preview-gate-locked capability entries never survive the platform->tier coercion pipeline (Sol F6)", () => {
  const previewIneligible = Object.values(ENGINE_CAPABILITIES).filter(
    (cap) => cap.sidecarOnly || cap.byokOnly,
  );

  it("today's table has at least one sidecarOnly and one byokOnly entry (sanity — a table with none would make this describe block vacuous)", () => {
    expect(previewIneligible.some((cap) => cap.sidecarOnly)).toBe(true);
    expect(previewIneligible.some((cap) => cap.byokOnly)).toBe(true);
  });

  it.each(previewIneligible.map((cap) => [cap.kind, cap] as const))(
    "%s (gate-locked: sidecarOnly||byokOnly) is coerced away by applyTierDefaults on every platform that can persist it",
    (kind, cap) => {
      for (const [isDesktop, isIos] of [
        [false, false], // web
        [true, false], // desktop
        [false, true], // iOS
      ] as const) {
        const persisted = { ...DEFAULT_SETTINGS, engine: kind };
        const platformSettings = applyPlatformEngineDefaults(persisted, isDesktop, isIos);
        const tierSettings = applyTierDefaults(platformSettings, /* isPreview */ true, /* hadSavedEngine */ true);
        expect(tierSettings.engine).not.toBe(cap.kind);
      }
    },
  );

  it("webspeech (no sidecarOnly/byokOnly — the intended preview default) is left alone by applyTierDefaults — the coercion isn't over-broad either. NOT a general 'every other entry' check: osspeech carries neither flag either but IS still hardcoded away in store.ts for its own (platform-structural, not byokOnly/sidecarOnly) reasons — see store.test.ts's own applyTierDefaults coverage", () => {
    const s = applyTierDefaults({ ...DEFAULT_SETTINGS, engine: ENGINE_CAPABILITIES.webspeech.kind }, true, true);
    expect(s.engine).toBe("webspeech");
  });
});

// v0.5 Wave-1 Feature 4 (docs/design-explorations/v05-wave1-blueprint.md
// §5 A4): provider-aware capability overlay — resolveTabAudioCloudProvider's
// sanitization contract and resolveEngineCapability's truth table.
describe("resolveTabAudioCloudProvider — A4 sanitization", () => {
  it("returns 'deepgram' only for the literal value 'deepgram'", () => {
    expect(resolveTabAudioCloudProvider({ ...DEFAULT_SETTINGS, tabAudioCloudProvider: "deepgram" })).toBe(
      "deepgram",
    );
  });

  it("falls back to 'soniox' for the DEFAULT_SETTINGS value", () => {
    expect(resolveTabAudioCloudProvider(DEFAULT_SETTINGS)).toBe("soniox");
  });

  it("falls back to 'soniox' for any invalid/corrupted persisted string (localStorage survives no runtime type guarantee)", () => {
    expect(
      resolveTabAudioCloudProvider({
        ...DEFAULT_SETTINGS,
        tabAudioCloudProvider: "azure" as unknown as "soniox" | "deepgram",
      }),
    ).toBe("soniox");
    expect(
      resolveTabAudioCloudProvider({
        ...DEFAULT_SETTINGS,
        tabAudioCloudProvider: undefined as unknown as "soniox" | "deepgram",
      }),
    ).toBe("soniox");
  });
});

describe("resolveEngineCapability — A4 provider-aware overlay truth table", () => {
  it("every kind besides tabaudio-cloud is a structural no-op (returns the static row as-is)", () => {
    for (const kind of Object.keys(ENGINE_CAPABILITIES) as (keyof typeof ENGINE_CAPABILITIES)[]) {
      if (kind === "tabaudio-cloud") continue;
      expect(resolveEngineCapability(kind, DEFAULT_SETTINGS)).toBe(ENGINE_CAPABILITIES[kind]);
    }
  });

  it("tabaudio-cloud + default settings (soniox): context bias, Soniox label suffix", () => {
    const cap = resolveEngineCapability("tabaudio-cloud", DEFAULT_SETTINGS);
    expect(cap).toEqual({
      kind: "tabaudio-cloud",
      label: "标签页音频·云端（Soniox）",
      retentionClass: "cloud-transient",
      biasSupport: "context",
      byokOnly: true,
    });
  });

  it("tabaudio-cloud + tabAudioCloudProvider:'deepgram': keyterms bias, Deepgram label suffix", () => {
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

  it("tabaudio-cloud + an invalid persisted provider string sanitizes to soniox's own overlay", () => {
    const cap = resolveEngineCapability("tabaudio-cloud", {
      ...DEFAULT_SETTINGS,
      tabAudioCloudProvider: "azure" as unknown as "soniox" | "deepgram",
    });
    expect(cap.biasSupport).toBe("context");
    expect(cap.label).toBe("标签页音频·云端（Soniox）");
  });

  it("resolved biasSupport matches the corresponding live engine's own static biasSupport (soniox/deepgram never disagree with their tab-cloud overlay)", () => {
    expect(resolveEngineCapability("tabaudio-cloud", { ...DEFAULT_SETTINGS, tabAudioCloudProvider: "soniox" }).biasSupport).toBe(
      ENGINE_CAPABILITIES.soniox.biasSupport,
    );
    expect(
      resolveEngineCapability("tabaudio-cloud", { ...DEFAULT_SETTINGS, tabAudioCloudProvider: "deepgram" }).biasSupport,
    ).toBe(ENGINE_CAPABILITIES.deepgram.biasSupport);
  });
});
