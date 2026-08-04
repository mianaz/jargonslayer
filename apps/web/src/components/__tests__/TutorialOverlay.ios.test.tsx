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

  // F1 fix round (BLOCKER): iOS groups with web, not desktop — step 2's
  // own grid offers the BYOK cloud trio here too, so the unconditional
  // "全程本地" claim would be just as false as on web.
  it("F1: uses the capability-phrased copy on step 1 (step 2 offers cloud engines here too)", async () => {
    await act(async () => {
      root!.render(<TutorialOverlay open={true} onClose={() => {}} />);
    });
    expect(container!.textContent).toContain("你的双语会议引擎");
    expect(container!.textContent).not.toContain("全程本地");
    expect(container!.textContent).toContain("听英文、看中文解释。选本地引擎时，音频和内容不出设备。");
  });

  // iOS-cloud round (Sol F2): the picker matches IOS_ENGINE_OPTIONS —
  // osspeech first + the BYOK cloud trio; the no-capture-path engines
  // stay absent.
  it("step 2's engine grid offers osspeech + the cloud trio — no webspeech/whisper/tabaudio/appaudio card", async () => {
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
    expect(cardLabels.some((t) => t?.includes("Soniox 云端"))).toBe(true);
    expect(cardLabels.some((t) => t?.includes("Deepgram 云端"))).toBe(true);
    expect(cardLabels.some((t) => t?.includes("ElevenLabs 云端"))).toBe(true);
    expect(cardLabels.some((t) => t?.includes("浏览器识别"))).toBe(false);
    expect(cardLabels.some((t) => t?.includes("本地模型"))).toBe(false);
    expect(cardLabels.some((t) => t?.includes("标签页音频"))).toBe(false);
    expect(cardLabels.some((t) => t?.includes("系统/App 音频"))).toBe(false);
  });

  // iOS-cloud round (Sol F2): a cloud pick from onboarding must land on
  // mode:"mic" exactly like osspeech — the trio are mic engines
  // (modeForPersistedEngine back-derivation, same write path).
  it("selecting a cloud card writes engine AND mode:mic", async () => {
    await act(async () => {
      root!.render(<TutorialOverlay open={true} onClose={() => {}} />);
    });
    const nextButton = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === "下一步")!;
    await act(async () => {
      nextButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const sonioxCard = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Soniox 云端"),
    )!;
    await act(async () => {
      sonioxCard.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.engine).toBe("soniox");
    expect(useApp.getState().settings.mode).toBe("mic");
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

  // ITEM 4 (fix round, Opus#2): the picker used to write `engine` alone,
  // leaving `mode` stuck on whatever it was before — contradicting
  // ModeSelector, which reads `mode` to decide the selected tile.
  // osspeech on iOS (mic-only v1) maps to mode:"mic" per
  // modeForPersistedEngine's own iOS branch.
  it("selecting the osspeech card ALSO writes settings.mode:mic (not left stale)", async () => {
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

    expect(useApp.getState().settings.mode).toBe("mic");
  });
});
