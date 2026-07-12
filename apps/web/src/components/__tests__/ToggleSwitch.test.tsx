// @vitest-environment jsdom
//
// ToggleSwitch — settings redesign (owner ask 2026-07-11: "checkboxes
// → toggles"). role/aria/keyboard/disabled, createRoot/act pattern
// (mirrors TranscriptPanel.render.test.tsx — no @testing-library/react
// in this repo's test stack).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import ToggleSwitch from "../ToggleSwitch";

describe("ToggleSwitch", () => {
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

  function mount(ui: React.ReactElement) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(ui));
    return container.querySelector("button") as HTMLButtonElement;
  }

  it("renders role=switch with aria-checked reflecting the checked prop", () => {
    const btnOn = mount(<ToggleSwitch checked={true} onChange={() => {}} />);
    expect(btnOn.getAttribute("role")).toBe("switch");
    expect(btnOn.getAttribute("aria-checked")).toBe("true");

    const btnOff = mount(<ToggleSwitch checked={false} onChange={() => {}} />);
    expect(btnOff.getAttribute("role")).toBe("switch");
    expect(btnOff.getAttribute("aria-checked")).toBe("false");
  });

  it("clicking calls onChange with the inverted value", () => {
    const onChange = vi.fn();
    const btn = mount(<ToggleSwitch checked={false} onChange={onChange} />);

    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("clicking an already-checked switch calls onChange(false)", () => {
    const onChange = vi.fn();
    const btn = mount(<ToggleSwitch checked={true} onChange={onChange} />);

    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("Enter and Space keydown both activate it (WAI-ARIA switch pattern)", () => {
    const onChangeEnter = vi.fn();
    const btnEnter = mount(<ToggleSwitch checked={false} onChange={onChangeEnter} />);
    act(() => {
      btnEnter.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(onChangeEnter).toHaveBeenCalledTimes(1);
    expect(onChangeEnter).toHaveBeenCalledWith(true);

    const onChangeSpace = vi.fn();
    const btnSpace = mount(<ToggleSwitch checked={false} onChange={onChangeSpace} />);
    act(() => {
      btnSpace.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
      );
    });
    expect(onChangeSpace).toHaveBeenCalledTimes(1);
    expect(onChangeSpace).toHaveBeenCalledWith(true);
  });

  it("ignores non-activation keys", () => {
    const onChange = vi.fn();
    const btn = mount(<ToggleSwitch checked={false} onChange={onChange} />);
    act(() => {
      btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disabled: sets the native disabled attribute and blocks both click and keyboard activation", () => {
    const onChange = vi.fn();
    const btn = mount(<ToggleSwitch checked={false} disabled onChange={onChange} />);

    expect(btn.disabled).toBe(true);

    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      btn.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a disabled, always-checked row with no onChange (the 基础包·始终启用 case) never throws on click", () => {
    const btn = mount(<ToggleSwitch checked disabled />);
    expect(() => {
      act(() => {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }).not.toThrow();
    expect(btn.getAttribute("aria-checked")).toBe("true");
  });

  it("applies id and aria-label when provided (label association)", () => {
    const btn = mount(
      <ToggleSwitch checked={false} onChange={() => {}} id="my-toggle" ariaLabel="示例开关" />,
    );
    expect(btn.id).toBe("my-toggle");
    expect(btn.getAttribute("aria-label")).toBe("示例开关");
  });

  it("clicking a <label> wrapping the switch (implicit label association, no id needed) toggles it — button is a labelable element", () => {
    const onChange = vi.fn();
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <label>
          <span>示例行</span>
          <ToggleSwitch checked={false} onChange={onChange} />
        </label>,
      );
    });
    const label = container.querySelector("label") as HTMLLabelElement;
    act(() => {
      label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
