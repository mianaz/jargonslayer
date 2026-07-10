// @vitest-environment jsdom
//
// Standalone 历史 button (E2E batch item 1): moved out of the ≡
// hamburger menu into the header's right cluster, directly left of ≡.
// isEngineControlBusy (Header.test.ts) already covers the pure
// busy-gate logic; this file covers the one rendering behavior worth a
// regression test. Mirrors Toast.test.tsx's createRoot/act pattern (no
// @testing-library/react in this repo's test stack).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import Header from "../Header";

function noop() {}

describe("Header — standalone 历史 button", () => {
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
  });

  it("renders btn-history in the header (not inside the ≡ menu) and fires onOpenHistory on click", async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    const onOpenHistory = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <Header
          onStart={noop}
          onStop={noop}
          onDemo={noop}
          onOpenHistory={onOpenHistory}
          onOpenSettings={noop}
          onOpenHelp={noop}
          onOpenImport={noop}
        />,
      );
    });

    const btn = container!.querySelector('[data-testid="btn-history"]');
    expect(btn).not.toBeNull();

    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenHistory).toHaveBeenCalledTimes(1);

    // The ≡ menu's dropdown (closed by default) must no longer carry
    // its own 历史 item at all.
    const menuBtn = container!.querySelector('[data-testid="btn-menu"]');
    await act(async () => {
      menuBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector('[role="menu"] [data-testid="btn-history"]')).toBeNull();
  });
});
