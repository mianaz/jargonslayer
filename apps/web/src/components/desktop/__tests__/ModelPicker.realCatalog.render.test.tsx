// @vitest-environment jsdom
//
// S12b worker B2 (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md,
// §C L1/§E) — ModelPicker.render.test.tsx mocks BOTH modelCatalog.ts AND
// mlxCaps.ts, so nothing in that suite ever exercises the REAL, shipped
// MODEL_CATALOG (worker B2's own task spec calls this out explicitly:
// "make sure at least one test exercises the REAL catalog entry, not
// just fixtures, against mocked caps in all three states"). This file
// is the real-catalog counterpart: modelCatalog.ts is left UNMOCKED
// (the genuine parakeet-tdt-0.6b-v3 entry, now `available: true` post-
// B2-flip, flows through exactly like a real render would), only
// mlxCaps.ts is mocked — the one seam ModelPicker.tsx itself can't
// exercise for real in a jsdom test env without a live Tauri runtime.
// Kept as its own file (not folded into ModelPicker.render.test.tsx)
// because vi.mock("@/lib/desktop/modelCatalog", ...) there is
// file-scoped/hoisted — a single file can't mock a module for some
// tests and leave it real for others.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { MlxCapabilities } from "@/lib/desktop/mlxCaps";

type MlxProbeResult = { status: "ok" | "error"; caps: MlxCapabilities };

const mlxState = vi.hoisted(() => {
  const state: { probeImpl: () => Promise<MlxProbeResult> } = {
    probeImpl: async () => ({ status: "ok", caps: { mlxSupported: true, reason: null } }),
  };
  return state;
});
const refreshMlxCapsSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/desktop/mlxCaps", () => ({
  getMlxCapsSnapshot: () => null,
  subscribeMlxCaps: () => () => {},
  probeMlxCaps: () => mlxState.probeImpl(),
  refreshMlxCaps: () => {
    refreshMlxCapsSpy();
    return mlxState.probeImpl();
  },
}));

import ModelPicker from "../ModelPicker";
import { MODEL_CATALOG } from "@/lib/desktop/modelCatalog";

describe("ModelPicker — REAL MODEL_CATALOG (§C Gating F13, mlxCaps mocked only)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    mlxState.probeImpl = async () => ({ status: "ok", caps: { mlxSupported: true, reason: null } });
    refreshMlxCapsSpy.mockClear();
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  async function mount(value: string, onChange: (model: string) => void) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ModelPicker value={value} onChange={onChange} />);
    });
    return container;
  }

  it("sanity: this suite's own MODEL_CATALOG import is the REAL, unmocked module — parakeet-tdt-0.6b-v3 is present and available", () => {
    const parakeet = MODEL_CATALOG.find((e) => e.id === "parakeet-tdt-0.6b-v3");
    expect(parakeet).toBeDefined();
    expect(parakeet?.mlxOnly).toBe(true);
    expect(parakeet?.available).not.toBe(false);
  });

  it("real catalog + mlxCaps status:ok/mlxSupported:true -> the real parakeet row renders selectable, and every other real row is unaffected", async () => {
    const onChange = vi.fn();
    await mount("small", onChange);

    expect(container!.querySelectorAll('[role="radio"]').length).toBe(MODEL_CATALOG.length);
    const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
    expect(row.disabled).toBe(false);
    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3-retry"]')).toBeNull();

    act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("parakeet-tdt-0.6b-v3");

    // Every non-mlxOnly real row stays selectable regardless — the gate
    // is a structural no-op for them (mirrors mlxGateFor's own contract).
    for (const entry of MODEL_CATALOG) {
      if (entry.mlxOnly) continue;
      const other = container!.querySelector(`[data-testid="model-option-${entry.id}"]`) as HTMLButtonElement;
      expect(other.disabled).toBe(false);
    }
  });

  it("real catalog + mlxCaps status:ok/mlxSupported:false -> the real parakeet row renders DISABLED with the caps' own reason, no retry affordance", async () => {
    const reason = "需要 Apple 芯片（M 系列），macOS 14 或更高";
    mlxState.probeImpl = async () => ({ status: "ok", caps: { mlxSupported: false, reason } });
    const onChange = vi.fn();
    await mount("small", onChange);

    const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain(reason);
    expect(container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3-retry"]')).toBeNull();

    act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("real catalog + mlxCaps status:error (fail-closed) -> the real parakeet row renders DISABLED with a 重试 affordance that calls refreshMlxCaps", async () => {
    const FAIL_CLOSED: MlxCapabilities = { mlxSupported: false, reason: "无法确认 Apple 芯片支持，请重试" };
    mlxState.probeImpl = async () => ({ status: "error", caps: FAIL_CLOSED });
    await mount("small", () => {});

    const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain(FAIL_CLOSED.reason);
    const retryBtn = container!.querySelector(
      '[data-testid="model-option-parakeet-tdt-0.6b-v3-retry"]',
    ) as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();

    mlxState.probeImpl = async () => ({ status: "ok", caps: { mlxSupported: true, reason: null } });
    await act(async () => {
      retryBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(refreshMlxCapsSpy).toHaveBeenCalledTimes(1);
    const rowAfter = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
    expect(rowAfter.disabled).toBe(false);
  });
});
