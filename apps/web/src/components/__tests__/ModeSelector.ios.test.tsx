// @vitest-environment jsdom
//
// ModeSelector — iOS-only coverage (blueprint §3 Q2 verbatim: "iOS shows
// only 麦克风 + 导入"). IS_IOS is a module-scope import-time const —
// vi.mock affects this whole file, mirroring engineOptions.ios.test.ts/
// TutorialOverlay.ios.test.tsx's own split.
//
// osspeechCaps' useOsSpeechCaps is mocked to a no-op (mirrors
// ModeSelector.desktop.test.tsx's own identical mock): vi.mock(
// "@/lib/platform/ios", ...) REPLACES that entire module's exports,
// including IS_TAURI, with exactly the object below — osspeechCaps.ts's
// own `import { IS_TAURI } from "../platform/ios"` then resolves to a
// genuinely UNDEFINED binding, and Vitest's mock interop throws ("No
// IS_TAURI export is defined on the mock") the instant that binding is
// READ inside probeOsSpeechCaps() — verified empirically (this file
// crashed without the mock below before it was added), not assumed.

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

vi.mock("@/lib/platform/ios", () => ({ IS_IOS: true }));
vi.mock("@/lib/desktop/osspeechCaps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop/osspeechCaps")>();
  return { ...actual, useOsSpeechCaps: () => null };
});

import { useApp } from "@/lib/store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import ModeSelector from "../ModeSelector";

function resetStore() {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, mode: "import" } });
}

describe("ModeSelector — iOS build", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

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

  it("shows ONLY 麦克风 + 导入 — no system-audio/tab/url tile (v1 mic-only capture, no sidecar to reach for 链接)", () => {
    resetStore();
    render();
    expect(container!.querySelector('[data-testid="mode-tile-system-audio"]')).toBeNull();
    expect(container!.querySelector('[data-testid="mode-tile-tab"]')).toBeNull();
    expect(container!.querySelector('[data-testid="mode-tile-url"]')).toBeNull();
    expect(container!.querySelector('[data-testid="mode-tile-mic"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="mode-tile-import"]')).not.toBeNull();
  });

  it("用麦克风 always derives osspeech (v1's only engine)", () => {
    resetStore();
    render();
    act(() => {
      tile("mic").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.mode).toBe("mic");
    expect(useApp.getState().settings.engine).toBe("osspeech");
  });
});
