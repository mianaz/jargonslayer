// @vitest-environment jsdom
//
// ModeSelector — ambient (web, full tier) coverage. v0.5 Wave-1 Feature 5
// (mode-first UI, docs/design-explorations/v05-wave1-blueprint.md §1
// Feature 5 + §5 A3/A4). IS_DESKTOP/IS_IOS are module-scope import-time
// consts — this file exercises the REAL (both false, i.e. "web") ambient
// values, mirroring StatusLine.test.tsx/engineOptions.test.ts's own
// "ambient env" split; ModeSelector.desktop.test.tsx/ModeSelector.ios.
// test.tsx cover the other two platforms with vi.mock. useOsSpeechCaps
// is left REAL here (safe — IS_TAURI is genuinely false in this ambient
// env, so its own probe fails open without ever reaching tauriApi.ts;
// see engineOptions.deriveEngineForMode.test.ts's own osspeech-floor
// coverage for the desktop-only branch that actually needs the cache
// primed).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "@/lib/store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import ModeSelector, { visibleModeTileKeys } from "../ModeSelector";

function resetStore() {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, mode: "import" } });
}

describe("ModeSelector — web build, ambient test env", () => {
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

  function render(onOpenImport: (tab: "file" | "text" | "url") => void = () => {}) {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<ModeSelector onOpenImport={onOpenImport} />);
    });
  }

  function tile(key: string): HTMLButtonElement {
    const el = container!.querySelector(`[data-testid="mode-tile-${key}"]`);
    if (!el) throw new Error(`tile ${key} not found`);
    return el as HTMLButtonElement;
  }

  it("web (not desktop, not iOS): shows tab/mic/import/url — no system-audio tile (§1 F5: browser has no system-audio capture)", () => {
    resetStore();
    render();
    expect(container!.querySelector('[data-testid="mode-tile-system-audio"]')).toBeNull();
    expect(container!.querySelector('[data-testid="mode-tile-tab"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="mode-tile-mic"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="mode-tile-import"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="mode-tile-url"]')).not.toBeNull();
  });

  it("clicking 用麦克风 writes mode:mic AND derives+writes engine (default settings -> webspeech)", () => {
    resetStore();
    render();
    act(() => {
      tile("mic").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.mode).toBe("mic");
    expect(useApp.getState().settings.engine).toBe("webspeech");
  });

  it("clicking 听浏览器标签页 writes mode:tab AND derives tabaudio (no BYOK key configured)", () => {
    resetStore();
    render();
    act(() => {
      tile("tab").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.mode).toBe("tab");
    expect(useApp.getState().settings.engine).toBe("tabaudio");
  });

  it("clicking 听浏览器标签页 derives tabaudio-cloud once the matching BYOK key exists", () => {
    useApp.setState({
      settings: { ...DEFAULT_SETTINGS, mode: "import", tabAudioCloudProvider: "soniox", sonioxKey: "sk-x" },
    });
    render();
    act(() => {
      tile("tab").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useApp.getState().settings.engine).toBe("tabaudio-cloud");
  });

  it("import/url tiles call onOpenImport at the right tab and do NOT write settings.mode/engine themselves", () => {
    resetStore();
    const onOpenImport = vi.fn();
    render(onOpenImport);
    const before = useApp.getState().settings;

    act(() => {
      tile("import").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenImport).toHaveBeenCalledWith("file");

    act(() => {
      tile("url").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenImport).toHaveBeenCalledWith("url");
    expect(useApp.getState().settings).toEqual(before);
  });

  it("selected tile is visually marked from settings.mode (border-act)", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, mode: "tab" } });
    render();
    expect(tile("tab").className).toContain("border-act");
    expect(tile("mic").className).not.toContain("border-act");
  });

  it("shows the '已选 X · 引擎：Y' hint once a capture mode + a real engine are set, absent for import/url modes", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, mode: "mic", engine: "webspeech" } });
    render();
    const hint = container!.querySelector('[data-testid="mode-selector-hint"]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe("已选 麦克风 · 引擎：浏览器识别（可在底栏更换）");
  });

  it("hint is absent for import/url modes (no live engine to report)", () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, mode: "import" } });
    render();
    expect(container!.querySelector('[data-testid="mode-selector-hint"]')).toBeNull();
  });

  it("hint is absent on a fresh install (mode:mic default, engine still 'demo' — nothing picked yet)", () => {
    useApp.setState({ settings: DEFAULT_SETTINGS });
    render();
    expect(container!.querySelector('[data-testid="mode-selector-hint"]')).toBeNull();
  });
});

// ITEM 1 (fix round, Sol#3): visibleModeTileKeys as a pure function —
// PREVIEW_TIER is an import-time const nothing in this repo mocks (see
// engineOptions.test.ts's own header comment on the identical
// constraint), so the preview-tier omission is pinned here via an
// explicit `isPreview` param instead of a live render + a deployTier
// mock the repo has no precedent for.
describe("visibleModeTileKeys — ITEM 1: preview tier omits the tab tile (never disabled)", () => {
  it("web, full tier: tab and url both present", () => {
    const keys = visibleModeTileKeys({ isDesktop: false, isIos: false, isPreview: false });
    expect(keys).toEqual(["tab", "mic", "import", "url"]);
  });

  it("web, preview tier: tab and url both ABSENT — never silently becomes a mic tile", () => {
    const keys = visibleModeTileKeys({ isDesktop: false, isIos: false, isPreview: true });
    expect(keys).not.toContain("tab");
    expect(keys).not.toContain("url");
    expect(keys).toEqual(["mic", "import"]);
  });

  it("desktop: system-audio present, tab never present regardless of tier (desktop never had a tab tile)", () => {
    expect(visibleModeTileKeys({ isDesktop: true, isIos: false, isPreview: false })).toEqual([
      "system-audio",
      "mic",
      "import",
      "url",
    ]);
    expect(visibleModeTileKeys({ isDesktop: true, isIos: false, isPreview: true })).toEqual([
      "system-audio",
      "mic",
      "import",
    ]);
  });

  it("iOS: mic+import only regardless of tier (tab/url/system-audio never applicable)", () => {
    expect(visibleModeTileKeys({ isDesktop: false, isIos: true, isPreview: false })).toEqual([
      "mic",
      "import",
    ]);
    expect(visibleModeTileKeys({ isDesktop: false, isIos: true, isPreview: true })).toEqual([
      "mic",
      "import",
    ]);
  });
});
