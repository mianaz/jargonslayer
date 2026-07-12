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

// ---------------------------------------------------------------
// Sidecar-down tooltip (owner ask 2026-07-11: "I cannot see in the GUI
// if the local side got set up at all") — the privacy segment's title
// hints the local Whisper sidecar isn't up, but only when: the
// SELECTED engine actually needs it (whisper/tabaudio), nothing is
// currently running (an active/paused meeting already proves the
// engine works — never override with a stale probe), and the last
// known probe (store.sidecarUp, written by SettingsDialog's 转录引擎
// status line — see lib/stt/sidecarHealth.ts) actually failed.
// Deliberately tooltip-only (v1) — see StatusLine.tsx's own doc.
// ---------------------------------------------------------------

describe("StatusLine — sidecar-down tooltip", () => {
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
      status: "idle",
      sidecarUp: null,
      settings: { ...s.settings, engine: "demo" },
    }));
    vi.unstubAllGlobals();
  });

  function renderStatusLine() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
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

  // The privacy sentence's OWN wrapping span is the only element in
  // this component styled with `truncate` — a stable-enough hook
  // without adding a new data-testid just for this.
  function privacySegment(): HTMLElement {
    const el = container!.querySelector(".truncate");
    if (!el) throw new Error("privacy segment (.truncate) not found");
    return el as HTMLElement;
  }

  it("hints when engine:whisper, status idle, and the last probe failed (sidecarUp:false)", async () => {
    useApp.setState((s) => ({
      status: "idle",
      sidecarUp: false,
      settings: { ...s.settings, engine: "whisper" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine />);
    });

    expect(privacySegment().title).toBe("本地 Whisper sidecar 未连接——见 设置 → 转录引擎");
  });

  it("hints for engine:tabaudio too (the other sidecar-backed engine)", async () => {
    useApp.setState((s) => ({
      status: "idle",
      sidecarUp: false,
      settings: { ...s.settings, engine: "tabaudio" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine />);
    });

    expect(privacySegment().title).not.toBe("");
  });

  it("no hint once the sidecar is confirmed up (sidecarUp:true)", async () => {
    useApp.setState((s) => ({
      status: "idle",
      sidecarUp: true,
      settings: { ...s.settings, engine: "whisper" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine />);
    });

    expect(privacySegment().title).toBe("");
  });

  it("no hint when never probed this session (sidecarUp:null) — doesn't guess before Settings has actually checked", async () => {
    useApp.setState((s) => ({
      status: "idle",
      sidecarUp: null,
      settings: { ...s.settings, engine: "whisper" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine />);
    });

    expect(privacySegment().title).toBe("");
  });

  it("no hint while a meeting is actually live (status listening) — a running engine already proves it works, never overridden by a stale probe", async () => {
    useApp.setState((s) => ({
      status: "listening",
      sidecarUp: false,
      settings: { ...s.settings, engine: "whisper" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine />);
    });

    expect(privacySegment().title).toBe("");
  });

  it("no hint for a non-sidecar engine (webspeech), even with a stale sidecarUp:false left over from a previous whisper session", async () => {
    useApp.setState((s) => ({
      status: "idle",
      sidecarUp: false,
      settings: { ...s.settings, engine: "webspeech" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine />);
    });

    expect(privacySegment().title).toBe("");
  });
});

// ---------------------------------------------------------------
// On-device Web Speech privacy posture (docs/research/
// stt-live-engines-2026-07.md item #1): the privacy segment shows the
// same green "音频未离开本机" posture whisper/tabaudio use whenever the
// ACTIVE webspeech session reported on-device mode
// (store.sttEngineMode, written by useMeeting.ts's onEngineMode
// handler) — instead of the default amber cloud warning webspeech
// otherwise always shows (ENGINE_POSTURE['webspeech'] === 'cloud').
// ---------------------------------------------------------------

describe("StatusLine — on-device privacy posture", () => {
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
      status: "idle",
      sttEngineMode: null,
      settings: { ...s.settings, engine: "demo" },
    }));
    vi.unstubAllGlobals();
  });

  function renderStatusLine() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
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

  // Same hook as the sidecar-down describe block above — the privacy
  // sentence's own wrapping span is the only `.truncate` element.
  function privacySegment(): HTMLElement {
    const el = container!.querySelector(".truncate");
    if (!el) throw new Error("privacy segment (.truncate) not found");
    return el as HTMLElement;
  }

  it("shows the green on-device posture when engine:webspeech and sttEngineMode:'on-device'", async () => {
    useApp.setState((s) => ({
      status: "listening",
      sttEngineMode: "on-device",
      settings: { ...s.settings, engine: "webspeech" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine />);
    });

    expect(privacySegment().textContent).toContain("音频未离开本机");
    expect(privacySegment().className).toContain("text-lab-green");
    expect(privacySegment().className).not.toContain("text-warn-soft");
  });

  it("stays amber cloud when engine:webspeech and sttEngineMode:'cloud' (decided/fell back to cloud)", async () => {
    useApp.setState((s) => ({
      status: "listening",
      sttEngineMode: "cloud",
      settings: { ...s.settings, engine: "webspeech" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine />);
    });

    expect(privacySegment().textContent).toContain("音频将经过浏览器厂商云端识别");
    expect(privacySegment().className).toContain("text-warn-soft");
  });

  it("stays amber cloud when engine:webspeech and sttEngineMode:null (no session has reported yet)", async () => {
    useApp.setState((s) => ({
      status: "connecting",
      sttEngineMode: null,
      settings: { ...s.settings, engine: "webspeech" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine />);
    });

    expect(privacySegment().textContent).toContain("音频将经过浏览器厂商云端识别");
    expect(privacySegment().className).toContain("text-warn-soft");
  });

  it("ignores a stale sttEngineMode:'on-device' left over from a previous webspeech session once the engine switches away", async () => {
    useApp.setState((s) => ({
      status: "listening",
      sttEngineMode: "on-device",
      settings: { ...s.settings, engine: "whisper" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine />);
    });

    // Still green (whisper's own posture is local) — but via
    // ENGINE_POSTURE, not the stale on-device flag; the point is this
    // doesn't crash/misbehave for a non-webspeech engine.
    expect(privacySegment().textContent).toContain("音频未离开本机");
    expect(privacySegment().className).toContain("text-lab-green");
  });
});
