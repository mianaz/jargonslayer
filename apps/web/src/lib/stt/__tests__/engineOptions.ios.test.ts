// ENGINE_OPTIONS — iOS-only coverage (S13, docs/design-explorations/
// s13-ios-blueprint.md, §6; widened by the iOS-cloud round, post-v0.6.0
// 手机版显然应该允许云端). IS_IOS is a module-scope import-time const
// (lib/platform/ios.ts) — vi.mock affects this whole file, so this lives
// in its own file rather than a describe block inside engineOptions.
// test.ts/engineOptions.desktop.test.ts, mirroring that pair's own
// existing split for the identical constraint.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true }));

import { ENGINE_OPTIONS } from "../engineOptions";

describe("ENGINE_OPTIONS (iOS build)", () => {
  it("is osspeech + the three BYOK cloud mic engines, osspeech FIRST (iOS-cloud round; still no webspeech/whisper/tabaudio/appaudio/tabaudio-cloud — each lacks an iOS capture path, see IOS_ENGINE_OPTIONS' own comment)", () => {
    const values = ENGINE_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["osspeech", "soniox", "deepgram", "elevenlabs"]);
  });

  it("osspeech carries the SAME S11-pinned label/posture the desktop build uses (Miana-veto #2: never say this engine's name differently)", () => {
    expect(ENGINE_OPTIONS[0]).toEqual({
      value: "osspeech",
      label: "系统识别",
      posture: "local",
      retentionClass: "local",
    });
  });

  it("the cloud trio projects the same capability rows every other surface reads (byokOnly + honest retention — elevenlabs is cloud-stored, not transient)", () => {
    const byValue = Object.fromEntries(ENGINE_OPTIONS.map((o) => [o.value, o]));
    expect(byValue.soniox).toMatchObject({ posture: "cloud", retentionClass: "cloud-transient", byokOnly: true });
    expect(byValue.deepgram).toMatchObject({ posture: "cloud", retentionClass: "cloud-transient", byokOnly: true });
    expect(byValue.elevenlabs).toMatchObject({ posture: "cloud", retentionClass: "cloud-stored", byokOnly: true });
  });
});
