// @vitest-environment jsdom
//
// v0.4 S4 chunk 3 — ModelPicker.tsx render coverage. Mirrors
// DesktopWizard.render.test.tsx's own createRoot/act pattern (no
// @testing-library/react in this repo's test stack) and ToggleSwitch.
// test.tsx's Enter/Space keyboard-activation pattern (same shared
// lib/a11y.ts helper under the hood).
//
// S12 (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
// Gating F13 + worker A3) — this suite mocks BOTH modelCatalog.ts and
// mlxCaps.ts rather than exercising the REAL MODEL_CATALOG:
//   - modelCatalog.ts: worker A2 owns modelCatalog.test.ts's own
//     invariants on the SHIPPED catalog (order/labels/sizes/etc) —
//     "catalog-driven UI assertions" belong here instead, per this
//     worker's own task spec, against a LOCAL fixture that can freely
//     include an `available: true` mlxOnly row. (Since worker B2's flip,
//     §C L1/§E, the real catalog's own parakeet entry ALSO reads
//     `available: true` — the sibling file ModelPicker.realCatalog.
//     render.test.tsx exercises that real entry, unmocked, against the
//     same three mlxCaps states this file's own fixture-based gating
//     tests below cover; this file stays fixture-based on purpose, so
//     modelCatalog.ts's own future stubs/prelude entries keep an
//     independent coverage path that never depends on what's currently
//     shipped.)
//   - mlxCaps.ts: a hand-rolled fake matching A2's PINNED contract (§D
//     F7 fix round): probeMlxCaps()/refreshMlxCaps() resolve an
//     EXPLICIT `{status: "ok" | "error", caps: MlxCapabilities}`
//     envelope (superseding the earlier cache-identity heuristic both
//     reviewers flagged as race-sensitive), and `MlxCapabilities.reason`
//     is `string | null` (not optional) — every literal below carries it
//     explicitly. Exercises all three real states (supported /
//     definitively unsupported / errored-fail-closed) end-to-end,
//     including the errored-only 重试 affordance calling mlxCaps.ts's
//     own (still A2-owned) refreshMlxCaps.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { ModelCatalogEntry } from "@/lib/desktop/modelCatalog";
import type { MlxCapabilities } from "@/lib/desktop/mlxCaps";

// vi.mock factories are hoisted above the top of this file, so
// MOCK_CATALOG must be built through vi.hoisted (same convention as
// OnboardingDiarizeStep.test.tsx/OnboardingByokStep.test.tsx) rather
// than a plain top-level const.
const { MOCK_CATALOG } = vi.hoisted(() => {
  const MOCK_CATALOG: ModelCatalogEntry[] = [
    {
      id: "small",
      label: "轻量·默认",
      size: "~0.46GB",
      macSpeedHint: "Mac 本机很快（约 5–10 倍实时）",
      qualityHint: "英文/清晰语音够用，中英混说容易漏细节",
      recommended: false,
    },
    {
      id: "medium",
      label: "均衡·推荐 (zh-en)",
      size: "~1.5GB",
      macSpeedHint: "Mac 本机流畅（约 2–3 倍实时）",
      qualityHint: "中英混说均衡，日常场景够用",
      recommended: true,
    },
    {
      id: "large-v3-turbo",
      label: "快·精度高 (English-primary)",
      size: "~1.6GB",
      macSpeedHint: "比 large-v3 快约 4 倍，Mac 本机流畅",
      qualityHint: "英文场景精度高，中文稍弱于 large-v3",
      recommended: false,
    },
    // TEST-ONLY fixture twin of the real catalog's parakeet entry (also
    // `available: true` since worker B2's flip, §C L1/§E) — kept here so
    // this file's own mlxOnly gating tests below stay independent of
    // whatever modelCatalog.ts currently ships (see this file's own
    // header comment for the real-catalog counterpart).
    {
      id: "parakeet-tdt-0.6b-v3",
      label: "英文加速 · Apple 芯片 · 约 2.5 GB",
      size: "~2.5GB",
      macSpeedHint: "仅 Apple 芯片（M 系列）可用，MLX 本机加速",
      qualityHint: "英文识别更快；中英混说效果待验证（M1 探针）",
      recommended: false,
      mlxOnly: true,
      available: true,
    },
    // TEST-ONLY: pins the `available: false` -> hidden-from-picker
    // contract independent of mlxOnly-ness (a plain hidden stub, no MLX
    // gating involved at all).
    {
      id: "hidden-stub",
      label: "隐藏中",
      size: "~9GB",
      macSpeedHint: "x",
      qualityHint: "y",
      recommended: false,
      available: false,
    },
  ];
  return { MOCK_CATALOG };
});

vi.mock("@/lib/desktop/modelCatalog", () => ({ MODEL_CATALOG: MOCK_CATALOG }));

// mlxCaps.ts fake — see this suite's own header doc for why this
// matches A2's pinned `{status, caps}` contract (§D F7) instead of a
// trivial constant. Built via vi.hoisted for the SAME reason MOCK_CATALOG
// is above (the vi.mock factory below is hoisted above plain top-level
// declarations). `mlxState.cached` mirrors mlxCaps.ts's own module-level
// `cached` variable (still read by getMlxCapsSnapshot, and used by
// ModelPicker's initial-render/loading-state path); `mlxState.probeImpl`/
// `mlxState.refreshImpl` are reassigned per-test (mutating the SAME
// hoisted object, not rebinding a module-level `let`) to drive the three
// real probe outcomes via their own EXPLICIT `status`.
type MlxProbeResult = { status: "ok" | "error"; caps: MlxCapabilities };

const mlxState = vi.hoisted(() => {
  const state: {
    cached: MlxCapabilities | null;
    probeImpl: () => Promise<{ status: "ok" | "error"; caps: MlxCapabilities }>;
    refreshImpl: () => Promise<{ status: "ok" | "error"; caps: MlxCapabilities }>;
  } = {
    cached: null,
    probeImpl: async () => {
      const caps: MlxCapabilities = { mlxSupported: true, reason: null };
      state.cached = caps;
      return { status: "ok", caps };
    },
    refreshImpl: () => state.probeImpl(),
  };
  return state;
});
const refreshMlxCapsSpy = vi.hoisted(() => vi.fn());

/** ok()/errorResult() build a {status, caps} envelope AND (ok only)
 *  write mlxState.cached — mirrors mlxCaps.ts's own pinned contract:
 *  a successful resolution is cached, an error deliberately is not. */
function ok(caps: MlxCapabilities): MlxProbeResult {
  mlxState.cached = caps;
  return { status: "ok", caps };
}
function errorResult(caps: MlxCapabilities): MlxProbeResult {
  return { status: "error", caps };
}

vi.mock("@/lib/desktop/mlxCaps", () => ({
  getMlxCapsSnapshot: () => mlxState.cached,
  subscribeMlxCaps: () => () => {},
  probeMlxCaps: () => mlxState.probeImpl(),
  refreshMlxCaps: () => {
    refreshMlxCapsSpy();
    return mlxState.refreshImpl();
  },
}));

import ModelPicker from "../ModelPicker";
import { MODEL_CATALOG } from "@/lib/desktop/modelCatalog";

const VISIBLE = MOCK_CATALOG.filter((e) => e.available !== false);

describe("ModelPicker", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    // Default: parakeet reads mlxSupported (status "ok") — every base
    // (non-gating) test below therefore treats it as an ordinary
    // selectable row, same as every other entry, unless a test
    // explicitly overrides mlxState.probeImpl/mlxState.cached for its
    // own gating scenario.
    mlxState.cached = null;
    mlxState.probeImpl = async () => ok({ mlxSupported: true, reason: null });
    mlxState.refreshImpl = () => mlxState.probeImpl();
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

  // Async — mlxCaps' probe is a real (mocked) Promise resolved from
  // ModelPicker's own mount effect; DesktopWizard.render.test.tsx's own
  // renderWizard helper establishes the same `await act(async () => {…})`
  // idiom for exactly this "component mounts, an effect awaits a
  // promise-returning caps probe" shape.
  async function mount(
    value: string,
    onChange: (model: string) => void,
    hideDefinitivelyUnsupported?: boolean,
  ) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ModelPicker value={value} onChange={onChange} hideDefinitivelyUnsupported={hideDefinitivelyUnsupported} />,
      );
    });
    return container;
  }

  it("renders a radiogroup with exactly one radio row per VISIBLE (available !== false) catalog entry — the hidden-stub entry never renders", async () => {
    await mount("medium", () => {});
    expect(container!.querySelector('[data-testid="model-picker"]')).not.toBeNull();
    expect(container!.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(container!.querySelectorAll('[role="radio"]').length).toBe(VISIBLE.length);
    for (const entry of VISIBLE) {
      expect(container!.querySelector(`[data-testid="model-option-${entry.id}"]`)).not.toBeNull();
    }
    expect(container!.querySelector('[data-testid="model-option-hidden-stub"]')).toBeNull();
    expect(container!.textContent).not.toContain("隐藏中");
  });

  it("aria-checked reflects the value prop — exactly the matching row reads true", async () => {
    await mount("large-v3-turbo", () => {});
    for (const entry of VISIBLE) {
      const row = container!.querySelector(`[data-testid="model-option-${entry.id}"]`)!;
      expect(row.getAttribute("aria-checked")).toBe(entry.id === "large-v3-turbo" ? "true" : "false");
    }
  });

  it("clicking a row calls onChange with that model's id", async () => {
    const onChange = vi.fn();
    await mount("small", onChange);
    act(() => {
      container!
        .querySelector('[data-testid="model-option-large-v3-turbo"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("large-v3-turbo");
  });

  it("Enter and Space keydown on a row also call onChange (keyboard operable, same lib/a11y.ts contract as ToggleSwitch)", async () => {
    const onChangeEnter = vi.fn();
    await mount("small", onChangeEnter);
    act(() => {
      container!
        .querySelector('[data-testid="model-option-medium"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onChangeEnter).toHaveBeenCalledTimes(1);
    expect(onChangeEnter).toHaveBeenCalledWith("medium");

    const onChangeSpace = vi.fn();
    await mount("small", onChangeSpace);
    act(() => {
      container!
        .querySelector('[data-testid="model-option-medium"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    });
    expect(onChangeSpace).toHaveBeenCalledTimes(1);
    expect(onChangeSpace).toHaveBeenCalledWith("medium");
  });

  it("ignores non-activation keys", async () => {
    const onChange = vi.fn();
    await mount("small", onChange);
    act(() => {
      container!
        .querySelector('[data-testid="model-option-medium"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("推荐 chip renders only on the medium row — NOT on parakeet, in any mlx caps state (§C Product/L3)", async () => {
    await mount("small", () => {});
    expect(container!.querySelector('[data-testid="model-option-medium"]')!.textContent).toContain("推荐");
    for (const entry of VISIBLE) {
      if (entry.id === "medium") continue;
      expect(container!.querySelector(`[data-testid="model-option-${entry.id}"]`)!.textContent).not.toContain("推荐");
    }
  });

  it("each row shows its id, size, and hints", async () => {
    await mount("small", () => {});
    for (const entry of VISIBLE) {
      const row = container!.querySelector(`[data-testid="model-option-${entry.id}"]`)!;
      expect(row.textContent).toContain(entry.id);
      expect(row.textContent).toContain(entry.size);
      expect(row.textContent).toContain(entry.macSpeedHint);
      expect(row.textContent).toContain(entry.qualityHint);
    }
  });

  it("honest download size display: the parakeet row shows ~2.5GB and its opt-in label's own 约 2.5 GB, same as every other row's plain size field", async () => {
    await mount("small", () => {});
    const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]')!;
    expect(row.textContent).toContain("~2.5GB");
    expect(row.textContent).toContain("约 2.5 GB");
  });

  // --- S12a mlxOnly gating (§C Gating F13) ---

  it("mlxOnly row is selectable (not disabled, no reason) when caps report mlxSupported", async () => {
    mlxState.probeImpl = async () => ok({ mlxSupported: true, reason: null });
    const onChange = vi.fn();
    await mount("small", onChange);

    const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
    expect(row.disabled).toBe(false);
    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3-retry"]')).toBeNull();

    act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("parakeet-tdt-0.6b-v3");
  });

  it("mlxOnly row renders DISABLED with real disabled + aria-disabled + caps' own reason when caps definitively report unsupported — no retry affordance (retrying can't change the answer)", async () => {
    const reason = "需要 Apple 芯片（M 系列），macOS 14 或更高";
    mlxState.probeImpl = async () => ok({ mlxSupported: false, reason });
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

  it("mlxOnly row falls back to the fixed fallback reason copy when a definitively-unsupported result carries no reason of its own (reason: null)", async () => {
    mlxState.probeImpl = async () => ok({ mlxSupported: false, reason: null });
    await mount("small", () => {});

    const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]')!;
    expect(row.textContent).toContain("需要 Apple 芯片（M 系列），macOS 14 或更高");
  });

  it("mlxOnly row is DISABLED (fail-closed) while the caps probe is still in flight (not yet resolved)", async () => {
    let resolveProbe!: (result: MlxProbeResult) => void;
    mlxState.probeImpl = () =>
      new Promise((resolve) => {
        resolveProbe = resolve;
      });
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<ModelPicker value="small" onChange={() => {}} />);
    });

    const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3-retry"]')).toBeNull();

    await act(async () => {
      resolveProbe(ok({ mlxSupported: true, reason: null }));
    });
    expect((container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("mlxOnly row DISABLED + a user-visible 重试 affordance when the caps probe returns status:\"error\" (fail-closed) — clicking 重试 calls the caps refresh, and a status:\"ok\" refresh re-enables the row", async () => {
    const FAIL_CLOSED: MlxCapabilities = { mlxSupported: false, reason: "无法确认 Apple 芯片支持，请重试" };
    mlxState.probeImpl = async () => errorResult(FAIL_CLOSED);
    const onChange = vi.fn();
    await mount("small", onChange);

    const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain(FAIL_CLOSED.reason);
    const retryBtn = container!.querySelector(
      '[data-testid="model-option-parakeet-tdt-0.6b-v3-retry"]',
    ) as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();

    // A status:"ok" refresh re-enables the row and drops the retry
    // affordance — driven purely by the explicit status, per §D F7.
    mlxState.refreshImpl = async () => ok({ mlxSupported: true, reason: null });
    await act(async () => {
      retryBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(refreshMlxCapsSpy).toHaveBeenCalledTimes(1);
    const rowAfter = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
    expect(rowAfter.disabled).toBe(false);
    expect(container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3-retry"]')).toBeNull();

    act(() => {
      rowAfter.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("parakeet-tdt-0.6b-v3");
  });

  // §D F7 regression: under the OLD reference-identity heuristic, a
  // status:"ok" resolution that (for whatever timing reason) did NOT
  // land in mlxState.cached before this component read it back would
  // have been misclassified as "errored" — the exact race both
  // reviewers flagged. The explicit `status` field makes that
  // impossible: `ok()` below deliberately does NOT write mlxState.cached
  // (unlike every other "ok" case above), yet the row must still read
  // as genuinely selectable, not errored/retry-able.
  it("a status:\"ok\" resolution reads as selectable even when it doesn't land in the shared cache (the exact identity-race F7 fixed)", async () => {
    mlxState.probeImpl = async () => ({ status: "ok", caps: { mlxSupported: true, reason: null } });
    const onChange = vi.fn();
    await mount("small", onChange);

    const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
    expect(row.disabled).toBe(false);
    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3-retry"]')).toBeNull();

    act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("parakeet-tdt-0.6b-v3");
  });

  it("a still-erroring retry (refresh also returns status:\"error\") leaves the row disabled with the retry affordance intact", async () => {
    const FAIL_CLOSED: MlxCapabilities = { mlxSupported: false, reason: "无法确认 Apple 芯片支持，请重试" };
    mlxState.probeImpl = async () => errorResult(FAIL_CLOSED);
    await mount("small", () => {});

    const retryBtn = container!.querySelector(
      '[data-testid="model-option-parakeet-tdt-0.6b-v3-retry"]',
    ) as HTMLButtonElement;
    mlxState.refreshImpl = async () => errorResult(FAIL_CLOSED); // still errors, still uncached
    await act(async () => {
      retryBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(refreshMlxCapsSpy).toHaveBeenCalledTimes(1);
    const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3-retry"]')).not.toBeNull();
  });

  it("non-mlxOnly rows are never gated by caps state, even while parakeet is disabled/errored", async () => {
    mlxState.probeImpl = async () => errorResult({ mlxSupported: false, reason: "无法确认 Apple 芯片支持，请重试" });
    await mount("small", () => {});
    for (const entry of VISIBLE) {
      if (entry.mlxOnly) continue;
      const row = container!.querySelector(`[data-testid="model-option-${entry.id}"]`) as HTMLButtonElement;
      expect(row.disabled).toBe(false);
      expect(row.getAttribute("aria-disabled")).toBeNull();
    }
  });

  it("MODEL_CATALOG import used by this suite is the mocked fixture, not the real catalog (sanity check on the vi.mock wiring above)", () => {
    expect(MODEL_CATALOG).toBe(MOCK_CATALOG);
  });

  // --- S12b fix round FB10 (§F; product default, ON THE VETO LIST §7.7) ---
  // Core hideDefinitivelyUnsupported contract against this file's own
  // fixture — the full 2-surface × 3-caps-state matrix against the REAL
  // catalog already lives in ModelPicker.realCatalog.render.test.tsx's
  // own "hideDefinitivelyUnsupported (§F FB10)" describe block; this is
  // the fixture-based counterpart so the prop's own contract stays
  // pinned independent of whatever modelCatalog.ts currently ships.
  describe("hideDefinitivelyUnsupported (§F FB10)", () => {
    it("prop omitted (default/Settings' posture): a DEFINITIVELY-unsupported mlxOnly row stays VISIBLE, disabled, with its reason", async () => {
      const reason = "需要 Apple 芯片（M 系列），macOS 14 或更高";
      mlxState.probeImpl = async () => ok({ mlxSupported: false, reason });
      await mount("small", () => {}); // hideDefinitivelyUnsupported omitted
      const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
      expect(row).not.toBeNull();
      expect(row.disabled).toBe(true);
      expect(container!.querySelectorAll('[role="radio"]').length).toBe(VISIBLE.length);
    });

    it("prop true (Wizard's posture): a DEFINITIVELY-unsupported mlxOnly row is HIDDEN entirely — the radio count drops by exactly one", async () => {
      const reason = "需要 Apple 芯片（M 系列），macOS 14 或更高";
      mlxState.probeImpl = async () => ok({ mlxSupported: false, reason });
      await mount("small", () => {}, true);
      expect(container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]')).toBeNull();
      expect(container!.textContent).not.toContain(reason);
      expect(container!.querySelectorAll('[role="radio"]').length).toBe(VISIBLE.length - 1);
    });

    it("prop true (Wizard's posture): a transient probe ERROR NEVER hides the row — stays visible, disabled, with 重试 (FB10's own carve-out)", async () => {
      const FAIL_CLOSED: MlxCapabilities = { mlxSupported: false, reason: "无法确认 Apple 芯片支持，请重试" };
      mlxState.probeImpl = async () => errorResult(FAIL_CLOSED);
      await mount("small", () => {}, true);
      const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
      expect(row).not.toBeNull();
      expect(row.disabled).toBe(true);
      expect(container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3-retry"]')).not.toBeNull();
      expect(container!.querySelectorAll('[role="radio"]').length).toBe(VISIBLE.length);
    });

    it("prop true (Wizard's posture): a mlxSupported:true row is unaffected — still visible + selectable", async () => {
      mlxState.probeImpl = async () => ok({ mlxSupported: true, reason: null });
      const onChange = vi.fn();
      await mount("small", onChange, true);
      const row = container!.querySelector('[data-testid="model-option-parakeet-tdt-0.6b-v3"]') as HTMLButtonElement;
      expect(row).not.toBeNull();
      expect(row.disabled).toBe(false);
      act(() => {
        row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onChange).toHaveBeenCalledWith("parakeet-tdt-0.6b-v3");
    });

    it("prop true (Wizard's posture): non-mlxOnly rows are never hidden by this policy either", async () => {
      mlxState.probeImpl = async () => ok({ mlxSupported: false, reason: "需要 Apple 芯片（M 系列），macOS 14 或更高" });
      await mount("small", () => {}, true);
      for (const entry of VISIBLE) {
        if (entry.mlxOnly) continue;
        expect(container!.querySelector(`[data-testid="model-option-${entry.id}"]`)).not.toBeNull();
      }
    });
  });
});
