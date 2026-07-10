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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "../../lib/store";
import { DEFAULT_SETTINGS, type Settings } from "../../lib/types";
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
