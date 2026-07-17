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
import { useLatencyStats } from "../../lib/stt/latencyStats";
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
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
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
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
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
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(privacySegment().title).toBe("本地 Whisper 未连接——见 设置 → 转录引擎");
  });

  it("hints for engine:tabaudio too (the other sidecar-backed engine)", async () => {
    useApp.setState((s) => ({
      status: "idle",
      sidecarUp: false,
      settings: { ...s.settings, engine: "tabaudio" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(privacySegment().title).not.toBe("");
  });

  it("hints for engine:appaudio too (S9/D7 — a third sidecar-backed engine)", async () => {
    useApp.setState((s) => ({
      status: "idle",
      sidecarUp: false,
      settings: { ...s.settings, engine: "appaudio" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
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
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
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
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
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
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
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
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(privacySegment().title).toBe("");
  });
});

// ---------------------------------------------------------------
// On-device Web Speech privacy posture (docs/research/
// stt-live-engines-2026-07.md item #1): the privacy segment shows the
// same green "音频在本地处理" posture whisper/tabaudio use whenever the
// ACTIVE webspeech session reported on-device mode
// (store.sttEngineMode, written by useMeeting.ts's onEngineMode
// handler) — instead of the default amber cloud warning webspeech
// otherwise always shows (ENGINE_OPTIONS's webspeech entry is
// posture:'cloud').
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
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(privacySegment().textContent).toContain("音频在本地处理");
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
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
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
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
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
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    // Still green (whisper's own posture is local) — but via
    // ENGINE_OPTIONS, not the stale on-device flag; the point is this
    // doesn't crash/misbehave for a non-webspeech engine.
    expect(privacySegment().textContent).toContain("音频在本地处理");
    expect(privacySegment().className).toContain("text-lab-green");
  });

  // S10 field-fix #2 (HIGH, adversarial review): posture now derives
  // from ENGINE_OPTIONS (lib/stt/engineOptions.ts) instead of a
  // second, drifted-out-of-sync local map — soniox is posture:"cloud"
  // there and must render the amber cloud sentence, never the green
  // local one.
  it("shows the amber cloud posture for engine:soniox (a CLOUD engine, not local)", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: { ...s.settings, engine: "soniox" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(privacySegment().textContent).toContain("音频将经过浏览器厂商云端识别");
    expect(privacySegment().className).toContain("text-warn-soft");
    expect(privacySegment().className).not.toContain("text-lab-green");
  });

  it("short variant also stays cloud for engine:soniox", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: { ...s.settings, engine: "soniox" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(privacySegment().textContent).toContain("音频将经厂商云端");
  });

  it("an engine value absent from ENGINE_OPTIONS falls back to cloud — never defaults to local for an unrecognized engine", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: {
        ...s.settings,
        engine: "future-engine" as unknown as typeof s.settings.engine,
      },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(privacySegment().textContent).toContain("音频将经过浏览器厂商云端识别");
    expect(privacySegment().className).toContain("text-warn-soft");
    expect(privacySegment().className).not.toContain("text-lab-green");
  });

  // Lead adjudication on F2's flagged side effect: "demo" is the
  // scripted preview — no audio exists at all, so the amber cloud
  // warning would be a false claim in the OTHER direction. It keeps
  // the green local posture the old ENGINE_POSTURE map always gave it
  // (see StatusLine.tsx's posture derivation comment).
  it("demo (scripted preview, no audio at all) keeps the green local posture", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: {
        ...s.settings,
        engine: "demo" as unknown as typeof s.settings.engine,
      },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(privacySegment().textContent).toContain("音频在本地处理");
    expect(privacySegment().className).toContain("text-lab-green");
  });
});

// ---------------------------------------------------------------
// S10 field-fix #5/#8: 延迟 chip — sustained (not momentary) local-
// Whisper transcribe latency, hidden whenever healthy/null/not-
// listening/not-local-whisper/not-yet-sustained. lagMs/sustained come
// from lib/stt/latencyStats.ts (fed by wsTransport.ts's own lag_ms
// passthrough — untested here, that wiring's own coverage lives in
// wsTransport.test.ts). The hysteresis ITSELF (3-consecutive-samples
// ON, <1200ms OFF, dead-zone hold) is latencyStats.test.ts's own
// coverage — StatusLine just reads the derived `sustained` flag, so
// these tests set it directly rather than re-deriving it from lagMs.
// ---------------------------------------------------------------

describe("StatusLine — 延迟 (sustained latency) chip", () => {
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
      settings: { ...s.settings, engine: "demo" },
    }));
    useLatencyStats.setState({ lagMs: null, sustained: false });
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

  function chip(): Element | null {
    return container!.querySelector('[data-testid="statusline-latency-chip"]');
  }

  it("shows once latencyStats reports sustained:true, while listening on whisper", async () => {
    useApp.setState((s) => ({ status: "listening", settings: { ...s.settings, engine: "whisper" } }));
    useLatencyStats.setState({ lagMs: 3200, sustained: true });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip()).not.toBeNull();
    expect(chip()!.textContent).toBe("延迟 ~3s");
  });

  it("hidden when lagMs is null (no sample yet), even if sustained were somehow true", async () => {
    useApp.setState((s) => ({ status: "listening", settings: { ...s.settings, engine: "whisper" } }));
    useLatencyStats.setState({ lagMs: null, sustained: true });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip()).toBeNull();
  });

  it("hidden while sustained:false, however high lagMs reads — StatusLine trusts the hysteresis, computes no threshold of its own", async () => {
    useApp.setState((s) => ({ status: "listening", settings: { ...s.settings, engine: "whisper" } }));
    useLatencyStats.setState({ lagMs: 5000, sustained: false });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip()).toBeNull();
  });

  it("hidden while not listening (e.g. paused), even with sustained:true left over", async () => {
    useApp.setState((s) => ({ status: "paused", settings: { ...s.settings, engine: "whisper" } }));
    useLatencyStats.setState({ lagMs: 5000, sustained: true });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip()).toBeNull();
  });

  it("hidden for engines that never route through the local Whisper sidecar (e.g. webspeech), even with sustained:true somehow set", async () => {
    useApp.setState((s) => ({ status: "listening", settings: { ...s.settings, engine: "webspeech" } }));
    useLatencyStats.setState({ lagMs: 5000, sustained: true });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip()).toBeNull();
  });

  it("shows for tabaudio and appaudio too — every engine that actually flows through wsTransport.ts", async () => {
    for (const engine of ["tabaudio", "appaudio"] as const) {
      useApp.setState((s) => ({ status: "listening", settings: { ...s.settings, engine } }));
      useLatencyStats.setState({ lagMs: 4000, sustained: true });
      renderStatusLine();
      await act(async () => {
        root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
      });
      expect(chip()).not.toBeNull();
      act(() => root!.unmount());
      container!.remove();
      container = null;
      root = null;
    }
  });
});

// ---------------------------------------------------------------
// S10 field-fix — engine picker as a bottom-bar dropdown (her words:
// 与其作为tab，engine不如改成dropdown，且显示在下方状态栏). Header.tsx no
// longer has ANY engine control (pills or mobile <select>) — this is
// THE picker at every width now.
// ---------------------------------------------------------------

describe("StatusLine — engine dropdown", () => {
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
    useApp.setState((s) => ({ status: "idle", settings: { ...s.settings, engine: "demo" } }));
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

  function select(): HTMLSelectElement {
    const el = container!.querySelector('[data-testid="statusline-engine-select"]');
    if (!el) throw new Error("engine select not found");
    return el as HTMLSelectElement;
  }

  it("lists every ENGINE_OPTIONS value (web build: webspeech/whisper/tabaudio/soniox, D7 keeps tabaudio)", async () => {
    useApp.setState((s) => ({ settings: { ...s.settings, engine: "whisper" } }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const values = Array.from(select().querySelectorAll("option"))
      .map((o) => o.getAttribute("value"))
      .filter((v) => v !== "");
    expect(values).toEqual(["webspeech", "whisper", "tabaudio", "soniox"]);
  });

  it("changing the value writes settings.engine (same store write as the old mobile <select>)", async () => {
    useApp.setState((s) => ({ status: "idle", settings: { ...s.settings, engine: "whisper" } }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    await act(async () => {
      select().value = "soniox";
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(useApp.getState().settings.engine).toBe("soniox");
  });

  it("disabled while a meeting is connecting/listening (isEngineControlBusy) — same gate the old header controls used", async () => {
    useApp.setState((s) => ({ status: "listening", settings: { ...s.settings, engine: "whisper" } }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(select().disabled).toBe(true);
  });

  it("not disabled while idle/stopped/paused", async () => {
    useApp.setState((s) => ({ status: "idle", settings: { ...s.settings, engine: "whisper" } }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(select().disabled).toBe(false);
  });

  it("shows a disabled 选择引擎 placeholder while engine is demo (mirrors the old mobile <select>'s own placeholder)", async () => {
    useApp.setState((s) => ({ status: "idle", settings: { ...s.settings, engine: "demo" } }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(select().value).toBe("");
    const placeholder = Array.from(select().querySelectorAll("option")).find(
      (o) => o.value === "",
    );
    expect(placeholder).toBeDefined();
    expect(placeholder!.disabled).toBe(true);
    expect(placeholder!.textContent).toBe("选择引擎");
  });
});

