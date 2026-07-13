// @vitest-environment jsdom
//
// SettingsDialog — tag-blocker-fix-pass regression tests (createRoot/
// act pattern, mirrors Toast.test.tsx — no @testing-library/react in
// this repo's test stack). Every module SettingsDialog reaches for on
// mount (detect/dictionary, detect/remotePacks, history/autoExport,
// audio/devices) already self-guards on `typeof indexedDB/navigator
// !== "undefined"` and no-ops under jsdom, so this mounts the REAL
// component rather than a mocked stand-in.
//
//  - BLOCKER 1: the auto-promote effect must wait for store hydration
//    (never fire on the pre-hydration DEFAULT_SETTINGS closure with an
//    empty-dep effect that then never re-runs) and must actually
//    promote once hydrate() publishes advanced-deviant settings.
//  - HIGH 3: 保存 must not revert a uiMode toggle click made live while
//    the dialog was open, using a stale open-time draft.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "../../lib/store";
import { SETTINGS_UI_LEVELS } from "../../lib/settingsSections";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import SettingsDialog from "../SettingsDialog";

function deviantSettings(): Settings {
  // shouldAutoPromoteToAdvanced (settingsSections.ts) trips on ANY
  // deviation from DEFAULT_SETTINGS — apiKey is the simplest one (and
  // the exact field the bug report calls out: "their BYOK key field
  // hidden").
  return { ...DEFAULT_SETTINGS, apiKey: "sk-real-user-key" };
}

function resetStore() {
  useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false });
}

async function flush() {
  // Drains the microtask queue for the fire-and-forget promises the
  // mount/open effects kick off (loadRemotePacksIntoRegistry,
  // listPackSources, getExportFolderName, …) so they can't bleed a
  // stray act() warning into a LATER test.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("SettingsDialog — tag-blocker BLOCKER 1: auto-promote waits for hydration", () => {
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

  it("stays simple while mounted pre-hydration (hydrated:false)", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(useApp.getState().settings.uiMode).toBe("simple");
  });

  it("promotes to advanced once hydrate() publishes advanced-deviant settings AFTER mount (the exact race BLOCKER 1 describes)", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    expect(useApp.getState().settings.uiMode).toBe("simple"); // not hydrated yet

    // Simulate store.hydrate()'s single synchronous `set` publishing the
    // real persisted (advanced-deviant) settings + hydrated:true together
    // — same shape as store.ts's own hydrate() action.
    await act(async () => {
      useApp.setState({ settings: deviantSettings(), hydrated: true });
    });
    await flush();

    expect(useApp.getState().settings.uiMode).toBe("advanced");
  });

  it("all-defaults settings published at hydration stays simple (no false-positive promotion)", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    await act(async () => {
      useApp.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: true });
    });
    await flush();

    expect(useApp.getState().settings.uiMode).toBe("simple");
  });
});

describe("SettingsDialog — tag-blocker HIGH 3: 保存 must not revert a live uiMode toggle", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, uiMode: "advanced" }, hydrated: true });
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

  function findButtonByText(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === text,
    );
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  it("clicking 简单 (live header toggle) then 保存 with a stale open-time draft.uiMode keeps the live uiMode as 简单, never reverted to 高级", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    expect(useApp.getState().settings.uiMode).toBe("advanced");

    // Header segmented control: applied immediately via updateSettings,
    // deliberately OUT of the draft/保存 flow — draft (seeded "advanced"
    // at open time) is NOT touched by this click.
    await act(async () => {
      findButtonByText("简单").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.uiMode).toBe("simple");

    // 保存 now runs with draft.uiMode still "advanced" (stale) — must
    // NOT revert the live "simple" the toggle just wrote.
    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.uiMode).toBe("simple");
  });
});

// ---------------------------------------------------------------
// 转录引擎 sidecar status line (owner ask 2026-07-11: "I cannot see in
// the GUI if the local side got set up at all") — probes GET /health
// (via lib/stt/sidecarHealth.ts's probeSidecar) whenever the draft
// engine is whisper/tabaudio/appaudio (S9/D7 added the third), mirrors
// the result into store.sidecarUp for StatusLine's tooltip, and offers
// a 重新检测 refresh. Mocks fetch (not probeSidecar) so this exercises
// the real component + real probe function, matching this file's own
// "mount the real component" header comment. Unlike the ENGINE_CARDS
// IS_DESKTOP swap itself (structurally unreachable in this ambient web
// test env — see this file's own 更换模型 describe block for that
// limitation), this triple-gate condition is plain draft.engine string
// comparison with no IS_DESKTOP dependency, so setting
// settings.engine:"appaudio" directly (bypassing the picker) exercises
// the real changed code path end-to-end.
// ---------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SettingsDialog — 转录引擎 sidecar status line", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

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
    useApp.setState({ sidecarUp: null });
    vi.unstubAllGlobals();
  });

  it("probes on render for engine:whisper and shows the connected/model/diarization line on success, mirrored into store.sidecarUp", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "whisper" }, hydrated: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ ok: true, model: "small", diarization_ready: true, diarization_error: null }),
      ),
    );

    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).toContain("已连接");
    expect(container!.textContent).toContain("模型 small");
    expect(container!.textContent).toContain("说话人分离已就绪");
    expect(useApp.getState().sidecarUp).toBe(true);
  });

  it("probes on render for engine:appaudio too (S9/D7 — a third sidecar-backed engine, same wsTransport-backed local sidecar as whisper/tabaudio)", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "appaudio" }, hydrated: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ ok: true, model: "small", diarization_ready: true, diarization_error: null }),
      ),
    );

    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).toContain("已连接");
    expect(useApp.getState().sidecarUp).toBe(true);
  });

  it("shows the down state + install hint when unreachable, and 重新检测 re-probes to the up state", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "whisper" }, hydrated: true });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(
        jsonResponse({ ok: true, model: "small", diarization_ready: false, diarization_error: null }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).toContain("未检测到本地服务");
    expect(container!.textContent).toContain("README「本地版安装」");
    expect(useApp.getState().sidecarUp).toBe(false);

    const btn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "重新检测",
    );
    if (!btn) throw new Error('button "重新检测" not found');
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container!.textContent).toContain("已连接");
    expect(useApp.getState().sidecarUp).toBe(true);
  });

  it("renders no 本地服务 status line for a non-sidecar engine (webspeech) and never probes", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, hydrated: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).not.toContain("本地服务");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useApp.getState().sidecarUp).toBeNull();
  });
});

// ---------------------------------------------------------------
// 转录引擎 系统/App 音频 permission-denied CTA (S9.4, D6) — engine-
// conditional like 本地服务/Soniox API Key above, so it's just as
// reachable in this ambient web test env regardless of the IS_DESKTOP-
// gated ENGINE_CARDS swap itself (same rationale as the sidecar status
// line's own appaudio test above). getInvoke() is NOT mocked here —
// on a non-desktop build it throws SYNCHRONOUSLY (tauriApi.ts's own
// guard), which handleOpenPrivacySettings' try/catch is exactly built
// to survive; this doubles as a real-behavior pin for "the button never
// throws an unhandled rejection even where open_privacy_settings can't
// possibly exist", not just a desktop-only path.
// ---------------------------------------------------------------

describe("SettingsDialog — 转录引擎 系统/App 音频 permission-denied CTA (S9.4)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

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
    useApp.setState({ toast: null });
  });

  it("renders the CTA (button + always-visible manual path) once appaudio is the drafted engine", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "appaudio" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).toContain("系统音频录制权限");
    expect(container!.textContent).toContain("系统设置 → 隐私与安全性 → 屏幕与系统音频录制");
    const btn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "打开系统设置",
    );
    expect(btn).toBeDefined();
  });

  it("is absent for every other engine", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "whisper" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).not.toContain("系统音频录制权限");
  });

  it("clicking 打开系统设置 on a non-desktop build catches getInvoke()'s synchronous throw and toasts rather than crashing", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "appaudio" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const btn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "打开系统设置",
    );
    if (!btn) throw new Error('button "打开系统设置" not found');
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(useApp.getState().toast).toContain("无法打开系统设置");
  });
});

// ---------------------------------------------------------------
// Settings redesign (owner ask 2026-07-11: "side navbar for each
// category" + "freeze 保存/取消"): nav rail + page-per-section content
// pane. activeCategory is local useState, NOT the zustand store — draft
// (and every other piece of dialog-level state: showHfToken,
// checkedPacks, exportStripKeys, …) already lives above the nav/content
// split, so switching categories can never lose an unsaved edit.
// ---------------------------------------------------------------

describe("SettingsDialog — settings redesign: nav rail + page-per-section", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function navButtons(): HTMLButtonElement[] {
    return Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
  }

  function clickCategory(label: string) {
    const btn = navButtons().find((b) => b.textContent === label);
    if (!btn) throw new Error(`nav category "${label}" not found`);
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  // Finds the switch nested inside the <label> whose text includes
  // labelText — mirrors every converted checkbox row's own markup
  // (label wraps both the description text and the control, so a real
  // <label> click also forwards to a nested ToggleSwitch — see
  // ToggleSwitch.tsx's own "labelable element" test).
  function findSwitchByLabel(labelText: string): HTMLButtonElement {
    const label = Array.from(container!.querySelectorAll("label")).find((l) =>
      l.textContent?.includes(labelText),
    );
    if (!label) throw new Error(`label containing "${labelText}" not found`);
    const btn = label.querySelector('button[role="switch"]');
    if (!btn) throw new Error(`no switch inside label "${labelText}"`);
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

  it("defaults to 转录引擎 active (aria-current=page) and lists one nav entry per visible category in simple mode", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, uiMode: "simple" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const buttons = navButtons();
    // Simple-visible categories only: engine/display are whole-section
    // "simple"; aiDetect (the one mixed section) always has at least
    // one simple row, so it's always listed too. The four advanced-only
    // whole sections (diarization/taskLlm/dataIntegration/
    // subscriptionDirect) are absent.
    expect(buttons.map((b) => b.textContent)).toEqual(["转录引擎", "AI 检测", "显示"]);
    expect(buttons[0].getAttribute("aria-current")).toBe("page");
    expect(buttons[1].getAttribute("aria-current")).toBeNull();
    expect(buttons[2].getAttribute("aria-current")).toBeNull();
  });

  it("advanced mode reveals the advanced-only categories too, still excludes 订阅直连 while its build flag is unset", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, uiMode: "advanced" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(navButtons().map((b) => b.textContent)).toEqual([
      "转录引擎",
      "说话人分离",
      "AI 检测",
      "分任务模型（高级）",
      "数据与联动",
      "显示",
    ]);
  });

  it("clicking a nav entry moves aria-current and swaps the content pane to ONLY that category — the previous category's own fields unmount, not just hide", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, uiMode: "simple" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.querySelector('input[placeholder="ws://localhost:8765"]')).not.toBeNull();

    await act(async () => {
      clickCategory("显示");
    });

    const buttons = navButtons();
    expect(buttons.find((b) => b.textContent === "显示")!.getAttribute("aria-current")).toBe("page");
    expect(buttons.find((b) => b.textContent === "转录引擎")!.getAttribute("aria-current")).toBeNull();
    expect(container!.querySelector('input[placeholder="ws://localhost:8765"]')).toBeNull();
    expect(container!.textContent).toContain("全局字号");
  });

  it("switching categories preserves an unsaved draft edit (draft lives at dialog level, not per-category)", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, uiMode: "simple" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    // 实时转录预览 defaults to checked (DEFAULT_SETTINGS.partials === true).
    expect(findSwitchByLabel("实时转录预览").getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      findSwitchByLabel("实时转录预览").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(findSwitchByLabel("实时转录预览").getAttribute("aria-checked")).toBe("false");

    // Navigate away — 转录引擎's own fields unmount entirely — then back.
    await act(async () => {
      clickCategory("显示");
    });
    await act(async () => {
      clickCategory("转录引擎");
    });

    // The edit survived the round trip: still a plain useState draft at
    // the dialog level, never reset by an activeCategory change.
    expect(findSwitchByLabel("实时转录预览").getAttribute("aria-checked")).toBe("false");
  });
});

// ---------------------------------------------------------------
// data-ui-level completeness under page-per-section rendering.
//
// Pre-existing settingsSections.ts doc comment: "Keys are also used as
// the JSX `data-ui-level` attribute value on the matching element, so
// they double as light e2e/visual-QA hooks." The actual JSX previously
// wrote `data-ui-level={SETTINGS_UI_LEVELS.xxx}` — the LEVEL ("simple"/
// "advanced"), not the KEY — which collides across every row sharing a
// level and can't identify any one row. Fixed alongside this redesign
// (SettingsDialog.tsx now writes the literal key, e.g.
// data-ui-level="aiDetectCore") so this completeness check — and the
// same attribute's original "e2e/visual-QA hook" purpose — actually
// works. Purely a data-* attribute; zero rendering/behavior change.
// ---------------------------------------------------------------

describe("SettingsDialog — data-ui-level completeness across nav categories (page-per-section)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

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
    vi.unstubAllEnvs();
  });

  it("the union of data-ui-level values rendered across every nav category exactly equals SETTINGS_UI_LEVELS' keys — nothing missing, nothing stray", async () => {
    // Advanced mode + the subscription-direct build flag on: every one
    // of the 7 nav categories (including the build-gated one) gets a
    // turn, so every SETTINGS_UI_LEVELS key has a chance to be found —
    // a category/row that's unreachable at every uiMode would otherwise
    // make an exact-union assertion impossible to satisfy honestly.
    vi.stubEnv("NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT", "1");
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, uiMode: "advanced" }, hydrated: true });

    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    expect(navButtons.length).toBe(7); // sanity: all 7 categories reachable this run

    const found = new Set<string>();
    for (const btn of navButtons) {
      await act(async () => {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      container!.querySelectorAll("[data-ui-level]").forEach((el) => {
        found.add(el.getAttribute("data-ui-level")!);
      });
    }

    // aiDetectPreviewBanner is gated by PREVIEW_TIER (lib/deployTier.ts)
    // — a module-level `const` frozen at import time from
    // process.env.NEXT_PUBLIC_DEPLOY_TIER === "preview", evaluated long
    // before this test body runs. A runtime vi.stubEnv here can't flip
    // an already-evaluated const (unlike NEXT_PUBLIC_ENABLE_SUBSCRIPTION_
    // DIRECT above, which SettingsDialog.tsx reads inline on every
    // render — see its own doc comment on that distinction), so that one
    // row is structurally unreachable from any render in this test file
    // regardless of category/uiMode — a pre-existing constraint this
    // redesign didn't introduce, not a real gap. Excluded here by name,
    // not by weakening the assertion to a subset check: every OTHER key
    // is still required to match exactly.
    const reachableKeys = Object.keys(SETTINGS_UI_LEVELS).filter(
      (k) => k !== "aiDetectPreviewBanner",
    );
    expect(Array.from(found).sort()).toEqual(reachableKeys.sort());
  });
});

// ---------------------------------------------------------------
// Soniox engine card + BYOK key field (v0.4 S4 chunk 6, blueprint
// decision E). PREVIEW_TIER/IS_DESKTOP are import-time consts (see
// this file's own header comment) — the previewLocked gating itself
// (ENGINE_CARDS' byokOnly extension, risk 4's triple gate) is NOT
// exercised here for the same reason the rest of this file never
// stubs PREVIEW_TIER live; only the full-tier (ambient) rendering path
// this suite already runs under is covered.
// ---------------------------------------------------------------

describe("SettingsDialog — 转录引擎 ENGINE_CARDS: Soniox (v0.4 S4 chunk 6)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function findButtonContaining(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    );
    if (!btn) throw new Error(`button containing "${text}" not found`);
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

  it("renders the Soniox card with its 实验 tag and honest (non-superlative) hint copy", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const card = findButtonContaining("Soniox 云端识别");
    expect(card.textContent).toContain("实验");
    expect(card.textContent).toContain("BYOK 按量计费");
    expect(card.textContent).toContain("尚未通过本地对照测试");
  });

  it("the Soniox API Key field is absent until the Soniox card is picked (engine-conditional, mirrors 本地服务's own posture)", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.querySelector('input[placeholder="粘贴你的 Soniox API Key"]')).toBeNull();

    await act(async () => {
      findButtonContaining("Soniox 云端识别").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container!.querySelector('input[placeholder="粘贴你的 Soniox API Key"]')).not.toBeNull();
  });

  it("switching off Soniox hides the key field again", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "soniox" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const input = container!.querySelector(
      'input[placeholder="粘贴你的 Soniox API Key"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();

    await act(async () => {
      findButtonContaining("浏览器识别").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector('input[placeholder="粘贴你的 Soniox API Key"]')).toBeNull();
  });
});

describe("SettingsDialog — 数据与联动: backup key-strip hint lists Soniox Key (v0.4 S4 chunk 6)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, uiMode: "advanced" }, hydrated: true });
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

  it("「不包含 API Key」hint enumerates Soniox Key alongside HF Token/Webhook/连接码 — matches stripKeyMaterial's own hand-listed fields (autoExport.ts)", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const dataIntegrationBtn = navButtons.find((b) => b.textContent === "数据与联动");
    if (!dataIntegrationBtn) throw new Error('nav category "数据与联动" not found');

    await act(async () => {
      dataIntegrationBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container!.textContent).toContain("Soniox Key");
  });
});

// ---------------------------------------------------------------
// 转录引擎 更换模型 (v0.4 S4 chunk 4, blueprint decision C's switch
// flow). Same IS_DESKTOP limitation this file's own Soniox describe
// block above already documents ("PREVIEW_TIER/IS_DESKTOP are
// import-time consts... the rest of this file never stubs PREVIEW_
// TIER live" — platform/desktop.ts's IS_DESKTOP is read once when
// THIS file's own top-level `import SettingsDialog from
// "../SettingsDialog"` first evaluates the module graph, long before
// any test body runs, so a runtime vi.stubEnv can't flip it here any
// more than it can PREVIEW_TIER). The whole 当前模型/更换模型 block
// (like the pre-existing 重新运行安装向导 button right beside it, which
// has never had its own render test in this file for the identical
// reason) sits behind `{IS_DESKTOP && (...)}` and is therefore
// structurally unreachable from any render in this suite — so neither
// the meeting-active disable (risk 2: switching stops+relaunches the
// sidecar, disruptive mid-meeting) nor the immediate-action placement
// (handleSwitchModel bypasses patch()/draft/保存 entirely — see that
// handler's own doc comment in SettingsDialog.tsx) is mount-testable
// here without a vi.resetModules() + dynamic-re-import workaround this
// file has never used for the analogous PREVIEW_TIER gap either; both
// are instead covered at the unit level in bootstrap.test.ts
// (switchModel()'s own non-HEALTHY-rejection/single-flight tests) and
// by direct code inspection (meetingActive gates the button's
// `disabled`/`title`, handleSwitchModel never calls patch()). What IS
// testable without IS_DESKTOP: that the block stays fully absent on an
// ordinary web build regardless of sidecarMode/meeting status — i.e.
// nothing here accidentally leaks into a build that never provisions
// anything.
// ---------------------------------------------------------------

describe("SettingsDialog — 转录引擎 更换模型 (v0.4 S4 chunk 4)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

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
    useApp.setState({ status: "idle" }); // resetStore() doesn't cover this field — avoid leaking into later tests
  });

  it("renders no 更换模型/当前模型 affordance on a non-desktop build, even with sidecarMode:\"managed\" and a meeting active — IS_DESKTOP gates the whole block", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, sidecarMode: "managed" },
      status: "listening",
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).not.toContain("更换模型");
    expect(container!.textContent).not.toContain("当前模型");
  });
});

// ---------------------------------------------------------------
// 说话人分离 安装扩展 (v0.4 S5 chunk 3, blueprint decision A). Same
// IS_DESKTOP limitation the 转录引擎 更换模型 describe block just above
// already documents in full ("PREVIEW_TIER/IS_DESKTOP are import-time
// consts... a runtime vi.stubEnv can't flip it here any more than it
// can PREVIEW_TIER" — not repeated verbatim here, see that block's own
// comment). The whole install-state row/安装扩展 button/log tail/移除
// 扩展 doc line, AND the realtime-toggle's inline "需先安装说话人分离扩展"
// warning, all sit behind `IS_DESKTOP && draft.sidecarMode ===
// "managed"` and are therefore structurally unreachable from any render
// in this suite — so neither handleInstallDiarization's own busy/
// meeting-guard wiring (mirrors handleSwitchModel's identical gap, same
// rationale) nor the diarizationInstalled true/false/undefined
// tri-state render is mount-testable here without the vi.resetModules()
// workaround this file has never used for the analogous PREVIEW_TIER/
// IS_DESKTOP gaps either; both are instead covered at the unit level
// (bootstrap.test.ts's own installDiarization() single-flight/non-
// HEALTHY-rejection tests) and by direct code inspection
// (meetingActive/reprovisioningDesktop/switchingModel/installing gate
// every button's `disabled`, diarizationInstalled === false gates both
// the install button and the realtime-toggle note). What IS testable
// without IS_DESKTOP: that the entire block stays fully absent on an
// ordinary web build regardless of sidecarMode/meeting status — i.e.
// nothing here accidentally leaks into a build that never provisions
// anything. sidecarHealth.test.ts/upload.test.ts cover the new
// diarization_installed parse (probeSidecar/fetchSidecarHealth) this
// block's row is sourced from.
// ---------------------------------------------------------------

describe("SettingsDialog — 说话人分离 安装扩展 (v0.4 S5 chunk 3)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function navButtons(): HTMLButtonElement[] {
    return Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
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
    useApp.setState({ status: "idle" }); // resetStore() doesn't cover this field — avoid leaking into later tests
  });

  it("renders no 安装扩展 install-state affordance on a non-desktop build, even with sidecarMode:\"managed\" and a meeting active — IS_DESKTOP gates the whole block", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, uiMode: "advanced", sidecarMode: "managed" },
      status: "listening",
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    // Navigate into 说话人分离 itself (unlike 更换模型's own home category
    // "转录引擎", this section is NOT the default-active category, so the
    // absence check would be trivially true without this click — it
    // would only be proving category-gating, not the IS_DESKTOP gate
    // this test actually targets).
    const diarBtn = navButtons().find((b) => b.textContent === "说话人分离");
    if (!diarBtn) throw new Error('nav category "说话人分离" not found');
    await act(async () => {
      diarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container!.textContent).not.toContain("说话人分离扩展：");
    expect(container!.textContent).not.toContain("安装扩展（约");
    expect(container!.textContent).not.toContain("移除扩展");
    expect(container!.textContent).not.toContain("需先安装说话人分离扩展");
  });
});
