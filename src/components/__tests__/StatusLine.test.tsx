// @vitest-environment jsdom
//
// Detect-mode toggle (E2E batch item 2): the statusline's detect-mode
// label becomes clickable while detectMode is "llm"/"dictionary" and
// flips settings.aiDetect. The label derives from detectMode (the
// scheduler's runtime state, see detect/scheduler.ts); the click also
// echoes the expected mode synchronously so an idle meeting doesn't
// show a dead button — the scheduler corrects the echo on its next
// batch if reality differs. Mirrors Toast.test.tsx's createRoot/act
// pattern (no @testing-library/react in this repo's test stack).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "../../lib/store";
import StatusLine from "../StatusLine";

describe("StatusLine — detect-mode toggle", () => {
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
    useApp.setState((s) => ({
      detectMode: "llm",
      settings: { ...s.settings, aiDetect: true },
    }));
    vi.unstubAllGlobals();
  });

  function renderStatusLine() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    // jsdom has no matchMedia — StatusLine mounts PixelDragon (the
    // mascot perch), whose prefers-reduced-motion hook calls it
    // unconditionally.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  it("clicking the detect-mode label flips settings.aiDetect (label keeps reading from detectMode)", async () => {
    useApp.setState((s) => ({
      detectMode: "llm",
      settings: { ...s.settings, aiDetect: true },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine />);
    });

    const toggle = container!.querySelector('[data-testid="statusline-detect-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent).toBe("词典+AI 检测");

    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.aiDetect).toBe(false);
    // Synchronous echo: the label must flip immediately, not wait for
    // the scheduler's next batch.
    expect(useApp.getState().detectMode).toBe("dictionary");
    expect(
      container!.querySelector('[data-testid="statusline-detect-toggle"]')!.textContent,
    ).toBe("词典检测");

    await act(async () => {
      container!
        .querySelector('[data-testid="statusline-detect-toggle"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.aiDetect).toBe(true);
    expect(useApp.getState().detectMode).toBe("llm");
  });

  it("detectMode 'off' renders the plain non-interactive span, no toggle button", async () => {
    useApp.setState({ detectMode: "off" });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine />);
    });

    expect(container!.querySelector('[data-testid="statusline-detect-toggle"]')).toBeNull();
    expect(container!.textContent).toContain("检测关闭");
  });
});
