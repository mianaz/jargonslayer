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
// engine is whisper/tabaudio, mirrors the result into store.sidecarUp
// for StatusLine's tooltip, and offers a 重新检测 refresh. Mocks fetch
// (not probeSidecar) so this exercises the real component + real probe
// function, matching this file's own "mount the real component" header
// comment.
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
