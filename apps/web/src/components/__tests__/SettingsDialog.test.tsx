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
import * as storageModule from "../../lib/history/storage";
import { SETTINGS_UI_LEVELS } from "../../lib/settingsSections";
import { recordLlmCall, resetLlmTelemetry } from "../../lib/llm/telemetry";
import { RETENTION_COPY } from "../../lib/stt/engineOptions";
import { CLARITY_THEME } from "../../lib/theme/themes";
import { BIT_COSTUME_LABELS } from "../../lib/bitCostumes";
import { DEFAULT_SETTINGS, type Settings } from "@jargonslayer/core/types";
import SettingsDialog, { SETTINGS_CATEGORIES, type SettingsCategoryId } from "../SettingsDialog";

// Copy constants (tech-debt ledger #4, 2026-07-17): derives an expected
// nav-label array straight from SETTINGS_CATEGORIES instead of
// re-pinning a second copy of the zh labels here — a reword in
// SettingsDialog.tsx can't silently desync these assertions from it.
function labelsOf(ids: SettingsCategoryId[]): string[] {
  return ids.map((id) => SETTINGS_CATEGORIES.find((c) => c.id === id)!.label);
}

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

// React tracks an <input>'s value via a wrapped native setter — same
// bypass SettingsDialog.desktop.test.tsx's own typeInto already
// documents (a plain `input.value = x` + dispatchEvent("input") doesn't
// reliably trip React's onChange).
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;
function typeInto(input: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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

// F1 (v0.5.1 appearance sprint fix round, GPT-5.6 Sol adversarial review):
// the [open]-keyed draft-seed effect never re-ran on the hydrated
// false->true flip, so a dialog opened before store.hydrate() resolves
// kept a DEFAULT_SETTINGS draft even after the real settings landed —
// clicking 保存 then spread those stale defaults straight over the
// user's real apiKey/engine/themeId. Same race as tag-blocker BLOCKER 1
// above (mirrors its exact mount/flip pattern), different effect.
describe("SettingsDialog — F1: draft re-seeds on hydration completing while the dialog is open", () => {
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

  function findButtonByText(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  it("saving right after a pre-hydration open + hydrate() flip persists the real hydrated settings, not the stale DEFAULT_SETTINGS draft seeded before hydration", async () => {
    // Dialog opens before store.hydrate() resolves — draft seeds from
    // DEFAULT_SETTINGS (resetStore's hydrated:false).
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    // hydrate()'s single synchronous `set` publishes the real persisted
    // settings + hydrated:true together (store.ts's own hydrate() shape)
    // — apiKey/engine/themeId all deviate from default so a revert to
    // defaults is unambiguous.
    const hydratedSettings: Settings = {
      ...DEFAULT_SETTINGS,
      apiKey: "sk-real-user-key",
      engine: "soniox",
      themeId: "clarity",
    };
    await act(async () => {
      useApp.setState({ settings: hydratedSettings, hydrated: true });
    });
    await flush();

    // No further edits — 保存 immediately with whatever the draft holds.
    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const saved = useApp.getState().settings;
    expect(saved.apiKey).toBe("sk-real-user-key");
    expect(saved.engine).toBe("soniox");
    expect(saved.themeId).toBe("clarity");
  });
});

// F2 fix (Sol MEDIUM review, fieldtest-a batch): flushSettings can now
// reject (storage.saveSettings propagates IndexedDB failures instead of
// always resolving — see both functions' own docs). handleSave must show
// an explicit error toast and keep the dialog open rather than falling
// through to "已保存" + onClose over a write that never landed — see
// store.test.ts's own flushSettings/updateSettings F2 describe block for
// the store-level half of this fix (chain-poisoning, unhandled
// rejections).
describe("SettingsDialog — F2: handleSave surfaces a flushSettings failure honestly", () => {
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
    vi.restoreAllMocks();
    resetStore();
    useApp.setState({ toast: null });
  });

  function findButtonByText(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  it("a rejected flushSettings shows the failure toast and does NOT close the dialog", async () => {
    vi.spyOn(storageModule, "saveSettings").mockRejectedValue(new Error("quota exceeded"));
    const onClose = vi.fn();
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={onClose} />);
    });
    await flush();

    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(useApp.getState().toast).toBe("设置保存失败，请重试（存储不可用或空间不足）");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a successful flushSettings still shows the normal success toast and closes (regression guard)", async () => {
    vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    const onClose = vi.fn();
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={onClose} />);
    });
    await flush();

    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(useApp.getState().toast).toBe("设置已保存");
    expect(onClose).toHaveBeenCalledTimes(1);
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
    expect(buttons.map((b) => b.textContent)).toEqual(labelsOf(["engine", "aiDetect", "display"]));
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

    expect(navButtons().map((b) => b.textContent)).toEqual(
      labelsOf(["engine", "diarization", "aiDetect", "taskLlm", "dataIntegration", "display"]),
    );
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

// ---------------------------------------------------------------
// Deepgram engine card + BYOK key field (v0.4.7 stt-provider-wiring,
// Lane D). Mirrors the Soniox describe block immediately above
// field-for-field — same PREVIEW_TIER/IS_DESKTOP import-time-const
// limitation, same reason previewLocked gating itself isn't exercised
// here.
// ---------------------------------------------------------------

describe("SettingsDialog — 转录引擎 ENGINE_CARDS: Deepgram (v0.4.7 Lane D)", () => {
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

  it("renders the Deepgram card with its 实验 tag and honest English-only scope copy", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const card = findButtonContaining("Deepgram 云端识别");
    expect(card.textContent).toContain("实验");
    expect(card.textContent).toContain("BYOK 按量计费");
    expect(card.textContent).toContain("仅英文");
    expect(card.textContent).toContain("Soniox");
  });

  it("the Deepgram API Key field is absent until the Deepgram card is picked (engine-conditional, mirrors Soniox's own posture)", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.querySelector('input[placeholder="粘贴你的 Deepgram API Key"]')).toBeNull();

    await act(async () => {
      findButtonContaining("Deepgram 云端识别").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container!.querySelector('input[placeholder="粘贴你的 Deepgram API Key"]')).not.toBeNull();
  });

  it("switching off Deepgram hides the key field again", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "deepgram" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const input = container!.querySelector(
      'input[placeholder="粘贴你的 Deepgram API Key"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();

    await act(async () => {
      findButtonContaining("浏览器识别").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container!.querySelector('input[placeholder="粘贴你的 Deepgram API Key"]')).toBeNull();
  });
});

// ---------------------------------------------------------------
// 标签页音频·云端 engine card (v0.5 Wave-1 Feature 4, docs/design-
// explorations/v05-wave1-blueprint.md §1 Feature 4 + §5 A4). Web-only
// (ambient test env is the web build) — has no key input of its own,
// unlike Soniox/Deepgram above, so it gets a hint pointing back at
// those cards instead of a key field of its own.
// ---------------------------------------------------------------

describe("SettingsDialog — 转录引擎 ENGINE_CARDS: 标签页音频·云端 (v0.5 Wave-1 F4)", () => {
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

  it("renders the card with its 实验 tag and copy naming both providers + the Deepgram English-only caveat", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const card = findButtonContaining("标签页音频·云端");
    expect(card.textContent).toContain("实验");
    expect(card.textContent).toContain("Soniox 或 Deepgram Key");
    expect(card.textContent).toContain("共享音频");
    expect(card.textContent).toContain("仅支持英文");
  });

  // ITEM 3 (fix round, Opus#1): tabAudioCloudProvider previously had NO
  // UI writer anywhere in the app — Deepgram tab-cloud was unreachable —
  // and the old copy ("点击上方对应卡片临时切换以填写") pointed at an
  // inert action. Replaced with a real 2-option select + honest copy.
  function findProviderSelect(): HTMLSelectElement {
    const label = Array.from(container!.querySelectorAll("label")).find(
      (l) => l.textContent === "转录服务商",
    );
    const select = label?.parentElement?.querySelector("select");
    if (!select) throw new Error("转录服务商 select not found");
    return select as HTMLSelectElement;
  }

  it("the provider select + honest copy are absent until the card is picked", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container!.textContent).not.toContain("点击上方对应卡片临时切换以填写");
    expect(Array.from(container!.querySelectorAll("label")).some((l) => l.textContent === "转录服务商")).toBe(
      false,
    );

    await act(async () => {
      findButtonContaining("标签页音频·云端").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container!.textContent).toContain("选择转录服务商；需在对应引擎卡片填写该服务商的 API Key");
    expect(container!.textContent).not.toContain("点击上方对应卡片临时切换以填写");
    expect(findProviderSelect().value).toBe("soniox");
  });

  it("the deepgram option is labeled 仅英文", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const select = findProviderSelect();
    const deepgramOption = Array.from(select.options).find((o) => o.value === "deepgram");
    expect(deepgramOption?.textContent).toContain("仅英文");
  });

  it("selecting deepgram in the provider select writes draft.tabAudioCloudProvider (saved on 保存)", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "tabaudio-cloud" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    expect(useApp.getState().settings.tabAudioCloudProvider).toBe("soniox");

    const select = findProviderSelect();
    await act(async () => {
      select.value = "deepgram";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container!.textContent).toContain("尚未配置 Deepgram API Key");

    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.tabAudioCloudProvider).toBe("deepgram");
  });

  function findButtonByText(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn as HTMLButtonElement;
  }
});

// ITEM 2 (fix round, Sol#4 + Lane C flag): 转录引擎 ENGINE_CARDS used to
// hand-roll its own binary 本地/云端 posture pair — pins that the card
// grid's retention badge now agrees, byte-for-byte, with RETENTION_COPY
// (lib/stt/engineOptions.ts), the SAME table Header/StatusLine read.
describe("SettingsDialog — 转录引擎 ENGINE_CARDS: retention badge agrees with RETENTION_COPY (ITEM 2)", () => {
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
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, hydrated: true });
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

  it("浏览器识别 (webspeech, cloud-transient) shows RETENTION_COPY's 云端·不留存 label, not the old binary 云端", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const card = findButtonContaining("浏览器识别");
    expect(card.textContent).toContain(RETENTION_COPY["cloud-transient"].label);
    // The card's own hint copy legitimately contains "云端" as a
    // substring ("由浏览器厂商云端识别…") — the badge itself must be the
    // richer tri-state label, not just the old binary "云端" chip text.
    const badge = Array.from(card.querySelectorAll("span")).find(
      (s) => s.textContent === "云端",
    );
    expect(badge).toBeUndefined();
  });

  it("本地 Whisper (local) shows RETENTION_COPY's 本地 label", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const card = findButtonContaining("本地 Whisper");
    expect(card.textContent).toContain(RETENTION_COPY.local.label);
  });
});

// ---------------------------------------------------------------
// Field-test fix: 本地 Whisper and 系统/App 音频 both transcribe with
// Whisper, but only 本地 Whisper's own hint used to name an engine —
// 系统/App 音频 named only its audio source. Both cards' hints must now
// name BOTH halves. 系统/App 音频 itself only renders once IS_DESKTOP is
// mocked true (SettingsDialog.desktop.test.tsx), so its own copy
// assertion lives there instead of here.
// ---------------------------------------------------------------

describe("SettingsDialog — 转录引擎 ENGINE_CARDS: hint copy names both audio source and recognition backend (field-test fix)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  // Exact label match, not substring: 浏览器识别's OWN hint recommends
  // "标签页音频或本地 Whisper" as an alternative, so a plain `.includes("本地
  // Whisper")` scan (this file's usual findButtonContaining idiom) would
  // match that EARLIER card instead of the 本地 Whisper card itself.
  function findCardLabeled(label: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.querySelector(".font-medium")?.textContent === label,
    );
    if (!btn) throw new Error(`card labeled "${label}" not found`);
    return btn as HTMLButtonElement;
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, hydrated: true });
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

  it("本地 Whisper card names the mic as the source and Whisper as the backend", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const card = findCardLabeled("本地 Whisper");
    expect(card.textContent).toContain("麦克风收音，本地 Whisper 模型识别，音频不出设备");
  });
});

// ---------------------------------------------------------------
// Field-test fix: the bottom bar (StatusLine) already disables engine
// switching via isEngineControlBusy the moment a meeting is connecting/
// listening — this dialog's own engine cards used to stay enabled the
// whole time, so a mid-session pick here was silently ignored rather
// than rejected (useMeeting.ts's attachEngine only snapshots
// settings.engine at Start). "paused" is deliberately excluded (same
// isEngineControlBusy contract Header.test.ts/StatusLine.test.tsx
// already pin) — resuming from pause genuinely reconciles an engine
// change, so cards must stay pickable there.
// ---------------------------------------------------------------

describe("SettingsDialog — 转录引擎 ENGINE_CARDS lock while a meeting is connecting/listening (field-test fix)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const LOCKED_HINT = "会议进行中，无法切换引擎；暂停或结束会议后可切换";

  function findButtonContaining(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    );
    if (!btn) throw new Error(`button containing "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" }, hydrated: true });
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

  it("disables every engine card and shows the standing locked hint while connecting, and again once listening", async () => {
    useApp.setState({ status: "connecting" });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(findButtonContaining("浏览器识别").disabled).toBe(true);
    expect(findButtonContaining("Soniox 云端识别").disabled).toBe(true);
    expect(container!.textContent).toContain(LOCKED_HINT);

    await act(async () => {
      useApp.setState({ status: "listening" });
    });

    expect(findButtonContaining("浏览器识别").disabled).toBe(true);
    expect(findButtonContaining("Soniox 云端识别").disabled).toBe(true);
    expect(container!.textContent).toContain(LOCKED_HINT);
  });

  it("leaves engine cards enabled with no locked hint while paused, and again once stopped", async () => {
    useApp.setState({ status: "paused" });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    expect(findButtonContaining("浏览器识别").disabled).toBe(false);
    expect(findButtonContaining("Soniox 云端识别").disabled).toBe(false);
    expect(container!.textContent).not.toContain(LOCKED_HINT);

    await act(async () => {
      useApp.setState({ status: "stopped" });
    });

    expect(findButtonContaining("浏览器识别").disabled).toBe(false);
    expect(findButtonContaining("Soniox 云端识别").disabled).toBe(false);
    expect(container!.textContent).not.toContain(LOCKED_HINT);
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

  it("「不包含 API Key」hint enumerates Soniox Key/Deepgram Key alongside HF Token/Webhook/连接码 — matches stripKeyMaterial's own hand-listed fields (autoExport.ts)", async () => {
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
    expect(container!.textContent).toContain("Deepgram Key");
  });
});

// ---------------------------------------------------------------
// PROVIDER_PRESETS suggestedModels (field-test fix v0.4.4): global
// DEFAULT_SETTINGS.detectModel/summaryModel switched to the DeepSeek
// OpenRouter slugs (product decision) — the "anthropic" preset's own
// suggestedModels is what preserves today's claude-haiku-4-5/
// claude-sonnet-5 pre-fill for an Anthropic-direct user picking that
// preset by hand (handleSelectPreset), and "openrouter"'s own
// suggestedModels makes hand-picking that preset land on real
// OpenRouter slugs immediately, same as the OAuth button's own
// conditional remap (openrouterModelDefaults.ts) — belt-and-suspenders
// for a user who fills the preset in manually instead of using
// "一键连接 OpenRouter 账号".
// ---------------------------------------------------------------

describe("SettingsDialog — PROVIDER_PRESETS suggestedModels (field-test fix v0.4.4)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // Seeded with distinctive models, neither preset's own suggestion —
    // so a passing assertion below can only be explained by the
    // preset's OWN suggestedModels actually firing, not a coincidental
    // match with whatever DEFAULT_SETTINGS already had.
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, uiMode: "advanced", detectModel: "custom-model-x", summaryModel: "custom-model-y" },
      hydrated: true,
    });
    // useProviderModels' own debounced fetch fires once the credentials
    // block mounts — stubbed so CI never turns it into a real network
    // call (same posture SettingsDialog.desktop.test.tsx's F5 suite
    // already documents for the identical mount).
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in tests")));
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
    vi.unstubAllGlobals();
  });

  function findProviderSelect(): HTMLSelectElement {
    const label = Array.from(container!.querySelectorAll("label")).find((l) => l.textContent === "提供方");
    const select = label?.parentElement?.querySelector("select");
    if (!select) throw new Error("提供方 select not found");
    return select as HTMLSelectElement;
  }

  function modelInputValue(datalistId: string): string {
    const input = container!.querySelector(`input[list="${datalistId}"]`) as HTMLInputElement | null;
    if (!input) throw new Error(`input[list="${datalistId}"] not found`);
    return input.value;
  }

  function findBaseUrlInput(): HTMLInputElement {
    const label = Array.from(container!.querySelectorAll("label")).find((l) => l.textContent === "Base URL");
    const input = label?.parentElement?.querySelector("input");
    if (!input) throw new Error("Base URL input not found");
    return input as HTMLInputElement;
  }

  async function selectPreset(id: string): Promise<void> {
    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const aiDetectBtn = navButtons.find((b) => b.textContent === "AI 检测");
    if (!aiDetectBtn) throw new Error('nav category "AI 检测" not found');
    await act(async () => {
      aiDetectBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const select = findProviderSelect();
    await act(async () => {
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("selecting the anthropic preset fills claude-haiku-4-5/claude-sonnet-5 — preserving today's Anthropic-direct behavior via the preset instead of the (now DeepSeek-flavored) global default", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    await selectPreset("anthropic");

    expect(modelInputValue("primary-detect-options")).toBe("claude-haiku-4-5");
    expect(modelInputValue("primary-summary-options")).toBe("claude-sonnet-5");
  });

  it("selecting the openrouter preset fills the DeepSeek OpenRouter slugs (deepseek/deepseek-v4-flash + deepseek/deepseek-v4-pro)", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    await selectPreset("openrouter");

    expect(modelInputValue("primary-detect-options")).toBe("deepseek/deepseek-v4-flash");
    expect(modelInputValue("primary-summary-options")).toBe("deepseek/deepseek-v4-pro");
  });

  // Tech-debt ledger item 4 (2026-07-17): suggestedModels ids verified
  // against OpenAI's own current model listing (see PROVIDER_PRESETS'
  // own doc comment on this entry for the gpt-5-mini/gpt-5.4 -> real
  // gpt-5.6-luna/gpt-5.6-sol correction) — same suggestedModels posture
  // as the anthropic/openrouter presets above, not a bare baseUrl switch.
  it("selecting the openai preset switches provider/baseUrl to OpenAI's official endpoint and fills gpt-5.6-luna/gpt-5.6-sol", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    await selectPreset("openai");

    expect(findProviderSelect().value).toBe("openai");
    expect(findBaseUrlInput().value).toBe("https://api.openai.com/v1");
    expect(modelInputValue("primary-detect-options")).toBe("gpt-5.6-luna");
    expect(modelInputValue("primary-summary-options")).toBe("gpt-5.6-sol");
  });
});

// ---------------------------------------------------------------
// FIX 2 (field-debugging postmortem, v0.5.1 fieldtest B): baseUrl
// hygiene at the save boundary — see SettingsDialog.tsx's
// normalizeBaseUrl/isValidBaseUrl, applied in handleSave right before
// toSave is built. Same 保存-boundary-sanitization shape as the F5
// custom-font suite above, and the same AI 检测/Base URL field the
// PROVIDER_PRESETS suite right above this already exercises.
// ---------------------------------------------------------------

describe("SettingsDialog — FIX 2: Base URL is normalized/validated at 保存", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // aiDetectCredentials (the section carrying the Base URL field) is
    // advanced-tier (settingsSections.ts) — needs uiMode: "advanced" to
    // render at all, same setup the F2/flushSettings suite above uses.
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, uiMode: "advanced" }, hydrated: true });
    // useProviderModels' own debounced fetch fires once the credentials
    // block mounts — stubbed so CI never turns it into a real network
    // call, same posture the PROVIDER_PRESETS suite above documents.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in tests")));
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
    vi.unstubAllGlobals();
  });

  function findButtonByText(text: string): HTMLButtonElement {
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  function findBaseUrlInput(): HTMLInputElement {
    const label = Array.from(container!.querySelectorAll("label")).find((l) => l.textContent === "Base URL");
    const input = label?.parentElement?.querySelector("input");
    if (!input) throw new Error("Base URL input not found");
    return input as HTMLInputElement;
  }

  async function openAiDetectSection(): Promise<void> {
    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const aiDetectBtn = navButtons.find((b) => b.textContent === "AI 检测");
    if (!aiDetectBtn) throw new Error('nav category "AI 检测" not found');
    await act(async () => {
      aiDetectBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  // F3/F5 fix-round helpers: render + open the AI 检测 section, then type
  // a candidate Base URL and click 保存 — every rejected/accepted-class
  // test below just varies the URL string.
  async function renderDialog(): Promise<void> {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectSection();
  }

  async function saveWithBaseUrl(url: string): Promise<void> {
    await act(async () => {
      typeInto(findBaseUrlInput(), url);
    });
    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("full-width punctuation + surrounding whitespace (Chinese IME paste) is normalized to a clean ASCII URL on save", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectSection();

    await act(async () => {
      typeInto(findBaseUrlInput(), "  https：／／openrouter．ai／api／v1／  ");
    });
    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(useApp.getState().toast).toBe("设置已保存");
  });

  it("garbage input blocks save (toast error, dialog stays open, live settings untouched)", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={onClose} />);
    });
    await flush();
    await openAiDetectSection();

    await act(async () => {
      typeInto(findBaseUrlInput(), "not-a-url");
    });
    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().toast).toBe("Base URL 无效，请检查格式（例如 https://openrouter.ai/api/v1）");
    expect(onClose).not.toHaveBeenCalled();
    // Blocked before updateSettings ever ran — the live setting is
    // untouched, not just "the toast happened to also fire".
    expect(useApp.getState().settings.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl);
  });

  it("an already-clean URL is saved byte-identical (no rewriting beyond the documented normalizations)", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectSection();

    await act(async () => {
      typeInto(findBaseUrlInput(), "https://api.openai.com/v1");
    });
    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.baseUrl).toBe("https://api.openai.com/v1");
    expect(useApp.getState().toast).toBe("设置已保存");
  });

  it("a DISABLED taskLlm override's stale/garbage baseUrl never blocks save — resolveTaskCreds ignores it entirely once enabled:false, same as a live setting nothing will ever send", async () => {
    useApp.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        uiMode: "advanced",
        taskLlm: { translate: { enabled: false, baseUrl: "not-a-url" } },
      },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectSection();

    // No taskLlm editing at all — 保存 immediately with whatever the
    // (disabled, untouched) override the draft was seeded with.
    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().toast).toBe("设置已保存");
    expect(useApp.getState().settings.taskLlm?.translate).toEqual({ enabled: false, baseUrl: "not-a-url" });
  });

  // -------------------------------------------------------------
  // F3 (Sol MEDIUM #15, fix round): isValidBaseUrl tightened beyond a
  // bare `new URL()` success — non-http(s) schemes and a search/hash/
  // userinfo component are now rejected outright (a query-bearing base
  // would otherwise put buildOpenAiCompatRequestInit's `/chat/
  // completions` path INSIDE the query string). Ports and multi-
  // segment paths — genuinely valid provider bases — still work.
  // -------------------------------------------------------------

  it("F3: rejects a file: scheme base URL", async () => {
    await renderDialog();
    await saveWithBaseUrl("file:///etc/passwd");

    expect(useApp.getState().toast).toBe("Base URL 无效，请检查格式（例如 https://openrouter.ai/api/v1）");
    expect(useApp.getState().settings.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl);
  });

  it("F3: rejects a mailto: scheme base URL", async () => {
    await renderDialog();
    await saveWithBaseUrl("mailto:someone@example.com");

    expect(useApp.getState().toast).toBe("Base URL 无效，请检查格式（例如 https://openrouter.ai/api/v1）");
  });

  it("F3: rejects an ftp: scheme base URL", async () => {
    await renderDialog();
    await saveWithBaseUrl("ftp://host.example.com/path");

    expect(useApp.getState().toast).toBe("Base URL 无效，请检查格式（例如 https://openrouter.ai/api/v1）");
  });

  it("F3: rejects a base URL carrying a query string", async () => {
    await renderDialog();
    await saveWithBaseUrl("https://host.example.com/v1?extra=1");

    expect(useApp.getState().toast).toBe("Base URL 无效，请检查格式（例如 https://openrouter.ai/api/v1）");
  });

  it("F3: rejects a base URL carrying a fragment", async () => {
    await renderDialog();
    await saveWithBaseUrl("https://host.example.com/v1#section");

    expect(useApp.getState().toast).toBe("Base URL 无效，请检查格式（例如 https://openrouter.ai/api/v1）");
  });

  it("F3: rejects a base URL carrying userinfo (username:password@)", async () => {
    await renderDialog();
    await saveWithBaseUrl("https://user:pass@host.example.com/v1");

    expect(useApp.getState().toast).toBe("Base URL 无效，请检查格式（例如 https://openrouter.ai/api/v1）");
  });

  it("F3: still accepts a non-default port", async () => {
    await renderDialog();
    await saveWithBaseUrl("http://localhost:11434/v1");

    expect(useApp.getState().settings.baseUrl).toBe("http://localhost:11434/v1");
    expect(useApp.getState().toast).toBe("设置已保存");
  });

  it("F3: still accepts a port + multi-segment path together", async () => {
    await renderDialog();
    await saveWithBaseUrl("https://api.deepseek.com:8443/v1/custom");

    expect(useApp.getState().settings.baseUrl).toBe("https://api.deepseek.com:8443/v1/custom");
    expect(useApp.getState().toast).toBe("设置已保存");
  });

  // -------------------------------------------------------------
  // F5 (Sol hunt-note g, fix round): normalizeBaseUrl used to strip
  // ALL whitespace, including internal — `https://host/my endpoint/v1`
  // silently became `.../myendpoint/v1` with no error. isValidBaseUrl
  // now rejects internal whitespace pre-parse instead, so the user
  // sees the existing error toast rather than a silent rewrite.
  // -------------------------------------------------------------

  it("F5: rejects internal whitespace instead of silently mangling it away", async () => {
    await renderDialog();
    await saveWithBaseUrl("https://host.example.com/my endpoint/v1");

    expect(useApp.getState().toast).toBe("Base URL 无效，请检查格式（例如 https://openrouter.ai/api/v1）");
    // Never silently saved as the mangled "/myendpoint/v1" (the old
    // bug) or any other rewrite — the live setting stays untouched.
    expect(useApp.getState().settings.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl);
  });

  // -------------------------------------------------------------
  // F4 (Sol MEDIUM #16, fix round): validation only applies when the
  // EFFECTIVE provider for that field actually uses Base URL
  // (openai-compat) — anthropic hides the field entirely
  // (CredentialFields.tsx), so a stale garbage value there must never
  // block 保存. Same provider-awareness for an enabled taskLlm
  // override, resolved the exact way resolveTaskCreds does:
  // `override.provider ?? primary.provider`.
  // -------------------------------------------------------------

  it("F4: primary provider=anthropic with a stale garbage baseUrl (hidden field) never blocks save", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, uiMode: "advanced", provider: "anthropic", baseUrl: "not-a-url" },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectSection();

    // Base URL isn't even rendered for anthropic — save without
    // touching it, same pattern as the DISABLED-override test above.
    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().toast).toBe("设置已保存");
    expect(useApp.getState().settings.baseUrl).toBe("not-a-url");
  });

  it("F4: primary provider=openai-compat with a garbage baseUrl still blocks save", async () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, uiMode: "advanced", provider: "openai-compat" },
      hydrated: true,
    });
    await renderDialog();
    await saveWithBaseUrl("not-a-url");

    expect(useApp.getState().toast).toBe("Base URL 无效，请检查格式（例如 https://openrouter.ai/api/v1）");
  });

  it("F4: an ENABLED taskLlm override with an explicit anthropic provider and a garbage baseUrl never blocks save (value left as-is)", async () => {
    useApp.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        uiMode: "advanced",
        taskLlm: { translate: { enabled: true, provider: "anthropic", baseUrl: "not-a-url" } },
      },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectSection();

    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().toast).toBe("设置已保存");
    expect(useApp.getState().settings.taskLlm?.translate).toEqual({
      enabled: true,
      provider: "anthropic",
      baseUrl: "not-a-url",
    });
  });

  it("F4: an ENABLED taskLlm override with NO provider of its own inherits the primary's anthropic provider — a garbage baseUrl never blocks save either", async () => {
    useApp.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        uiMode: "advanced",
        provider: "anthropic",
        taskLlm: { translate: { enabled: true, baseUrl: "not-a-url" } },
      },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectSection();

    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().toast).toBe("设置已保存");
    expect(useApp.getState().settings.taskLlm?.translate).toEqual({ enabled: true, baseUrl: "not-a-url" });
  });

  it("F4: an ENABLED taskLlm override that inherits the primary's (default) openai-compat provider still blocks save on a garbage baseUrl", async () => {
    useApp.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        uiMode: "advanced",
        taskLlm: { translate: { enabled: true, baseUrl: "not-a-url" } },
      },
      hydrated: true,
    });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectSection();

    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().toast).toBe("Base URL 无效，请检查格式（例如 https://openrouter.ai/api/v1）");
    // Blocked before updateSettings ran — live setting is untouched.
    expect(useApp.getState().settings.taskLlm?.translate).toEqual({ enabled: true, baseUrl: "not-a-url" });
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

// ---------------------------------------------------------------
// v0.4.5 AI 检测 additions (design doc v045-ai-transparency-qc.md):
// the idiom-cap controls (settings.detectIdiomMaxWords/
// detectIdiomMaxChars, owner ruling: configurable, not a hardcoded
// constant) and the AiStatusPanel mirror mounted right after 测试连接.
// Both live in the aiDetectCredentials/aiDetectConfidence "advanced"
// rows, so uiMode:"advanced" is seeded up front (same posture as the
// PROVIDER_PRESETS suite above).
// ---------------------------------------------------------------

describe("SettingsDialog — AI 检测: idiom-cap controls + AiStatusPanel mount (v0.4.5)", () => {
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

  async function openAiDetectCategory(): Promise<void> {
    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const aiDetectBtn = navButtons.find((b) => b.textContent === "AI 检测");
    if (!aiDetectBtn) throw new Error('nav category "AI 检测" not found');
    await act(async () => {
      aiDetectBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function numberInputByLabel(label: string): HTMLInputElement {
    const labelEl = Array.from(container!.querySelectorAll("label")).find(
      (l) => l.textContent === label,
    );
    const input = labelEl?.parentElement?.querySelector('input[type="number"]');
    if (!input) throw new Error(`number input for "${label}" not found`);
    return input as HTMLInputElement;
  }

  it("renders 行话最大词数/行话最大字符数 seeded from the draft (DEFAULT_SETTINGS: 12 words / 90 chars)", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory();

    expect(numberInputByLabel("行话最大词数").value).toBe("12");
    expect(numberInputByLabel("行话最大字符数").value).toBe("90");
  });

  it("typing into either input patches draft.detectIdiomMaxWords/detectIdiomMaxChars via the same patch({...}) mechanism every other field uses", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory();

    await act(async () => {
      typeInto(numberInputByLabel("行话最大词数"), "20");
    });
    expect(numberInputByLabel("行话最大词数").value).toBe("20");

    await act(async () => {
      typeInto(numberInputByLabel("行话最大字符数"), "150");
    });
    expect(numberInputByLabel("行话最大字符数").value).toBe("150");

    // Draft-only (unsaved) — mirrors every other field's own "commits
    // on 保存" contract, not asserted again here (already covered by the
    // tag-blocker HIGH 3 suite's own draft/store split above).
    expect(useApp.getState().settings.detectIdiomMaxWords).toBe(DEFAULT_SETTINGS.detectIdiomMaxWords);
  });

  // F5 (Sol+Opus review, MAJOR/silent-failure): a blank/0/negative value
  // in either idiom-cap input used to patch straight through
  // (Number("")===0), and idiomMaxWords=0 silently drops EVERY idiom/
  // slang span app-wide. The onChange handler now only patches a
  // finite integer >= 1 — a rejected keystroke leaves the input showing
  // the last-good draft value, same as any other clamped control.
  it("rejects a blank value (input reverts to the last-good draft value, no patch)", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory();

    await act(async () => {
      typeInto(numberInputByLabel("行话最大词数"), "");
    });
    expect(numberInputByLabel("行话最大词数").value).toBe(String(DEFAULT_SETTINGS.detectIdiomMaxWords));
  });

  it("rejects a negative value", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory();

    await act(async () => {
      typeInto(numberInputByLabel("行话最大字符数"), "-5");
    });
    expect(numberInputByLabel("行话最大字符数").value).toBe(String(DEFAULT_SETTINGS.detectIdiomMaxChars));
  });

  it("rejects zero", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory();

    await act(async () => {
      typeInto(numberInputByLabel("行话最大词数"), "0");
    });
    expect(numberInputByLabel("行话最大词数").value).toBe(String(DEFAULT_SETTINGS.detectIdiomMaxWords));
  });

  it("truncates a fractional value to an integer", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory();

    await act(async () => {
      typeInto(numberInputByLabel("行话最大字符数"), "12.7");
    });
    expect(numberInputByLabel("行话最大字符数").value).toBe("12");
  });

  it("mounts AiStatusPanel (all 4 rows) right after 测试连接 in the aiDetectCredentials block", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openAiDetectCategory();

    expect(container!.querySelector('[data-testid="ai-status-panel"]')).not.toBeNull();
    for (const domain of ["detect", "define", "translate", "summary"]) {
      expect(container!.querySelector(`[data-testid="ai-status-row-${domain}"]`)).not.toBeNull();
    }

    // Right after 测试连接: the 测试连接 button and the panel share the
    // same aiDetectCredentials container.
    const testConnBtn = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "测试连接",
    );
    if (!testConnBtn) throw new Error('button "测试连接" not found');
    expect(
      testConnBtn.parentElement?.querySelector('[data-testid="ai-status-panel"]'),
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------
// S14: credential-health status chips (未配置/已配置/正常/异常) next to
// each credential row. Minimal render coverage only — every status/
// evidence-attribution rule is unit tested directly against
// lib/settings/keyStatus.ts (deriveKeyStatus/llmKeyEvidence/
// domainUsesOwnKey/primaryTelemetryDomains).
// ---------------------------------------------------------------

describe("SettingsDialog — S14 credential-health chips", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, uiMode: "advanced", apiKey: "sk-real-key" },
      hydrated: true,
    });
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
    resetLlmTelemetry();
  });

  it("renders a 已配置 chip next to the primary API Key row once apiKey is set with no telemetry evidence yet", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const aiDetectBtn = navButtons.find((b) => b.textContent === "AI 检测");
    if (!aiDetectBtn) throw new Error('nav category "AI 检测" not found');
    await act(async () => {
      aiDetectBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const chips = Array.from(container!.querySelectorAll('[data-testid="key-status-chip"]'));
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.some((c) => c.textContent === "已配置")).toBe(true);
  });

  it("renders no chip at all for the empty primary key (未配置 is still shown, just via deriveKeyStatus's own unconfigured branch)", async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, uiMode: "advanced", apiKey: "" }, hydrated: true });
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const aiDetectBtn = navButtons.find((b) => b.textContent === "AI 检测");
    if (!aiDetectBtn) throw new Error('nav category "AI 检测" not found');
    await act(async () => {
      aiDetectBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const chips = Array.from(container!.querySelectorAll('[data-testid="key-status-chip"]'));
    expect(chips.some((c) => c.textContent === "未配置")).toBe(true);
  });

  // FINDING 5 (S14 fix round): stale evidence attribution — test key A,
  // paste key B must not let B's chip immediately inherit A's 正常. The
  // saved settings' apiKey ("sk-real-key", seeded by beforeEach above)
  // matches the draft at open time, so the mocked telemetry success
  // legitimately backs 正常 first; editing the draft key away from the
  // saved value must cap the chip back at 已配置 (credsMatch no longer
  // holds), even though the telemetry success is still sitting there.
  it("editing the draft key after a saved-key success drops the chip from 正常 to 已配置", async () => {
    recordLlmCall("detect", "ok");
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const aiDetectBtn = navButtons.find((b) => b.textContent === "AI 检测");
    if (!aiDetectBtn) throw new Error('nav category "AI 检测" not found');
    await act(async () => {
      aiDetectBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const apiKeyInput = container!.querySelector('input[placeholder="sk-…"]') as HTMLInputElement | null;
    if (!apiKeyInput) throw new Error("primary API Key input not found");

    let chips = Array.from(container!.querySelectorAll('[data-testid="key-status-chip"]'));
    expect(chips.some((c) => c.textContent === "正常")).toBe(true);

    await act(async () => {
      typeInto(apiKeyInput, "sk-different-draft-key");
    });

    chips = Array.from(container!.querySelectorAll('[data-testid="key-status-chip"]'));
    expect(chips.some((c) => c.textContent === "已配置")).toBe(true);
    expect(chips.some((c) => c.textContent === "正常")).toBe(false);
    expect(chips.some((c) => c.textContent === "异常")).toBe(false);
  });
});

// v0.5.1 desktop keychain custody design — web (IS_DESKTOP false, this
// file's own ambient default) keeps the BYTE-IDENTICAL prior apiKeyHint
// copy; the desktop-only Keychain hint is pinned separately in
// SettingsDialog.desktop.test.tsx (needs IS_DESKTOP mocked true, a
// module-scope import-time const — same file-split constraint that
// file's own header comment documents).
describe("SettingsDialog — primary API Key hint stays the pre-migration web copy (v0.5.1 desktop keychain migration)", () => {
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

  it("shows the original 仅存于本机浏览器 hint, never the desktop Keychain copy", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const aiDetectBtn = navButtons.find((b) => b.textContent === "AI 检测");
    if (!aiDetectBtn) throw new Error('nav category "AI 检测" not found');
    await act(async () => {
      aiDetectBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container!.textContent).toContain(
      "仅存于本机浏览器；调用时经应用接口内存转发，不落盘（env-first 见 README）",
    );
    expect(container!.textContent).not.toContain("系统钥匙串");
  });
});

// ---------------------------------------------------------------
// v0.5.1 appearance sprint fix round (GPT-5.6 Sol adversarial review,
// F2/F3) + an Opus test-gap addendum pinning the D1 write-through
// contract (theme CRUD writes straight through updateSettings, never
// staged in the dialog draft — see SettingsDialog.tsx's own
// handleSaveCustomTheme doc comment).
// ---------------------------------------------------------------

describe("SettingsDialog — F2: deleting the LIVE active custom theme resets settings.themeId, not just the draft", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        customThemes: [{ id: "custom-mine", label: "我的主题", scheme: "dark", tokens: CLARITY_THEME.tokens }],
        themeId: "custom-mine",
      },
      hydrated: true,
    });
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

  it("deleting the tile that IS settings.themeId falls back to terminal in the STORE (not just the dialog's own draft.themeId)", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const displayBtn = navButtons.find((b) => b.textContent === "显示");
    if (!displayBtn) throw new Error('nav category "显示" not found');
    await act(async () => {
      displayBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const editBtn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === "编辑");
    if (!editBtn) throw new Error('theme tile "编辑" button not found');
    await act(async () => {
      editBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const deleteBtn = () =>
      Array.from(container!.querySelectorAll("button")).find((b) => b.textContent?.includes("删除"))!;
    await act(async () => {
      deleteBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      deleteBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.themeId).toBe("terminal");
    expect(useApp.getState().settings.customThemes.some((t) => t.id === "custom-mine")).toBe(false);
  });
});

describe("SettingsDialog — F3: two theme-file imports resolving out of order both land (no last-write-wins drop)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: true });
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
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  // A real File whose own .text() is a manually-controlled deferred
  // promise — lets the test resolve two in-flight imports in whichever
  // order it wants, rather than depending on real async file-read
  // timing.
  function deferredFile(name: string, json: string) {
    const file = new File([json], name, { type: "application/json" });
    let resolve!: () => void;
    const promise = new Promise<string>((res) => {
      resolve = () => res(json);
    });
    Object.defineProperty(file, "text", { value: () => promise, configurable: true });
    return { file, resolve };
  }

  // input.files is read-only on a real <input> — Object.defineProperty
  // is the standard test-only bypass (component only ever reads
  // e.target.files?.[0], a plain array satisfies that).
  function pickFile(input: HTMLInputElement, file: File) {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("both themes survive when the file picked SECOND finishes reading FIRST", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const displayBtn = navButtons.find((b) => b.textContent === "显示");
    if (!displayBtn) throw new Error('nav category "显示" not found');
    await act(async () => {
      displayBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      findButtonByText("展开").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const fileInput = container!.querySelector('input[type="file"]') as HTMLInputElement;
    if (!fileInput) throw new Error("theme file input not found");

    const fileA = deferredFile("a.json", JSON.stringify({ ...CLARITY_THEME, id: "whatever-a", label: "主题A" }));
    const fileB = deferredFile("b.json", JSON.stringify({ ...CLARITY_THEME, id: "whatever-b", label: "主题B" }));

    // Picking file B re-uses the SAME <input> (e.target.value is reset
    // to "" on every change, explicitly to allow this) — both reads
    // start in flight before either resolves.
    await act(async () => {
      pickFile(fileInput, fileA.file);
    });
    await act(async () => {
      pickFile(fileInput, fileB.file);
    });

    // Out-of-order completion: the SECOND file picked finishes reading
    // FIRST — the exact race the pre-fix `settings` closure lost.
    fileB.resolve();
    await flush();
    fileA.resolve();
    await flush();

    const labels = useApp.getState().settings.customThemes.map((t) => t.label);
    expect(labels).toContain("主题A");
    expect(labels).toContain("主题B");
    expect(useApp.getState().settings.customThemes.length).toBe(2);
  });
});

describe("SettingsDialog — D1 contract: importing a theme then 取消 leaves the import in the store (write-through, not draft-staged)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  function typeIntoTextarea(el: HTMLTextAreaElement, value: string) {
    nativeTextareaValueSetter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: true });
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
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  it("解析并导入 writes through immediately; a later 取消 (never touching draft/保存) does not revert it", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const displayBtn = navButtons.find((b) => b.textContent === "显示");
    if (!displayBtn) throw new Error('nav category "显示" not found');
    await act(async () => {
      displayBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      findButtonByText("展开").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const textarea = container!.querySelector(
      'textarea[placeholder="或粘贴主题 JSON…"]',
    ) as HTMLTextAreaElement;
    if (!textarea) throw new Error("theme JSON textarea not found");
    await act(async () => {
      typeIntoTextarea(textarea, JSON.stringify({ ...CLARITY_THEME, id: "whatever", label: "导入的主题" }));
    });
    await act(async () => {
      findButtonByText("解析并导入").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.customThemes.some((t) => t.label === "导入的主题")).toBe(true);

    await act(async () => {
      findButtonByText("取消").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.customThemes.some((t) => t.label === "导入的主题")).toBe(true);
  });
});

// F5 (v0.5.1 appearance sprint, GPT-5.6 Sol adversarial review): the
// 自定义 font text inputs stored the RAW typed text into the draft —
// sanitizeFontFamily (lib/theme/fonts.ts) only ever ran at CSS-
// application time, so a quoted/`;`-laced payload round-tripped through
// Settings/export unsanitized while only ever RENDERING the sanitized
// form, and an empty `custom:` persisted forever instead of visually
// falling back to "default".
describe("SettingsDialog — F5: custom font values are sanitized at 保存, not left raw", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: true });
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
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  // Scopes to the 界面字体 block specifically — 等宽字体 right below it
  // renders an identically-labeled 自定义 button, both go through the
  // SAME shared sanitizeDraftFontValue at 保存.
  function uiFontSection(): HTMLElement {
    const label = Array.from(container!.querySelectorAll("label")).find((l) => l.textContent === "界面字体");
    if (!label) throw new Error('"界面字体" label not found');
    return label.parentElement as HTMLElement;
  }

  async function openUiFontCustomInput(): Promise<HTMLInputElement> {
    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const displayBtn = navButtons.find((b) => b.textContent === "显示");
    if (!displayBtn) throw new Error('nav category "显示" not found');
    await act(async () => {
      displayBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const section = uiFontSection();
    const customBtn = Array.from(section.querySelectorAll("button")).find((b) => b.textContent === "自定义");
    if (!customBtn) throw new Error('"自定义" button not found in 界面字体 section');
    await act(async () => {
      customBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const input = section.querySelector('input[type="text"]') as HTMLInputElement | null;
    if (!input) throw new Error("custom uiFont text input not found");
    return input;
  }

  it('save with custom:\'"Fira";x\' stores the sanitized form (custom:Firax), not the raw quoted/semicolon payload', async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    const input = await openUiFontCustomInput();
    await act(async () => {
      typeInto(input, '"Fira";x');
    });
    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.uiFont).toBe("custom:Firax");
  });

  it("save with an empty custom: family falls back to \"default\" instead of persisting a dangling custom: prefix", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();

    // Freshly opened, the custom field is already empty (draft.uiFont
    // === "custom:", untyped) — the exact "custom: with empty family"
    // shape the finding describes; no need to type anything.
    await openUiFontCustomInput();
    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.uiFont).toBe("default");
  });
});

describe("SettingsDialog — Bit 装扮 picker (v0.5.1 Bit sprint, Lane B)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: true });
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
    const btn = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn as HTMLButtonElement;
  }

  // Scopes to the Bit 装扮 block specifically, mirrors uiFontSection()'s
  // own "find by label text, use its parent" approach above.
  function bitCostumeSection(): HTMLElement {
    const label = Array.from(container!.querySelectorAll("label")).find((l) => l.textContent === "Bit 装扮");
    if (!label) throw new Error('"Bit 装扮" label not found');
    return label.parentElement as HTMLElement;
  }

  async function openDisplayCategory(): Promise<void> {
    const navButtons = Array.from(
      container!.querySelectorAll('nav[aria-label="设置分类"] button'),
    ) as HTMLButtonElement[];
    const displayBtn = navButtons.find((b) => b.textContent === "显示");
    if (!displayBtn) throw new Error('nav category "显示" not found');
    await act(async () => {
      displayBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("renders exactly 9 options — 跟随主题 + 原装 + the 7 BIT_COSTUME_LABELS entries, in registry order", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openDisplayCategory();

    const section = bitCostumeSection();
    const labels = Array.from(section.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["跟随主题", "原装", ...Object.values(BIT_COSTUME_LABELS)]);
  });

  it("clicking a costume option patches the draft, applied to settings on 保存 (not write-through)", async () => {
    await act(async () => {
      root!.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
    await flush();
    await openDisplayCategory();

    const section = bitCostumeSection();
    const douliBtn = Array.from(section.querySelectorAll("button")).find(
      (b) => b.textContent === BIT_COSTUME_LABELS.douli,
    );
    if (!douliBtn) throw new Error("斗笠 button not found in Bit 装扮 section");
    await act(async () => {
      douliBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Still a draft edit — normal 保存 flow, exactly like uiFont — so the
    // live store hasn't moved yet until 保存 is clicked.
    expect(useApp.getState().settings.bitCostume).toBe("auto");

    await act(async () => {
      findButtonByText("保存").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.bitCostume).toBe("douli");
  });
});
