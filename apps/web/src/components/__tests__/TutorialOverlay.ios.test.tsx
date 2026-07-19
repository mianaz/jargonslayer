// @vitest-environment jsdom
//
// TutorialOverlay — iOS-only coverage (S13, docs/design-explorations/
// s13-ios-blueprint.md, §6 Sol F5). IS_IOS is a module-scope import-time
// const, so this needs its own file/vi.mock, mirroring engineOptions.
// desktop.test.ts's own split for the identical constraint. Verified
// (worker report, see task): this overlay mounts unconditionally from
// app/page.tsx regardless of platform — no IS_DESKTOP-style first-run
// wizard supersedes it on a Tauri shell, so it's iOS's own first-run
// onboarding too, and touches zero `@tauri-apps/*`/tauriApi surface
// (no mocking needed beyond the platform flag itself, unlike
// SettingsDialog's own elaborate desktop-build mock set).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true }));

import { useApp } from "@/lib/store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import TutorialOverlay from "../TutorialOverlay";

function resetStore() {
  useApp.setState({ settings: DEFAULT_SETTINGS });
}

describe("TutorialOverlay — iOS engine picker (S13 §6 Sol F5)", () => {
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

  it("step 2's engine grid offers osspeech ONLY — no webspeech/whisper/tabaudio/appaudio card", async () => {
    await act(async () => {
      root!.render(<TutorialOverlay open={true} onClose={() => {}} />);
    });
    // Step 0 is the landing step — advance to step 1 (engine picker).
    const nextButton = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === "下一步")!;
    await act(async () => {
      nextButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const cardLabels = Array.from(container!.querySelectorAll("button")).map((b) => b.textContent);
    expect(cardLabels.some((t) => t?.includes("系统识别"))).toBe(true);
    expect(cardLabels.some((t) => t?.includes("浏览器识别"))).toBe(false);
    expect(cardLabels.some((t) => t?.includes("本地 Whisper"))).toBe(false);
    expect(cardLabels.some((t) => t?.includes("标签页音频"))).toBe(false);
    expect(cardLabels.some((t) => t?.includes("系统/App 音频"))).toBe(false);
  });

  it("selecting the osspeech card updates settings.engine", async () => {
    await act(async () => {
      root!.render(<TutorialOverlay open={true} onClose={() => {}} />);
    });
    const nextButton = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === "下一步")!;
    await act(async () => {
      nextButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const osspeechCard = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("系统识别"),
    )!;
    await act(async () => {
      osspeechCard.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.engine).toBe("osspeech");
  });
});
