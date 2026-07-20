// @vitest-environment jsdom
//
// TranslationEngineRow — hidden entirely on Tauri (desktop/iOS), A6:
// "system hidden/fallback on Tauri desktop + iOS", no on-device
// Translator there today. IS_TAURI is a module-scope import-time const,
// so this needs its own file/vi.mock — mirrors AnkiConnectSection.ios.
// test.tsx's own split for the identical constraint.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/ios", () => ({ IS_TAURI: true }));
vi.mock("@/lib/translate/providers", () => ({
  checkSystemTranslatorAvailability: vi.fn().mockResolvedValue("available"),
  ChromeTranslatorProvider: vi.fn(),
}));

import TranslationEngineRow from "../TranslationEngineRow";

describe("TranslationEngineRow (Tauri build)", () => {
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
