"use client";

// Terminal-style boolean switch (settings redesign, owner ask
// 2026-07-11: "checkboxes → toggles") — replaces every raw
// <input type="checkbox"> row across SettingsDialog.tsx. A real
// <button role="switch"> (not a role="button" div), so a real browser
// already activates it on Enter/Space via the button's own native
// default action; onKeyDown still wires the shared a11y.ts helper
// (same pattern as CardsPanel/HistoryDrawer/TaskTray's role="button"
// rows) so that activation is independently exercised under jsdom,
// which doesn't simulate a native <button>'s default keyboard-to-click
// behavior. 0px radius (app-wide rule): no rounded-* class anywhere
// here, matching every other bordered element in this codebase.
import { handleButtonKeyDown } from "@/lib/a11y";

export interface ToggleSwitchProps {
  checked: boolean;
  /** Omit for a purely decorative, always-on/disabled row (see the
   *  始终启用 dictionary base-pack row in SettingsDialog.tsx). */
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** For an explicit htmlFor/id pairing; every current call site
   *  instead relies on being nested inside an existing <label> (button
   *  is a labelable element, so a label click already forwards to it
   *  with no id needed) — kept for callers that need the label
   *  elsewhere in the DOM. */
  id?: string;
  ariaLabel?: string;
  className?: string;
}

export default function ToggleSwitch({
  checked,
  onChange,
  disabled,
  id,
  ariaLabel,
  className,
}: ToggleSwitchProps) {
  const toggle = () => {
    if (disabled) return;
    onChange?.(!checked);
  };

  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={toggle}
      onKeyDown={(e) => handleButtonKeyDown(e, toggle)}
      className={`btn-tactile relative inline-flex h-5 w-9 shrink-0 items-center border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "border-act bg-act" : "border-edge bg-panel2"
      } ${className ?? ""}`}
    >
      <span
        aria-hidden="true"
        className={`block h-4 w-4 shrink-0 transition-transform ${
          checked ? "translate-x-5 bg-ink" : "translate-x-0.5 bg-mut2"
        }`}
      />
    </button>
  );
}
