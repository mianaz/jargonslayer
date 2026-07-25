"use client";

// BottomSheet — shared iOS primitive (mobile-UX sprint; Miana's
// direction: "交互还是太网页化了。考虑诸如claude手机版如何交互"): a
// slide-up-from-bottom panel replacing web-idiom floating dropdowns/
// modals on iOS. Controlled (open/onClose).
//
// MOUNT CONTRACT (#58 fix round FIX 6 + the sim-caught follow-up): the
// caller must render this component OUTSIDE any sticky/transformed
// stacking context, in ordinary app-root tree position — the same spot
// HistoryDrawer.tsx/TaskCenterDrawer.tsx/ImportHub.tsx mount from,
// which is why their plain `fixed` divs work. Two dead-ends are
// load-bearing history here: ① rendering from INSIDE Header's
// `<header className="sticky top-0 z-20">` clamped the sheet's z-40/50
// layers under root-level z-30/40 overlays (touch-lookup-bar,
// btn-exit-focus, drawers — Opus proved the overlaps); ② the "obvious"
// escape, createPortal(document.body), painted correctly but DIED in
// WKWebView — the app's draggable bottom panel composited ABOVE the
// body-portaled fixed layers regardless of z-index and swallowed every
// row tap (backdrop still worked; rows dead — sim-caught, jsdom green).
// Hence: no portal, in-tree mount, caller places it correctly
// (Header.tsx renders IosMenuSheet as a SIBLING of its sticky
// <header>).
//
// Backdrop + panel are separate sibling elements — mirrors HistoryDrawer.
// tsx/TaskCenterDrawer.tsx's own shape (a plain backdrop div with its
// own onClick), NOT SettingsDialog.tsx/ImportHub.tsx's centered-modal
// "backdrop WRAPS panel" shape, whose onMouseDown + target===
// currentTarget check exists specifically because a click landing on
// the panel would otherwise bubble up through it to the backdrop's own
// handler — irrelevant here since panel and backdrop are siblings, not
// parent/child. Escape-to-close mirrors ImportHub.tsx's own identical
// document keydown effect ("#58 review fix 5").
//
// Focus: deliberately NO programmatic focus move (FIX 7 tried it and
// was retracted — WKWebView's native focus rectangle intercepted every
// touch over the focused panel; see the effect's comment below). Same
// no-trap posture as HistoryDrawer.tsx/TaskCenterDrawer.tsx/ImportHub.
// tsx.
//
// 0px radius (app-wide rule): the grabber bar below is a plain square
// bar, not a pill — no rounded-* class anywhere in this file.

import { useEffect, useState } from "react";

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export default function BottomSheet({ open, onClose, children }: BottomSheetProps) {
  // Mount-then-flip so the slide-up transition actually has a FROM
  // (translate-y-full, the first painted frame) and a TO (translate-
  // y-0, one rAF later) — rendering already-in-place on the very first
  // frame would leave nothing to transition. Resets to false on close
  // so the same slide-up replays every time this reopens; there is no
  // exit animation — this component unmounts immediately on close, the
  // same "if (!open) return null" posture every other dialog/drawer in
  // this app already uses (HistoryDrawer.tsx/TaskCenterDrawer.tsx/
  // ImportHub.tsx/SettingsDialog.tsx/TutorialOverlay.tsx).
  const [entered, setEntered] = useState(false);
  // FIX 7 RETRACTED on sim evidence: programmatic panel.focus() made
  // WKWebView draw its native focus rectangle over the panel (the
  // simulator's attached hardware keyboard arms the focus system), and
  // that native overlay INTERCEPTED every touch inside the panel's
  // bounds — rows painted but dead, while the backdrop above stayed
  // live. Chased through three false suspects first (body portal,
  // transform-layer hit-testing, ios-shell overflow lock) — the dead
  // zone tracked the focused element's rect the whole time. role=
  // "dialog"/aria-modal stay; VoiceOver reaches the sheet without a
  // forced focus move, same as every other overlay here.

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Esc-to-close — mirrors ImportHub.tsx's own identical document
  // keydown effect.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  // NO portal (sim-caught): a document.body portal put this sheet's
  // fixed layers OUTSIDE the app root, and WKWebView composited the
  // app's draggable bottom panel ABOVE them regardless of z-index —
  // the panel painted over the sheet's top edge and swallowed every
  // row tap (backdrop still worked; rows dead). In-tree fixed overlays
  // hit-test correctly, so the CALLER is responsible for mounting this
  // component outside any transformed/sticky stacking context —
  // Header.tsx mounts its menu instance as a sibling of the sticky
  // <header>, NOT inside it (see IosMenuSheet's comment there).
  return (
    <>
      {/* Tap-to-close backdrop (plain onClick, not the mousedown/
         target-check dance — see this file's header comment for why
         that pattern doesn't apply to a sibling-shaped overlay). */}
      <div className="fixed inset-0 z-40 bg-black/60" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        // `entered` drops the transform CLASS entirely (not translate-y-0):
        // sim-caught — WKWebView kept a stale composited-layer hit-test
        // region for the transformed fixed panel, so the painted sheet
        // missed every row tap (page behind received them; neither panel
        // nor backdrop closed). With no transform class after entry the
        // layer decomposits and hit-testing matches the paint. Same
        // slide-up visual: translate-y-full -> (class removed) still
        // transitions via transition-transform. outline-none: the panel
        // takes programmatic focus on open (a11y) — the focus ring is
        // pure noise on a tap-driven sheet.
        className={`fixed inset-x-0 bottom-0 z-50 flex flex-col border-t border-edge bg-panel glassable-panel outline-none pb-[env(safe-area-inset-bottom)] transition-transform duration-200 ease-out motion-reduce:transition-none motion-reduce:duration-0 ${
          entered ? "" : "translate-y-full"
        }`}
      >
        <span aria-hidden="true" className="mx-auto my-2 h-1 w-9 shrink-0 bg-mut2" />
        <div className="scroll-thin max-h-[70vh] overflow-y-auto">{children}</div>
      </div>
    </>
  );
}
