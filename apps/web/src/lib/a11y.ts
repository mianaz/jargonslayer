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
// F4 fix round: non-modal popovers (e.g. AiStatusPanel's own popover,
// which can itself nest inside StatusLine's <sm overflow popover) still
// want the full Escape/Tab-trap/focus-restore contract but must NOT
// claim aria-modal=true — a modal dialog stacked inside another dialog
// is the wrong ARIA shape (aria-modal belongs on the outermost one).
const NON_MODAL_DIALOG_PROPS = { role: "dialog" as const };

// F3 fix round (HIGH): module-level overlay stack. Every mounted
// useOverlayA11y instance pushes its own token here while open and pops
// it on close/unmount — each instance still registers its own document
// keydown listener (so it's ready to become top-of-stack the instant
// the one above it closes), but the handler no-ops unless its token is
// the LAST one pushed. Before this, Escape closed EVERY open overlay at
// once (each installed an unconditional document listener) — a nested
// overlay (e.g. ImportHub opened from HistoryDrawer) closed both
// stacked dialogs on one Escape press instead of just the top one.
let overlayStack: symbol[] = [];

function pushOverlay(token: symbol): void {
  overlayStack = [...overlayStack, token];
}

function popOverlay(token: symbol): void {
  overlayStack = overlayStack.filter((t) => t !== token);
}

function isTopOverlay(token: symbol): boolean {
  return overlayStack[overlayStack.length - 1] === token;
}

export interface UseOverlayA11yOptions {
  open: boolean;
  onClose: () => void;
  containerRef: React.RefObject<HTMLElement | null>;
  /** F4: false for a non-modal popover nested under another overlay —
   *  drops aria-modal from the returned props (role=dialog stays).
   *  Defaults to true, matching every pre-F4 caller. */
  modal?: boolean;
}

/**
 * Overlay/dialog a11y contract (DESIGN.md v3.9b): role=dialog +
 * aria-modal, document Escape → onClose, Tab trap within containerRef,
 * initial focus on the first focusable inside (not the container —
 * see BottomSheet.tsx FIX 7), focus restore on close. SSR-safe.
 *
 * F3: Escape/Tab only act for the TOP-of-stack overlay instance — see
 * the module-level stack above. F4: pass `modal: false` to drop
 * aria-modal for a non-modal nested popover.
 */
export function useOverlayA11y({
  open,
  onClose,
  containerRef,
  modal = true,
}: UseOverlayA11yOptions): { role: "dialog"; "aria-modal"?: true } {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // Stable per-instance token — created once (Symbol() only evaluates
  // the first time tokenRef.current is still null) and reused for the
  // lifetime of this hook call, so push/pop always agree on identity.
  const tokenRef = useRef<symbol | null>(null);
  if (tokenRef.current === null) tokenRef.current = Symbol("overlay");

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

  // F3: push this instance's token while open, pop on close/unmount.
  // Runs in mount/commit order, so an overlay opened WHILE another is
  // already open always lands on top — exactly the sequential-open
  // scenario (ImportHub opened from an already-open HistoryDrawer) F3
  // fixes.
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const token = tokenRef.current!;
    pushOverlay(token);
    return () => {
      popOverlay(token);
    };
  }, [open]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;

    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      // IME guard: Escape during zh composition cancels the composition,
      // never the overlay (would silently discard a settings draft).
      if (e.isComposing || e.keyCode === 229) return;
      // F3: only the top-of-stack overlay reacts to Escape/Tab — a
      // stacked overlay underneath stays inert until the one above it
      // closes and pops.
      if (!isTopOverlay(tokenRef.current!)) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const container = containerRef.current;
      if (!container) return;

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        // F12: nothing focusable inside — trap Tab on the container
        // itself instead of letting it walk out to the page behind the
        // overlay. Only set tabIndex when the container doesn't already
        // carry one (never clobber a deliberate author choice).
        e.preventDefault();
        if (!container.hasAttribute("tabindex")) {
          container.tabIndex = -1;
        }
        container.focus();
        return;
      }

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

  return modal ? OVERLAY_DIALOG_PROPS : NON_MODAL_DIALOG_PROPS;
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
