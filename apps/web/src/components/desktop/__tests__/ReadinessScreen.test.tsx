// @vitest-environment jsdom
//
// Out-of-box defaults: the desktop first-run 开始前检查 screen. Same
// createRoot/act pattern as EngineChoiceScreen.test.tsx. Every native
// call goes through the component's injectable props, so a FakeEngine
// stands in for OsSpeechEngine and no Tauri bridge is touched.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SETTINGS, type STTEngine, type STTEvents } from "@jargonslayer/core/types";
import { CH_MIC_SPEAKER, CH_SYS_SPEAKER, useApp } from "@/lib/store";
import * as storageModule from "@/lib/history/storage";
import ReadinessScreen, { type ReadinessScreenProps } from "../ReadinessScreen";

class FakeEngine implements STTEngine {
  readonly kind = "osspeech" as const;
  events: STTEvents | null = null;
  startedWith: unknown = null;
  start = vi.fn(async (events: STTEvents, settings: unknown) => {
    this.events = events;
    this.startedWith = settings;
  });
  stop = vi.fn(async () => {});
}

describe("ReadinessScreen", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let engine: FakeEngine;

  beforeEach(() => {
    engine = new FakeEngine();
    vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "osspeech", mode: "system-audio", bilingualTranscript: false },
      hydrated: true,
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    vi.restoreAllMocks();
    useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false });
  });

  async function renderScreen(overrides: Partial<ReadinessScreenProps> = {}) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const props: ReadinessScreenProps = {
      onDone: vi.fn(),
      createEngine: async () => engine,
      probeTranslate: vi.fn(async () => "installed" as const),
      openPrivacySettings: vi.fn(async () => {}),
      ...overrides,
    };
    await act(async () => {
      root!.render(<ReadinessScreen {...props} />);
    });
    return props;
  }

  const q = (testid: string) => container!.querySelector(`[data-testid="${testid}"]`);
  async function click(testid: string) {
    await act(async () => {
      q(testid)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("跳过 before testing leaves capture settings untouched and exits", async () => {
    const props = await renderScreen();
    await click("btn-readiness-skip");
    expect(props.onDone).toHaveBeenCalledTimes(1);
    expect(engine.start).not.toHaveBeenCalled();
    expect(useApp.getState().settings.mode).toBe("system-audio");
  });

  it("授权并试听 with the recommended card switches on dual capture, then passes once both 我 and 对方 are heard", async () => {
    const props = await renderScreen();
    expect(q("readiness-mode-dual")!.getAttribute("aria-pressed")).toBe("true");

    await click("btn-readiness-start");
    expect(useApp.getState().settings).toMatchObject({ engine: "osspeech", mode: "dual" });
    expect(engine.startedWith).toMatchObject({ engine: "osspeech", mode: "dual" });

    await act(async () => {
      engine.events!.onStatus("listening");
      engine.events!.onInterim("testing one two", undefined, CH_MIC_SPEAKER);
    });
    expect(q("readiness-channel-mic")!.getAttribute("data-heard")).toBe("true");
    expect(q("readiness-channel-system")!.getAttribute("data-heard")).toBe("false");
    expect(container!.textContent).toContain("testing one two");
    expect(q("readiness-passed")).toBeNull();

    await act(async () => {
      engine.events!.onFinal("welcome everyone", { sttSpeaker: CH_SYS_SPEAKER });
    });
    expect(q("readiness-passed")).not.toBeNull();
    expect(engine.stop).toHaveBeenCalled();

    await click("btn-readiness-done");
    expect(props.onDone).toHaveBeenCalledTimes(1);
  });

  it("只听会议声音 tests just the meeting channel and keeps mode system-audio", async () => {
    await renderScreen();
    await click("readiness-mode-system-audio");
    await click("btn-readiness-start");
    expect(useApp.getState().settings.mode).toBe("system-audio");
    expect(q("readiness-channel-mic")).toBeNull();

    await act(async () => {
      engine.events!.onStatus("listening");
      engine.events!.onInterim("meeting audio", undefined, undefined);
    });
    expect(q("readiness-passed")).not.toBeNull();
  });

  it("a permission denial shows the engine's copy plus 打开系统设置, and 重试 starts a fresh session", async () => {
    const props = await renderScreen();
    await click("btn-readiness-start");
    await act(async () => {
      engine.events!.onStatus("error", "JargonSlayer 没有麦克风权限，请前往 设置 → 隐私与安全性 → 麦克风 开启后重试");
    });
    expect(q("readiness-error")!.textContent).toContain("没有麦克风权限");

    await click("btn-readiness-open-privacy");
    expect(props.openPrivacySettings).toHaveBeenCalledTimes(1);

    expect(q("btn-readiness-start")!.textContent).toBe("重试");
    await click("btn-readiness-start");
    expect(engine.start).toHaveBeenCalledTimes(2);
    expect(q("readiness-error")).toBeNull();
  });

  it("unmounting mid-check stops the engine", async () => {
    await renderScreen();
    await click("btn-readiness-start");
    await act(async () => {
      engine.events!.onStatus("listening");
    });
    act(() => root!.unmount());
    root = null;
    expect(engine.stop).toHaveBeenCalled();
  });

  it("translation pack installed: the bilingual toggle is enabled and drives the setting", async () => {
    await renderScreen();
    expect(q("readiness-translate")!.getAttribute("data-status")).toBe("installed");
    const toggle = container!.querySelector('[aria-label="中英双语转录"]') as HTMLElement;
    expect(toggle.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.bilingualTranscript).toBe(true);
  });

  it("translation pack not downloaded: shows the System Settings path; 重新检查 re-probes fresh and turns bilingual on once installed", async () => {
    const probeTranslate = vi
      .fn<(fresh: boolean) => Promise<"installed" | "supported" | "unsupported">>()
      .mockResolvedValueOnce("supported")
      .mockResolvedValueOnce("installed");
    await renderScreen({ probeTranslate });
    expect(probeTranslate).toHaveBeenLastCalledWith(false);
    expect(q("readiness-translate")!.getAttribute("data-status")).toBe("supported");
    expect(q("readiness-translate")!.textContent).toContain("语言与地区 → 翻译语言");
    const toggle = container!.querySelector('[aria-label="中英双语转录"]') as HTMLElement;
    expect(toggle.hasAttribute("disabled")).toBe(true);

    await click("btn-readiness-recheck-translate");
    expect(probeTranslate).toHaveBeenLastCalledWith(true);
    expect(q("readiness-translate")!.getAttribute("data-status")).toBe("installed");
    expect(useApp.getState().settings.bilingualTranscript).toBe(true);
  });
});
