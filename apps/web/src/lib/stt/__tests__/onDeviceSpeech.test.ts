import { describe, expect, it } from "vitest";
import { decideOnDeviceMode, type OnDeviceAvailability } from "../onDeviceSpeech";

const ALL_AVAILABILITY: OnDeviceAvailability[] = [
  "available",
  "downloadable",
  "downloading",
  "unavailable",
  "api-absent",
];

describe("decideOnDeviceMode", () => {
  it("pref off -> cloud, never install, regardless of availability", () => {
    for (const availability of ALL_AVAILABILITY) {
      expect(decideOnDeviceMode(availability, false)).toEqual({
        mode: "cloud",
        triggerInstall: false,
      });
    }
  });

  it("available + pref on -> on-device, no install needed", () => {
    expect(decideOnDeviceMode("available", true)).toEqual({
      mode: "on-device",
      triggerInstall: false,
    });
  });

  it("downloadable + pref on -> cloud now, but triggers install for a later session", () => {
    expect(decideOnDeviceMode("downloadable", true)).toEqual({
      mode: "cloud",
      triggerInstall: true,
    });
  });

  it("downloading + pref on -> cloud, no (duplicate) install", () => {
    expect(decideOnDeviceMode("downloading", true)).toEqual({
      mode: "cloud",
      triggerInstall: false,
    });
  });

  it("unavailable + pref on -> cloud, no install (nothing to install)", () => {
    expect(decideOnDeviceMode("unavailable", true)).toEqual({
      mode: "cloud",
      triggerInstall: false,
    });
  });

  it("api-absent + pref on -> cloud, no install (the feature doesn't exist here)", () => {
    expect(decideOnDeviceMode("api-absent", true)).toEqual({
      mode: "cloud",
      triggerInstall: false,
    });
  });
});
