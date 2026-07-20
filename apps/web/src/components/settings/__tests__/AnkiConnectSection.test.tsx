// @vitest-environment jsdom
//
// AnkiConnectSection — props-driven render states. createRoot/act
// pattern (no @testing-library/react in this repo's test stack — see
// ToggleSwitch.test.tsx's own header comment). See
// AnkiConnectSection.ios.test.tsx for the IS_IOS-hidden branch.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

const testAndAuthorizeMock = vi.fn();
vi.mock("@/lib/history/connectors/ankiConnect", () => ({
  testAndAuthorize: (...args: unknown[]) => testAndAuthorizeMock(...args),
}));

import AnkiConnectSection, { type AnkiConnectSectionValue } from "../AnkiConnectSection";

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;
function typeInto(input: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AnkiConnectSection", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    testAndAuthorizeMock.mockReset();
  });

  function mount(value: AnkiConnectSectionValue, onChange: (patch: Partial<AnkiConnectSectionValue>) => void) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<AnkiConnectSection value={value} onChange={onChange} />));
    return container;
  }

  const value: AnkiConnectSectionValue = { enabled: false, deckName: "JargonSlayer", port: 8765 };

  it("renders the toggle/deck-name/port fields reflecting the given value", () => {
    const el = mount(value, () => {});
    expect(el.querySelector('[data-testid="anki-connect-section"]')).not.toBeNull();
    const deckInput = el.querySelector('input[type="text"]') as HTMLInputElement;
    expect(deckInput.value).toBe("JargonSlayer");
    const portInput = el.querySelector('input[type="number"]') as HTMLInputElement;
    expect(portInput.value).toBe("8765");
    const toggle = el.querySelector('button[role="switch"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("toggling calls onChange({enabled: true}) — value itself is never mutated locally (props-driven)", async () => {
    const onChange = vi.fn();
    const el = mount(value, onChange);
    const toggle = el.querySelector('button[role="switch"]') as HTMLButtonElement;

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ enabled: true });
  });

  it("editing the deck name field calls onChange({deckName})", async () => {
    const onChange = vi.fn();
    const el = mount(value, onChange);
    const deckInput = el.querySelector('input[type="text"]') as HTMLInputElement;

    await act(async () => {
      typeInto(deckInput, "我的牌组");
    });

    expect(onChange).toHaveBeenCalledWith({ deckName: "我的牌组" });
  });

  it("port field: a positive integer fires onChange({port}); blank/zero does not (same guard as SettingsDialog's numeric fields)", async () => {
    const onChange = vi.fn();
    const el = mount(value, onChange);
    const portInput = el.querySelector('input[type="number"]') as HTMLInputElement;

    await act(async () => {
      typeInto(portInput, "8766");
    });
    expect(onChange).toHaveBeenLastCalledWith({ port: 8766 });

    onChange.mockClear();
    await act(async () => {
      typeInto(portInput, "0");
    });
    expect(onChange).not.toHaveBeenCalled();

    onChange.mockClear();
    await act(async () => {
      typeInto(portInput, "");
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clicking 测试并授权 calls testAndAuthorize(value.port) and renders the resolved status label", async () => {
    testAndAuthorizeMock.mockResolvedValue({ kind: "ok", label: "已连接" });
    const el = mount(value, () => {});
    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.includes("测试并授权"))!;

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(testAndAuthorizeMock).toHaveBeenCalledWith(8765);
    expect(el.textContent).toContain("已连接");
  });

  it("shows a denied/blocked status in the warning color class, not the ok green", async () => {
    testAndAuthorizeMock.mockResolvedValue({ kind: "denied", label: "未授权（请在 Anki 弹窗中允许）" });
    const el = mount(value, () => {});
    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.includes("测试并授权"))!;

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const statusEl = Array.from(el.querySelectorAll("span")).find((s) =>
      s.textContent?.includes("未授权"),
    )!;
    expect(statusEl.className).toContain("text-warn-soft");
  });

  it("shows the port-clash note verbatim", () => {
    const el = mount(value, () => {});
    expect(el.textContent).toContain("若同时使用本地 Whisper");
    expect(el.textContent).toContain("需在 Anki 的 AnkiConnect");
  });
});
