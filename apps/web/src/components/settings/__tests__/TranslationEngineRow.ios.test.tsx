// @vitest-environment jsdom
//
// TranslationEngineRow — iOS build. v0.6 field-fix (item 5, iOS
// TestFlight report): iOS used to be hidden entirely (see this file's
// git history for the old "renders nothing" assertion) — but a
// translateEngine:"system" value picked on another platform (settings
// sync) still silently fell back to LLM here (providers.ts's
// resolveTranslationProvider), with no UI to explain why. iOS now
// renders the SAME WebTranslationEngineRow branch desktop's dispatcher
// falls through to, with 系统 force-disabled + suffixed — mirrors
// TranslationEngineRow.test.tsx's own mount/select shape. IS_IOS is a
// module-scope import-time const, so this needs its own file/vi.mock —
// mirrors AnkiConnectSection.ios.test.tsx's own split for the identical
// constraint. IS_DESKTOP is deliberately left UNMOCKED (real, false in
// this env) — IS_IOS/IS_DESKTOP are mutually exclusive in any real
// build, matching that invariant here.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true }));
vi.mock("@/lib/translate/providers", () => ({
  checkSystemTranslatorAvailability: vi.fn().mockResolvedValue("available"),
  ChromeTranslatorProvider: vi.fn(),
}));

import TranslationEngineRow, { type TranslationEngineRowProps } from "../TranslationEngineRow";

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

  it("renders the row (no longer hidden) with 系统 force-disabled and suffixed （iOS 暂不支持）, even though the underlying probe resolves 'available'", async () => {
    const el = mount({ value: "llm", onChange: () => {}, langPair });
    await flush();

    expect(el.querySelector('[data-testid="translation-engine-row"]')).not.toBeNull();
    const systemOption = select(el).querySelector('option[value="system"]') as HTMLOptionElement;
    expect(systemOption.disabled).toBe(true);
    expect(systemOption.textContent).toContain("（iOS 暂不支持）");
  });

  it("AI 模型 stays selectable — onChange still fires for it", async () => {
    const onChange = vi.fn();
    const el = mount({ value: "system", onChange, langPair });
    await flush();

    await act(async () => {
      select(el).value = "llm";
      select(el).dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith("llm");
  });
});
