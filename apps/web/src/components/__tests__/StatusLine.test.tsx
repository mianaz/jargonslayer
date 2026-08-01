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
import { ENGINE_OPTIONS } from "../../lib/stt/engineOptions";
import { recordLlmCall, resetLlmTelemetry } from "../../lib/llm/telemetry";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import StatusLine, {
  AI_STATUS_CHIP_DOMAIN_LABEL,
  AI_STATUS_CHIP_GLYPH,
  DETECT_MODE_LABEL,
  ENGINE_SELECT_PLACEHOLDER,
  shortModelName,
  SIDECAR_DOWN_HINT_WEB,
} from "../StatusLine";

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
    expect(toggle!.textContent).toBe(DETECT_MODE_LABEL.llm);

    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.aiDetect).toBe(false);
    // Synchronous echo: the label must flip immediately, not wait for
    // the scheduler's next batch.
    expect(useApp.getState().detectMode).toBe("dictionary");
    expect(
      container!.querySelector('[data-testid="statusline-detect-toggle"]')!.textContent,
    ).toBe(DETECT_MODE_LABEL.dictionary);

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
    expect(container!.textContent).toContain("关闭");
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

    expect(privacySegment().title).toBe(SIDECAR_DOWN_HINT_WEB);
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
// stt-live-engines-2026-07.md item #1; upgraded to the v0.4.7 Lane C
// tri-state retention label, docs/design-explorations/
// stt-provider-wiring-2026-07.md §4/§9 D5-D7): the privacy segment
// shows the same green "本地处理 · 音频不出设备" hint whisper/tabaudio use
// whenever the ACTIVE webspeech session reported on-device mode
// (store.sttEngineMode, written by useMeeting.ts's onEngineMode
// handler) — instead of the default amber "云端 · 处理后不留存"
// cloud-transient hint webspeech otherwise always shows (ENGINE_
// OPTIONS's webspeech entry is retentionClass:'cloud-transient').
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

    expect(privacySegment().textContent).toContain("本地处理 · 音频不出设备");
    expect(privacySegment().className).toContain("text-lab-green");
    expect(privacySegment().className).not.toContain("text-warn-soft");
  });

  it("stays cloud-transient when engine:webspeech and sttEngineMode:'cloud' (decided/fell back to cloud)", async () => {
    useApp.setState((s) => ({
      status: "listening",
      sttEngineMode: "cloud",
      settings: { ...s.settings, engine: "webspeech" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(privacySegment().textContent).toContain("云端 · 处理后不留存");
    expect(privacySegment().className).toContain("text-warn-soft");
  });

  it("stays cloud-transient when engine:webspeech and sttEngineMode:null (no session has reported yet)", async () => {
    useApp.setState((s) => ({
      status: "connecting",
      sttEngineMode: null,
      settings: { ...s.settings, engine: "webspeech" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(privacySegment().textContent).toContain("云端 · 处理后不留存");
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

    // Still green (whisper's own retentionClass is local) — but via
    // ENGINE_OPTIONS, not the stale on-device flag; the point is this
    // doesn't crash/misbehave for a non-webspeech engine.
    expect(privacySegment().textContent).toContain("本地处理 · 音频不出设备");
    expect(privacySegment().className).toContain("text-lab-green");
  });

  // S10 field-fix #2 (HIGH, adversarial review); upgraded to tri-state
  // (Lane C): posture derives from ENGINE_OPTIONS (lib/stt/
  // engineOptions.ts) instead of a second, drifted-out-of-sync local
  // map — soniox is retentionClass:"cloud-transient" there and must
  // render the amber cloud-transient hint, never the green local one.
  it("shows the cloud-transient posture for engine:soniox (a CLOUD engine, not local)", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: { ...s.settings, engine: "soniox" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(privacySegment().textContent).toContain("云端 · 处理后不留存");
    expect(privacySegment().className).toContain("text-warn-soft");
    expect(privacySegment().className).not.toContain("text-lab-green");
  });

  it("an engine value absent from ENGINE_OPTIONS falls back to cloud-transient — never defaults to local for an unrecognized engine", async () => {
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

    expect(privacySegment().textContent).toContain("云端 · 处理后不留存");
    expect(privacySegment().className).toContain("text-warn-soft");
    expect(privacySegment().className).not.toContain("text-lab-green");
  });

  // Lead adjudication on F2's flagged side effect: "demo" is the
  // scripted preview — no audio exists at all, so the cloud warning
  // would be a false claim in the OTHER direction. It keeps the green
  // local posture the old ENGINE_POSTURE map always gave it (see
  // resolveEngineRetentionClass's own doc comment, lib/stt/
  // engineOptions.ts).
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

    expect(privacySegment().textContent).toContain("本地处理 · 音频不出设备");
    expect(privacySegment().className).toContain("text-lab-green");
  });

  // v0.4.7 Lane C: cloud-stored is pinned directly at the data level
  // (RETENTION_COPY / resolveEngineRetentionClass, engineOptions.test.
  // ts) — no live ENGINE_OPTIONS entry resolves to it yet (Deepgram
  // lands as cloud-transient per D7's unconditional mip_opt_out=true),
  // so this component can't be driven into that state through real
  // props/store today. Add a DOM-level case here once an engine does.
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

  it("groups every visible engine by its capability family", async () => {
    useApp.setState((s) => ({
      settings: {
        ...s.settings,
        engine: "whisper",
        sonioxKey: "sk-test",
        deepgramKey: "dg-test",
        elevenLabsKey: "el-test",
      },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const values = Array.from(select().querySelectorAll("option"))
      .map((o) => o.getAttribute("value"))
      .filter((v) => v !== "");
    expect(values).toEqual([
      "whisper",
      "tabaudio",
      "webspeech",
      "tabaudio-cloud",
      "soniox",
      "deepgram",
      "elevenlabs",
    ]);
    expect(Array.from(select().querySelectorAll("optgroup")).map((group) => group.label)).toEqual([
      "本地 STT 模型",
      "系统 STT 服务",
      "第三方 STT 提供商",
    ]);
  });

  it("keeps third-party providers visible and labels their real catalog-key status", async () => {
    useApp.setState((s) => ({
      settings: { ...s.settings, engine: "whisper", sonioxKey: "", deepgramKey: "", elevenLabsKey: "" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const values = Array.from(select().querySelectorAll("option"))
      .map((o) => o.getAttribute("value"))
      .filter((v) => v !== "");
    expect(values).toContain("soniox");
    expect(values).toContain("deepgram");
    expect(values).toContain("elevenlabs");
    const labelOf = (value: string) =>
      Array.from(select().querySelectorAll("option")).find((o) => o.value === value)?.textContent;
    // FINDING 12 fix: short NAME half (ENGINE_SELECT_LABEL_OVERRIDE) — the
    // full "Soniox 云端识别 · 未配置" truncates in this bar's
    // max-w-[7.5rem] below sm.
    expect(labelOf("soniox")).toBe("Soniox · 未配置");
    expect(labelOf("deepgram")).toBe("Deepgram · 未配置");
    expect(labelOf("elevenlabs")).toBe("ElevenLabs · 未配置");
  });

  // Same MEDIUM fix: tabaudio-cloud's "own key" is whichever provider
  // Settings.tabAudioCloudProvider resolves to, not sonioxKey
  // unconditionally — a Deepgram-resolved pick with its own key set is
  // configured even with sonioxKey empty.
  it("shows tabaudio-cloud when resolved to deepgram and deepgramKey is set (sonioxKey empty)", async () => {
    useApp.setState((s) => ({
      settings: {
        ...s.settings,
        engine: "whisper",
        tabAudioCloudProvider: "deepgram",
        sonioxKey: "",
        deepgramKey: "dg-test",
        elevenLabsKey: "",
      },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const values = Array.from(select().querySelectorAll("option"))
      .map((o) => o.getAttribute("value"))
      .filter((v) => v !== "");
    expect(values).toContain("tabaudio-cloud");
  });

  it("does not let a different provider's key mark Deepgram configured", async () => {
    useApp.setState((s) => ({
      settings: {
        ...s.settings,
        engine: "whisper",
        tabAudioCloudProvider: "deepgram",
        sonioxKey: "sk-test",
        deepgramKey: "",
        elevenLabsKey: "",
      },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const deepgram = Array.from(select().querySelectorAll("option")).find((o) => o.value === "deepgram");
    // FINDING 12 fix: short label form — see the test above.
    expect(deepgram?.textContent).toBe("Deepgram · 未配置");
  });

  it("keeps all third-party provider choices available even when the selected key is missing", async () => {
    useApp.setState((s) => ({
      settings: { ...s.settings, engine: "soniox", sonioxKey: "", deepgramKey: "", elevenLabsKey: "" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const values = Array.from(select().querySelectorAll("option"))
      .map((o) => o.getAttribute("value"))
      .filter((v) => v !== "");
    expect(values).toContain("soniox");
    expect(values).toContain("deepgram");
    expect(values).toContain("elevenlabs");
    expect(select().value).toBe("soniox");
  });

  it("shows configured hints per third-party provider", async () => {
    useApp.setState((s) => ({
      settings: {
        ...s.settings,
        engine: "whisper",
        sonioxKey: "sk-test",
        deepgramKey: "dg-test",
        elevenLabsKey: "el-test",
      },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const labelOf = (value: string) =>
      Array.from(select().querySelectorAll("option")).find((o) => o.getAttribute("value") === value)
        ?.textContent;
    // FINDING 12 fix: short label form — see the earlier test above.
    expect(labelOf("soniox")).toBe("Soniox · 已配置");
    expect(labelOf("deepgram")).toBe("Deepgram · 已配置");
    expect(labelOf("elevenlabs")).toBe("ElevenLabs · 已配置");
    // webspeech has no keyField and isn't in the override map — its own
    // label is already short, unaffected by either fix.
    expect(labelOf("webspeech")).toBe(ENGINE_OPTIONS.find((o) => o.value === "webspeech")!.label);
  });

  // FINDING 10 fix (MEDIUM): tabaudio-cloud has no static keyField of its
  // own (its credential resolves via Settings.tabAudioCloudProvider) — it
  // used to render bare/selectable with zero keys and no hint, unlike
  // every other third-party option in this same optgroup, and it would
  // fail honestly-but-silently at engine start. RED against the pre-fix
  // code (engineOptionLabel returned opt.label verbatim for a null
  // keyField, with no tabaudio-cloud special case): both assertions below
  // would read the bare "标签页音频·云端" label instead.
  it("FINDING 10: gives tabaudio-cloud a derived 已配置/未配置 hint, off whichever provider it would actually run", async () => {
    useApp.setState((s) => ({
      settings: {
        ...s.settings,
        engine: "whisper",
        tabAudioCloudProvider: "soniox",
        sonioxKey: "",
        deepgramKey: "",
        elevenLabsKey: "",
      },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const labelOf = () =>
      Array.from(select().querySelectorAll("option")).find((o) => o.value === "tabaudio-cloud")
        ?.textContent;
    expect(labelOf()).toContain("未配置");

    await act(async () => {
      useApp.setState((s) => ({ settings: { ...s.settings, sonioxKey: "sk-test" } }));
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });
    expect(labelOf()).toContain("已配置");

    // Provider resolved to deepgram: the soniox key set above must NOT
    // mark it configured — only deepgramKey does.
    await act(async () => {
      useApp.setState((s) => ({
        settings: { ...s.settings, tabAudioCloudProvider: "deepgram", deepgramKey: "" },
      }));
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });
    expect(labelOf()).toContain("未配置");

    await act(async () => {
      useApp.setState((s) => ({ settings: { ...s.settings, deepgramKey: "dg-test" } }));
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });
    expect(labelOf()).toContain("已配置");
  });

  it("changing the value writes settings.engine AND back-derives a matching mode (v0.7.4 pairing — the source label follows what the engine actually captures)", async () => {
    useApp.setState((s) => ({
      status: "idle",
      settings: { ...s.settings, engine: "whisper", mode: "tab", sonioxKey: "sk-test" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    await act(async () => {
      select().value = "soniox";
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(useApp.getState().settings.engine).toBe("soniox");
    // modeForPersistedEngine("soniox", …, "web") — the stale "tab" claim
    // can't survive an engine pick (inverse of the FINDING 1 pairing).
    expect(useApp.getState().settings.mode).toBe("mic");
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
    expect(placeholder!.textContent).toBe(ENGINE_SELECT_PLACEHOLDER);
  });

  it("explains that recognizer and source are separate controls", async () => {
    useApp.setState((s) => ({ status: "idle", settings: { ...s.settings, engine: "whisper" } }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(select().title).toBe("选择转录服务；音源随之切换");
  });

  // FINDING 1 fix (BLOCKER): the source dropdown used to write `mode`
  // alone — nothing in lib/stt/useMeeting/any transport reads
  // settings.mode at capture time, the ENGINE decides what's actually
  // recorded, so picking a source without updating the engine left the
  // UI's claim and the actual capture silently diverging. Disabled while
  // isEngineControlBusy (mirrors EngineDropdown's own gate — the source
  // can't be swapped at a moment the engine can't follow either).
  it("disabled while a meeting is connecting/listening (isEngineControlBusy) — mirrors EngineDropdown's own gate", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: { ...s.settings, mode: "mic", engine: "soniox" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const source = container!.querySelector('[data-testid="statusline-audio-source-select"]') as HTMLSelectElement;
    expect(source.disabled).toBe(true);
  });

  it("FINDING 1: changing the source writes a MATCHING engine (mirrors ModeSelector.pickCapture), never just mode", async () => {
    useApp.setState((s) => ({
      status: "idle",
      settings: {
        ...s.settings,
        mode: "mic",
        engine: "soniox",
        tabAudioCloudProvider: "soniox",
        sonioxKey: "",
      },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const source = container!.querySelector('[data-testid="statusline-audio-source-select"]') as HTMLSelectElement;
    expect(source.disabled).toBe(false);
    await act(async () => {
      source.value = "tab";
      source.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(useApp.getState().settings.mode).toBe("tab");
    // deriveEngineForMode("tab", web, {tabAudioCloudProvider:"soniox",
    // sonioxKey:""}) resolves to "tabaudio" (keyless, non-preview — see
    // engineOptions.deriveEngineForMode.test.ts's own "tab — web" cases)
    // — the OLD behavior left this at the stale "soniox" instead.
    expect(useApp.getState().settings.engine).toBe("tabaudio");
  });
});

// ---------------------------------------------------------------
// v0.4.5 AI-status chip (design doc v045-ai-transparency-qc.md Part A,
// owner ruling on Q3: a fuller "检测 · luna ✓" label over a single
// worst-state dot). Always shows the detect agent's resolved model
// short-name + a health glyph; clicking opens the popover hosting the
// full 4-row AiStatusPanel (that panel's own coverage — dot colors,
// zero-config banner, per-row counts — lives in AiStatusPanel.test.tsx,
// not re-pinned here).
// ---------------------------------------------------------------

describe("StatusLine — AI 状态 chip", () => {
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
    useApp.setState((s) => ({ settings: { ...DEFAULT_SETTINGS } }));
    resetLlmTelemetry();
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

  function chip(): HTMLButtonElement {
    const el = container!.querySelector('[data-testid="statusline-ai-status-chip"]');
    if (!el) throw new Error("AI status chip not found");
    return el as HTMLButtonElement;
  }

  it("shows the fuller label — domain + model short-name + neutral glyph — before detect was ever called", async () => {
    useApp.setState((s) => ({
      settings: { ...s.settings, detectModel: "deepseek/deepseek-v4-flash" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toContain(AI_STATUS_CHIP_DOMAIN_LABEL);
    expect(chip().textContent).toContain(shortModelName("deepseek/deepseek-v4-flash"));
    expect(chip().textContent).toContain(AI_STATUS_CHIP_GLYPH.neutral);
  });

  it("switches to the ok glyph once detect has a recorded success this session", async () => {
    recordLlmCall("detect", "ok");
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toContain(AI_STATUS_CHIP_GLYPH.ok);
  });

  it("clicking the chip opens the popover hosting the 4-row AiStatusPanel; clicking again closes it", async () => {
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(container!.querySelector('[data-testid="statusline-ai-status-popover"]')).toBeNull();

    await act(async () => {
      chip().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector('[data-testid="statusline-ai-status-popover"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="ai-status-row-detect"]')).not.toBeNull();

    await act(async () => {
      chip().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector('[data-testid="statusline-ai-status-popover"]')).toBeNull();
  });
});

// ---------------------------------------------------------------
// Translation-rework wave 2: 翻译 status chip — driven by settings.
// bilingualTranscript (whether the live queue is even asked to
// translate) AND store.translateStatus (the queue's own live state; no
// writer yet as of this lane, same "set the derived field directly"
// posture as the 延迟 chip's own sustained-flag tests above).
// ---------------------------------------------------------------

describe("StatusLine — 翻译 status chip", () => {
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
      segments: [],
      translateStatus: { state: "off", pending: 0 },
      settings: { ...s.settings, bilingualTranscript: false },
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

  function chip(): HTMLElement {
    const el = container!.querySelector('[data-testid="statusline-translate-chip"]');
    if (!el) throw new Error("translate chip not found");
    return el as HTMLElement;
  }

  it("hidden while status is idle and no segments are on screen", async () => {
    useApp.setState({ status: "idle", segments: [] });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(container!.querySelector('[data-testid="statusline-translate-chip"]')).toBeNull();
  });

  it("shows once segments exist even while idle (a meeting that just ended)", async () => {
    useApp.setState({
      status: "idle",
      segments: [{ id: "s1", index: 0, startedAt: 0, endedAt: 0, text: "hi", engine: "demo" }],
    });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(container!.querySelector('[data-testid="statusline-translate-chip"]')).not.toBeNull();
  });

  it("bilingualTranscript off renders a clickable 未译 button that flips the setting on", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: { ...s.settings, bilingualTranscript: false },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().tagName).toBe("BUTTON");
    expect(chip().textContent).toBe("未译");

    await act(async () => {
      chip().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.bilingualTranscript).toBe(true);
  });

  it("bilingualTranscript on but translateStatus 'off' — neutral dim chip, no checkmark, not clickable", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: { ...s.settings, bilingualTranscript: true },
      translateStatus: { state: "off", pending: 0 },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().tagName).not.toBe("BUTTON");
    expect(chip().textContent).toContain("翻译");
    expect(chip().textContent).not.toContain("✓");
    expect(chip().className).toContain("text-mut2");
  });

  it("tap-to-enable guard: en->en pair shows a toast and does not enable bilingualTranscript", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: { ...s.settings, bilingualTranscript: false, language: "en-US", explainLanguage: "en" },
      toast: null,
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    await act(async () => {
      chip().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.bilingualTranscript).toBe(false);
    expect(useApp.getState().toast).toBe("解释语言为英文时无需翻译");
  });

  it("tap-to-enable guard: differing pair still enables (unaffected by the guard)", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: { ...s.settings, bilingualTranscript: false, language: "en-US", explainLanguage: "zh" },
      toast: null,
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    await act(async () => {
      chip().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.bilingualTranscript).toBe(true);
    expect(useApp.getState().toast).toBeNull();
  });

  it("busy shows 翻译中… with the pending count", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: { ...s.settings, bilingualTranscript: true },
      translateStatus: { state: "busy", pending: 3 },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toContain("翻译中…");
    expect(chip().textContent).toContain("3");
  });

  it("done shows 翻译 ✓", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: { ...s.settings, bilingualTranscript: true },
      translateStatus: { state: "done", pending: 0 },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toContain("翻译 ✓");
  });

  it("stalled shows 翻译暂停 in amber, title carries the reason", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: { ...s.settings, bilingualTranscript: true },
      translateStatus: { state: "stalled", pending: 2, reason: "DeepL 429" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toContain("翻译暂停");
    expect(chip().className).toContain("text-lab-yellow");
    expect(chip().title).toBe("DeepL 429");
  });
});

// Bit mascot behavior train (chamber B): the always-on status-line perch
// (#mascot-perch / data-slot="mascot", a permanently-mounted PixelDragon)
// is retired entirely — Bit now only appears as ModeSelector's greeting
// and a post-meeting celebration overlay (page.tsx), never in this bar,
// at any status.
describe("StatusLine — no mascot perch (retired)", () => {
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
  });

  function renderStatusLine() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  it.each(["idle", "connecting", "listening", "paused", "stopped"] as const)(
    "renders no #mascot-perch / [data-slot=mascot] while status is %s",
    async (status) => {
      useApp.setState((s) => ({ status, settings: { ...s.settings, engine: "demo" } }));
      renderStatusLine();
      await act(async () => {
        root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
      });
      expect(container!.querySelector("#mascot-perch")).toBeNull();
      expect(container!.querySelector('[data-slot="mascot"]')).toBeNull();
    },
  );
});
