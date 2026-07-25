// @vitest-environment jsdom
//
// TranslationEngineRow — desktop (macOS 26+, v0.6) branch. Un-gated
// from the old IS_TAURI-hidden behavior (see TranslationEngineRow.ios.
// test.tsx for the platform that's STILL hidden) and driven by
// providers.ts's system_translate_probe wrapper instead of
// checkSystemTranslatorAvailability — mirrors TranslationEngineRow.
// test.tsx's own shape for the web/Chrome branch. IS_DESKTOP is a
// module-scope import-time const, so this needs its own file/vi.mock.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/desktop", () => ({ IS_DESKTOP: true }));

const probeMock = vi.fn();
vi.mock("@/lib/translate/providers", () => ({
  probeSystemTranslateSupport: (...args: unknown[]) => probeMock(...args),
}));

import TranslationEngineRow, { type TranslationEngineRowProps } from "../TranslationEngineRow";

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TranslationEngineRow (desktop build)", () => {
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
    probeMock.mockReset();
  });

  const langPair = { source: "en", target: "zh" };

  function mount(props: TranslationEngineRowProps) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<TranslationEngineRow {...props} />));
    return container;
  }

  function select(el: HTMLElement): HTMLSelectElement {
    return el.querySelector("select") as HTMLSelectElement;
  }

  it("renders both options with the given value selected", async () => {
    probeMock.mockResolvedValue({ osSupported: true, status: "installed" });
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    expect(el.querySelector('[data-testid="translation-engine-row"]')).not.toBeNull();
    const values = Array.from(select(el).querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["llm", "system"]);
    expect(select(el).value).toBe("llm");
  });

  it("changing the select calls onChange with the new value", async () => {
    probeMock.mockResolvedValue({ osSupported: true, status: "installed" });
    const onChange = vi.fn();
    const el = mount({ value: "llm", onChange, langPair });
    await flush();

    await act(async () => {
      select(el).value = "system";
      select(el).dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith("system");
  });

  it("status 'installed' -> system option selectable, hint 已就绪", async () => {
    probeMock.mockResolvedValue({ osSupported: true, status: "installed" });
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    const systemOption = select(el).querySelector('option[value="system"]') as HTMLOptionElement;
    expect(systemOption.disabled).toBe(false);
    expect(systemOption.textContent).toBe("Apple 翻译 · 本机离线");
    expect(el.textContent).toContain("已就绪");
  });

  it("status 'supported' (pair not downloaded) -> system option STILL selectable, honest hint pointing at 系统设置, no download button (no headless trigger exists)", async () => {
    probeMock.mockResolvedValue({ osSupported: true, status: "supported" });
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    const systemOption = select(el).querySelector('option[value="system"]') as HTMLOptionElement;
    expect(systemOption.disabled).toBe(false);
    expect(el.textContent).toContain("系统设置");
    expect(el.textContent).toContain("语言与地区");
    expect(el.textContent).toContain("翻译语言");
    expect(el.textContent).not.toContain("已就绪");
    const button = Array.from(el.querySelectorAll("button"));
    expect(button).toHaveLength(0);
  });

  it("osSupported:false (macOS < 26) -> row STAYS VISIBLE, option disabled, label carries 需要 macOS 26 或更高版本 — never hidden", async () => {
    probeMock.mockResolvedValue({ osSupported: false, status: "unsupported" });
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    expect(el.querySelector('[data-testid="translation-engine-row"]')).not.toBeNull();
    const systemOption = select(el).querySelector('option[value="system"]') as HTMLOptionElement;
    expect(systemOption.disabled).toBe(true);
    expect(systemOption.textContent).toContain("需要 macOS 26 或更高版本");
  });

  it("re-probes when the langPair itself changes (e.g. explainLanguage edited live in the dialog)", async () => {
    probeMock.mockResolvedValue({ osSupported: true, status: "installed" });
    const el = mount({ value: "llm", onChange: () => {}, langPair: { source: "en", target: "zh" } });
    await flush();
    expect(probeMock).toHaveBeenLastCalledWith({ source: "en", target: "zh" });

    probeMock.mockResolvedValue({ osSupported: false, status: "unsupported" });
    act(() => {
      root!.render(
        <TranslationEngineRow value="llm" onChange={() => {}} langPair={{ source: "en", target: "en" }} />,
      );
    });
    await flush();

    expect(probeMock).toHaveBeenLastCalledWith({ source: "en", target: "en" });
    const systemOption = select(el).querySelector('option[value="system"]') as HTMLOptionElement;
    expect(systemOption.disabled).toBe(true);
  });
});
