// Built-in theme registry (v0.2.1). Exactly two themes ship in this
// release: `terminal` (the existing v3 default — mirrors globals.css's
// `:root, [data-theme="terminal"]` block verbatim, values never
// touched here) and `clarity` (a high-readability dark variant, the
// first theme to travel the full engine pipeline: validated by
// schema.ts, injected by apply.ts via setProperty, never a CSS string).
//
// docs/DESIGN.md v3.5 roadmap: this registry is the "open engine, only
// built-ins for now" foundation — a future community theme source
// would validate against ThemeSchema and slot in beside these two, but
// no loader for that exists yet (out of scope for v0.2.1).

import type { ThemeDefinition } from "./schema";

// Mirrors globals.css `:root, [data-theme="terminal"]` 1:1 — this is
// the CSS-authored default; applyTheme() never needs to inject these
// (switching TO terminal is a resetToDefaultTheme() removeProperty
// pass, see apply.ts), but the values are still declared here so the
// theme picker has a real ThemeDefinition to point at and future
// theme-diffing/export tooling has one source of truth.
export const TERMINAL_THEME: ThemeDefinition = {
  id: "terminal",
  label: "终端（默认）",
  scheme: "dark",
  tokens: {
    ink: "#0a0a0a",
    panel: "#121212",
    panel2: "#1a1a1a",
    panel3: "#202020",
    edge: "#262626",
    edge2: "#333333",
    fg: "#ededed",
    mut: "#9a9a9a",
    // Raised from the pre-v0.2.1 #5c5c5c (2.8:1, failing AA) to clear
    // >=4.5:1 against every panel level in use (ink/panel/panel2/
    // panel3) while staying visibly darker than --mut — see the
    // v0.2.1 contrast-audit findings (mut2 carries real Chinese
    // content text in many components, not just decoration).
    mut2: "#8c8c8c",
    "lab-red": "#ff5f56",
    "lab-orange": "#ffaa44",
    "lab-yellow": "#f7d51d",
    "lab-green": "#4ade80",
    "lab-purple": "#c084fc",
    "lab-cyan": "#22d3ee",
    act: "#ffffff",
    "warn-soft": "#ff8a80",
  },
};

// High-readability dark variant — the first theme to travel the full
// engine pipeline. Token values chosen to clear: mut >=7:1, mut2
// >=5:1, edge2-vs-panel >=3:1 (UI-component contrast, WCAG 1.4.11),
// while keeping the fg > mut > mut2 legibility ladder intact. lab-*
// hues are carried over unchanged from terminal (same label-color
// contract); only the neutral ladder + warn-soft shift for readability.
export const CLARITY_THEME: ThemeDefinition = {
  id: "clarity",
  label: "清晰（高对比深色）",
  scheme: "dark",
  tokens: {
    ink: "#0a0a0a",
    panel: "#141414",
    panel2: "#1c1c1c",
    panel3: "#242424",
    edge: "#3a3a3a",
    // Nudged from the initial #5f5f5f draft (2.89:1 vs panel, just
    // under the 3:1 UI-contrast bar) to #636363 (3.07:1) — the
    // smallest bump that clears the requirement.
    edge2: "#636363",
    fg: "#ffffff",
    mut: "#b5b5b5",
    mut2: "#8c8c8c",
    "lab-red": "#ff5f56",
    "lab-orange": "#ffaa44",
    "lab-yellow": "#f7d51d",
    "lab-green": "#4ade80",
    "lab-purple": "#c084fc",
    "lab-cyan": "#22d3ee",
    act: "#ffffff",
    "warn-soft": "#ff9d94",
  },
};

// Light counterpart of the terminal default (v0.2.4 "light mode"):
// the same neutral-ladder grammar mirrored onto warm paper. Every
// value was tuned programmatically against WCAG before landing here —
// see themes.test.ts's contrast suite, which now enforces the same
// bars on every builtin: fg/mut/mut2 and ALL lab-* + warn-soft >=4.5:1
// against every panel level (panel3, the darkest light surface, is the
// binding constraint that forced the lab-* hues this dark), edge2 and
// the lab-cyan focus ring >=3:1 (WCAG 1.4.11), and the chip pairings
// (`text-ink` on bg-act / bg-lab-green / bg-mut, StatusLine.tsx) >=
// 4.5:1. lab-* stay the SAME HUE FAMILIES as terminal (red/amber/
// gold/green/purple/cyan label contract) but drop to their AA-dark
// cousins — the bright phosphor originals sit at ~1.3-2.5:1 on paper
// and are unusable as text. `act` inverts to near-black (white is the
// dark themes' sanctioned large-area accent; its mirror here is ink-
// black), which is why primary buttons must never hardcode a hover
// hex — they use `hover:bg-act/85` (see the v0.2.4 sweep).
export const TERMINAL_LIGHT_THEME: ThemeDefinition = {
  id: "terminal-light",
  label: "终端（浅色）",
  scheme: "light",
  tokens: {
    ink: "#f2f0eb",
    panel: "#faf9f6",
    panel2: "#efede8",
    panel3: "#e7e4dd",
    edge: "#d6d3ca",
    edge2: "#8e8a7f",
    fg: "#191919",
    mut: "#45443f",
    mut2: "#63615a",
    "lab-red": "#b0302a",
    "lab-orange": "#964b00",
    "lab-yellow": "#7c6200",
    "lab-green": "#137038",
    "lab-purple": "#8440cf",
    "lab-cyan": "#076d82",
    act: "#191919",
    "warn-soft": "#b23a30",
  },
};

export const BUILTIN_THEMES: readonly ThemeDefinition[] = [
  TERMINAL_THEME,
  TERMINAL_LIGHT_THEME,
  CLARITY_THEME,
];

export function getBuiltinTheme(id: string): ThemeDefinition | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}
