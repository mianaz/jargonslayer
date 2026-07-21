// @vitest-environment jsdom
//
// ThemeEditor — props-driven render + preview/save/cancel behavior.
// createRoot/act pattern (no @testing-library/react in this repo's
// test stack — see TranslationEngineRow.test.tsx's own header
// comment). lib/theme/apply's activateTheme/resetToDefaultTheme are
// mocked at the module boundary (per the task spec) so preview timing
// is directly observable without depending on real CSSOM mutation.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

const activateThemeMock = vi.fn();
const resetToDefaultThemeMock = vi.fn();
vi.mock("@/lib/theme/apply", () => ({
  activateTheme: (...args: unknown[]) => activateThemeMock(...args),
  resetToDefaultTheme: () => resetToDefaultThemeMock(),
}));

import ThemeEditor, { type ThemeEditorProps } from "../ThemeEditor";
import { CLARITY_THEME, TERMINAL_THEME } from "@/lib/theme/themes";
import type { ThemeDefinition } from "@/lib/theme/schema";

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;
function typeInto(input: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const CUSTOM: ThemeDefinition = {
  id: "custom-abc",
  label: "我的主题",
  scheme: "dark",
  tokens: CLARITY_THEME.tokens,
};

describe("ThemeEditor", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    activateThemeMock.mockReset();
    resetToDefaultThemeMock.mockReset();
  });

  function mount(overrides: Partial<ThemeEditorProps> = {}) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const props: ThemeEditorProps = {
      customThemes: [],
      sourceThemeId: "terminal",
      activeThemeId: "terminal",
      onSave: vi.fn(),
      onDelete: vi.fn(),
      onBack: vi.fn(),
      showToast: vi.fn(),
      ...overrides,
    };
    act(() => root!.render(<ThemeEditor {...props} />));
    return { el: container, props };
  }

  function hexInput(el: HTMLElement, key: string): HTMLInputElement {
    return el.querySelector(`input[aria-label="${key} 十六进制值"]`) as HTMLInputElement;
  }

  it("renders the 新建主题 title and a row for every one of the 17 tokens", () => {
    const { el } = mount();
    expect(el.textContent).toContain("新建主题");
    expect(hexInput(el, "ink")).not.toBeNull();
    expect(hexInput(el, "warn-soft")).not.toBeNull();
    expect(el.querySelectorAll('input[type="color"]')).toHaveLength(17);
  });

  it("renders 编辑主题 (not 新建) + a 删除 button when editingThemeId is set", () => {
    const { el } = mount({
      customThemes: [CUSTOM],
      sourceThemeId: CUSTOM.id,
      editingThemeId: CUSTOM.id,
    });
    expect(el.textContent).toContain("编辑主题");
    const deleteBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "删除");
    expect(deleteBtn).toBeDefined();
  });

  it("does not render a 删除 button for a fresh create (no editingThemeId)", () => {
    const { el } = mount();
    const deleteBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "删除");
    expect(deleteBtn).toBeUndefined();
  });

  it("previews the initial (based-on) tokens via activateTheme once mounted, after the debounce", () => {
    mount({ sourceThemeId: "terminal" });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(activateThemeMock).toHaveBeenCalledWith("custom-preview", TERMINAL_THEME.tokens, "dark");
  });

  it("editing a token's hex text input calls activateTheme with the updated tokens after the debounce", () => {
    const { el } = mount({ sourceThemeId: "terminal" });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    activateThemeMock.mockClear();

    act(() => {
      typeInto(hexInput(el, "fg"), "#123456");
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(activateThemeMock).toHaveBeenCalledWith(
      "custom-preview",
      expect.objectContaining({ fg: "#123456" }),
      "dark",
    );
  });

  it("取消/返回 re-activates the SAVED theme (activeThemeId), NOT whatever was being previewed, then calls onBack", () => {
    const onBack = vi.fn();
    const { el } = mount({
      sourceThemeId: "terminal",
      activeThemeId: "clarity",
      onBack,
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    activateThemeMock.mockClear();

    const backBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "← 返回")!;
    act(() => {
      backBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(activateThemeMock).toHaveBeenCalledWith("clarity", CLARITY_THEME.tokens, "dark");
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("返回 resets to terminal defaults when activeThemeId is unresolvable", () => {
    const { el } = mount({ sourceThemeId: "terminal", activeThemeId: "custom-does-not-exist" });
    const backBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "← 返回")!;
    act(() => {
      backBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(resetToDefaultThemeMock).toHaveBeenCalledTimes(1);
  });

  it("保存主题 calls onSave with a valid ThemeDefinition (label trimmed, tokens intact) and onBack", () => {
    const onSave = vi.fn();
    const onBack = vi.fn();
    const { el } = mount({ sourceThemeId: "terminal", onSave, onBack });

    const nameInput = el.querySelector('input[placeholder="自定义主题"]') as HTMLInputElement;
    act(() => {
      typeInto(nameInput, "  我的新主题  ");
    });

    const saveBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "保存主题")!;
    act(() => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as ThemeDefinition;
    expect(saved.label).toBe("我的新主题");
    expect(saved.id.startsWith("custom-")).toBe(true);
    expect(saved.tokens).toEqual(TERMINAL_THEME.tokens);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("删除 requires a second confirming click before calling onDelete", () => {
    const onDelete = vi.fn();
    const { el } = mount({
      customThemes: [CUSTOM],
      sourceThemeId: CUSTOM.id,
      editingThemeId: CUSTOM.id,
      onDelete,
    });
    const deleteBtn = () => Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.includes("删除"))!;

    act(() => {
      deleteBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDelete).not.toHaveBeenCalled();
    expect(deleteBtn().textContent).toBe("确认删除？");

    act(() => {
      deleteBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDelete).toHaveBeenCalledWith(CUSTOM.id);
  });
});
