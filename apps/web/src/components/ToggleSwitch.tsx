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
//
// S10 field-fix (#7, "太丑"): visual-only rework, API unchanged. The
// thumb is absolutely positioned (not flex-centered) so its resting
// inset is exact on both axes — the old flex layout put the CHECKED
// thumb's translate 4px past the track's own inner edge (translate-x-5
// on a 34px content box, from a 16px-wide thumb: 20+16=36 > 34),
// overflowing the border on one side while the unchecked rest position
// sat flush; the new left-0.5/top-1/2 + translate-x-4 pairing is
// symmetric (2px inset all around at both extremes). Track border
// upgraded edge -> edge2 (unchecked): edge is a passive hairline
// (DESIGN.md), too low-contrast for a control's own outline. Hover
// reuses the app's existing tokens (bg-act/85 for checked, matching
// every other primary button's hover idiom; panel3 "hover/active
// surface" for unchecked) rather than inventing new colors. Transition
// timing: the track's background-color/border-color ride .btn-tactile's
// own transition (already reduced-motion-safe, globals.css); the
// thumb's translate needs its own (nothing else here touches it), so
// duration-150 ease-out + an explicit motion-reduce override (DESIGN.md:
// "all decorative motion collapses ... no exceptions").
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
      className={`btn-tactile relative inline-block h-5 w-9 shrink-0 border disabled:cursor-not-allowed disabled:opacity-50 ${
        checked
          ? "border-act bg-act hover:bg-act/85 disabled:hover:bg-act"
          : "border-edge2 bg-panel2 hover:bg-panel3 disabled:hover:bg-panel2"
      } ${className ?? ""}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute left-0.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 transition-transform duration-150 ease-out motion-reduce:transition-none ${
          checked ? "translate-x-4 bg-ink" : "translate-x-0 bg-mut2"
        }`}
      />
    </button>
  );
}
