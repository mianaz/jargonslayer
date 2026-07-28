// @vitest-environment jsdom
//
// TranslationEngineRow — iOS build. Reverted from the old force-disabled
// stopgap (see this file's own git history for that version) back to
// probe-driven behavior: iOS now ships the SAME 4-invoke-command
// system-translate surface as desktop (providers.ts's own
// NATIVE_SYSTEM_TRANSLATE gate), so the dispatcher routes iOS to
// DesktopTranslationEngineRow exactly like desktop — mirrors
// TranslationEngineRow.desktop.test.tsx's own shape, mocking IS_IOS
// instead of IS_DESKTOP. IS_IOS is a module-scope import-time const, so
// this needs its own file/vi.mock — mirrors AnkiConnectSection.ios.
// test.tsx's own split for the identical constraint. IS_DESKTOP is
// deliberately left UNMOCKED (real, false in this env) — IS_IOS/
// IS_DESKTOP are mutually exclusive in any real build, matching that
// invariant here.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true }));

const probeMock = vi.fn();
vi.mock("@/lib/translate/providers", () => ({
  probeSystemTranslateSupport: (...args: unknown[]) => probeMock(...args),
}));

import TranslationEngineRow, {
  LLM_TRANSLATE_WARNING,
  type TranslationEngineRowProps,
} from "../TranslationEngineRow";

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TranslationEngineRow (iOS build)", () => {
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

  it("probe says 'installed' -> 系统 option enabled, hint 已就绪 (no more force-disabled/iOS-suffixed label)", async () => {
    probeMock.mockResolvedValue({ osSupported: true, status: "installed" });
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    expect(el.querySelector('[data-testid="translation-engine-row"]')).not.toBeNull();
    expect(probeMock).toHaveBeenCalledWith(langPair);
    const systemOption = select(el).querySelector('option[value="system"]') as HTMLOptionElement;
    expect(systemOption.disabled).toBe(false);
    expect(systemOption.textContent).not.toContain("暂不支持");
    expect(el.textContent).toContain("已就绪");
  });

  it("probe says 'unsupported' -> 系统 option disabled, fallback hint shown", async () => {
    probeMock.mockResolvedValue({ osSupported: false, status: "unsupported" });
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    const systemOption = select(el).querySelector('option[value="system"]') as HTMLOptionElement;
    expect(systemOption.disabled).toBe(true);
    expect(systemOption.textContent).toContain("当前设备或语言组合不支持");
  });

  it("probe says 'supported' (pair not downloaded) -> option STILL enabled, install hint points at the system 「翻译」App, not 系统设置", async () => {
    probeMock.mockResolvedValue({ osSupported: true, status: "supported" });
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    const systemOption = select(el).querySelector('option[value="system"]') as HTMLOptionElement;
    expect(systemOption.disabled).toBe(false);
    expect(el.textContent).toContain("「翻译」App");
    expect(el.textContent).not.toContain("系统设置");
    expect(el.textContent).not.toContain("已就绪");
  });

  it("AI 模型 stays selectable — onChange still fires for it", async () => {
    probeMock.mockResolvedValue({ osSupported: true, status: "installed" });
    const onChange = vi.fn();
    const el = mount({ value: "system", onChange, langPair });
    await flush();

    await act(async () => {
      select(el).value = "llm";
      select(el).dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith("llm");
  });

  // Wave-2B reorder — mirrors TranslationEngineRow.desktop.test.tsx's own
  // coverage (this file dispatches to the SAME DesktopTranslationEngineRow
  // function, just with IS_IOS mocked true instead of IS_DESKTOP).
  it("renders all four options, in system/deepl/youdao/llm order; deepl and 有道 both stay enabled regardless of key presence", async () => {
    probeMock.mockResolvedValue({ osSupported: true, status: "installed" });
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    const values = Array.from(select(el).querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["system", "deepl", "youdao", "llm"]);
    const deeplOption = select(el).querySelector('option[value="deepl"]') as HTMLOptionElement;
    expect(deeplOption.disabled).toBe(false);
    const youdaoOption = select(el).querySelector('option[value="youdao"]') as HTMLOptionElement;
    expect(youdaoOption.disabled).toBe(false);
  });

  it("llm inline latency warning shows only while llm is the selected value", async () => {
    probeMock.mockResolvedValue({ osSupported: true, status: "installed" });
    const el = mount({ value: "system", onChange: () => {}, langPair });
    await flush();
    expect(el.textContent).not.toContain(LLM_TRANSLATE_WARNING);

    act(() => {
      root!.render(<TranslationEngineRow value="llm" onChange={() => {}} langPair={langPair} />);
    });
    await flush();
    expect(el.textContent).toContain(LLM_TRANSLATE_WARNING);
  });
});
