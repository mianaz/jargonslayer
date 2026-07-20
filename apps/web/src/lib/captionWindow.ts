// S14 floating live caption — window-management plumbing for the ONE
// shared presentational view (components/FloatingCaption.tsx) across
// its two hosts:
//   - web (non-Tauri builds, Chrome/Edge 116+ — feature-detected via
//     "documentPictureInPicture" in window): opens a Document
//     Picture-in-Picture window, copies this document's stylesheets
//     into it (so Tailwind classes render there too), and portals
//     FloatingCaption into its body. Same JS realm as the main page —
//     no second webview, no message-passing — so the store's zustand
//     subscriptions work completely unchanged inside the PiP window.
//   - desktop (IS_DESKTOP): no second window/webview at all — shrinks
//     the MAIN window itself into a caption strip via tauriApi.ts's
//     getMainWindow() wrappers, restoring its prior rect on exit.
//     Split into a deps-injected "with" core + a thin IS_DESKTOP-gated
//     real entry point, mirroring lib/desktop/updateCheck.ts's own
//     checkAppUpdateWith/checkAppUpdate split — so the enter/exit
//     sequencing is unit-testable with a fake MainWindowApi, without a
//     real Tauri runtime.
// iOS never reaches either host — Header.tsx's own menu-entry gate
// hides 悬浮字幕 there entirely (no second-webview/PiP story on iOS).

import { createElement, useCallback, useEffect, useRef, useState, type ReactPortal } from "react";
import { createPortal } from "react-dom";
import FloatingCaption from "@/components/FloatingCaption";
import { IS_DESKTOP } from "./platform/desktop";
import { getMainWindow, type MainWindowApi, type WindowRect } from "./desktop/tauriApi";

// ---------------------------------------------------------------
// Web host: Document Picture-in-Picture
// ---------------------------------------------------------------

const PIP_WIDTH = 420;
const PIP_HEIGHT = 160;

/** Pure feature-detect — `target` is typed as a bare `object` (not
 *  `Window`) so a test can pass a fake `{}` / `{ documentPictureInPicture:
 *  {} }` without needing a real browser global. jsdom has no PiP API at
 *  all (and TypeScript's own bundled DOM lib doesn't declare it yet
 *  either, hence the hand-rolled interfaces below) — that absence IS
 *  the "unsupported" path Header.tsx's menu entry hides behind; real
 *  call sites just pass `window` itself. */
export function supportsDocumentPip(target: object): boolean {
  return "documentPictureInPicture" in target;
}

// Matches `window.documentPictureInPicture`'s real (non-standard, not
// yet in TypeScript's bundled DOM lib) shape closely enough for this
// module's one call site — same "close enough" contract tauriApi.ts's
// own interfaces document for @tauri-apps/* types.
interface DocumentPictureInPictureApi {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}
interface WindowWithPip extends Window {
  documentPictureInPicture?: DocumentPictureInPictureApi;
}

/** Clones every current-document stylesheet into `targetDoc` — standard
 *  PiP recipe: a `<link rel=stylesheet>` is cloned by its href (the PiP
 *  document fetches it itself), a `<style>` tag by its text content —
 *  so Tailwind's classes render correctly inside the PiP window's own
 *  separate document. */
export function copyStylesInto(sourceDoc: Document, targetDoc: Document): void {
  for (const sheet of Array.from(sourceDoc.styleSheets)) {
    const owner = sheet.ownerNode;
    if (owner instanceof HTMLLinkElement) {
      const link = targetDoc.createElement("link");
      link.rel = "stylesheet";
      link.href = owner.href;
      targetDoc.head.appendChild(link);
    } else if (owner instanceof HTMLStyleElement) {
      const style = targetDoc.createElement("style");
      style.textContent = owner.textContent;
      targetDoc.head.appendChild(style);
    }
  }
}

/** Opens the PiP window and copies styles into it. Returns null when
 *  the API is absent, `requestWindow()` itself rejects (e.g. the user
 *  declines a second PiP window), or the style-copy step throws — in
 *  that last case the window DID already open, so this closes it
 *  before returning null (S14 fix-round finding 4d): a caller that
 *  gets null back must never also have an orphaned, blank PiP window
 *  it doesn't know about. Never throws itself, so a menu click handler
 *  can `void` the call without its own try/catch. */
async function openPipWindow(): Promise<Window | null> {
  if (typeof window === "undefined" || !supportsDocumentPip(window)) return null;
  const dpip = (window as WindowWithPip).documentPictureInPicture;
  if (!dpip) return null;
  let pipWindow: Window;
  try {
    pipWindow = await dpip.requestWindow({ width: PIP_WIDTH, height: PIP_HEIGHT });
  } catch {
    return null;
  }
  try {
    copyStylesInto(document, pipWindow.document);
  } catch {
    pipWindow.close();
    return null;
  }
  return pipWindow;
}

export interface CaptionPipHandle {
  /** Whether this browser exposes the PiP API at all — Header.tsx
   *  hides the 悬浮字幕 menu entry on web when this is false. Starts
   *  false and is set from an effect (not read synchronously at module
   *  or first-render scope) so a static-export/SSR pass never touches
   *  `window`. */
  supported: boolean;
  open: boolean;
  toggle: () => void;
  /** Render this as-is, anywhere in the calling component's own JSX —
   *  a portal teleports its children into the PiP document regardless
   *  of where it sits in the caller's own tree. Null while no PiP
   *  window is open. */
  portal: ReactPortal | null;
}

/** Web-host hook: owns the PiP window handle, portals FloatingCaption
 *  into it, and syncs `open` back to false on the browser's own
 *  "pagehide" (user closed the PiP window via its native chrome, not
 *  via FloatingCaption's own ✕) — see this module's own header
 *  comment. */
export function useCaptionPip(): CaptionPipHandle {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [supported, setSupported] = useState(false);
  // Latest-value mirror of pipWindow, for the unmount cleanup below —
  // that effect's own closure is fixed at mount time (deps: []), so it
  // can't read a LATER pipWindow value directly; this ref (kept in
  // sync by the effect right under it) gives it one. (S14 fix-round
  // finding 4c.)
  const pipWindowRef = useRef<Window | null>(null);
  useEffect(() => {
    pipWindowRef.current = pipWindow;
  }, [pipWindow]);
  // (4a) re-entrant-toggle guard: true while an openPipWindow() call is
  // in flight, so a second click before the first window has even
  // opened is ignored instead of racing a second requestWindow().
  const openPendingRef = useRef(false);
  // (4c) unmount guard: flipped by this hook's own unmount cleanup so
  // an open() that resolves AFTER unmount closes the now-orphaned
  // window instead of calling setState on an unmounted component.
  const abandonedRef = useRef(false);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && supportsDocumentPip(window));
  }, []);

  useEffect(() => {
    return () => {
      abandonedRef.current = true;
      pipWindowRef.current?.close();
    };
  }, []);

  const close = useCallback(() => {
    setPipWindow((win) => {
      win?.close();
      return null;
    });
  }, []);

  const toggle = useCallback(() => {
    if (pipWindow) {
      close();
      return;
    }
    if (openPendingRef.current) return;
    openPendingRef.current = true;
    void openPipWindow().then((win) => {
      openPendingRef.current = false;
      if (!win) return;
      if (abandonedRef.current) {
        win.close();
        return;
      }
      win.addEventListener("pagehide", () => {
        // (4b) identity guard — closes over THIS win specifically, so a
        // dying OLD window's pagehide can never clear a NEWER one that
        // has since replaced it in state.
        setPipWindow((cur) => (cur === win ? null : cur));
      });
      setPipWindow(win);
    });
  }, [pipWindow, close]);

  const portal = pipWindow
    ? createPortal(createElement(FloatingCaption, { onClose: close }), pipWindow.document.body)
    : null;

  return { supported, open: pipWindow !== null, toggle, portal };
}

// ---------------------------------------------------------------
// Desktop host: shrink the main window itself (no second webview)
// ---------------------------------------------------------------

export const CAPTION_STRIP_WIDTH = 480;
export const CAPTION_STRIP_HEIGHT = 150;
const TOP_RIGHT_MARGIN = 24;

export interface MainWindowDeps {
  getMainWindow: () => Promise<MainWindowApi>;
}

// Module-level serialization (S14 fix-round findings 1+3) — a single
// promise queue plus one generation counter make "a pending enter
// lands after an exit" structurally impossible, instead of relying on
// timing. Both enter and exit bump `generation` and capture their own
// `myGen` BEFORE enqueueing, so two calls fired back-to-back already
// agree on which one is current the instant both synchronous call
// sites return — no await needed for that part. Each queued task then
// checks `myGen === generation` at its start and again after every
// awaited window call, bailing out (a plain `return`, never a throw)
// the moment it's superseded. Combined with `queue`'s own strict FIFO
// ordering (a later call's task can only start once every earlier
// one has fully settled), a stale enter's remaining steps can never
// run after a newer exit's — the exit's task hasn't even started while
// the stale enter is still unwinding.
let queue: Promise<void> = Promise.resolve();
let originalRect: WindowRect | null = null;
let generation = 0;

/** Appends `task` to the module-level queue and becomes its new tail.
 *  `task` itself must never reject — every enter/exit task below wraps
 *  its own body in try/catch — so this needs no defensive `.catch()`
 *  of its own to keep the chain alive. */
function enqueue(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task);
  queue = run;
  return run;
}

/** Test-only reset — clears the queue/rect/generation state above.
 *  Mirrors tauriApi.ts's own resetTauriApiCache convention for module-
 *  level state that must never leak between independent `it()` blocks. */
export function resetCaptionWindowStateForTests(): void {
  queue = Promise.resolve();
  originalRect = null;
  generation = 0;
}

/** Deps-injected core, mirroring updateCheck.ts's own
 *  checkAppUpdateWith — enqueues a task that records the window's
 *  current rect, pins it on top, and shrinks it into the caption strip
 *  near the top-right corner. Fire-and-forget by design (void, not a
 *  rect): page.tsx flips the store's captionMode/swaps to the
 *  FloatingCaption layout regardless of whether this succeeds — only
 *  the OS window chrome (always-on-top, the actual resize/move)
 *  depends on it. */
export function enterDesktopCaptionModeWith(deps: MainWindowDeps): Promise<void> {
  generation += 1;
  const myGen = generation;
  return enqueue(async () => {
    if (myGen !== generation) return;
    try {
      const api = await deps.getMainWindow();
      if (myGen !== generation) return;
      const rect = await api.getRect();
      // Record immediately, unconditionally (as long as we got this
      // far) — and ONLY when nothing is recorded yet. A re-enter
      // (originalRect already set, caption mode never actually
      // exited) must never overwrite the real pre-caption rect with
      // THIS call's own reading, which could already be the caption
      // strip's own geometry.
      if (originalRect === null) originalRect = rect;
      if (myGen !== generation) return;
      await api.setAlwaysOnTop(true);
      if (myGen !== generation) return;
      await api.setLogicalSize(CAPTION_STRIP_WIDTH, CAPTION_STRIP_HEIGHT);
      if (myGen !== generation) return;
      await api.moveToTopRight(CAPTION_STRIP_WIDTH, TOP_RIGHT_MARGIN);
    } catch (err) {
      console.warn("[captionWindow] enterDesktopCaptionMode failed", err);
    }
  });
}

/** Deps-injected core — enqueues a task that turns always-on-top back
 *  off and restores whatever entry recorded in the module's
 *  `originalRect`. The two steps run in INDEPENDENT try/catches: an OS
 *  hiccup on one must not skip the other. `originalRect` clears after
 *  the restore is attempted (hit or miss) — ponytail: single-shot by
 *  design, so a second exit with no matching enter in between is a
 *  harmless no-op instead of re-applying a stale rect; upgrade path if
 *  that's ever wrong is a per-generation rect stack instead of one
 *  module-level slot. */
export function exitDesktopCaptionModeWith(deps: MainWindowDeps): Promise<void> {
  generation += 1;
  const myGen = generation;
  return enqueue(async () => {
    if (myGen !== generation) return;
    let api: MainWindowApi;
    try {
      api = await deps.getMainWindow();
    } catch (err) {
      console.warn("[captionWindow] exitDesktopCaptionMode failed", err);
      return;
    }
    if (myGen !== generation) return;

    try {
      await api.setAlwaysOnTop(false);
    } catch (err) {
      console.warn("[captionWindow] exitDesktopCaptionMode setAlwaysOnTop failed", err);
    }
    // Superseded mid-restore by a newer enter/exit — leave
    // originalRect untouched so THAT generation's own eventual exit
    // can still restore it, instead of clearing it out from under it.
    if (myGen !== generation) return;

    try {
      if (originalRect) await api.setRect(originalRect);
    } catch (err) {
      console.warn("[captionWindow] exitDesktopCaptionMode setRect failed", err);
    } finally {
      originalRect = null;
    }
  });
}

/** Real entry points — IS_DESKTOP-gated no-ops off desktop, mirroring
 *  updateCheck.ts's checkAppUpdate/checkAppUpdateWith split exactly.
 *  page.tsx's own captionMode effect is the one caller. Fire-and-forget
 *  (void promises) — see enterDesktopCaptionModeWith's own doc comment
 *  for why no rect round-trips through the caller anymore. */
export function enterDesktopCaptionMode(): Promise<void> {
  if (!IS_DESKTOP) return Promise.resolve();
  return enterDesktopCaptionModeWith({ getMainWindow });
}

export function exitDesktopCaptionMode(): Promise<void> {
  if (!IS_DESKTOP) return Promise.resolve();
  return exitDesktopCaptionModeWith({ getMainWindow });
}
