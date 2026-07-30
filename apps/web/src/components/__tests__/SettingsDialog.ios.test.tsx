// @vitest-environment jsdom
//
// SettingsDialog — iOS-only coverage (S13 mobile-UX sprint). IS_IOS is
// a module-scope import-time const, so this needs its own file/vi.mock
// — mirrors AnkiConnectSection.ios.test.tsx/TranslationEngineRow.ios.
// test.tsx's own split for the identical constraint (SettingsDialog.
// test.tsx itself needs the REAL, false value for its own ambient/web
// coverage, and must keep working unmodified — see that file's own
// suite, still green after this sprint's changes).
//
// IS_TAURI must be supplied explicitly in the mock factory too (its
// real value would be IS_DESKTOP || IS_IOS = true here) — mocking the
// WHOLE "@/lib/platform/ios" module replaces every one of its exports,
// and SettingsDialog.tsx imports IS_TAURI directly alongside IS_IOS
// (its own ENGINE_CARDS array reads it at module scope) — see
// ModeSelector.ios.test.tsx's own header comment for the exact "No
// IS_TAURI export is defined on the mock" throw this avoids.
//
// useOsSpeechCaps/preinstallOsSpeech (lib/desktop/osspeechCaps.ts) are
// mocked for the SAME reason SettingsDialog.desktop.test.tsx already
// mocks them: with IS_TAURI now true, the REAL useOsSpeechCaps would
// call probeOsSpeechCaps() -> tauriApi.ts's getInvoke(), which throws
// SYNCHRONOUSLY outside an actual NEXT_PUBLIC_IOS=1 build (there is no
// real Tauri runtime in jsdom either way). isOsSpeechFloorLocked/
// osSpeechLockReason are left REAL via importOriginal — pure functions
// of their own arguments, no Tauri dependency (same split the desktop
// suite's own header comment documents for the identical landmine).
// IS_DESKTOP is deliberately left UNMOCKED (real, false in this env) —
// IS_IOS/IS_DESKTOP are mutually exclusive in any real build, matching
// that invariant here (same posture TranslationEngineRow.ios.test.tsx
// documents).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true, IS_TAURI: true }));
vi.mock("@/lib/desktop/osspeechCaps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop/osspeechCaps")>();
  return {
    ...actual,
    useOsSpeechCaps: () => null,
    preinstallOsSpeech: async () => undefined,
  };
});

import { useApp } from "../../lib/store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import SettingsDialog from "../SettingsDialog";

function resetStore() {
  useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: true });
}

async function flush() {
  // Drains the microtask queue for the fire-and-forget mount-effect
  // promises (loadRemotePacksIntoRegistry, listPackSources,
  // getExportFolderName, listAudioInputs, …) — mirrors
  // SettingsDialog.test.tsx's own identical helper.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("SettingsDialog — iOS build", () => {
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

  async function render() {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
  }

  function buttons(): HTMLButtonElement[] {
    return Array.from(container!.querySelectorAll("button"));
  }

  // Root-list rows carry a trailing "›" chevron span alongside the
  // label (button.textContent === `${label}›`), so this matches by
  // prefix rather than exact equality.
  function findRow(label: string): HTMLButtonElement {
    const btn = buttons().find((b) => b.textContent?.startsWith(label));
    if (!btn) throw new Error(`row "${label}" not found`);
    return btn as HTMLButtonElement;
  }

  function findExact(label: string): HTMLButtonElement | undefined {
    return buttons().find((b) => b.textContent === label);
  }

  // ENGINE_CARDS' own buttons trail off into a per-card hint <div>
  // beneath the label (and sometimes a badge span before that) — unlike
  // findRow/findExact's own chevron/label-only shapes, a plain
  // `.includes` match is what SettingsDialog.test.tsx/.desktop.test.tsx/
  // .sonioxPreviewLane.test.tsx's own identical helper of this exact name
  // already uses for the same reason; mirrored verbatim here (iOS-cloud
  // round: this file's own suite gets its first ENGINE_CARDS case).
  function findButtonContaining(text: string): HTMLButtonElement {
    const btn = buttons().find((b) => b.textContent?.includes(text));
    if (!btn) throw new Error(`button containing "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  function hasLabel(text: string): boolean {
    return Array.from(container!.querySelectorAll("label")).some((l) => l.textContent === text);
  }

  // Mirrors SettingsDialog.dictPacks.test.tsx's own helper of the same
  // name byte-for-byte (independent test files — same "mirror, don't
  // hand-duplicate a DIFFERENT rule" posture that file's own comment
  // documents). Pack rows are a <label> wrapping the name/description
  // text plus a ToggleSwitch (a real <button role="switch">).
  function findSwitchByLabel(labelText: string): HTMLButtonElement {
    const label = Array.from(container!.querySelectorAll("label")).find((l) =>
      l.textContent?.includes(labelText),
    );
    if (!label) throw new Error(`label containing "${labelText}" not found`);
    const btn = label.querySelector('button[role="switch"]');
    if (!btn) throw new Error(`no switch inside label "${labelText}"`);
    return btn as HTMLButtonElement;
  }

  // Sticky 保存 bar is IS_IOS-only (draftDirty-gated) — absent whenever
  // nothing differs from savedSnapshot.
  function hasSaveBar(): boolean {
    return findExact("保存") !== undefined;
  }

  it("root list shows 常用/高级 groups with the expected category labels; diarization excluded entirely", async () => {
    await render();
    // 常用 — the phone landing page stays focused on the three things
    // needed during ordinary use.
    expect(findRow("转录引擎")).toBeTruthy();
    expect(findRow("AI 检测")).toBeTruthy();
    expect(findRow("密钥")).toBeTruthy();
    expect(findRow("显示")).toBeTruthy();
    // 高级
    expect(findRow("数据与联动")).toBeTruthy();
    // Row label drops the （高级） suffix on iOS — redundant under the
    // 高级 group header it sits in (design-polish pass); the canonical
    // SETTINGS_CATEGORIES label keeps it for desktop/web.
    expect(findRow("分任务模型")).toBeTruthy();
    expect(buttons().some((b) => b.textContent?.includes("（高级）"))).toBe(false);
    const rootText = container!.textContent ?? "";
    expect(rootText.indexOf("显示")).toBeLessThan(rootText.indexOf("高级"));
    expect(rootText.indexOf("数据与联动")).toBeGreaterThan(rootText.indexOf("高级"));
    // 「密钥」is simple-tagged → 常用, before the 高级 group header.
    expect(rootText.indexOf("密钥")).toBeLessThan(rootText.indexOf("高级"));
    // Part A #1: 说话人分离 (pyannote+sidecar) is impossible on iOS —
    // nowhere in the rendered nav/list.
    expect(container!.textContent).not.toContain("说话人分离");
  });

  it("简单/高级 control absent on iOS (Part B #3)", async () => {
    await render();
    expect(findExact("简单")).toBeUndefined();
    expect(findExact("高级")).toBeUndefined();
  });

  it("tapping 转录引擎 shows the engine detail panel (识别语言 present, whisper-only rows absent) with a back affordance, and back returns to the root list", async () => {
    await render();
    act(() => {
      findRow("转录引擎").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Detail view: 识别语言 (osspeech's own language picker) stays.
    expect(hasLabel("识别语言")).toBe(true);
    // Part A #2: whisper-only rows gone (麦克风 device picker + its
    // 仅本地 Whisper 生效 hint, Whisper 地址 field, 实时转录预览 toggle).
    expect(container!.textContent).not.toContain("仅本地 Whisper 生效");
    expect(hasLabel("Whisper 地址")).toBe(false);
    expect(container!.textContent).not.toContain("实时转录预览");

    // Back affordance present (Part B #2 detail header).
    const back = buttons().find((b) => b.textContent === "‹设置");
    expect(back).toBeTruthy();

    act(() => {
      back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Back at the root list — the row reappears, the panel is gone.
    expect(findRow("转录引擎")).toBeTruthy();
    expect(hasLabel("识别语言")).toBe(false);
  });

  it("数据与联动 detail panel has no TestFlight promo line and no 自动导出 block (Part A #3/#5)", async () => {
    await render();
    act(() => {
      findRow("数据与联动").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.textContent).not.toContain("TestFlight");
    expect(container!.textContent).not.toContain("自动导出");
    expect(container!.textContent).not.toContain("选择导出文件夹");
  });

  it("AI 检测 detail panel hides 一键连接 OpenRouter and shows the paste-first hint instead (Part A #4)", async () => {
    await render();
    act(() => {
      findRow("AI 检测").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.textContent).not.toContain("一键连接 OpenRouter 账号");
    expect(container!.textContent).toContain("在电脑浏览器完成 OpenRouter 授权后，把 API Key 粘贴到这里");
  });

  // #58 fix round FIX 1 (BLOCKER, both reviewers, repro-confirmed):
  // enabledPacks lives in `checkedPacks`, a Set kept outside `draft` —
  // a pack toggle used to never surface the sticky 保存 bar at all.
  it("toggling a dictionary pack surfaces the sticky 保存 bar (FIX 1)", async () => {
    await render();
    act(() => {
      findRow("AI 检测").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // No edit yet — the bar stays absent (nothing to save).
    expect(hasSaveBar()).toBe(false);

    // "会议流程与推进" (meeting-flow) is a built-in, checked-by-default
    // non-core pack (packages/core/src/detect/packs.ts) — no remote
    // pack/catalog setup needed to exercise it. v0.6 field-fix (item 1):
    // it now lives inside the collapsed 职场与会议 group — expand that
    // group first so its own row exists in the DOM.
    act(() => {
      buttons()
        .find((b) => b.textContent?.startsWith("职场与会议"))!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      findSwitchByLabel("会议流程与推进").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(hasSaveBar()).toBe(true);
  });

  // #58 fix round FIX 4: the dialog-open effect never reset
  // activeCategory — closing from a detail page and reopening used to
  // land back on that same stale detail instead of the root list.
  it("reopening after closing from a detail page lands back on the root list (FIX 4)", async () => {
    await render();
    act(() => {
      findRow("转录引擎").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(hasLabel("识别语言")).toBe(true);

    // Close from the detail page (no back-button tap) then reopen — same
    // mounted component instance (page.tsx's own always-mounted contract,
    // mirrored by SettingsDialog.dictPacks.test.tsx's own L1 case).
    await act(async () => {
      root!.render(<SettingsDialog open={false} onClose={() => {}} />);
    });
    await flush();
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(findRow("转录引擎")).toBeTruthy();
    expect(hasLabel("识别语言")).toBe(false);
  });

  // iOS-cloud round (post-v0.6.0, Miana's direct call: 手机版显然应该允许
  // 云端): 转录引擎 ENGINE_CARDS widens from S13's osspeech-only matrix to
  // osspeech + the 3 BYOK cloud cards (IOS_ENGINE_CARD_VALUES) — mirrors
  // lib/stt/engineOptions.ts's own IOS_ENGINE_OPTIONS widening
  // (engineOptions.ios.test.ts) one level up in the same feature.
  it("转录引擎 detail: ENGINE_CARDS keeps osspeech + the 3 BYOK cloud cards, drops 本地 Whisper/标签页音频/浏览器识别; picking ElevenLabs reveals its own API Key field", async () => {
    await render();
    act(() => {
      findRow("转录引擎").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(findButtonContaining("系统识别")).toBeTruthy();
    expect(findButtonContaining("Soniox 云端识别")).toBeTruthy();
    expect(findButtonContaining("Deepgram 云端识别")).toBeTruthy();
    expect(findButtonContaining("ElevenLabs 云端识别")).toBeTruthy();
    expect(buttons().some((b) => b.textContent?.includes("本地 Whisper"))).toBe(false);
    expect(buttons().some((b) => b.textContent?.includes("标签页音频"))).toBe(false);
    expect(buttons().some((b) => b.textContent?.includes("浏览器识别"))).toBe(false);

    expect(hasLabel("ElevenLabs API Key")).toBe(false);
    act(() => {
      findButtonContaining("ElevenLabs 云端识别").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(hasLabel("ElevenLabs API Key")).toBe(true);
  });
});
