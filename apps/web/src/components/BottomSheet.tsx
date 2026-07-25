"use client";

// BottomSheet — shared iOS primitive (mobile-UX sprint; Miana's
// direction: "交互还是太网页化了。考虑诸如claude手机版如何交互"): a
// slide-up-from-bottom panel replacing web-idiom floating dropdowns/
// modals on iOS. Controlled (open/onClose).
//
// #58 fix round FIX 6 (both reviewers, Opus proved concrete overlaps):
// portals into document.body. This file used to claim "no portal
// library — plain `fixed` positioning, same posture as every other
// overlay in this app... none of them portal" — true of where those
// others (HistoryDrawer.tsx/TaskCenterDrawer.tsx/ImportHub.tsx/
// SettingsDialog.tsx) mount FROM (page.tsx's own root), which is
// exactly why a plain `fixed` div is enough for them. This component's
// only caller (Header.tsx's HamburgerMenu) renders it from INSIDE
// `<header className="sticky top-0 z-20">` — a positioned ancestor
// that starts its own stacking context — so this sheet's z-40/z-50
// layers were only ever competing against siblings WITHIN that header,
// losing to root-level overlays with a lower NUMERIC z-index
// (TranscriptPanel's touch-lookup-bar z-40, Header's own
// btn-exit-focus z-40, assorted drawers z-30/z-40). createPortal to
// document.body is what actually RESTORES the "mounts at page.tsx
// root" posture the old comment here just asserted without having it.
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
// Focus (FIX 7, Sol MEDIUM + Opus L2, adjudicated light): on open,
// focus moves to the panel itself and, on close, back to whatever had
// focus before — NO full focus trap (matches the app's existing
// overlay posture; HistoryDrawer.tsx/TaskCenterDrawer.tsx/ImportHub.tsx
// don't trap focus either).
//
// 0px radius (app-wide rule): the grabber bar below is a plain square
// bar, not a pill — no rounded-* class anywhere in this file.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  // FIX 7: the panel itself (focus target on open) and whatever had
  // focus right before open (restored on close) — see this file's
  // header comment for why this stops short of a full focus trap.
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    // Capture BEFORE moving focus onto the panel below, or this would
    // just read back the panel itself.
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const id = requestAnimationFrame(() => setEntered(true));
    return () => {
      cancelAnimationFrame(id);
      previouslyFocusedRef.current?.focus();
    };
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
  // Belt-and-suspenders: `!open` above already covers every real render
  // path (this component only ever mounts already-closed — see the
  // header comment), but createPortal needs a real `document` to target.
  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      {/* Tap-to-close backdrop (plain onClick, not the mousedown/
         target-check dance — see this file's header comment for why
         that pattern doesn't apply to a sibling-shaped overlay). */}
      <div className="fixed inset-0 z-40 bg-black/60" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`fixed inset-x-0 bottom-0 z-50 flex flex-col border-t border-edge bg-panel glassable-panel pb-[env(safe-area-inset-bottom)] transition-transform duration-200 ease-out motion-reduce:transition-none motion-reduce:duration-0 ${
          entered ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <span aria-hidden="true" className="mx-auto my-2 h-1 w-9 shrink-0 bg-mut2" />
        <div className="scroll-thin max-h-[70vh] overflow-y-auto">{children}</div>
      </div>
    </>,
    document.body,
  );
}
