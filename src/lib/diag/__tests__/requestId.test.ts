import { describe, expect, it } from "vitest";
import { newRequestId } from "../requestId";

describe("diag/requestId.ts — newRequestId", () => {
  it("returns a non-empty string", () => {
    const id = newRequestId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("produces different ids across calls (statistical)", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
    expect(ids.size).toBeGreaterThan(190);
  });
});
