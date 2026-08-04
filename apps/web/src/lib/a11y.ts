// Keyboard-activation helper for elements given the button role via
// role="button" + tabIndex={0}, rather than a native <button>. Used where
// a real <button> can't be: the container carries block layout that the
// browser's default button chrome would fight (CardsPanel card blocks),
// or it wraps another interactive control and a real button would nest
// illegally (HistoryDrawer's session row wraps a delete button). This
// centralizes the WAI-ARIA button pattern — Enter/Space activate, Space
// suppresses page scroll — so those sites share one tested path.
// PracticeDeck inlines the same pattern (predates this helper).

import { createElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/lib/store";

/** Keys that activate a button per the WAI-ARIA button pattern. */
export function isActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

/**
 * onKeyDown handler for a container given role="button" + tabIndex={0}.
 * Fires `onActivate` on Enter/Space and calls preventDefault so Space
 * doesn't scroll the page. Only activates when the key event originates
 * on the container itself (target === currentTarget): a keypress that
 * bubbled up from a nested focusable child — e.g. the delete button
 * inside a history row — is left to that child, so its own activation
 * isn't double-fired as a container activation.
 */
export function handleButtonKeyDown(
  e: KeyboardEvent<HTMLElement>,
  onActivate: () => void,
): void {
  if (e.target !== e.currentTarget) return;
  if (!isActivationKey(e.key)) return;
  e.preventDefault();
  onActivate();
}

const FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.tabIndex >= 0 && !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
}

const OVERLAY_DIALOG_PROPS = { role: "dialog" as const, "aria-modal": true as const };

export interface UseOverlayA11yOptions {
  open: boolean;
  onClose: () => void;
  containerRef: React.RefObject<HTMLElement | null>;
}

/**
 * Overlay/dialog a11y contract (DESIGN.md v3.9b): role=dialog +
 * aria-modal, document Escape → onClose, Tab trap within containerRef,
 * initial focus on the first focusable inside (not the container —
 * see BottomSheet.tsx FIX 7), focus restore on close. SSR-safe.
 */
export function useOverlayA11y({
  open,
  onClose,
  containerRef,
}: UseOverlayA11yOptions): { role: "dialog"; "aria-modal": true } {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open || typeof document === "undefined") return;

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const container = containerRef.current;
    if (container) {
      const focusables = getFocusableElements(container);
      if (focusables.length > 0) {
        focusables[0].focus();
      }
    }
  }, [open, containerRef]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;

    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      // IME guard: Escape during zh composition cancels the composition,
      // never the overlay (would silently discard a settings draft).
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const container = containerRef.current;
      if (!container) return;

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose, containerRef]);

  // Focus restore keys on [open] ALONE: an unstable onClose identity re-runs
  // the listener effect every render, and restoring focus in that cleanup
  // would yank focus back to the background element while the dialog is open.
  useEffect(() => {
    if (!open) return;
    return () => {
      const prev = previouslyFocusedRef.current;
      if (prev?.isConnected) {
        prev.focus();
      }
    };
  }, [open]);

  return OVERLAY_DIALOG_PROPS;
}

const CARD_ANNOUNCE_MIN_GAP_MS = 2000;

/**
 * Visually-hidden polite live region for new expression-card arrivals.
 * Mounted once at app root (page.tsx). Rate-limited to one announcement
 * per 2s; intermediate arrivals are dropped, latest wins.
 */
export function CardArrivalAnnouncer() {
  const cards = useApp(useShallow((s) => s.cards));
  const [announcement, setAnnouncement] = useState("");
  const prevCountRef = useRef(0);
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAnnounceAtRef = useRef(0);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    const count = cards.length;
    if (count <= prevCountRef.current) {
      prevCountRef.current = count;
      return;
    }

    const newest = cards[count - 1];
    const headword = newest?.expression;
    if (!headword) {
      prevCountRef.current = count;
      return;
    }

    pendingRef.current = headword;
    prevCountRef.current = count;

    if (timerRef.current) return;

    const schedule = () => {
      const now = Date.now();
      const delay = Math.max(0, CARD_ANNOUNCE_MIN_GAP_MS - (now - lastAnnounceAtRef.current));
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const text = pendingRef.current;
        pendingRef.current = null;
        if (text) {
          setAnnouncement(`新卡片：${text}`);
          lastAnnounceAtRef.current = Date.now();
        }
        if (pendingRef.current) schedule();
      }, delay);
    };
    schedule();
  }, [cards]);

  return createElement(
    "div",
    { role: "status", "aria-live": "polite", className: "sr-only" },
    announcement,
  );
}
