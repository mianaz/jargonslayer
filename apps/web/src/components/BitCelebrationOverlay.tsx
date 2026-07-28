"use client";

// Bit mascot behavior train (chamber B, 参考 Claude 手机版吉祥物): with the
// always-on status-line perch retired (StatusLine.tsx), a meeting-end
// celebration (summary generated / review queue cleared — both bump the
// store's bitCelebrateNonce, see PixelDragon.tsx's own celebration doc)
// needs a vehicle on the MAIN screen. This is that vehicle: a fixed
// bottom-right overlay that mounts ONLY while a celebration plays —
// unlike PixelDragon's own internal `celebrating` state (a permanent
// render-override on an already-mounted instance), this component owns
// its OWN mount/unmount lifecycle, keyed off the exact same nonce.
//
// Gated on status === "stopped": both celebration triggers only ever
// fire post-meeting (SummaryPanel.handleGenerate, review/page.tsx's
// onQueueEmptied), so this can never appear mid-meeting even if some
// future caller mis-times a celebrateBit() call.
//
// pointer-events-none (decorative, never intercepts a tap) and reuses
// PixelDragon's own idle-life-agnostic single instance — reduced-motion
// gating happens at the mount decision itself (mirrors PixelDragon.tsx's
// own usePrefersReducedMotion posture: reduced-motion settles its
// celebration back to nothing almost immediately anyway).

import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/store";
import PixelDragon, { CELEBRATE_MS } from "@/components/PixelDragon";

export default function BitCelebrationOverlay() {
  const status = useApp((s) => s.status);
  const celebrateNonce = useApp((s) => s.bitCelebrateNonce);
  const prevNonce = useRef(celebrateNonce);
  const [show, setShow] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (
      celebrateNonce > prevNonce.current &&
      status === "stopped" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      setShow(true);
      timer.current = window.setTimeout(() => {
        setShow(false);
        timer.current = null;
      }, CELEBRATE_MS);
    }
    prevNonce.current = celebrateNonce;
  }, [celebrateNonce, status]);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  // F2 fix (bit-train fix round): the mount effect above only reacts to a
  // nonce bump — nothing previously hid the overlay if the user started a
  // new meeting DURING the celebration window, so it lingered through
  // idle/connecting/listening. Unmount immediately the moment status
  // leaves "stopped", clearing any pending auto-dismiss timer too.
  useEffect(() => {
    if (status !== "stopped") {
      setShow(false);
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    }
  }, [status]);

  // Render-gate on status too, not just `show`: when a meeting starts,
  // React commits one render with the NEW status and the STALE show
  // (the hiding effect only runs post-commit) — without this gate the
  // overlay survives that one paint outside "stopped" (Sol r2 H).
  if (!show || status !== "stopped") return null;

  return (
    <div
      aria-hidden="true"
      data-testid="bit-celebration-overlay"
      // bottom offset clears StatusLine's own h-9/sm:h-7 + the iOS
      // safe-area spacer (page.tsx) — "above the status bar", never
      // overlapping it; z-20 mirrors review/page.tsx's own identical
      // perch (below every z-30+ dialog/drawer/Toast).
      className="pointer-events-none fixed bottom-[calc(2.25rem+env(safe-area-inset-bottom))] right-2 z-20 sm:bottom-[calc(1.75rem+env(safe-area-inset-bottom))] sm:right-4"
    >
      {/* celebrateOnMount: this instance mounts FRESH each time (unlike
          PixelDragon's other always-mounted consumers), so it needs to
          seed straight into the celebrating state instead of waiting for
          a nonce delta it will never see on its own first render — see
          PixelDragon.tsx's own doc on the prop (F1, bit-train fix round). */}
      <PixelDragon celebrateOnMount />
    </div>
  );
}
