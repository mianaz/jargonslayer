// @vitest-environment jsdom
//
// S11 osspeech blueprint (§3 Worker D) — EngineChoiceScreen render +
// selection + 继续 routing. Mirrors DesktopWizard.render.test.tsx's own
// createRoot/act pattern (no @testing-library/react in this repo's test
// stack). Purely presentational (this component's own header comment) —
// every assertion drives the REAL component with plain vi.fn() callback
// props, zero mocking needed (no cross-worker imports in this file at
// all).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import EngineChoiceScreen from "../EngineChoiceScreen";

describe("EngineChoiceScreen", () => {
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

  async function renderScreen(onChooseOsSpeech = vi.fn(), onChooseWhisper = vi.fn()) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<EngineChoiceScreen onChooseOsSpeech={onChooseOsSpeech} onChooseWhisper={onChooseWhisper} />);
    });
    return { onChooseOsSpeech, onChooseWhisper };
  }

  it("renders both cards with 系统识别 pre-selected (Miana-veto #1), 继续 with no changes calls onChooseOsSpeech", async () => {
    const { onChooseOsSpeech, onChooseWhisper } = await renderScreen();

    const osspeechCard = container!.querySelector('[data-testid="engine-choice-card-osspeech"]')!;
    const whisperCard = container!.querySelector('[data-testid="engine-choice-card-whisper"]')!;
    expect(osspeechCard.getAttribute("aria-pressed")).toBe("true");
    expect(whisperCard.getAttribute("aria-pressed")).toBe("false");

    // both cards' own copy renders (pinned per the blueprint's §3 Worker D copy).
    expect(osspeechCard.textContent).toContain("系统识别 · 开箱即用");
    expect(osspeechCard.textContent).toContain("无需配置");
    expect(osspeechCard.textContent).toContain("无需下载");
    expect(osspeechCard.textContent).toContain("macOS 原生识别");
    expect(osspeechCard.textContent).toContain("音频不离开本机");
    expect(whisperCard.textContent).toContain("Whisper · 更高质量");
    expect(whisperCard.textContent).toContain("支持说话人分离");
    expect(whisperCard.textContent).toContain("多语混合更强");
    expect(whisperCard.textContent).toContain("需下载模型（约 1.5GB）");

    await act(async () => {
      container!.querySelector('[data-testid="btn-engine-choice-continue"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(onChooseOsSpeech).toHaveBeenCalledTimes(1);
    expect(onChooseWhisper).not.toHaveBeenCalled();
  });

  it("selecting the Whisper card then 继续 calls onChooseWhisper, not onChooseOsSpeech", async () => {
    const { onChooseOsSpeech, onChooseWhisper } = await renderScreen();

    await act(async () => {
      container!.querySelector('[data-testid="engine-choice-card-whisper"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(container!.querySelector('[data-testid="engine-choice-card-whisper"]')!.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(container!.querySelector('[data-testid="engine-choice-card-osspeech"]')!.getAttribute("aria-pressed")).toBe(
      "false",
    );

    await act(async () => {
      container!.querySelector('[data-testid="btn-engine-choice-continue"]')!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(onChooseWhisper).toHaveBeenCalledTimes(1);
    expect(onChooseOsSpeech).not.toHaveBeenCalled();
  });
});
