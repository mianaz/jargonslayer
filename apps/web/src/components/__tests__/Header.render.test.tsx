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
import { useApp } from "../../lib/store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";

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
          onPause={noop}
          onResume={noop}
          onStop={noop}
          onDemo={noop}
          onOpenHistory={onOpenHistory}
          onOpenSettings={noop}
          onOpenHelp={noop}
          onOpenImport={noop}
          onOpenTaskCenter={noop}
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

// B4/B6: the listening/paused button matrix. canPause (Header.test.ts)
// already covers the pure per-engine gating logic; this covers the one
// rendering behavior worth a regression test — which buttons actually
// show up for each store status/engine combination.
describe("Header — pause/resume/end button matrix (B4)", () => {
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
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle" });
  });

  async function renderHeader(onPause = noop, onResume = noop) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <Header
          onStart={noop}
          onPause={onPause}
          onResume={onResume}
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
  }

  it("listening (webspeech): shows 暂停 + 结束, not 开始监听/继续", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "webspeech" },
      status: "listening",
    });
    await renderHeader();

    const pauseBtn = container!.querySelector('[data-testid="btn-pause"]');
    const stopBtn = container!.querySelector('[data-testid="btn-stop"]');
    expect(pauseBtn).not.toBeNull();
    expect(pauseBtn!.textContent).toBe("暂停");
    expect(stopBtn).not.toBeNull();
    expect(stopBtn!.textContent).toContain("结束");
    expect(container!.querySelector('[data-testid="btn-start"]')).toBeNull();
    expect(container!.querySelector('[data-testid="btn-resume"]')).toBeNull();
  });

  it("paused: shows 继续 + 结束, not 暂停/开始监听", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "webspeech" },
      status: "paused",
    });
    await renderHeader();

    const resumeBtn = container!.querySelector('[data-testid="btn-resume"]');
    const stopBtn = container!.querySelector('[data-testid="btn-stop"]');
    expect(resumeBtn).not.toBeNull();
    expect(resumeBtn!.textContent).toBe("继续");
    expect(stopBtn).not.toBeNull();
    expect(stopBtn!.textContent).toContain("结束");
    expect(container!.querySelector('[data-testid="btn-pause"]')).toBeNull();
    expect(container!.querySelector('[data-testid="btn-start"]')).toBeNull();
  });

  it("listening + tabaudio: shows 暂停 (STT protocol v2 soft pause) and 结束", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "tabaudio" },
      status: "listening",
    });
    await renderHeader();

    expect(container!.querySelector('[data-testid="btn-pause"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="btn-stop"]')).not.toBeNull();
  });

  it("listening + appaudio (S9/D7): shows 暂停 (same STT protocol v2 soft pause) and 结束", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "appaudio" },
      status: "listening",
    });
    await renderHeader();

    expect(container!.querySelector('[data-testid="btn-pause"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="btn-stop"]')).not.toBeNull();
  });

  it("listening + whisper with realtime diarization ON: hides 暂停 entirely (end-only), 结束 still shows", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "whisper", realtimeDiarize: true },
      status: "listening",
    });
    await renderHeader();

    expect(container!.querySelector('[data-testid="btn-pause"]')).toBeNull();
    expect(container!.querySelector('[data-testid="btn-stop"]')).not.toBeNull();
  });

  it("listening + whisper with realtime diarization OFF: shows 暂停", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "whisper", realtimeDiarize: false },
      status: "listening",
    });
    await renderHeader();

    expect(container!.querySelector('[data-testid="btn-pause"]')).not.toBeNull();
  });

  it("listening + soniox: hides 暂停 entirely (v0.4 S4, canPause=false — no pause/resume implemented), 结束 still shows", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "soniox" },
      status: "listening",
    });
    await renderHeader();

    expect(container!.querySelector('[data-testid="btn-pause"]')).toBeNull();
    expect(container!.querySelector('[data-testid="btn-stop"]')).not.toBeNull();
  });

  it("clicking 暂停/继续 fires onPause/onResume", async () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "webspeech" },
      status: "listening",
    });
    await renderHeader(onPause, onResume);

    await act(async () => {
      container!
        .querySelector('[data-testid="btn-pause"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onPause).toHaveBeenCalledTimes(1);

    await act(async () => {
      useApp.setState({ status: "paused" });
      root!.render(
        <Header
          onStart={noop}
          onPause={onPause}
          onResume={onResume}
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
        .querySelector('[data-testid="btn-resume"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});

// E2E batch item 1: the old chip read as clickable (bordered, sitting
// right beside btn-history's icon button). It's now plain text — this
// covers both the copy change and the "no border chrome" requirement.
describe("Header — chip-saved (E2E batch item 1)", () => {
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
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle", activeSessionId: null });
  });

  async function renderHeader() {
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
  }

  it("reads 已保存, not 历史会话, and carries no border class", async () => {
    useApp.setState({
      settings: DEFAULT_SETTINGS,
      status: "stopped",
      activeSessionId: "session-1",
    });
    await renderHeader();

    const chip = container!.querySelector('[data-testid="chip-saved"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe("已保存");
    expect(chip!.className).not.toMatch(/\bborder\b/);

    // btn-history's title now matches its aria-label exactly.
    const historyBtn = container!.querySelector('[data-testid="btn-history"]');
    expect(historyBtn!.getAttribute("title")).toBe("历史");
    expect(historyBtn!.getAttribute("aria-label")).toBe("历史");
  });

  it("does not render when there is no active session (nothing to be mistaken for a button)", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle", activeSessionId: null });
    await renderHeader();

    expect(container!.querySelector('[data-testid="chip-saved"]')).toBeNull();
  });
});

// E2E batch item 2: mirrors StatusLine.test.tsx's detect-toggle
// coverage for the header's own copy of the control (header-detect-toggle).
describe("Header — header-detect-toggle (E2E batch item 2)", () => {
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
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle", detectMode: "llm" });
  });

  async function renderHeader() {
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
  }

  it("clicking the badge flips settings.aiDetect and echoes detectMode synchronously, borderless throughout", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, aiDetect: true },
      status: "idle",
      detectMode: "llm",
    });
    await renderHeader();

    const toggle = container!.querySelector('[data-testid="header-detect-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.tagName).toBe("BUTTON");
    expect(toggle!.className).not.toMatch(/\bborder\b/);

    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.aiDetect).toBe(false);
    // Synchronous echo — same rationale as StatusLine's toggle: the
    // scheduler only re-reads settings on its next segment/batch.
    expect(useApp.getState().detectMode).toBe("dictionary");
  });

  it("detectMode 'off' renders a non-interactive, borderless span (no toggle button)", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle", detectMode: "off" });
    await renderHeader();

    expect(container!.querySelector('[data-testid="header-detect-toggle"]')).toBeNull();
    const badge = Array.from(container!.querySelectorAll("span")).find((el) =>
      el.textContent?.includes("检测关闭"),
    );
    expect(badge).toBeDefined();
    expect(badge!.className).not.toMatch(/\bborder\b/);
  });
});

// E2E batch item 3: 学习中心 must not full-reload the app, but must also
// not strand a zombie listening/paused UI if clicked mid-meeting.
describe("HamburgerMenu — btn-review gating (E2E batch item 3)", () => {
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
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle" });
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

  it("renders btn-review as a real link (next/link -> <a>) while idle", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle" });
    await renderAndOpenMenu();

    const item = container!.querySelector('[data-testid="btn-review"]');
    expect(item).not.toBeNull();
    expect(item!.tagName).toBe("A");
    expect(item!.getAttribute("href")).toContain("/review");
    expect(item!.getAttribute("aria-disabled")).toBeNull();
  });

  it("renders btn-review as a disabled, non-clickable element while a meeting is active (listening)", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "listening" });
    await renderAndOpenMenu();

    const item = container!.querySelector('[data-testid="btn-review"]');
    expect(item).not.toBeNull();
    expect(item!.tagName).not.toBe("A");
    expect(item!.getAttribute("aria-disabled")).toBe("true");
    expect(item!.getAttribute("title")).toBe("会议进行中，结束后可进入学习中心");
  });

  it("also disables btn-review while paused (resuming is still possible, not a dead meeting)", async () => {
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "paused" });
    await renderAndOpenMenu();

    const item = container!.querySelector('[data-testid="btn-review"]');
    expect(item!.getAttribute("aria-disabled")).toBe("true");
  });
});

// S14 floating caption, web host — menu-entry visibility is driven by
// captionWindow.ts's own supportsDocumentPip(window) helper (unit-
// tested directly in lib/__tests__/captionWindow.test.ts), not by
// actually launching a PiP window here: jsdom has no Document
// Picture-in-Picture API at all, so `window` genuinely lacks
// `documentPictureInPicture` in this test environment — the SAME
// absent path a real Safari/Firefox/mobile browser hits. This covers
// the resulting UI behavior end to end (helper -> hidden menu item),
// without ever calling requestWindow() itself. IS_DESKTOP's own
// (always-shown) branch is covered separately in
// Header.caption.desktop.test.tsx (module-scope import-time const,
// needs its own vi.mock'd file — same split SettingsDialog.desktop.
// test.tsx/engineOptions.desktop.test.ts already established).
describe("HamburgerMenu — btn-caption (S14 悬浮字幕), web host", () => {
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
    useApp.setState({ settings: DEFAULT_SETTINGS, status: "idle" });
  });

  it("hidden on a plain web build without the Document Picture-in-Picture API (jsdom's own real absence)", async () => {
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

    expect(container!.querySelector('[data-testid="btn-caption"]')).toBeNull();
  });
});
