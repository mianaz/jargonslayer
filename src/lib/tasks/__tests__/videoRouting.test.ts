import { describe, expect, it } from "vitest";
import { decideVideoRouting } from "../videoRouting";

describe("decideVideoRouting — sidecar-healthy × tier decision table (#58 design decision 6)", () => {
  it("preview tier: browser default, sidecar unavailable AND locked, regardless of health", () => {
    expect(
      decideVideoRouting({ sidecarHealth: { diarization_ready: true }, isPreviewTier: true }),
    ).toEqual({ defaultPath: "browser", sidecarAvailable: false, sidecarLocked: true });
    expect(decideVideoRouting({ sidecarHealth: null, isPreviewTier: true })).toEqual({
      defaultPath: "browser",
      sidecarAvailable: false,
      sidecarLocked: true,
    });
    expect(decideVideoRouting({ sidecarHealth: undefined, isPreviewTier: true })).toEqual({
      defaultPath: "browser",
      sidecarAvailable: false,
      sidecarLocked: true,
    });
  });

  it("local tier, sidecar reachable (diarization_ready true or false): sidecar is the default and available, not locked", () => {
    expect(
      decideVideoRouting({ sidecarHealth: { diarization_ready: true }, isPreviewTier: false }),
    ).toEqual({ defaultPath: "sidecar", sidecarAvailable: true, sidecarLocked: false });
    expect(
      decideVideoRouting({ sidecarHealth: { diarization_ready: false }, isPreviewTier: false }),
    ).toEqual({ defaultPath: "sidecar", sidecarAvailable: true, sidecarLocked: false });
  });

  it("local tier, sidecar confirmed unreachable (health === null): browser default, sidecar unavailable but NOT locked (it's just down, not a tier restriction)", () => {
    expect(decideVideoRouting({ sidecarHealth: null, isPreviewTier: false })).toEqual({
      defaultPath: "browser",
      sidecarAvailable: false,
      sidecarLocked: false,
    });
  });

  it("local tier, health not yet probed (undefined): optimistically available/default sidecar, same as the pre-existing sidecarReachable posture (don't flash disabled before the probe resolves)", () => {
    expect(decideVideoRouting({ sidecarHealth: undefined, isPreviewTier: false })).toEqual({
      defaultPath: "sidecar",
      sidecarAvailable: true,
      sidecarLocked: false,
    });
  });
});
