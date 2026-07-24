// @vitest-environment jsdom
//
// Quit-time settings flush (field fix): an API key saved shortly before
// quitting the desktop/Tauri (WKWebView) app was lost — updateSettings'
// own persist is a fire-and-forget storage.saveSettings write, and
// WKWebView can drop an uncommitted IndexedDB write on app teardown
// (WebKit bug 199854 — see useMeeting.ts's own live-draft pagehide/
// visibilitychange flush, which hydrate()'s listener install mirrors).
// This pins the DOM-side listener wiring specifically; flushSettings'
// own promise-chaining contract is covered separately in store.test.ts
// (no jsdom needed there). Needs a real `window`/`document` to dispatch
// against — kept in its own file rather than folded into
// store.appearanceSettings.test.ts, which is a DIFFERENT hydrate()-side-
// effect concern (theme/font/glass) with its own shared setup.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../store";
import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import * as storageModule from "../history/storage";

beforeEach(() => {
  useApp.setState({ settings: DEFAULT_SETTINGS, hydrated: false, demoOverlayPrevEngine: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hydrate() — quit-time settings flush listeners", () => {
  it("a pagehide event flushes the CURRENT live settings", async () => {
    await useApp.getState().hydrate();
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" } });

    window.dispatchEvent(new Event("pagehide"));

    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ engine: "webspeech" }));
  });

  it("a visibilitychange to hidden ALSO flushes current settings", async () => {
    await useApp.getState().hydrate();
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "tabaudio" } });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });

    document.dispatchEvent(new Event("visibilitychange"));

    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ engine: "tabaudio" }));
  });

  it("does NOT flush on a visibilitychange while still visible", async () => {
    await useApp.getState().hydrate();
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    document.dispatchEvent(new Event("visibilitychange"));

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("installs the listeners only ONCE — repeated hydrate() calls never stack a second pagehide handler", async () => {
    await useApp.getState().hydrate();
    await useApp.getState().hydrate(); // must not double-install
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    window.dispatchEvent(new Event("pagehide"));

    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  // F1 fix (Sol + Opus review, BLOCK): every test above awaits hydrate()
  // BEFORE dispatching — exactly how this was missed in the field.
  // hydrate()'s listener-install prefix runs synchronously (before its
  // first `await`), so calling hydrate() WITHOUT awaiting and dispatching
  // immediately after lands the event squarely in the pre-hydration
  // window: listeners are already live, but get().hydrated is still
  // false and get().settings is still DEFAULT_SETTINGS. Before the fix,
  // flush() -> flushSettings() would persist THAT (defaults) straight
  // over the user's real saved blob — API keys/engine/theme lost.
  it("a pagehide firing BEFORE hydrate() resolves must NOT overwrite the saved settings blob with defaults", async () => {
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);

    const hydrating = useApp.getState().hydrate(); // listeners install synchronously, then suspends
    expect(useApp.getState().hydrated).toBe(false); // still mid-hydration — the exact bug window

    window.dispatchEvent(new Event("pagehide"));

    expect(saveSpy).not.toHaveBeenCalled();

    await hydrating; // let hydrate() finish so it doesn't bleed into a later test
  });

  // Demo-overlay stash (field-test round, extends S14.1): a quit mid-demo
  // is exactly the durability gap the quit-time flush exists for — the
  // flush must not undo the overlay by re-baking the live "demo" value
  // into storage. See store.test.ts's own "demo-overlay stash" describe
  // block for the flushSettings-call-site half of this (no DOM needed
  // there); this pins the actual pagehide dispatch.
  it("a pagehide DURING an active demo overlay flushes the STASHED engine, not \"demo\"", async () => {
    await useApp.getState().hydrate();
    const saveSpy = vi.spyOn(storageModule, "saveSettings").mockResolvedValue(undefined);
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, engine: "webspeech" } });
    useApp.getState().beginDemoOverlay();
    expect(useApp.getState().settings.engine).toBe("demo"); // live UI shows the demo

    window.dispatchEvent(new Event("pagehide"));

    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ engine: "webspeech" }));
  });
});
