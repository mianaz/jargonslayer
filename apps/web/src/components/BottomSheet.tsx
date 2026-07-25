"use client";

// BottomSheet — shared iOS primitive (mobile-UX sprint; Miana's
// direction: "交互还是太网页化了。考虑诸如claude手机版如何交互"): a
// slide-up-from-bottom panel replacing web-idiom floating dropdowns/
// modals on iOS. Controlled (open/onClose), no portal library — plain
// `fixed` positioning, same posture as every other overlay in this app
// (HistoryDrawer.tsx/TaskCenterDrawer.tsx/ImportHub.tsx/SettingsDialog.
// tsx all render straight into the existing tree, none of them portal).
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

  return (
    <>
      {/* Tap-to-close backdrop (plain onClick, not the mousedown/
         target-check dance — see this file's header comment for why
         that pattern doesn't apply to a sibling-shaped overlay). */}
      <div className="fixed inset-0 z-40 bg-black/60" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className={`fixed inset-x-0 bottom-0 z-50 flex flex-col border-t border-edge bg-panel glassable-panel pb-[env(safe-area-inset-bottom)] transition-transform duration-200 ease-out motion-reduce:transition-none motion-reduce:duration-0 ${
          entered ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <span aria-hidden="true" className="mx-auto my-2 h-1 w-9 shrink-0 bg-mut2" />
        <div className="scroll-thin max-h-[70vh] overflow-y-auto">{children}</div>
      </div>
    </>
  );
}
