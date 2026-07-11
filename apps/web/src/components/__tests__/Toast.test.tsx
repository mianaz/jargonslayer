// @vitest-environment jsdom
//
// Backward-compat + ref-carrying-toast render test — mirrors
// TranscriptPanel.render.test.tsx's createRoot/act pattern (no
// @testing-library/react in this repo's test stack).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "../../lib/store";
import Toast from "../Toast";

describe("Toast — backward compat + diagnostics ref (item 3)", () => {
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
    useApp.setState({ toast: null });
    vi.unstubAllGlobals();
  });

  function renderToast() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  it("a plain string toast (every pre-existing call site) renders the message, no ref suffix, no action button", async () => {
    useApp.setState({ toast: "已复制" });
    renderToast();
    await act(async () => {
      root!.render(<Toast />);
    });

    expect(container!.textContent).toContain("已复制");
    expect(container!.querySelector("button")).toBeNull();
  });

  it("a {message, action} toast (pre-existing object form, e.g. the undo-familiar toast) renders its own action, no ref suffix", async () => {
    const run = vi.fn();
    useApp.setState({ toast: { message: "已记一次熟悉", action: { label: "撤销", run } } });
    renderToast();
    await act(async () => {
      root!.render(<Toast />);
    });

    expect(container!.textContent).toContain("已记一次熟悉");
    const button = container!.querySelector("button");
    expect(button?.textContent).toBe("撤销");
    expect(container!.textContent).not.toMatch(/\[JS-/);

    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a {message, ref} toast (error-class choke point) renders a `[JS-xxxx]` suffix and a 复制诊断 action", async () => {
    useApp.setState({ toast: { message: "AI 检测暂时不可用，词典检测继续运行", ref: "JS-K3F9" } });
    renderToast();
    await act(async () => {
      root!.render(<Toast />);
    });

    expect(container!.textContent).toContain("AI 检测暂时不可用，词典检测继续运行");
    expect(container!.textContent).toContain("[JS-K3F9]");
    const button = container!.querySelector("button");
    expect(button?.textContent).toBe("复制诊断");
  });

  it("clicking 复制诊断 copies the diagnostic report to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: "test-agent" });

    useApp.setState({ toast: { message: "出错了", ref: "JS-ABCD" } });
    renderToast();
    await act(async () => {
      root!.render(<Toast />);
    });

    const button = container!.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
