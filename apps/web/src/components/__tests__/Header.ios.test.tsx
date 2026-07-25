// @vitest-environment jsdom
//
// Header ≡ menu — iOS-only coverage (S15 mobile-UX sprint, Miana: "交互
// 还是太网页化了...考虑诸如claude手机版如何交互"): on iOS the ☰ button
// opens BottomSheet.tsx instead of the floating absolute dropdown, with
// the SAME six items (order/handlers/labels byte-identical to the
// desktop dropdown — see Header.render.test.tsx's own HamburgerMenu
// coverage for that side). IS_IOS is a module-scope import-time const,
// so this needs its own file/vi.mock — mirrors TutorialOverlay.ios.
// test.tsx's own split for the identical constraint.
//
// No osspeechCaps mock needed here (unlike ModeSelector.ios.test.tsx):
// Header's own render path never calls useOsSpeechCaps()/
// probeOsSpeechCaps() — the only osspeechCaps.ts function that actually
// READS IS_TAURI — engineOptions.ts (Header's one dependency that
// touches that module) only imports the pure snapshot/gate helpers
// (getOsSpeechCapsSnapshot/isOsSpeechFloorLocked/osSpeechLockReason),
// none of which reference IS_TAURI at all (verified by reading both
// files directly, not assumed).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true }));

import Header from "../Header";
import { useApp } from "../../lib/store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";

function noop() {}

describe("Header ≡ menu — iOS BottomSheet variant (S15)", () => {
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
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle", activeSessionId: null });
  });

  async function renderAndOpenMenu(onOpenSettings: () => void = noop): Promise<void> {
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
          onOpenSettings={onOpenSettings}
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

  it("☰ opens the BottomSheet variant (header-menu-sheet), not the web/desktop floating dropdown", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "stopped", activeSessionId: "session-1" });
    await renderAndOpenMenu();

    // #58 FIX 6 (rev): sheet mounts in-tree as a sibling of <header> — not
    // descendant of `container` (Header's own sticky/z-20 subtree), so
    // these queries run against document.body instead.
    expect(document.body.querySelector('[data-testid="header-menu-sheet"]')).not.toBeNull();
    // Exactly one role="menu" in the tree — the desktop dropdown branch
    // is `{!IS_IOS && open && (...)}`, so it must not ALSO be present.
    expect(document.body.querySelectorAll('[role="menu"]').length).toBe(1);
  });

  it("all six items are present — labels byte-identical to the desktop dropdown", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "stopped", activeSessionId: "session-1" });
    await renderAndOpenMenu();

    // #58 FIX 6: portaled to document.body — see the test above.
    const sheet = document.body.querySelector('[data-testid="header-menu-sheet"]')!;
    for (const label of ["演示", "学习中心", "设置", "帮助", "复制诊断信息", "新会议"]) {
      expect(sheet.textContent).toContain(label);
    }
  });

  // Sim-caught (rect-probed live): a display:flex <button> sizes to its
  // content — without w-full each row's tappable area was ~90pt of a
  // 402pt-wide row, so taps right of the label silently hit the
  // container. jsdom does no layout, so the honest pin is the class
  // itself on every row-shaped item in the sheet.
  it("every sheet row is full-width tappable (w-full pinned on the row class)", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "stopped", activeSessionId: "session-1" });
    await renderAndOpenMenu();

    const sheet = document.body.querySelector('[data-testid="header-menu-sheet"]')!;
    const rows = Array.from(sheet.querySelectorAll('[role="menuitem"]'));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(row.className).toContain("w-full");
    }
  });

  it("tapping 设置 fires onOpenSettings and closes the sheet", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "stopped", activeSessionId: "session-1" });
    const onOpenSettings = vi.fn();
    await renderAndOpenMenu(onOpenSettings);

    // #58 FIX 6: portaled to document.body — see the first test above.
    const settingsBtn = document.body.querySelector('[data-testid="btn-settings"]') as HTMLButtonElement;
    expect(settingsBtn).not.toBeNull();
    await act(async () => {
      settingsBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="header-menu-sheet"]')).toBeNull();
  });

  // Sim-caught REGRESSION pin (post-FIX-6): a real tap fires mousedown
  // BEFORE click. Once the sheet portaled out of rootRef, Header's
  // outside-mousedown listener treated every row tap as "outside" and
  // unmounted the sheet between the two events — the click never landed
  // and every menu item was dead ON DEVICE while the bare-click tests
  // above stayed green. The listener is now IS_IOS-skipped (the sheet
  // owns its own dismissal); this test replays the full event sequence
  // so the gap can't reopen.
  it("real tap sequence (mousedown then click) on 设置 still lands — outside-mousedown must not eat portaled rows", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "stopped", activeSessionId: "session-1" });
    const onOpenSettings = vi.fn();
    await renderAndOpenMenu(onOpenSettings);

    const settingsBtn = document.body.querySelector('[data-testid="btn-settings"]') as HTMLButtonElement;
    expect(settingsBtn).not.toBeNull();
    await act(async () => {
      settingsBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    // The sheet (and the row) must survive the mousedown for the click
    // to land — this is the exact assertion the regression failed.
    expect(document.body.querySelector('[data-testid="header-menu-sheet"]')).not.toBeNull();
    await act(async () => {
      settingsBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="header-menu-sheet"]')).toBeNull();
  });

  // #58 fix round FIX 6 + sim-caught follow-up: the sheet must escape
  // Header's sticky/z-20 stacking context (its z-40/50 layers lost to
  // root-level z-30/40 overlays — Opus proved the overlaps) WITHOUT a
  // document.body portal (WKWebView composited the app's draggable
  // bottom panel above body-portaled fixed layers and swallowed every
  // row tap — painted-but-dead, invisible to jsdom). The landing spot:
  // in-tree, as a SIBLING of the sticky <header> element (IosMenuSheet
  // in Header.tsx). This pins both halves.
  it("BottomSheet mounts in-tree as a sibling of <header> — outside its sticky stacking context, NOT a body portal (FIX 6)", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "stopped", activeSessionId: "session-1" });
    await renderAndOpenMenu();

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // In-tree (inside the React container), not portaled to body:
    expect(container!.contains(dialog)).toBe(true);
    expect(dialog!.parentElement).not.toBe(document.body);
    // ...but OUTSIDE the sticky <header> element's subtree:
    const header = container!.querySelector("header");
    expect(header).not.toBeNull();
    expect(header!.contains(dialog)).toBe(false);
  });
});
