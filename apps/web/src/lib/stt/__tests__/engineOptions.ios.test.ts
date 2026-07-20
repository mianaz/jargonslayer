// ENGINE_OPTIONS — iOS-only coverage (S13, docs/design-explorations/
// s13-ios-blueprint.md, §6). IS_IOS is a module-scope import-time const
// (lib/platform/ios.ts) — vi.mock affects this whole file, so this lives
// in its own file rather than a describe block inside engineOptions.
// test.ts/engineOptions.desktop.test.ts, mirroring that pair's own
// existing split for the identical constraint.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true }));

import { ENGINE_OPTIONS } from "../engineOptions";

describe("ENGINE_OPTIONS (iOS build)", () => {
  it("is osspeech ONLY — no webspeech/whisper/tabaudio/appaudio/soniox (v1 mic-only, single native engine)", () => {
    const values = ENGINE_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["osspeech"]);
  });

  it("osspeech carries the SAME S11-pinned label/posture the desktop build uses (Miana-veto #2: never say this engine's name differently)", () => {
    expect(ENGINE_OPTIONS[0]).toEqual({
      value: "osspeech",
      label: "系统识别 · 开箱即用",
      posture: "local",
      retentionClass: "local",
    });
  });
});
