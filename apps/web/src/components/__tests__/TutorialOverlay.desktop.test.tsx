// @vitest-environment jsdom
//
// TutorialOverlay — desktop-only coverage (Miana 2026-08-01 taxonomy
// fix). IS_DESKTOP is a module-scope import-time const — vi.mock
// affects this whole file, so this lives in its own file rather than a
// describe block inside TutorialOverlay.test.tsx (ambient web coverage,
// IS_DESKTOP false there) or TutorialOverlay.ios.test.tsx (IS_IOS true),
// mirroring the exact split those two files already established.
//
// Before this fix, the desktop build reused the WEB branch's three-card
// list (webspeech + whisper + appaudio) verbatim — webspeech can NEVER
// work inside Tauri's WKWebView (no SpeechRecognition API), so this
// suite pins the corrected two-card desktop list instead: osspeech
// (系统识别, zero-config default) first, then ONE local-sidecar card
// (本地模型) standing in for whisper/appaudio — same recognizer, mic vs
// system-audio source, resolved via the plain "whisper" (mic) engine
// since this first-run picker has no live `mode` to resolve against.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/desktop", () => ({ IS_DESKTOP: true }));

import { useApp } from "@/lib/store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import TutorialOverlay from "../TutorialOverlay";

function resetStore() {
  useApp.setState({ settings: DEFAULT_SETTINGS });
}

describe("TutorialOverlay — desktop engine picker (Miana 2026-08-01 taxonomy fix)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root!.unmount());
    container!.remove();
    container = null;
    root = null;
    resetStore();
  });

  async function openEnginePickerStep() {
    await act(async () => {
      root!.render(<TutorialOverlay open={true} onClose={() => {}} />);
    });
    const nextButton = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "下一步",
    )!;
    await act(async () => {
      nextButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function findCard(labelSubstring: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(labelSubstring),
    );
    if (!btn) throw new Error(`card containing "${labelSubstring}" not found`);
    return btn as HTMLButtonElement;
  }

  // F1 fix round (BLOCKER): desktop's default engines (osspeech,
  // whisper) genuinely ARE local, so this build keeps the stronger
  // step-1 claim — only web/iOS (whose defaults/step-2 offers can be
  // cloud) get the capability-phrased copy instead.
  it("F1: keeps the unconditional 全程本地 claim on step 1 (default engines are actually local here)", async () => {
    await act(async () => {
      root!.render(<TutorialOverlay open={true} onClose={() => {}} />);
    });
    expect(container!.textContent).toContain("你的双语会议引擎，全程本地");
    expect(container!.textContent).toContain("私有 · 全本地 · 双语。听英文、看中文解释，会议内容留在你的设备。");
  });

  it("offers osspeech + 本地模型 only — no webspeech/浏览器识别/系统 App 音频 card", async () => {
    await openEnginePickerStep();

    const cardLabels = Array.from(container!.querySelectorAll("button")).map((b) => b.textContent);
    expect(cardLabels.some((t) => t?.includes("系统识别"))).toBe(true);
    expect(cardLabels.some((t) => t?.includes("本地模型"))).toBe(true);
    expect(cardLabels.some((t) => t?.includes("浏览器识别"))).toBe(false);
    expect(cardLabels.some((t) => t?.includes("系统/App 音频"))).toBe(false);
    // Exactly two cards on the desktop grid.
    expect(container!.querySelectorAll(".mt-3.grid button").length).toBe(2);
  });

  it("picking 系统识别 (osspeech) writes mode:system-audio — desktop osspeech is a system-audio tap, not mic", async () => {
    await openEnginePickerStep();
    await act(async () => {
      findCard("系统识别").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.engine).toBe("osspeech");
    expect(useApp.getState().settings.mode).toBe("system-audio");
  });

  it("picking 本地模型 (whisper) writes mode:mic", async () => {
    await openEnginePickerStep();
    await act(async () => {
      findCard("本地模型").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.engine).toBe("whisper");
    expect(useApp.getState().settings.mode).toBe("mic");
  });
});
