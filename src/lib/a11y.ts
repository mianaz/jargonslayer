// Keyboard-activation helper for elements given the button role via
// role="button" + tabIndex={0}, rather than a native <button>. Used where
// a real <button> can't be: the container carries block layout that the
// browser's default button chrome would fight (CardsPanel card blocks),
// or it wraps another interactive control and a real button would nest
// illegally (HistoryDrawer's session row wraps a delete button). This
// centralizes the WAI-ARIA button pattern — Enter/Space activate, Space
// suppresses page scroll — so those sites share one tested path.
// PracticeDeck inlines the same pattern (predates this helper).

import type { KeyboardEvent } from "react";

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
