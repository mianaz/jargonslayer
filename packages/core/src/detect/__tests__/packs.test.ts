import { describe, expect, it } from "vitest";
import { isPackEnabled } from "../packs";

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
