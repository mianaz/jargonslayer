// v0.4 S4 chunk 3 — MODEL_CATALOG's own invariants: the picker's data
// module never offers a model the Rust/marker side would reject, never
// offers the two weak models, and always recommends exactly one
// (medium).
import { describe, expect, it } from "vitest";

import { MODEL_CATALOG, WIZARD_PRESELECTED_MODEL } from "../modelCatalog";
import { ALLOWED_MARKER_MODELS } from "../provisionMachine";

describe("MODEL_CATALOG", () => {
  it("every catalog id (the now fully-offered parakeet entry included) is a member of provisionMachine.ts's ALLOWED_MARKER_MODELS (the Rust/marker allowlist) — catalog ⊆ allowlist", () => {
    // S12a (§C L1 prelude's carve-out, now removed): worker A2's own
    // provisionMachine.ts edit adds parakeet-tdt-0.6b-v3 to
    // ALLOWED_MARKER_MODELS alongside the rest of the parakeet install/
    // marker/quarantine lane, so the invariant is exact — every entry
    // this catalog offers (worker B2's flip, §C L1/§E) was already a
    // valid marker/Rust model id, and a parakeet marker has been a
    // fully real, quarantine-checked possibility (handleCheckResult's
    // own mlx-usability branch) since S12a landed.
    for (const entry of MODEL_CATALOG) {
      expect(ALLOWED_MARKER_MODELS).toContain(entry.id);
    }
  });

  it("does not offer tiny/base — too weak to recommend, even though the allowlist itself still permits them", () => {
    const ids = MODEL_CATALOG.map((e) => e.id);
    expect(ids).not.toContain("tiny");
    expect(ids).not.toContain("base");
  });

  it("covers exactly small/medium/large-v3/large-v3-turbo plus the S12a parakeet stub, in that order", () => {
    expect(MODEL_CATALOG.map((e) => e.id)).toEqual([
      "small",
      "medium",
      "large-v3",
      "large-v3-turbo",
      "parakeet-tdt-0.6b-v3",
    ]);
  });

  it("ids are unique", () => {
    const ids = MODEL_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exactly one entry is recommended, and it is medium — the parakeet stub carries NO 推荐 chip (§C Product/L3)", () => {
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

  it("size strings are the exact blueprint values (~0.46GB/~1.5GB/~1.6GB/~1.6GB/~2.5GB)", () => {
    expect(MODEL_CATALOG.map((e) => e.size)).toEqual(["~0.46GB", "~1.5GB", "~1.6GB", "~1.6GB", "~2.5GB"]);
  });

  it("wizard labels are the exact blueprint decision A values, plus §C Product/L3's parakeet opt-in label", () => {
    expect(MODEL_CATALOG.map((e) => e.label)).toEqual([
      "轻量·默认",
      "均衡·推荐 (zh-en)",
      "最高精度",
      "快·精度高 (English-primary)",
      "英文加速 · Apple 芯片 · 约 2.5 GB",
    ]);
  });

  it("WIZARD_PRESELECTED_MODEL (medium, the veto-window default) is a valid catalog id", () => {
    expect(MODEL_CATALOG.map((e) => e.id)).toContain(WIZARD_PRESELECTED_MODEL);
    expect(WIZARD_PRESELECTED_MODEL).toBe("medium");
  });

  it("the parakeet-tdt-0.6b-v3 entry is mlxOnly and available (§C L1/§E — worker B2's flip, once the install+backend lane cleared its live merge gates)", () => {
    const parakeet = MODEL_CATALOG.find((e) => e.id === "parakeet-tdt-0.6b-v3");
    expect(parakeet?.mlxOnly).toBe(true);
    expect(parakeet?.available).not.toBe(false);
  });

  it("every OTHER entry is not mlxOnly and not explicitly unavailable", () => {
    for (const entry of MODEL_CATALOG) {
      if (entry.id === "parakeet-tdt-0.6b-v3") continue;
      expect(entry.mlxOnly).toBeFalsy();
      expect(entry.available).not.toBe(false);
    }
  });

  it("every catalog entry is offered today — none reads available:false (§C L1's prelude gate is fully retired post-B2-flip)", () => {
    for (const entry of MODEL_CATALOG) {
      expect(entry.available).not.toBe(false);
    }
  });
});
