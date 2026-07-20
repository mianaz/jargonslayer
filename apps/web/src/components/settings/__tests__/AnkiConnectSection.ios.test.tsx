// @vitest-environment jsdom
//
// AnkiConnectSection — hidden entirely on iOS (A8: there is no local
// Anki app to reach). IS_IOS is a module-scope import-time const, so
// this needs its own file/vi.mock — mirrors TutorialOverlay.ios.test.tsx's
// own split for the identical constraint.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true }));

import AnkiConnectSection from "../AnkiConnectSection";

describe("AnkiConnectSection (iOS build)", () => {
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
        <AnkiConnectSection value={{ enabled: false, deckName: "JargonSlayer", port: 8765 }} onChange={() => {}} />,
      );
    });
    expect(container.innerHTML).toBe("");
  });
});
