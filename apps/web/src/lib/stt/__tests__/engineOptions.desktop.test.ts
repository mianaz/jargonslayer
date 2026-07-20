// ENGINE_OPTIONS — desktop-only coverage (S11, v0.4.3). IS_DESKTOP is a
// module-scope import-time const (lib/platform/desktop.ts) — vi.mock
// affects this whole file, so this lives in its own file rather than a
// describe block inside engineOptions.test.ts, which needs the REAL
// (false) value for its own ambient (web) coverage — same split
// SettingsDialog.desktop.test.tsx/TaskCenterDrawer.desktop.test.tsx
// already established for the identical constraint (see those files'
// own header comments).

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform/desktop", () => ({ IS_DESKTOP: true }));

import { ENGINE_OPTIONS } from "../engineOptions";

describe("ENGINE_OPTIONS (desktop build)", () => {
  it("swaps tabaudio for appaudio (D7) AND adds osspeech (S11), dropping webspeech (S10 field-fix #1), and lists deepgram alongside soniox (v0.4.7 Lane D)", () => {
    const values = ENGINE_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["whisper", "appaudio", "osspeech", "soniox", "deepgram"]);
  });

  it("osspeech carries the S11-pinned label, local posture, and is NOT sidecarOnly (zero-install, no local Whisper sidecar)", () => {
    const osspeech = ENGINE_OPTIONS.find((o) => o.value === "osspeech");
    expect(osspeech).toEqual({
      value: "osspeech",
      label: "系统识别 · 开箱即用",
      posture: "local",
      retentionClass: "local",
    });
  });
});
