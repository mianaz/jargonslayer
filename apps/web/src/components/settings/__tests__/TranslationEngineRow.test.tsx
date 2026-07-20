// @vitest-environment jsdom
//
// TranslationEngineRow — props-driven render states. createRoot/act
// pattern (no @testing-library/react in this repo's test stack — see
// ToggleSwitch.test.tsx's own header comment), mirroring
// AnkiConnectSection.test.tsx's own shape. The underlying Chrome
// Translator surface (checkSystemTranslatorAvailability/
// ChromeTranslatorProvider) is mocked at the providers.ts module
// boundary — real-API/ordering behavior is providers.test.ts's job; this
// file is about what the ROW renders/calls given a resolved state. See
// TranslationEngineRow.tauri.test.tsx for the IS_TAURI-hidden branch.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

const checkAvailabilityMock = vi.fn();
const prepareMock = vi.fn();
vi.mock("@/lib/translate/providers", () => ({
  checkSystemTranslatorAvailability: (...args: unknown[]) => checkAvailabilityMock(...args),
  // A plain `function` (not an arrow function) so `new ChromeTranslatorProvider()`
  // is legal — an object explicitly returned from a `new`-invoked
  // function replaces the constructed instance (standard JS), which is
  // exactly how this fake stands in for the real class.
  ChromeTranslatorProvider: vi.fn().mockImplementation(function FakeChromeTranslatorProvider() {
    return { prepare: prepareMock };
  }),
}));

import TranslationEngineRow, { type TranslationEngineRowProps } from "../TranslationEngineRow";

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TranslationEngineRow", () => {
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
    checkAvailabilityMock.mockReset();
    prepareMock.mockReset();
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
    checkAvailabilityMock.mockResolvedValue("available");
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    expect(el.querySelector('[data-testid="translation-engine-row"]')).not.toBeNull();
    const values = Array.from(select(el).querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["llm", "system"]);
    expect(select(el).value).toBe("llm");
  });

  it("changing the select calls onChange with the new value — props-driven, value itself never mutated locally", async () => {
    checkAvailabilityMock.mockResolvedValue("available");
    const onChange = vi.fn();
    const el = mount({ value: "llm", onChange, langPair });
    await flush();

    await act(async () => {
      select(el).value = "system";
      select(el).dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith("system");
  });

  it("API absent (checkSystemTranslatorAvailability resolves null) -> system option disabled with a 不支持浏览器 reason", async () => {
    checkAvailabilityMock.mockResolvedValue(null);
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    const systemOption = select(el).querySelector('option[value="system"]') as HTMLOptionElement;
    expect(systemOption.disabled).toBe(true);
    expect(systemOption.textContent).toContain("当前浏览器不支持");
  });

  it("availability 'unavailable' (this language pair unsupported) -> disabled with a distinct reason", async () => {
    checkAvailabilityMock.mockResolvedValue("unavailable");
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    const systemOption = select(el).querySelector('option[value="system"]') as HTMLOptionElement;
    expect(systemOption.disabled).toBe(true);
    expect(systemOption.textContent).toContain("当前语言组合不支持");
  });

  it("availability 'available' -> system option enabled, no extra hint block", async () => {
    checkAvailabilityMock.mockResolvedValue("available");
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    const systemOption = select(el).querySelector('option[value="system"]') as HTMLOptionElement;
    expect(systemOption.disabled).toBe(false);
    expect(el.textContent).not.toContain("下载并启用");
  });

  it("availability 'downloadable' -> shows the hint + 下载并启用 button; option stays enabled (selectable ahead of download)", async () => {
    checkAvailabilityMock.mockResolvedValue("downloadable");
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    const systemOption = select(el).querySelector('option[value="system"]') as HTMLOptionElement;
    expect(systemOption.disabled).toBe(false);
    expect(el.textContent).toContain("首次使用系统翻译需下载语言包");
    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.includes("下载并启用"));
    expect(button).toBeDefined();
  });

  it("availability 'downloading' -> shows a downloading hint, no button (nothing more for the user to click)", async () => {
    checkAvailabilityMock.mockResolvedValue("downloading");
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    expect(el.textContent).toContain("语言包下载中");
    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.includes("下载并启用"));
    expect(button).toBeUndefined();
  });

  it("下载并启用 click calls provider.prepare(langPair) SYNCHRONOUSLY from its own click gesture (A6) and flips the hint to downloading", async () => {
    checkAvailabilityMock.mockResolvedValue("downloadable");
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.includes("下载并启用"))!;
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Synchronous — no await between the click and this assertion.
    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(prepareMock).toHaveBeenCalledWith(langPair);
    expect(el.textContent).toContain("语言包下载中");
  });

  it("re-probes when the langPair itself changes (e.g. explainLanguage edited live in the dialog)", async () => {
    checkAvailabilityMock.mockResolvedValue("available");
    const el = mount({ value: "llm", onChange: () => {}, langPair: { source: "en", target: "zh" } });
    await flush();
    expect(checkAvailabilityMock).toHaveBeenLastCalledWith({ source: "en", target: "zh" });

    checkAvailabilityMock.mockResolvedValue("unavailable");
    act(() => {
      root!.render(
        <TranslationEngineRow value="llm" onChange={() => {}} langPair={{ source: "en", target: "en" }} />,
      );
    });
    await flush();

    expect(checkAvailabilityMock).toHaveBeenLastCalledWith({ source: "en", target: "en" });
    const systemOption = select(el).querySelector('option[value="system"]') as HTMLOptionElement;
    expect(systemOption.disabled).toBe(true);
  });
});
