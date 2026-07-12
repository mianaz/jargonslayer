// v0.4 S4 chunk 3 — MODEL_CATALOG's own invariants: the picker's data
// module never offers a model the Rust/marker side would reject, never
// offers the two weak models, and always recommends exactly one
// (medium).
import { describe, expect, it } from "vitest";

import { MODEL_CATALOG, WIZARD_PRESELECTED_MODEL } from "../modelCatalog";
import { ALLOWED_MARKER_MODELS } from "../provisionMachine";

describe("MODEL_CATALOG", () => {
  it("every catalog id is a member of provisionMachine.ts's ALLOWED_MARKER_MODELS (the Rust/marker allowlist) — catalog ⊆ allowlist", () => {
    for (const entry of MODEL_CATALOG) {
      expect(ALLOWED_MARKER_MODELS).toContain(entry.id);
    }
  });

  it("does not offer tiny/base — too weak to recommend, even though the allowlist itself still permits them", () => {
    const ids = MODEL_CATALOG.map((e) => e.id);
    expect(ids).not.toContain("tiny");
    expect(ids).not.toContain("base");
  });

  it("covers exactly small/medium/large-v3/large-v3-turbo, in the PLAN-v0.4.md §2 table's own order", () => {
    expect(MODEL_CATALOG.map((e) => e.id)).toEqual(["small", "medium", "large-v3", "large-v3-turbo"]);
  });

  it("ids are unique", () => {
    const ids = MODEL_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exactly one entry is recommended, and it is medium", () => {
    const recommended = MODEL_CATALOG.filter((e) => e.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0].id).toBe("medium");
  });

  it("every entry has a non-empty label/size/speed-hint/quality-hint", () => {
    for (const entry of MODEL_CATALOG) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.size.length).toBeGreaterThan(0);
      expect(entry.macSpeedHint.length).toBeGreaterThan(0);
      expect(entry.qualityHint.length).toBeGreaterThan(0);
    }
  });

  it("size strings are the exact blueprint values (~0.46GB/~1.5GB/~1.6GB/~1.6GB)", () => {
    expect(MODEL_CATALOG.map((e) => e.size)).toEqual(["~0.46GB", "~1.5GB", "~1.6GB", "~1.6GB"]);
  });

  it("wizard labels are the exact blueprint decision A values", () => {
    expect(MODEL_CATALOG.map((e) => e.label)).toEqual([
      "轻量·默认",
      "均衡·推荐 (zh-en)",
      "最高精度",
      "快·精度高 (English-primary)",
    ]);
  });

  it("WIZARD_PRESELECTED_MODEL (medium, the veto-window default) is a valid catalog id", () => {
    expect(MODEL_CATALOG.map((e) => e.id)).toContain(WIZARD_PRESELECTED_MODEL);
    expect(WIZARD_PRESELECTED_MODEL).toBe("medium");
  });
});
