// @vitest-environment jsdom
//
// btn-caption (S14 悬浮字幕) — desktop-host coverage. IS_DESKTOP is a
// module-scope import-time const (lib/platform/desktop.ts) — vi.mock
// affects this whole file, so this lives in its own file rather than a
// describe block inside Header.render.test.tsx, which needs the REAL
// (false) value for its own ambient (web) coverage — same split
// SettingsDialog.desktop.test.tsx/engineOptions.desktop.test.ts already
// established for the identical constraint (see those files' own
// header comments). Only Header.tsx's own click -> store.captionMode
// wiring is covered here; the actual OS window resize/always-on-top
// sequencing (lib/captionWindow.ts's enterDesktopCaptionModeWith/
// exitDesktopCaptionModeWith) is covered directly against a fake
// MainWindowApi in lib/__tests__/captionWindow.test.ts — Header.tsx
// itself never touches tauriApi, only the store flag (page.tsx's own
// effect is what calls into captionWindow.ts on a real transition).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/desktop", () => ({ IS_DESKTOP: true }));

import { useApp } from "@/lib/store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import Header from "../Header";

function noop() {}

describe("HamburgerMenu — btn-caption (S14 悬浮字幕), desktop host", () => {
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
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle", captionMode: false });
  });

  async function renderAndOpenMenu() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <Header
          onStart={noop}
          onPause={noop}
          onResume={noop}
          onStop={noop}
          onDemo={noop}
          onOpenHistory={noop}
          onOpenSettings={noop}
          onOpenHelp={noop}
          onOpenImport={noop}
          onOpenTaskCenter={noop}
        />,
      );
    });
    await act(async () => {
      container!
        .querySelector('[data-testid="btn-menu"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("shown on desktop (no PiP feature-detect needed there), labeled 悬浮字幕 while off", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle", captionMode: false });
    await renderAndOpenMenu();

    const item = container!.querySelector('[data-testid="btn-caption"]');
    expect(item).not.toBeNull();
    expect(item!.textContent).toBe("悬浮字幕");
  });

  it("clicking toggles store.captionMode true, and the label flips to 关闭悬浮字幕 on the next open", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle", captionMode: false });
    await renderAndOpenMenu();

    await act(async () => {
      container!
        .querySelector('[data-testid="btn-caption"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().captionMode).toBe(true);
    // Clicking any ≡ item also closes the dropdown (setOpen(false)) —
    // reopen it to see the label reflect the new state.
    await act(async () => {
      container!
        .querySelector('[data-testid="btn-menu"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector('[data-testid="btn-caption"]')!.textContent).toBe(
      "关闭悬浮字幕",
    );

    await act(async () => {
      container!
        .querySelector('[data-testid="btn-caption"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().captionMode).toBe(false);
  });
});
