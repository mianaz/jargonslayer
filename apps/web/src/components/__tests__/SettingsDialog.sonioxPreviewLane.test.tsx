// @vitest-environment jsdom
//
// SettingsDialog — Soniox preview lane, M2 fix (Sol review 2026-07-20,
// v0.5 closeout). PREVIEW_TIER/SONIOX_PREVIEW_LANE are both import-time
// consts (deployTier.ts) — same "needs its own vi.mock'd file" limit
// SettingsDialog.test.tsx's own header comment documents (that file's
// ambient PREVIEW_TIER is false) — mirrors engineOptions.
// sonioxPreviewLane.test.ts's established one-file-per-const-combo
// convention.
//
// Covers: the tabaudio-cloud card previously promised the shared trial
// UNCONDITIONALLY (both its grid hint and its own detail-panel hint),
// and had no restored-backup notice at all — unlike the Soniox card,
// which already had the notice but the SAME unconditional-trial hint
// bug. Both cards' hints + the (now-shared) notice component are
// covered here.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/deployTier", () => ({
  PREVIEW_TIER: true,
  SONIOX_PREVIEW_LANE: true,
  PREVIEW_LIVE_MODELS: ["minimax/minimax-m3", "deepseek/deepseek-v4-flash"],
  PREVIEW_SUMMARY_MODELS: ["minimax/minimax-m3", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
}));

import { useApp } from "../../lib/store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import SettingsDialog from "../SettingsDialog";

function resetStore() {
  useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("SettingsDialog — Soniox preview lane: restored-key honesty (M2)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function findButtonContaining(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    );
    if (!btn) throw new Error(`button containing "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  function findButtonByText(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  it("without a restored key, both cards keep the keyless trial hint (no regression)", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech", sonioxKey: "" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const sonioxCard = findButtonContaining("Soniox 云端识别");
    const tabCloudCard = findButtonContaining("标签页音频·云端");
    expect(sonioxCard.textContent).toContain("预览体验：无需密钥");
    expect(tabCloudCard.textContent).toContain("预览体验：无需密钥");
    expect(sonioxCard.textContent).not.toContain("将按你的账户计费");
    expect(tabCloudCard.textContent).not.toContain("将按你的账户计费");
  });

  it("a restored sonioxKey switches BOTH cards' grid hint to the BYOK-billing copy", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "webspeech", sonioxKey: "sk-restored-from-backup" },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const sonioxCard = findButtonContaining("Soniox 云端识别");
    const tabCloudCard = findButtonContaining("标签页音频·云端");
    expect(sonioxCard.textContent).toContain("已检测到你的 Soniox Key，将按你的账户计费");
    expect(tabCloudCard.textContent).toContain("已检测到你的 Soniox Key，将按你的账户计费");
    expect(sonioxCard.textContent).not.toContain("预览体验：无需密钥");
    expect(tabCloudCard.textContent).not.toContain("预览体验：无需密钥");
  });

  it("the Soniox card's own restored-backup notice still renders (post-extraction regression check)", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "soniox", sonioxKey: "sk-restored-from-backup" },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).toContain(
      "检测到已保存的 Soniox Key：会话将直接使用你自己的 Key 并按你的账户计费，而非上方的预览体验。",
    );
    expect(container!.textContent).toContain("清除已保存的 Key（改用预览体验）");
  });

  it("the tab-cloud card gets the SAME restored-backup notice the Soniox card has (the M2 gap)", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud", sonioxKey: "sk-restored-from-backup" },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).toContain(
      "检测到已保存的 Soniox Key：会话将直接使用你自己的 Key 并按你的账户计费，而非上方的预览体验。",
    );
    expect(container!.textContent).toContain("清除已保存的 Key（改用预览体验）");
    // The detail panel's OWN separate hint line (distinct from the grid
    // card's hint above) must also stop promising "无需自备 Key" once a
    // key is present — otherwise it flatly contradicts the notice right
    // below it.
    expect(container!.textContent).toContain("已检测到你的 Soniox Key，将按你的账户计费");
    expect(container!.textContent).not.toContain("预览体验固定使用 Soniox 云端转写，无需自备 Key");
  });

  it("the tab-cloud card has NO notice and the ordinary trial detail-hint when no key is present", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud", sonioxKey: "" },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).not.toContain("清除已保存的 Key（改用预览体验）");
    expect(container!.textContent).toContain("预览体验固定使用 Soniox 云端转写，无需自备 Key");
  });

  it("清除已保存的 Key on the tab-cloud card's notice clears draft.sonioxKey (notice + BYOK hint both revert)", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud", sonioxKey: "sk-restored-from-backup" },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    expect(container!.textContent).toContain("清除已保存的 Key（改用预览体验）");

    await act(async () => {
      findButtonByText("清除已保存的 Key（改用预览体验）").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(container!.textContent).not.toContain("清除已保存的 Key（改用预览体验）");
    expect(container!.textContent).toContain("预览体验固定使用 Soniox 云端转写，无需自备 Key");

    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.sonioxKey).toBe("");
  });
});
