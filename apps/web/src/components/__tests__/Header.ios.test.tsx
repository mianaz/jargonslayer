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
import type { HeaderProps } from "../Header";

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

// TestFlight feedback (phone-width icon pass): brand logo/wordmark
// removed entirely on iOS, and the transport buttons (开始/暂停/继续/
// 结束) go icon-only (开始 keeps a visible short label) — same testids/
// handlers as the desktop text buttons, see Header.render.test.tsx's
// non-iOS coverage of those.
describe("Header — iOS brand removal + icon-only transport buttons (mobile icon pass)", () => {
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
    useApp.setState({
      settings: DEFAULT_SETTINGS,
      status: "idle",
      activeSessionId: null,
      segments: [],
      translations: {},
      translateStatus: { state: "off", pending: 0 },
      correctionBusy: false,
    });
  });

  async function renderHeader(extraProps: Partial<HeaderProps> = {}): Promise<void> {
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
          {...extraProps}
        />,
      );
    });
  }

  it("no logo <img> and no JargonSlayer wordmark anywhere in the header", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle" });
    await renderHeader();

    expect(container!.querySelector("header img")).toBeNull();
    expect(container!.querySelector("header")!.textContent).not.toContain("JargonSlayer");
  });

  it("idle: 开始 button is icon-only (aria-label/title carry 开始, no visible text)", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle" });
    await renderHeader();

    const startBtn = container!.querySelector('[data-testid="btn-start"]')!;
    expect(startBtn.querySelector("svg")).not.toBeNull();
    expect(startBtn.textContent).toBe("");
    expect(startBtn.getAttribute("aria-label")).toBe("开始");
    expect(startBtn.getAttribute("title")).toBe("开始");
  });

  // D2 fold (task 4): 选择/AI 校正/补全翻译 no longer render as standalone
  // header buttons at all — they moved into the ≡ menu (IosMenuSheet on
  // this build) as labeled rows, still gated on the same isMobileLayout
  // prop (not bare IS_IOS), same gate TranscriptPanel.tsx's own
  // toolbarVisible reads. Each button's OWN gate (aiConfigured/
  // stopped+segments, showGapFill) is exercised once here; the exhaustive
  // per-condition matrix already lives in TranscriptPanel.f1f2.test.tsx —
  // this only pins that Header actually renders/wires them into the sheet
  // when told to.
  it("mobile toolbar rows (选择/AI 校正/补全翻译) render inside the ≡ sheet when isMobileLayout is true, and 选择 fires onToggleSelectMode", async () => {
    useApp.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKeyOpenrouter: "byok-key",
        bilingualTranscript: true,
        language: "en-US",
        explainLanguage: "zh",
      },
      status: "stopped",
      segments: [{ id: "s1", index: 0, startedAt: 0, endedAt: 0, text: "hi", engine: "demo" }],
      translations: {},
    });
    const onToggleSelectMode = vi.fn();
    await renderHeader({
      isMobileLayout: true,
      selectMode: false,
      onToggleSelectMode,
      onOpenCorrection: noop,
    });

    // Not present before the menu is opened at all.
    expect(container!.querySelector('[data-testid="btn-select-mode"]')).toBeNull();

    await act(async () => {
      container!
        .querySelector('[data-testid="btn-menu"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container!.querySelector('[data-testid="btn-select-mode"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="btn-ai-correct"]')).not.toBeNull();
    const gapFillBtn = container!.querySelector('[data-testid="btn-gap-fill"]');
    expect(gapFillBtn).not.toBeNull();
    expect(gapFillBtn!.textContent).toContain("1");

    await act(async () => {
      container!
        .querySelector('[data-testid="btn-select-mode"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggleSelectMode).toHaveBeenCalledTimes(1);
    // Tapping the row also closes the sheet (mirrors every other row).
    expect(container!.querySelector('[data-testid="header-menu-sheet"]')).toBeNull();
  });

  it("mobile toolbar rows are absent from the ≡ sheet when isMobileLayout is false (default) — desktop-shaped header, unchanged", async () => {
    useApp.setState({
      settings: DEFAULT_SETTINGS,
      status: "stopped",
      segments: [{ id: "s1", index: 0, startedAt: 0, endedAt: 0, text: "hi", engine: "demo" }],
    });
    await renderHeader();

    expect(container!.querySelector('[data-testid="btn-select-mode"]')).toBeNull();
    expect(container!.querySelector('[data-testid="btn-ai-correct"]')).toBeNull();
    expect(container!.querySelector('[data-testid="btn-gap-fill"]')).toBeNull();

    await act(async () => {
      container!
        .querySelector('[data-testid="btn-menu"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container!.querySelector('[data-testid="btn-select-mode"]')).toBeNull();
    expect(container!.querySelector('[data-testid="btn-ai-correct"]')).toBeNull();
    expect(container!.querySelector('[data-testid="btn-gap-fill"]')).toBeNull();
  });

  it("listening: 暂停/结束 are icon-only with aria-label + title carrying the Chinese label", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "webspeech", realtimeDiarize: false },
      status: "listening",
    });
    await renderHeader();

    const pauseBtn = container!.querySelector('[data-testid="btn-pause"]')!;
    expect(pauseBtn.querySelector("svg")).not.toBeNull();
    expect(pauseBtn.textContent).toBe("");
    expect(pauseBtn.getAttribute("aria-label")).toBe("暂停");
    expect(pauseBtn.getAttribute("title")).toBe("暂停");

    const stopBtn = container!.querySelector('[data-testid="btn-stop"]')!;
    expect(stopBtn.querySelector("svg")).not.toBeNull();
    expect(stopBtn.getAttribute("aria-label")).toBe("结束");
    expect(stopBtn.getAttribute("title")).toBe("结束");
  });

  it("paused: 继续 is icon-only with aria-label + title", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "paused" });
    await renderHeader();

    const resumeBtn = container!.querySelector('[data-testid="btn-resume"]')!;
    expect(resumeBtn.querySelector("svg")).not.toBeNull();
    expect(resumeBtn.textContent).toBe("");
    expect(resumeBtn.getAttribute("aria-label")).toBe("继续");
    expect(resumeBtn.getAttribute("title")).toBe("继续");
  });

  // TestFlight batch fix: the mobile-icon import button is gone entirely
  // on iOS — the start-screen ModeSelector already offers 导入文件或文稿
  // there, so this was a second, redundant entry point on the platform
  // with the least header width to spare.
  it("does not render the mobile import button (btn-import-mobile) — ModeSelector's own import tile covers it", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle" });
    await renderHeader();

    expect(container!.querySelector('[data-testid="btn-import-mobile"]')).toBeNull();
  });
});
