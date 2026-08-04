// @vitest-environment jsdom
//
// AppUpdateBanner — field-fix #8 v2. IS_DESKTOP mocked true (module-scope
// import-time const, same reason TaskCenterDrawer.desktop.test.tsx lives
// in its own file rather than a describe block — see that file's own
// header comment). shouldShowUpdateBanner itself already has thorough
// pure-logic coverage in lib/desktop/__tests__/updateCheck.test.ts; this
// file only checks THIS component's wiring to it plus the two actions
// (openExternal, 忽略 writing appUpdateDismissedVersion) — real stores,
// no store mocking. mocking @/lib/platform/desktop's IS_DESKTOP also
// flips ios.ts's own IS_TAURI (= IS_DESKTOP || IS_IOS) true for this
// whole file's module graph, so openExternal would otherwise take the
// REAL Tauri-opener branch and throw outside an actual Tauri build —
// tauriApi's getOpener is mocked too, same precedent as TaskCenterDrawer.
// desktop.test.tsx's own identical setup (see that file's own comment).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/platform/desktop", () => ({ IS_DESKTOP: true }));

const mockOpenUrl = vi.fn(async (_url: string) => {});
vi.mock("@/lib/desktop/tauriApi", () => ({
  getOpener: async () => (url: string) => mockOpenUrl(url),
}));

import AppUpdateBanner from "../AppUpdateBanner";
import { useApp } from "@/lib/store";
import { useUpdateCheck } from "@/lib/desktop/updateCheck";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";

describe("AppUpdateBanner — desktop-only", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    useUpdateCheck.setState({
      status: "idle",
      currentVersion: "",
      latestVersion: undefined,
      url: undefined,
      checkedAt: undefined,
    });
    useApp.setState({ settings: { ...DEFAULT_SETTINGS } });
    mockOpenUrl.mockClear();
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
  });

  function mount() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<AppUpdateBanner />);
    });
  }

  it("renders nothing when no update has been found", () => {
    mount();
    expect(container!.textContent).toBe("");
  });

  it("shows 发现新版本 + both actions once status is available", () => {
    useUpdateCheck.setState({
      status: "available",
      currentVersion: "0.4.1",
      latestVersion: "v0.5.0",
      url: "https://example.com/v0.5.0",
    });
    mount();

    expect(container!.textContent).toContain("发现新版本 v0.5.0");
    expect(container!.querySelector('[data-testid="app-update-banner-open"]')).toBeTruthy();
    expect(container!.querySelector('[data-testid="app-update-banner-dismiss"]')).toBeTruthy();
  });

  it("打开下载页 opens the found release URL via the system opener", async () => {
    useUpdateCheck.setState({
      status: "available",
      currentVersion: "0.4.1",
      latestVersion: "v0.5.0",
      url: "https://example.com/v0.5.0",
    });
    mount();

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[data-testid="app-update-banner-open"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com/v0.5.0");
  });

  it("忽略 records appUpdateDismissedVersion and hides the banner immediately", () => {
    useUpdateCheck.setState({
      status: "available",
      currentVersion: "0.4.1",
      latestVersion: "v0.5.0",
      url: "https://example.com/v0.5.0",
    });
    mount();

    act(() => {
      container!
        .querySelector<HTMLButtonElement>('[data-testid="app-update-banner-dismiss"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useApp.getState().settings.appUpdateDismissedVersion).toBe("v0.5.0");
    expect(container!.textContent).toBe("");
  });

  it("a NEWER version shows again even though an older one was already dismissed — non-nag, not silence-forever", () => {
    useApp.setState((s) => ({ settings: { ...s.settings, appUpdateDismissedVersion: "v0.5.0" } }));
    useUpdateCheck.setState({
      status: "available",
      currentVersion: "0.4.1",
      latestVersion: "v0.6.0",
      url: "https://example.com/v0.6.0",
    });
    mount();

    expect(container!.textContent).toContain("发现新版本 v0.6.0");
  });
});
