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
import { DEFAULT_SETTINGS } from "../../lib/types";

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

  it("listening + tabaudio: hides 暂停 entirely (end-only), 结束 still shows", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "tabaudio" },
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
