// @vitest-environment jsdom
//
// v0.4 S4 chunk 3 — ModelPicker.tsx render coverage. Mirrors
// DesktopWizard.render.test.tsx's own createRoot/act pattern (no
// @testing-library/react in this repo's test stack) and ToggleSwitch.
// test.tsx's Enter/Space keyboard-activation pattern (same shared
// lib/a11y.ts helper under the hood).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import ModelPicker from "../ModelPicker";
import { MODEL_CATALOG } from "@/lib/desktop/modelCatalog";

describe("ModelPicker", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

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

  function mount(value: string, onChange: (model: string) => void) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<ModelPicker value={value} onChange={onChange} />);
    });
    return container;
  }

  it("renders a radiogroup with exactly one radio row per MODEL_CATALOG entry", () => {
    mount("medium", () => {});
    expect(container!.querySelector('[data-testid="model-picker"]')).not.toBeNull();
    expect(container!.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(container!.querySelectorAll('[role="radio"]').length).toBe(MODEL_CATALOG.length);
    for (const entry of MODEL_CATALOG) {
      expect(container!.querySelector(`[data-testid="model-option-${entry.id}"]`)).not.toBeNull();
    }
  });

  it("aria-checked reflects the value prop — exactly the matching row reads true", () => {
    mount("large-v3", () => {});
    for (const entry of MODEL_CATALOG) {
      const row = container!.querySelector(`[data-testid="model-option-${entry.id}"]`)!;
      expect(row.getAttribute("aria-checked")).toBe(entry.id === "large-v3" ? "true" : "false");
    }
  });

  it("clicking a row calls onChange with that model's id", () => {
    const onChange = vi.fn();
    mount("small", onChange);
    act(() => {
      container!
        .querySelector('[data-testid="model-option-large-v3-turbo"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("large-v3-turbo");
  });

  it("Enter and Space keydown on a row also call onChange (keyboard operable, same lib/a11y.ts contract as ToggleSwitch)", () => {
    const onChangeEnter = vi.fn();
    mount("small", onChangeEnter);
    act(() => {
      container!
        .querySelector('[data-testid="model-option-medium"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onChangeEnter).toHaveBeenCalledTimes(1);
    expect(onChangeEnter).toHaveBeenCalledWith("medium");

    const onChangeSpace = vi.fn();
    mount("small", onChangeSpace);
    act(() => {
      container!
        .querySelector('[data-testid="model-option-medium"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    });
    expect(onChangeSpace).toHaveBeenCalledTimes(1);
    expect(onChangeSpace).toHaveBeenCalledWith("medium");
  });

  it("ignores non-activation keys", () => {
    const onChange = vi.fn();
    mount("small", onChange);
    act(() => {
      container!
        .querySelector('[data-testid="model-option-medium"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("推荐 chip renders only on the medium row", () => {
    mount("small", () => {});
    expect(container!.querySelector('[data-testid="model-option-medium"]')!.textContent).toContain("推荐");
    for (const entry of MODEL_CATALOG) {
      if (entry.id === "medium") continue;
      expect(container!.querySelector(`[data-testid="model-option-${entry.id}"]`)!.textContent).not.toContain("推荐");
    }
  });

  it("each row shows its id, size, and hints", () => {
    mount("small", () => {});
    for (const entry of MODEL_CATALOG) {
      const row = container!.querySelector(`[data-testid="model-option-${entry.id}"]`)!;
      expect(row.textContent).toContain(entry.id);
      expect(row.textContent).toContain(entry.size);
      expect(row.textContent).toContain(entry.macSpeedHint);
      expect(row.textContent).toContain(entry.qualityHint);
    }
  });
});
