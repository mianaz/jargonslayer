import { describe, expect, it } from "vitest";
import { isPackEnabled, materializeEnabledPacks } from "../packs";

describe("isPackEnabled", () => {
  it("returns true for any pack when enabled is null (everything on)", () => {
    expect(isPackEnabled("meeting-flow", null)).toBe(true);
    expect(isPackEnabled("academic", null)).toBe(true);
    expect(isPackEnabled("some-unknown-pack", null)).toBe(true);
  });

  it("'core' is always enabled regardless of the enabled list", () => {
    expect(isPackEnabled("core", null)).toBe(true);
    expect(isPackEnabled("core", [])).toBe(true);
    expect(isPackEnabled("core", ["academic"])).toBe(true); // core not even listed
  });

  it("a listed pack is enabled", () => {
    expect(isPackEnabled("academic", ["academic", "sales"])).toBe(true);
  });

  it("an unlisted pack is disabled", () => {
    expect(isPackEnabled("academic", ["sales", "feedback"])).toBe(false);
  });

  it("an empty enabled array disables every non-core pack", () => {
    expect(isPackEnabled("meeting-flow", [])).toBe(false);
    expect(isPackEnabled("core", [])).toBe(true);
  });
});

describe("materializeEnabledPacks (v0.6 T3)", () => {
  it("null currentEnabled materializes the full list: built-ins + already-installed remote ids + the new id", () => {
    const result = materializeEnabledPacks(null, ["core", "academic"], ["remote-a"], "remote-b");
    expect(result).toEqual(["core", "academic", "remote-a", "remote-b"]);
  });

  it("an explicit currentEnabled list is only ever appended to — allBuiltInIds/installedIds are ignored so a user's disabled packs never get resurrected", () => {
    const result = materializeEnabledPacks(["academic", "sales"], ["core", "academic"], ["remote-a"], "remote-b");
    expect(result).toEqual(["academic", "sales", "remote-b"]);
  });

  it("appending an id already present in the explicit list is a no-op (dedupe, order unchanged)", () => {
    const result = materializeEnabledPacks(["academic", "remote-b"], ["core"], [], "remote-b");
    expect(result).toEqual(["academic", "remote-b"]);
  });

  it("null currentEnabled dedupes across all three sources (an id appearing in more than one input isn't repeated)", () => {
    const result = materializeEnabledPacks(null, ["core"], ["core", "remote-a"], "remote-a");
    expect(result).toEqual(["core", "remote-a"]);
  });
});
