// @vitest-environment jsdom
//
// TutorialOverlay — ambient (web, full tier) coverage. Mirrors
// ModeSelector.test.tsx's own "ambient env" split (TutorialOverlay.ios.
// test.tsx covers the iOS-only osspeech card separately, via vi.mock).
//
// ITEM 2 (fix round, Sol#4 + Lane C flag): the engine picker step used
// to hand-roll its own binary 本地/云端 posture pair — pins that the
// retention badge under each card now agrees, byte-for-byte, with
// RETENTION_COPY (lib/stt/engineOptions.ts), the SAME table Header/
// StatusLine read, so this first-run surface can never disagree with
// them. ITEM 4 (fix round, Opus#2): picking a card now writes `mode`
// alongside `engine` in one updateSettings call (modeForPersistedEngine)
// — pins the pairing for each card.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "@/lib/store";
import { RETENTION_COPY } from "@/lib/stt/engineOptions";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import TutorialOverlay from "../TutorialOverlay";

function resetStore() {
  useApp.setState({ settings: DEFAULT_SETTINGS });
}

describe("TutorialOverlay — web build, ambient test env", () => {
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

  it("浏览器识别 (webspeech, cloud-transient) shows RETENTION_COPY's 云端·不留存 label", async () => {
    await openEnginePickerStep();
    const card = findCard("浏览器识别");
    expect(card.textContent).toContain(RETENTION_COPY["cloud-transient"].label);
  });

  it("本地识别 (whisper, local) shows RETENTION_COPY's 本地 label", async () => {
    await openEnginePickerStep();
    const card = findCard("本地识别");
    expect(card.textContent).toContain(RETENTION_COPY.local.label);
  });

  it("浏览器标签页 (tabaudio, local) shows RETENTION_COPY's 本地 label", async () => {
    await openEnginePickerStep();
    const card = findCard("浏览器标签页");
    expect(card.textContent).toContain(RETENTION_COPY.local.label);
  });

  // ITEM 4: each card write pairs `mode` with `engine` in one call —
  // mirrors ModeSelector's own mode/engine pairing so a returning user
  // sees the matching tile selected there, not silently reset to "mic".
  it("picking 浏览器识别 (webspeech) writes mode:mic alongside engine", async () => {
    await openEnginePickerStep();
    await act(async () => {
      findCard("浏览器识别").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.engine).toBe("webspeech");
    expect(useApp.getState().settings.mode).toBe("mic");
  });

  it("picking 本地识别 (whisper) writes mode:mic alongside engine", async () => {
    await openEnginePickerStep();
    await act(async () => {
      findCard("本地识别").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.engine).toBe("whisper");
    expect(useApp.getState().settings.mode).toBe("mic");
  });

  it("picking 浏览器标签页 (tabaudio) writes mode:tab alongside engine", async () => {
    await openEnginePickerStep();
    await act(async () => {
      findCard("浏览器标签页").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.engine).toBe("tabaudio");
    expect(useApp.getState().settings.mode).toBe("tab");
  });
});
