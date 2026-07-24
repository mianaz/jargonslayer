// @vitest-environment jsdom
//
// TranslationEngineRow — still hidden entirely on iOS (A6: no on-device
// Translator there; v0.6 only added a macOS-desktop path, see
// TranslationEngineRow.desktop.test.tsx for THAT platform's own three
// render states). IS_IOS is a module-scope import-time const, so this
// needs its own file/vi.mock — mirrors AnkiConnectSection.ios.test.tsx's
// own split for the identical constraint. IS_DESKTOP is deliberately
// left UNMOCKED (real, false in this env) — IS_IOS/IS_DESKTOP are
// mutually exclusive in any real build, matching that invariant here.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true }));
vi.mock("@/lib/translate/providers", () => ({
  checkSystemTranslatorAvailability: vi.fn().mockResolvedValue("available"),
  ChromeTranslatorProvider: vi.fn(),
}));

import TranslationEngineRow from "../TranslationEngineRow";

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

  it("renders nothing", () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <TranslationEngineRow
          value="llm"
          onChange={() => {}}
          langPair={{ source: "en", target: "zh" }}
        />,
      );
    });
    expect(container.innerHTML).toBe("");
  });
});
