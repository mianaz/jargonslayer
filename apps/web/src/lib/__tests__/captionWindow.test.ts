// @vitest-environment jsdom
//
// captionWindow.ts — pure/deps-injected coverage, plus the two hosts'
// own race-prone bits (S14 fix-round findings 1/3/4). jsdom has no REAL
// Document Picture-in-Picture API (supportsDocumentPip's own tests
// below cover that absence directly, the same absent path Header.tsx's
// menu-entry gate hides behind) — but useCaptionPip's own lifecycle/
// race handling IS covered, by stubbing `window.documentPictureInPicture`
// with a fake `requestWindow`. The desktop enter/exit sequencing
// (finding 1+3's module-level queue + generation serialization) is
// covered via enterDesktopCaptionModeWith/exitDesktopCaptionModeWith's
// deps injection (mirrors lib/desktop/updateCheck.ts's own
// checkAppUpdateWith split) against a fake MainWindowApi, so it's
// testable without a real Tauri runtime.

import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import {
  CAPTION_STRIP_HEIGHT,
  CAPTION_STRIP_WIDTH,
  copyStylesInto,
  enterDesktopCaptionMode,
  enterDesktopCaptionModeWith,
  exitDesktopCaptionMode,
  exitDesktopCaptionModeWith,
  resetCaptionWindowStateForTests,
  supportsDocumentPip,
  useCaptionPip,
  type CaptionPipHandle,
} from "../captionWindow";
import * as tauriApiModule from "../desktop/tauriApi";
import type { MainWindowApi, WindowRect } from "../desktop/tauriApi";

// Shared across the desktop-host (findings 1+3) and useCaptionPip
// (finding 4) race tests below.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
// setTimeout-based flush (not a fixed number of `await Promise.resolve()`
// ticks) — reliably drains every pending microtask regardless of how
// many `.then()`/`await` links a queued task chains through. Mirrors
// useMeeting.lifecycle.test.tsx's own `flush` helper.
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  // Module-level queue/rect/generation state (findings 1+3) must never
  // leak between independent `it()` blocks, in this describe or any
  // other in this file.
  resetCaptionWindowStateForTests();
});

describe("supportsDocumentPip — pure feature-detect", () => {
  it("false for a plain object with no documentPictureInPicture property", () => {
    expect(supportsDocumentPip({})).toBe(false);
  });

  it("false for the real jsdom `window` global — the absent path this whole feature hides behind", () => {
    expect(supportsDocumentPip(window)).toBe(false);
  });

  it("true once a documentPictureInPicture property exists, regardless of its value", () => {
    expect(supportsDocumentPip({ documentPictureInPicture: {} })).toBe(true);
    expect(supportsDocumentPip({ documentPictureInPicture: undefined })).toBe(true);
  });
});

// jsdom doesn't fetch external <link> resources by default, so a real
// <link rel=stylesheet> never actually gets an entry in
// `document.styleSheets` here (only inline <style> tags do) — a fake
// `styleSheets` list (real elements as ownerNode, fake list container)
// sidesteps that environment quirk and exercises copyStylesInto's own
// two branches directly, independent of jsdom's resource loading.
function fakeSourceDoc(ownerNodes: (Element | null)[]): Document {
  return { styleSheets: ownerNodes.map((ownerNode) => ({ ownerNode })) } as unknown as Document;
}

describe("copyStylesInto — clones stylesheets into a target document", () => {
  it("clones a <style> tag by its text content", () => {
    const target = document.implementation.createHTMLDocument("target");
    const style = document.createElement("style");
    style.textContent = ".foo { color: red; }";

    copyStylesInto(fakeSourceDoc([style]), target);

    const cloned = target.head.querySelector("style");
    expect(cloned).not.toBeNull();
    expect(cloned!.textContent).toBe(".foo { color: red; }");
  });

  it("clones a <link rel=stylesheet> by its href", () => {
    const target = document.implementation.createHTMLDocument("target");
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://example.com/app.css";

    copyStylesInto(fakeSourceDoc([link]), target);

    const cloned = target.head.querySelector("link[rel=stylesheet]");
    expect(cloned).not.toBeNull();
    expect((cloned as HTMLLinkElement).href).toBe("https://example.com/app.css");
  });

  it("ignores an entry whose ownerNode is neither a <style> nor a <link> (e.g. null, for a constructed/imported sheet)", () => {
    // createHTMLDocument(title) pre-populates <head><title> — assert
    // against style/link elements specifically, not raw children count.
    const target = document.implementation.createHTMLDocument("target");

    expect(() => copyStylesInto(fakeSourceDoc([null]), target)).not.toThrow();
    expect(target.head.querySelectorAll("style, link").length).toBe(0);
  });

  it("clones every sheet in source order for a mix of both kinds", () => {
    const target = document.implementation.createHTMLDocument("target");
    const style = document.createElement("style");
    style.textContent = "body { margin: 0; }";
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://example.com/tailwind.css";

    copyStylesInto(fakeSourceDoc([style, link]), target);

    const cloned = target.head.querySelectorAll("style, link");
    expect(cloned.length).toBe(2);
    expect(cloned[0]!.tagName).toBe("STYLE");
    expect(cloned[1]!.tagName).toBe("LINK");
  });
});

// useCaptionPip — web-host PiP hook races (S14 fix-round finding 4).
// jsdom has no real documentPictureInPicture, so every test here stubs
// `window.documentPictureInPicture.requestWindow` directly. The hook is
// driven through a Probe component (createRoot/act, this repo's usual
// no-@testing-library pattern — see useMeeting.lifecycle.test.tsx's own
// header comment) — plain `createElement`, not JSX, since this file is
// `.ts` not `.tsx` (mirrors captionWindow.ts's own createElement use in
// useCaptionPip itself, for the identical reason).
let pipApi: CaptionPipHandle | null = null;
function PipProbe() {
  pipApi = useCaptionPip();
  return null;
}

describe("useCaptionPip — PiP hook races", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function stubRequestWindow(impl: (opts: { width: number; height: number }) => Promise<Window>) {
    const fn = vi.fn(impl);
    (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture = {
      requestWindow: fn,
    };
    return fn;
  }

  /** A fake PiP `Window`: a REAL Document (via createHTMLDocument, same
   *  helper the copyStylesInto tests above already use) so copyStylesInto
   *  and react-dom's createPortal both have a genuinely functional
   *  target — plus a manual pagehide "fire" hook, since jsdom's real
   *  window.close()/pagehide plumbing doesn't apply to a synthetic
   *  second window like this. */
  function makeFakeWindow() {
    const listeners = new Map<string, Array<() => void>>();
    const win = {
      document: document.implementation.createHTMLDocument("pip"),
      close: vi.fn(),
      addEventListener: (type: string, cb: () => void) => {
        const arr = listeners.get(type) ?? [];
        arr.push(cb);
        listeners.set(type, arr);
      },
      removeEventListener: vi.fn(),
    };
    return {
      win: win as unknown as Window,
      close: win.close,
      fire: (type: string) => listeners.get(type)?.forEach((cb) => cb()),
    };
  }

  async function mount() {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(PipProbe));
    });
  }

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    if (container) {
      container.remove();
      container = null;
    }
    delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture;
    pipApi = null;
  });

  it("(4a) a second toggle while requestWindow() is still pending is ignored — only one window ever opens", async () => {
    const gate = deferred<Window>();
    const fake = makeFakeWindow();
    const requestWindow = stubRequestWindow(() => gate.promise);
    await mount();

    act(() => {
      pipApi!.toggle();
      pipApi!.toggle(); // re-entrant — must be a no-op while the first is in flight
    });

    await act(async () => {
      gate.resolve(fake.win);
      await flush();
    });

    expect(requestWindow).toHaveBeenCalledTimes(1);
    expect(pipApi!.open).toBe(true);
  });

  it("(4b) identity-guard pagehide — a dying OLD window's pagehide can't clear a NEWER one that replaced it", async () => {
    const a = makeFakeWindow();
    const b = makeFakeWindow();
    let call = 0;
    stubRequestWindow(async () => (call++ === 0 ? a.win : b.win));
    await mount();

    await act(async () => {
      pipApi!.toggle(); // open A
      await flush();
    });
    expect(pipApi!.open).toBe(true);

    act(() => {
      pipApi!.toggle(); // close A
    });
    expect(pipApi!.open).toBe(false);

    await act(async () => {
      pipApi!.toggle(); // open B
      await flush();
    });
    expect(pipApi!.open).toBe(true);

    // A's pagehide fires late (e.g. the real window only finished
    // tearing down just now) — must NOT clear B.
    act(() => {
      a.fire("pagehide");
    });
    expect(pipApi!.open).toBe(true);

    // B's own pagehide still works correctly.
    act(() => {
      b.fire("pagehide");
    });
    expect(pipApi!.open).toBe(false);
  });

  it("(4c) unmounting the hook closes whatever window is currently open", async () => {
    const a = makeFakeWindow();
    stubRequestWindow(async () => a.win);
    await mount();

    await act(async () => {
      pipApi!.toggle();
      await flush();
    });
    expect(pipApi!.open).toBe(true);

    act(() => root!.unmount());
    root = null;

    expect(a.close).toHaveBeenCalledTimes(1);
  });

  it("(4c) an open() that resolves AFTER unmount is abandoned — the window closes, no state is touched", async () => {
    const gate = deferred<Window>();
    const a = makeFakeWindow();
    stubRequestWindow(() => gate.promise);
    await mount();

    act(() => {
      pipApi!.toggle(); // requestWindow() is now in flight
    });
    act(() => root!.unmount()); // unmount BEFORE it resolves
    root = null;

    await act(async () => {
      gate.resolve(a.win);
      await flush();
    });

    expect(a.close).toHaveBeenCalledTimes(1);
  });

  it("(4d) a style-copy failure closes the freshly-opened window and hands back null — never a blank window", async () => {
    // copyStylesInto only ever touches targetDoc.head once it finds at
    // least one entry in the REAL document's styleSheets — so this
    // needs a genuine <style> tag there to reach (and fail on) a
    // deliberately head-less fake target document.
    const style = document.createElement("style");
    style.textContent = "body { margin: 0; }";
    document.head.appendChild(style);
    try {
      const closeFn = vi.fn();
      const badWin = {
        document: { head: null },
        close: closeFn,
        addEventListener: vi.fn(),
      } as unknown as Window;
      stubRequestWindow(async () => badWin);
      await mount();

      await act(async () => {
        pipApi!.toggle();
        await flush();
      });

      expect(closeFn).toHaveBeenCalledTimes(1);
      expect(pipApi!.open).toBe(false);
    } finally {
      style.remove();
    }
  });
});

function makeFakeMainWindow(overrides: Partial<MainWindowApi> = {}): MainWindowApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getRect: vi.fn(async () => {
      calls.push("getRect");
      return { x: 10, y: 20, width: 1200, height: 800 };
    }),
    setRect: vi.fn(async (rect: WindowRect) => {
      calls.push(`setRect:${rect.x},${rect.y},${rect.width},${rect.height}`);
    }),
    setLogicalSize: vi.fn(async (w: number, h: number) => {
      calls.push(`setLogicalSize:${w}x${h}`);
    }),
    moveToTopRight: vi.fn(async (w: number, margin?: number) => {
      calls.push(`moveToTopRight:${w},${margin}`);
    }),
    setAlwaysOnTop: vi.fn(async (v: boolean) => {
      calls.push(`setAlwaysOnTop:${v}`);
    }),
    ...overrides,
  };
}

// enterDesktopCaptionModeWith / exitDesktopCaptionModeWith — deps-
// injected core, module-level queue+generation serialization (S14
// fix-round findings 1+3). Every `it()` gets a clean queue/rect/
// generation via the file-level afterEach's resetCaptionWindowStateForTests()
// above.
describe("captionWindow desktop host — enter/exit serialization", () => {
  it("enter: records the rect, pins on top, resizes to the caption strip, then repositions — in that order", async () => {
    const api = makeFakeMainWindow();

    await expect(enterDesktopCaptionModeWith({ getMainWindow: async () => api })).resolves.toBeUndefined();

    expect(api.calls).toEqual([
      "getRect",
      "setAlwaysOnTop:true",
      `setLogicalSize:${CAPTION_STRIP_WIDTH}x${CAPTION_STRIP_HEIGHT}`,
      `moveToTopRight:${CAPTION_STRIP_WIDTH},24`,
    ]);
  });

  it("enter fails soft: a throwing step never rejects the returned promise", async () => {
    const api = makeFakeMainWindow({
      setAlwaysOnTop: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await expect(enterDesktopCaptionModeWith({ getMainWindow: async () => api })).resolves.toBeUndefined();
  });

  it("enter then exit: restores the recorded rect and turns always-on-top back off", async () => {
    const api = makeFakeMainWindow();

    await enterDesktopCaptionModeWith({ getMainWindow: async () => api });
    await exitDesktopCaptionModeWith({ getMainWindow: async () => api });

    expect(api.calls).toEqual([
      "getRect",
      "setAlwaysOnTop:true",
      `setLogicalSize:${CAPTION_STRIP_WIDTH}x${CAPTION_STRIP_HEIGHT}`,
      `moveToTopRight:${CAPTION_STRIP_WIDTH},24`,
      "setAlwaysOnTop:false",
      "setRect:10,20,1200,800",
    ]);
  });

  it("exit with no prior enter: still turns always-on-top off, skips the restore (nothing was ever recorded)", async () => {
    const api = makeFakeMainWindow();

    await exitDesktopCaptionModeWith({ getMainWindow: async () => api });

    expect(api.calls).toEqual(["setAlwaysOnTop:false"]);
  });

  it("exit never rejects, even if getMainWindow() itself throws", async () => {
    await expect(
      exitDesktopCaptionModeWith({
        getMainWindow: async () => {
          throw new Error("no tauri");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("(finding 3) a failing moveToTopRight during enter still leaves the rect recorded, so a LATER exit restores it", async () => {
    const api = makeFakeMainWindow({
      moveToTopRight: vi.fn(async () => {
        throw new Error("no monitor");
      }),
    });

    await enterDesktopCaptionModeWith({ getMainWindow: async () => api });
    await exitDesktopCaptionModeWith({ getMainWindow: async () => api });

    expect(api.calls).toEqual([
      "getRect",
      "setAlwaysOnTop:true",
      `setLogicalSize:${CAPTION_STRIP_WIDTH}x${CAPTION_STRIP_HEIGHT}`,
      // moveToTopRight itself threw here — never recorded as a call —
      // but the exit below still finds a rect to restore.
      "setAlwaysOnTop:false",
      "setRect:10,20,1200,800",
    ]);
  });

  it("(finding 1) enter -> enter keeps the FIRST snapshot, even though the second enter's own getRect() reads different (caption-strip) geometry", async () => {
    const readings: WindowRect[] = [
      { x: 10, y: 20, width: 1200, height: 800 }, // real pre-caption rect
      { x: 1400, y: 24, width: 480, height: 150 }, // caption-strip geometry, read back on a re-enter
    ];
    let call = 0;
    const api = makeFakeMainWindow({
      getRect: vi.fn(async () => readings[call++]!),
    });

    await enterDesktopCaptionModeWith({ getMainWindow: async () => api });
    await enterDesktopCaptionModeWith({ getMainWindow: async () => api }); // re-enter, no exit in between
    await exitDesktopCaptionModeWith({ getMainWindow: async () => api });

    const setRectCall = api.calls.find((c) => c.startsWith("setRect:"));
    expect(setRectCall).toBe("setRect:10,20,1200,800"); // the FIRST reading, never overwritten
  });

  it("(finding 1) enter still mid-flight (stuck on setAlwaysOnTop) when exit is called — exit wins, the pending entry's remaining steps never land", async () => {
    const gate = deferred<void>();
    const calls: string[] = [];
    const api: MainWindowApi = {
      getRect: async () => {
        calls.push("getRect");
        return { x: 10, y: 20, width: 1200, height: 800 };
      },
      setRect: async (rect) => {
        calls.push(`setRect:${rect.x},${rect.y},${rect.width},${rect.height}`);
      },
      setLogicalSize: async (w, h) => {
        calls.push(`setLogicalSize:${w}x${h}`);
      },
      moveToTopRight: async (w, m) => {
        calls.push(`moveToTopRight:${w},${m}`);
      },
      setAlwaysOnTop: async (v) => {
        calls.push(`setAlwaysOnTop:${v}`);
        if (v) await gate.promise; // only the ENTER call (true) blocks
      },
    };
    const deps = { getMainWindow: async () => api };

    const enterP = enterDesktopCaptionModeWith(deps);
    // Let enter's task actually run and genuinely get stuck inside
    // setAlwaysOnTop(true) — NOT merely queued-but-not-started.
    await flush();
    expect(calls).toEqual(["getRect", "setAlwaysOnTop:true"]);

    const exitP = exitDesktopCaptionModeWith(deps); // called while enter is still pending

    gate.resolve();
    await Promise.all([enterP, exitP]);

    // setLogicalSize/moveToTopRight (the rest of enter's own sequence)
    // never run — exit's own calls land right after enter settles.
    expect(calls).toEqual(["getRect", "setAlwaysOnTop:true", "setAlwaysOnTop:false", "setRect:10,20,1200,800"]);
  });

  it("resetCaptionWindowStateForTests clears the recorded rect — a stray exit afterward has nothing to restore", async () => {
    const api = makeFakeMainWindow();

    await enterDesktopCaptionModeWith({ getMainWindow: async () => api });
    resetCaptionWindowStateForTests();
    await exitDesktopCaptionModeWith({ getMainWindow: async () => api });

    expect(api.calls).toEqual([
      "getRect",
      "setAlwaysOnTop:true",
      `setLogicalSize:${CAPTION_STRIP_WIDTH}x${CAPTION_STRIP_HEIGHT}`,
      `moveToTopRight:${CAPTION_STRIP_WIDTH},24`,
      "setAlwaysOnTop:false",
      // no setRect — reset cleared originalRect before this exit ran
    ]);
  });
});

describe("enterDesktopCaptionMode / exitDesktopCaptionMode — IS_DESKTOP-guarded real entry points", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("outside a desktop build (NEXT_PUBLIC_DESKTOP unset in the test env), both are inert no-ops that never call getMainWindow", async () => {
    const spy = vi.spyOn(tauriApiModule, "getMainWindow");

    await expect(enterDesktopCaptionMode()).resolves.toBeUndefined();
    await expect(exitDesktopCaptionMode()).resolves.toBeUndefined();

    expect(spy).not.toHaveBeenCalled();
  });
});
