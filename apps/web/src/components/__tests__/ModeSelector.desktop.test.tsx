// @vitest-environment jsdom
//
// ModeSelector — desktop-only coverage. IS_DESKTOP is a module-scope
// import-time const — vi.mock affects this whole file, so this lives in
// its own file rather than a describe block inside ModeSelector.test.tsx
// (which needs the REAL, false value for its own ambient/web coverage) —
// same split SettingsDialog.desktop.test.tsx/engineOptions.desktop.
// test.ts already established for the identical constraint.
//
// osspeechCaps' useOsSpeechCaps is mocked to a no-op (mirrors
// SettingsDialog.desktop.test.tsx's own identical mock + doc comment):
// with IS_DESKTOP mocked true here (and "@/lib/platform/ios" left REAL),
// that module's own IS_TAURI recomputes true, which would otherwise send
// ModeSelector's mount-time useOsSpeechCaps() into tauriApi.ts's
// getInvoke() — which throws SYNCHRONOUSLY outside an actual
// NEXT_PUBLIC_DESKTOP=1 build. isOsSpeechFloorLocked/getOsSpeechCapsSnapshot/
// probeOsSpeechCapabilitiesWith/resetOsSpeechCapsCache are left REAL
// (importOriginal) — deriveEngineForMode's own floor-branch tests below
// exercise the genuine gating logic, not a stand-in.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

vi.mock("@/lib/platform/desktop", () => ({ IS_DESKTOP: true }));
vi.mock("@/lib/desktop/osspeechCaps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop/osspeechCaps")>();
  return { ...actual, useOsSpeechCaps: () => null };
});

import { useApp } from "@/lib/store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import {
  probeOsSpeechCapabilitiesWith,
  resetOsSpeechCapsCache,
  type OsSpeechCapabilities,
} from "@/lib/desktop/osspeechCaps";
import type { InvokeFn } from "@/lib/desktop/tauriApi";
import ModeSelector from "../ModeSelector";

function fakeInvoke(handler: () => unknown): InvokeFn {
  return (async () => handler()) as InvokeFn;
}

async function setOsSpeechFloor(supported: boolean): Promise<void> {
  const caps: OsSpeechCapabilities = {
    supported,
    reason: supported ? null : "需要 macOS 26 或更高版本",
    locales: [],
    installedLocales: [],
  };
  await probeOsSpeechCapabilitiesWith(fakeInvoke(() => caps));
}

function resetStore() {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, mode: "import" } });
}

describe("ModeSelector — desktop build", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => resetOsSpeechCapsCache());

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    resetStore();
    resetOsSpeechCapsCache();
  });

  function render() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<ModeSelector onOpenImport={() => {}} />);
    });
  }

  function tile(key: string): HTMLButtonElement {
    const el = container!.querySelector(`[data-testid="mode-tile-${key}"]`);
    if (!el) throw new Error(`tile ${key} not found`);
    return el as HTMLButtonElement;
  }

  it("shows system-audio/mic/import/url — no tab tile (D7: WKWebView has no tab-share picker)", () => {
    resetStore();
    render();
    expect(container!.querySelector('[data-testid="mode-tile-tab"]')).toBeNull();
    expect(container!.querySelector('[data-testid="mode-tile-system-audio"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="mode-tile-mic"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="mode-tile-import"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="mode-tile-url"]')).not.toBeNull();
  });

  it("听本机会议声音: osspeech floor met -> mode:system-audio, engine:osspeech", async () => {
    await setOsSpeechFloor(true);
    resetStore();
    render();
    act(() => {
      tile("system-audio").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.mode).toBe("system-audio");
    expect(useApp.getState().settings.engine).toBe("osspeech");
  });

  it("听本机会议声音: osspeech floor NOT met -> engine:appaudio", async () => {
    await setOsSpeechFloor(false);
    resetStore();
    render();
    act(() => {
      tile("system-audio").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.engine).toBe("appaudio");
  });

  it("用麦克风: osspeech floor NOT met -> engine:whisper (never appaudio — that's system audio, not mic)", async () => {
    await setOsSpeechFloor(false);
    resetStore();
    render();
    act(() => {
      tile("mic").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.mode).toBe("mic");
    expect(useApp.getState().settings.engine).toBe("whisper");
  });
});
