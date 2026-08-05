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
import { RENOTICE_INTERVAL_MS, useAudioLiveness, type AudioChannel } from "../../lib/stt/audioLiveness";
import { ENGINE_OPTIONS, RETENTION_COPY } from "../../lib/stt/engineOptions";
import { ENGINE_CAPABILITIES } from "../../lib/stt/engineCapabilities";
import { recordLlmCall, resetLlmTelemetry } from "../../lib/llm/telemetry";
import { setClientTransportOverride } from "../../lib/llm/llmTransport";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import StatusLine, {
  AI_STATUS_CHIP_DICT_LABEL,
  AI_STATUS_CHIP_DOMAIN_LABEL,
  AI_STATUS_CHIP_GLYPH,
  AI_STATUS_CHIP_UNCONFIGURED_LABEL,
  DETECT_MODE_LABEL,
  ENGINE_SELECT_PLACEHOLDER,
  LOCAL_SIDECAR_LABEL,
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

  // F6 fix round (HIGH): osspeech is desktop-only in THIS build's
  // (ambient web) ENGINE_OPTIONS, but it's still a KNOWN, real engine —
  // a persisted cross-platform value (e.g. settings synced from a
  // desktop install) must resolve its REAL (local) retention off
  // ENGINE_CAPABILITIES, not fall through to the generic
  // cloud-transient "unrecognized engine" default the test above pins.
  it("F6: a stray osspeech engine on web still renders the local/green posture (KNOWN engine, just platform-filtered out of the picker)", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: {
        ...s.settings,
        engine: "osspeech" as unknown as typeof s.settings.engine,
      },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(privacySegment().textContent).toContain("本地处理 · 音频不出设备");
    expect(privacySegment().className).toContain("text-lab-green");
    expect(privacySegment().className).not.toContain("text-warn-soft");
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
    // Miana 2026-08-01: whisper/tabaudio/appaudio are ONE recognizer
    // (the local sidecar) — the picker shows a single 本地模型 sentinel;
    // the 音源 dropdown owns the source axis. Third family renamed
    // 第三方 STT 提供商 -> 云端 STT 服务 (her taxonomy).
    expect(values).toEqual([
      "local-sidecar",
      "webspeech",
      "tabaudio-cloud",
      "soniox",
      "deepgram",
      "elevenlabs",
    ]);
    expect(Array.from(select().querySelectorAll("optgroup")).map((group) => group.label)).toEqual([
      "本地 STT 模型",
      "系统 STT 服务",
      "云端 STT 服务",
    ]);
    // The sentinel is SELECTED when the persisted engine is any
    // sidecar-family kind (engine:"whisper" was set above).
    expect(select().value).toBe("local-sidecar");
  });

  it("picking 本地模型 resolves to the sidecar kind serving the CURRENT source (tab -> tabaudio, mic -> whisper)", async () => {
    useApp.setState((s) => ({
      status: "idle",
      settings: { ...s.settings, engine: "tabaudio-cloud", mode: "tab", sonioxKey: "sk-test" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    await act(async () => {
      select().value = "local-sidecar";
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Sticky to the tab source: sidecar's tab lane, NOT whisper+mic —
    // and mode stays "tab" (modeForPersistedEngine(tabaudio) = tab).
    expect(useApp.getState().settings.engine).toBe("tabaudio");
    expect(useApp.getState().settings.mode).toBe("tab");

    await act(async () => {
      const source = container!.querySelector(
        '[data-testid="statusline-audio-source-select"]',
      ) as HTMLSelectElement;
      source.value = "mic";
      source.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Source flip keeps the recognizer: tabaudio -> whisper, never a
    // silent swap to webspeech (recognizer stickiness).
    expect(useApp.getState().settings.engine).toBe("whisper");
    expect(useApp.getState().settings.mode).toBe("mic");
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

  // TASK 5 root cause (value/option mismatch): a persisted engine value
  // this build's platform-filtered picker carries no <option> for at all
  // (e.g. "osspeech" — desktop-only, surviving into a plain web session)
  // used to fall through to a native <select>'s own "auto-select the
  // first enabled option" default (本地模型) instead of showing nothing —
  // silently misrepresenting an unrelated/unavailable engine as the
  // local sidecar. Mutation-checked: reverting `unmapped`/`unmappedLabel`
  // back to the old `engine === "demo" || engine === "import"` check
  // makes this fail (select().value would read "local-sidecar" instead
  // of "", and the placeholder text would read 本地模型 rather than
  // 系统识别).
  it("TASK 5: an engine value with no <option> in THIS build's picker shows that engine's OWN name as a disabled placeholder, not a misleading fallback to 本地模型", async () => {
    useApp.setState((s) => ({
      status: "idle",
      settings: { ...s.settings, engine: "osspeech" as unknown as typeof s.settings.engine, mode: "mic" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(select().value).toBe("");
    const placeholder = Array.from(select().querySelectorAll("option")).find((o) => o.value === "");
    expect(placeholder).toBeDefined();
    expect(placeholder!.disabled).toBe(true);
    expect(placeholder!.textContent).toBe(ENGINE_CAPABILITIES.osspeech.label);
    expect(placeholder!.textContent).not.toBe(LOCAL_SIDECAR_LABEL);
  });

  // F5 fix round (HIGH): below-sm row-width budget — see the comment
  // above StatusLine's own return for the worst-case pixel accounting
  // these two specific values were chosen against. ≥sm stays unchanged
  // (sm:max-w-[12rem] on both, untouched by this fix).
  it("F5: below sm the two selects carry their asymmetric width caps (音源 7rem, 引擎 8.5rem), unchanged at sm+", async () => {
    useApp.setState((s) => ({ status: "idle", settings: { ...s.settings, engine: "whisper" } }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const audioSource = container!.querySelector(
      '[data-testid="statusline-audio-source-select"]',
    ) as HTMLSelectElement;
    expect(audioSource.className).toContain("max-w-[7rem]");
    expect(audioSource.className).toContain("sm:max-w-[12rem]");
    expect(select().className).toContain("max-w-[8.5rem]");
    expect(select().className).toContain("sm:max-w-[12rem]");
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
    useApp.setState((s) => ({ detectMode: "llm", settings: { ...DEFAULT_SETTINGS } }));
    resetLlmTelemetry();
    setClientTransportOverride(null);
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

  it("shows the fuller label — domain + model short-name + neutral glyph — before detect was ever called (llm mode, key configured)", async () => {
    useApp.setState((s) => ({
      detectMode: "llm",
      settings: { ...s.settings, detectModel: "deepseek/deepseek-v4-flash", apiKeyOpenrouter: "sk-test" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toContain(AI_STATUS_CHIP_DOMAIN_LABEL);
    expect(chip().textContent).toContain(shortModelName("deepseek/deepseek-v4-flash"));
    expect(chip().textContent).toContain(AI_STATUS_CHIP_GLYPH.neutral);
    expect(chip().className).not.toContain("text-warn-soft");
  });

  // TASK 1 (TRUTH — the chip shows what's RUNNING, not what's merely
  // configured): dictionary mode never calls the configured model at
  // all, regardless of detectModel/apiKey — a stale "检测 · deepseek-v4-
  // flash" label while nothing but the dictionary floor is running is
  // exactly the bug this fixes. Mutation-checked: reverting AiStatusChip's
  // runningLabel back to always reading `model` makes this fail (it would
  // read "deepseek-v4-flash" instead of 词典).
  it("TASK 1: dictionary mode shows 词典, never the configured model name — even with a key configured", async () => {
    useApp.setState((s) => ({
      detectMode: "dictionary",
      settings: { ...s.settings, detectModel: "deepseek/deepseek-v4-flash", apiKeyOpenrouter: "sk-test" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toContain(AI_STATUS_CHIP_DOMAIN_LABEL);
    expect(chip().textContent).toContain(AI_STATUS_CHIP_DICT_LABEL);
    expect(chip().textContent).not.toContain("deepseek-v4-flash");
    expect(chip().className).not.toContain("text-warn-soft");
  });

  // F2 fix round (HIGH): 未配置 used to key on resolved.apiKey ALONE —
  // but on the Next.js transport path (the ambient test env here: full-
  // tier web, no client-transport override) the SERVER may hold its own
  // funded key, so a missing CLIENT key doesn't prove the call fails.
  // Mutation-checked intent: reverting AiStatusChip back to
  // `resolved.apiKey ? model : UNCONFIGURED_LABEL` makes this fail (it
  // would show 未配置 here instead of the model name).
  it("F2: llm mode with no CLIENT key, but the Next.js path would serve (full-tier web, server may be funded) — shows the model name, not 未配置", async () => {
    useApp.setState((s) => ({
      detectMode: "llm",
      settings: { ...s.settings, detectModel: "deepseek/deepseek-v4-flash", apiKeyOpenrouter: "" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toContain(shortModelName("deepseek/deepseek-v4-flash"));
    expect(chip().textContent).not.toContain(AI_STATUS_CHIP_UNCONFIGURED_LABEL);
    expect(chip().className).not.toContain("text-warn-soft");
    // Clicking still opens the existing explain popover (unaffected by
    // the label truth fix).
    await act(async () => {
      chip().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector('[data-testid="statusline-ai-status-popover"]')).not.toBeNull();
  });

  // F2: the ONE case a missing client key genuinely dooms the request —
  // desktop (llmTransport.ts's client-transport flag on), which has no
  // /api/* server to fall back to at all. setClientTransportOverride is
  // the same test-only override useDirectTransport's own test suite
  // uses (useDirectTransport.test.ts) to simulate this without a real
  // Tauri build.
  it("F2: llm mode with no client key AND the direct client transport (desktop) — still shows 未配置, this request truly can't succeed", async () => {
    setClientTransportOverride(true);
    useApp.setState((s) => ({
      detectMode: "llm",
      settings: { ...s.settings, detectModel: "deepseek/deepseek-v4-flash", apiKeyOpenrouter: "" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toContain(AI_STATUS_CHIP_UNCONFIGURED_LABEL);
    expect(chip().textContent).not.toContain("deepseek-v4-flash");
    expect(chip().className).toContain("text-warn-soft");
  });

  it("TASK 1: detectMode 'off' shows 关闭, matching the non-interactive detect-mode label beside it", async () => {
    useApp.setState((s) => ({
      detectMode: "off",
      settings: { ...s.settings, detectModel: "deepseek/deepseek-v4-flash", apiKeyOpenrouter: "sk-test" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toContain(DETECT_MODE_LABEL.off);
    expect(chip().textContent).not.toContain("deepseek-v4-flash");
  });

  it("switches to the ok glyph once detect has a recorded success this session", async () => {
    recordLlmCall("detect", "ok");
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toContain(AI_STATUS_CHIP_GLYPH.ok);
  });

  // F10 fix round (MEDIUM): the ✓/✗ telemetry glyph used to render
  // regardless of runningLabel — a failure recorded while llm mode was
  // active stayed "✗" even after switching to 词典 mode, which never
  // calls the model at all (misread as "dictionary mode is failing").
  // Mutation-checked intent: reverting the glyph gate back to "always
  // AI_STATUS_CHIP_GLYPH[health]" makes this fail (chip would still
  // show 词典 ✗).
  it("F10: switching to dictionary mode after a recorded llm failure drops the ✗ glyph — 词典 renders bare", async () => {
    recordLlmCall("detect", { kind: "upstream" });
    useApp.setState({ detectMode: "dictionary" });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toContain(AI_STATUS_CHIP_DICT_LABEL);
    expect(chip().textContent).not.toContain(AI_STATUS_CHIP_GLYPH.fail);
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
    // text-mut, not text-mut2: the law (DESIGN.md) forbids mut2 on zh words.
    expect(chip().className).toContain("text-mut ");
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

  // FT-11 fix: "dead" — same amber structure as 翻译暂停 above (this app's
  // flat-design law invents no new visual vocabulary), but distinct
  // copy/testid-carried state so a field session isn't left reading a
  // silently-dead lane as merely "paused". The STICKINESS itself (a
  // later retry never flips this back to busy) is queue.ts's own
  // emitState() contract — covered in queue.test.ts — this component
  // just renders whatever state it's handed; this test's second render
  // pins that a subsequent "dead" emission (what a real retry actually
  // produces, per that contract) renders identically, not a fresh
  // "busy" flash in between.
  it("dead shows 翻译失败 in amber, title carries the reason, and stays put across a later retry (another 'dead' emission, not busy)", async () => {
    useApp.setState((s) => ({
      status: "listening",
      settings: { ...s.settings, bilingualTranscript: true },
      translateStatus: { state: "dead", pending: 0, reason: "系统翻译不可用，双语转录已暂停。可在设置中切换回 AI 模型翻译" },
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toContain("翻译失败");
    expect(chip().className).toContain("text-lab-yellow");
    expect(chip().title).toBe("系统翻译不可用，双语转录已暂停。可在设置中切换回 AI 模型翻译");

    useApp.setState({ translateStatus: { state: "dead", pending: 1, reason: undefined } });
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });
    expect(chip().textContent).toContain("翻译失败");
  });
});

// ---------------------------------------------------------------
// TASK 3 — mode block never truncates (root cause: this span was the
// one leading status chip in the row without shrink-0; AudioSource
// Dropdown/EngineDropdown already carry it defensively — see StatusLine
// .tsx's own TASK 3 comment on the mode-block span). jsdom does no
// layout, so the honest pin for the fix itself is the class (same
// posture Header.ios.test.tsx's own w-full row pin already documents);
// the short/full TOKEN CONTENT for every status is real DOM content and
// is asserted directly.
// ---------------------------------------------------------------

describe("StatusLine — mode block (task 3: no mid-token clipping, role=status)", () => {
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

  function modeBlock(): HTMLElement {
    const el = container!.querySelector('[role="status"]');
    if (!el) throw new Error("mode block (role=status) not found");
    return el as HTMLElement;
  }

  // Mutation-checked: reverting the `shrink-0` class (StatusLine.tsx's
  // own TASK 3 fix) makes this fail.
  it("carries shrink-0 — the root-cause fix — so it can never be squeezed by a crowded <sm row", async () => {
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(modeBlock().className.split(/\s+/)).toContain("shrink-0");
  });

  it("carries role=status (exactly one in the whole bar) so a screen reader announces status transitions", async () => {
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(container!.querySelectorAll('[role="status"]').length).toBe(1);
  });

  it.each([
    ["listening", "--LIVE--", "-- LISTENING --"],
    ["paused", "--PAUS--", "-- PAUSED --"],
    ["stopped", "--STOP--", "-- STOPPED --"],
    ["connecting", "--CONN--", "-- CONNECTING --"],
    ["idle", "--IDLE--", "-- IDLE --"],
  ] as const)(
    "status %s renders the WHOLE short token (%s) below sm and the WHOLE full-form token (%s) at sm+ — never a truncated fragment of either",
    async (status, short, full) => {
      useApp.setState((s) => ({ status, settings: { ...s.settings, engine: "demo" } }));
      renderStatusLine();
      await act(async () => {
        root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
      });

      const [fullSpan, shortSpan] = Array.from(modeBlock().children) as HTMLElement[];
      expect(fullSpan.textContent).toBe(full);
      expect(shortSpan.textContent).toBe(short);
    },
  );
});

// ---------------------------------------------------------------
// TASK 2 — privacy visible at every breakpoint. The full sentence
// (privacyCopy.hint) stays `hidden sm:inline`, unchanged — this compact
// chip is its <sm replacement, reusing the SAME retentionClass the
// sentence and Header's EnginePostureChip both resolve, collapsed to
// derivePosture's binary local/cloud.
// ---------------------------------------------------------------

describe("StatusLine — privacy posture chip (task 2: never fully hidden)", () => {
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
    const el = container!.querySelector('[data-testid="statusline-privacy-chip"]');
    if (!el) throw new Error("privacy chip not found");
    return el as HTMLElement;
  }

  // Mutation-checked: reverting PrivacyPostureChip's className back to a
  // bare `hidden sm:inline` (matching the sentence it replaces) instead
  // of `sm:hidden` makes this fail — the chip would then be hidden at
  // EVERY breakpoint (never shown below sm, exactly the bug task 2
  // fixes), not just paired-complementary with the sentence.
  it("carries sm:hidden (visible below sm, paired with the sentence's own hidden sm:inline) — never a bare `hidden`", async () => {
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const classes = chip().className.split(/\s+/);
    expect(classes).toContain("sm:hidden");
    expect(classes).not.toContain("hidden");
  });

  it("shows 本地 in lab-green for a local engine, full sentence as aria-label + title", async () => {
    useApp.setState((s) => ({ status: "idle", settings: { ...s.settings, engine: "whisper" } }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toBe(RETENTION_COPY.local.label);
    expect(chip().className).toContain("text-lab-green");
    expect(chip().getAttribute("aria-label")).toBe("本地处理 · 音频不出设备");
    expect(chip().title).toBe("本地处理 · 音频不出设备");
  });

  // F7 fix round (MEDIUM): this used to collapse to the binary 云端
  // posture — now renders the full tri-state RETENTION_COPY label, same
  // table the wider sentence right next to it (hidden below sm) reads.
  it("F7: shows the tri-state 云端·不留存 label (not the collapsed 云端) for a cloud-transient engine (soniox)", async () => {
    useApp.setState((s) => ({ status: "idle", settings: { ...s.settings, engine: "soniox" } }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toBe(RETENTION_COPY["cloud-transient"].label);
    expect(chip().className).toContain("text-warn-soft");
  });

  // F7 fix round (MEDIUM): the bug this fixes — ElevenLabs (cloud-
  // stored, 可能留存) used to collapse to the SAME "云端" text a
  // cloud-transient engine shows, losing its stronger warning exactly
  // where a BYOK phone user is most likely to be looking. Mutation-
  // checked intent: reverting PrivacyPostureChip back to
  // POSTURE_LABEL[derivePosture(...)] makes this fail (textContent
  // would read the collapsed "云端" instead).
  it("F7: shows the distinct 云端·可能留存 label for a cloud-stored engine (elevenlabs) — no longer collapsed with cloud-transient", async () => {
    useApp.setState((s) => ({ status: "idle", settings: { ...s.settings, engine: "elevenlabs" } }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip().textContent).toBe(RETENTION_COPY["cloud-stored"].label);
    expect(chip().textContent).not.toBe(RETENTION_COPY["cloud-transient"].label);
    expect(chip().className).toContain("text-warn-soft");
  });
});

// ---------------------------------------------------------------
// Lane W (mid-session STT liveness watchdog + per-channel silence hint):
// LivenessChip's OWN rendering — audioLiveness.ts's verdict logic itself
// is audioLiveness.test.ts's job; this only pins the chip's gating/
// styling/testid contract, mirroring the 延迟 chip's own test shape
// above and 翻译失败's dual-surface (sm:flex group + overflow popover)
// coverage below.
// ---------------------------------------------------------------

describe("StatusLine — liveness chip (Lane W)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const EMPTY_VERDICTS = {
    watchdogChannels: [] as AudioChannel[],
    statsStale: false,
    silentChannels: [] as AudioChannel[],
  };

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    useApp.setState((s) => ({ status: "idle", toast: null, settings: { ...s.settings, engine: "demo" } }));
    useAudioLiveness.setState({ armed: false, verdicts: EMPTY_VERDICTS });
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
    return container!.querySelector('[data-testid="statusline-liveness-chip"]');
  }

  it("hidden by default — unarmed, no verdict active", async () => {
    useApp.setState({ status: "listening" });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip()).toBeNull();
  });

  it("hidden while armed but no verdict is active", async () => {
    useApp.setState({ status: "listening" });
    useAudioLiveness.setState({ armed: true, verdicts: EMPTY_VERDICTS });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip()).toBeNull();
  });

  it("hidden while not listening (e.g. paused), even with an active watchdog verdict", async () => {
    useApp.setState({ status: "paused" });
    useAudioLiveness.setState({
      armed: true,
      verdicts: { ...EMPTY_VERDICTS, watchdogChannels: ["default"] },
    });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip()).toBeNull();
  });

  it("watchdog verdict: warning styling, 转写停滞 label, title names the channel", async () => {
    useApp.setState({ status: "listening" });
    useAudioLiveness.setState({
      armed: true,
      verdicts: { ...EMPTY_VERDICTS, watchdogChannels: ["system"] },
    });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip()).not.toBeNull();
    expect(chip()!.textContent).toBe("转写停滞");
    expect(chip()!.className).toContain("text-lab-yellow");
    expect(chip()!.getAttribute("title")).toContain("对方声道");
  });

  it("statsStale verdict: also warning styling/label, distinct pipeline-stalled title", async () => {
    useApp.setState({ status: "listening" });
    useAudioLiveness.setState({ armed: true, verdicts: { ...EMPTY_VERDICTS, statsStale: true } });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip()!.textContent).toBe("转写停滞");
    expect(chip()!.className).toContain("text-lab-yellow");
    expect(chip()!.getAttribute("title")).toBe("音频统计中断，转写管线可能已停止");
  });

  it("silentChannel verdict (info-only): neutral/muted styling, 单路无声 label — never reads as a warning", async () => {
    useApp.setState({ status: "listening" });
    useAudioLiveness.setState({
      armed: true,
      verdicts: { ...EMPTY_VERDICTS, silentChannels: ["mic"] },
    });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip()!.textContent).toBe("单路无声");
    expect(chip()!.className).not.toContain("text-lab-yellow");
    expect(chip()!.className).toContain("text-mut");
    expect(chip()!.getAttribute("title")).toContain("我方声道");
  });

  it("severity: a warning verdict wins over a simultaneously-active info verdict", async () => {
    useApp.setState({ status: "listening" });
    useAudioLiveness.setState({
      armed: true,
      verdicts: { watchdogChannels: ["default"], statsStale: false, silentChannels: ["mic"] },
    });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(chip()!.textContent).toBe("转写停滞");
    expect(chip()!.className).toContain("text-lab-yellow");
  });

  it("appears in OverflowChip's popover too — MUST NOT vanish below sm", async () => {
    useApp.setState({ status: "listening" });
    useAudioLiveness.setState({
      armed: true,
      verdicts: { ...EMPTY_VERDICTS, statsStale: true },
    });
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    const overflowChip = container!.querySelector(
      '[data-testid="statusline-overflow-chip"]',
    ) as HTMLButtonElement;
    await act(async () => {
      overflowChip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const popover = container!.querySelector('[data-testid="statusline-overflow-popover"]');
    expect(popover).not.toBeNull();
    expect(popover!.querySelector('[data-testid="statusline-liveness-chip"]')).not.toBeNull();
  });

  it("one-shot notice: toast fires once on activation, re-arms only after RENOTICE_INTERVAL_MS while still active, resets immediately on recovery", async () => {
    vi.useFakeTimers();
    try {
      useApp.setState({ status: "listening", toast: null });
      renderStatusLine();
      await act(async () => {
        root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
      });

      await act(async () => {
        useAudioLiveness.setState({ armed: true, verdicts: { ...EMPTY_VERDICTS, statsStale: true } });
      });
      expect(useApp.getState().toast).toContain("转写疑似停滞");

      // Same still-active verdict, identity-STABLE (Fix E: computeVerdicts
      // returns prev by reference for an unchanged verdict) — so the
      // effect's only re-run driver is the sentinel's noticeTick
      // heartbeat, which is exactly what production provides. Well before
      // RENOTICE_INTERVAL_MS — must NOT re-fire yet.
      useApp.setState({ toast: null });
      await act(async () => {
        vi.advanceTimersByTime(RENOTICE_INTERVAL_MS - 1000);
        useAudioLiveness.setState((s) => ({ noticeTick: s.noticeTick + 1 }));
      });
      expect(useApp.getState().toast).toBeNull();

      // Crossing RENOTICE_INTERVAL_MS while STILL active re-arms it —
      // again via the heartbeat alone, the verdicts object untouched.
      await act(async () => {
        vi.advanceTimersByTime(1001);
        useAudioLiveness.setState((s) => ({ noticeTick: s.noticeTick + 1 }));
      });
      expect(useApp.getState().toast).toContain("转写疑似停滞");

      // Recovery (verdict clears) resets the one-shot guard — a LATER
      // activation fires immediately, without waiting out another full
      // RENOTICE_INTERVAL_MS.
      useApp.setState({ toast: null });
      await act(async () => {
        useAudioLiveness.setState({ armed: true, verdicts: EMPTY_VERDICTS });
      });
      await act(async () => {
        vi.advanceTimersByTime(1000); // well under RENOTICE_INTERVAL_MS
        useAudioLiveness.setState({ verdicts: { ...EMPTY_VERDICTS, statsStale: true } });
      });
      expect(useApp.getState().toast).toContain("转写疑似停滞");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------
// TASK 4 — D2 fold (<sm only; ≥sm stays exactly as before the fold).
// DetectModeChip + AiStatusChip + TranslateStatusChip collapse into one
// overflow chip below sm; the popover reuses the SAME three components,
// not a forked copy.
// ---------------------------------------------------------------

describe("StatusLine — D2 fold: overflow chip (task 4)", () => {
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
      detectMode: "llm",
      settings: { ...s.settings, engine: "demo" },
    }));
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

  function overflowChip(): HTMLButtonElement {
    const el = container!.querySelector('[data-testid="statusline-overflow-chip"]');
    if (!el) throw new Error("overflow chip not found");
    return el as HTMLButtonElement;
  }

  function detectGroup(): HTMLElement {
    const el = container!.querySelector('[data-testid="statusline-detect-group"]');
    if (!el) throw new Error("detect group not found");
    return el as HTMLElement;
  }

  // Mutation-checked: reverting OverflowChip's wrapping className from
  // `sm:hidden` to `hidden sm:flex` (or removing it) makes the first
  // assertion fail; reverting the detect-group's own `hidden sm:flex`
  // back to no responsive classes makes the second fail.
  it("fold visibility at <sm: overflow chip's own class shows it below sm (sm:hidden), the sm+ inline group's own class hides it below sm (hidden sm:flex) — individual chips never independently show below sm", async () => {
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(overflowChip()).not.toBeNull();
    const overflowRootClasses = overflowChip().parentElement!.className.split(/\s+/);
    expect(overflowRootClasses).toContain("sm:hidden");

    const groupClasses = detectGroup().className.split(/\s+/);
    expect(groupClasses).toContain("hidden");
    expect(groupClasses).toContain("sm:flex");
  });

  it("≥sm group renders the exact same three chips as before the fold, byte-identical testids", async () => {
    useApp.setState((s) => ({
      status: "listening",
      segments: [{ id: "s1", index: 0, startedAt: 0, endedAt: 0, text: "hi", engine: "demo" }],
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(detectGroup().querySelector('[data-testid="statusline-detect-toggle"]')).not.toBeNull();
    expect(detectGroup().querySelector('[data-testid="statusline-ai-status-chip"]')).not.toBeNull();
    expect(detectGroup().querySelector('[data-testid="statusline-translate-chip"]')).not.toBeNull();
  });

  it("tapping the overflow chip opens a popover stacking the same three chips (reused components, not forked copies); tapping again closes it", async () => {
    useApp.setState((s) => ({
      status: "listening",
      segments: [{ id: "s1", index: 0, startedAt: 0, endedAt: 0, text: "hi", engine: "demo" }],
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    expect(container!.querySelector('[data-testid="statusline-overflow-popover"]')).toBeNull();

    await act(async () => {
      overflowChip().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const popover = container!.querySelector('[data-testid="statusline-overflow-popover"]');
    expect(popover).not.toBeNull();
    expect(popover!.querySelector('[data-testid="statusline-detect-toggle"]')).not.toBeNull();
    expect(popover!.querySelector('[data-testid="statusline-ai-status-chip"]')).not.toBeNull();
    expect(popover!.querySelector('[data-testid="statusline-translate-chip"]')).not.toBeNull();

    await act(async () => {
      overflowChip().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector('[data-testid="statusline-overflow-popover"]')).toBeNull();
  });

  // F4 fix round (HIGH): before this, both popovers installed their own
  // unconditional document Escape listener — one Escape press closed
  // BOTH the overflow popover AND the nested AI-status popover at once.
  // Now stack-aware (a11y.ts's module-level overlay stack): the first
  // Escape closes only the top-of-stack (nested) AI panel, the second
  // closes the overflow popover underneath it. The nested panel also
  // drops aria-modal (F4: role=dialog stays, non-modal once stacked).
  it("F4: Escape closes only the nested AI-status popover first, then the overflow popover on a second Escape", async () => {
    useApp.setState((s) => ({
      status: "listening",
      segments: [{ id: "s1", index: 0, startedAt: 0, endedAt: 0, text: "hi", engine: "demo" }],
    }));
    renderStatusLine();
    await act(async () => {
      root!.render(<StatusLine onOpenTaskCenter={() => {}} />);
    });

    await act(async () => {
      overflowChip().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const popover = container!.querySelector('[data-testid="statusline-overflow-popover"]');
    expect(popover).not.toBeNull();

    const aiChipInsidePopover = popover!.querySelector(
      '[data-testid="statusline-ai-status-chip"]',
    ) as HTMLButtonElement;
    await act(async () => {
      aiChipInsidePopover.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const aiPopover = container!.querySelector('[data-testid="statusline-ai-status-popover"]');
    expect(aiPopover).not.toBeNull();
    expect(aiPopover!.getAttribute("role")).toBe("dialog");
    expect(aiPopover!.hasAttribute("aria-modal")).toBe(false);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container!.querySelector('[data-testid="statusline-ai-status-popover"]')).toBeNull();
    expect(container!.querySelector('[data-testid="statusline-overflow-popover"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container!.querySelector('[data-testid="statusline-overflow-popover"]')).toBeNull();
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
