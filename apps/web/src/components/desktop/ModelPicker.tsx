"use client";

// v0.4 S4 chunk 3 (docs/design-explorations/s4-model-wizard-blueprint.md,
// decision A + chunk 3) — the shared model-picker table: one row per
// MODEL_CATALOG entry, radio semantics (exactly one selectable at a
// time), reused by both the first-run wizard's consent overlay
// (DesktopWizard.tsx) and Settings' 更换模型 flow (chunk 4, not built
// yet). Terminal design language matching DesktopWizard.tsx/
// SettingsDialog.tsx: border-edge/bg-panel2/text-mut, mono, 0px radius
// (no rounded-* class anywhere below). Controlled component (value +
// onChange) — this file owns no selection state of its own, same
// contract as ToggleSwitch.tsx.
//
// Row styling mirrors SettingsDialog.tsx's ENGINE_CARDS button-card
// idiom (border-act bg-panel3 when selected, border-edge otherwise);
// the 推荐 chip reuses that same file's border-lab-green/30 text-lab-
// green idiom verbatim.
//
// Keyboard: a real <button role="radio"> per row — a real browser
// already activates a <button> on Enter/Space via its own native
// default action, but jsdom doesn't simulate that (see ToggleSwitch.
// tsx's own header comment) — onKeyDown wires the SAME shared
// lib/a11y.ts helper every other custom control in this codebase uses
// (CardsPanel/HistoryDrawer/TaskTray/ToggleSwitch), not a new
// implementation.

import { handleButtonKeyDown } from "@/lib/a11y";
import { MODEL_CATALOG } from "@/lib/desktop/modelCatalog";

export interface ModelPickerProps {
  value: string;
  onChange: (model: string) => void;
}

export default function ModelPicker({ value, onChange }: ModelPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="识别模型"
      data-testid="model-picker"
      className="space-y-1 border border-edge bg-panel2 p-1 font-mono"
    >
      {MODEL_CATALOG.map((entry) => {
        const selected = entry.id === value;
        const select = () => onChange(entry.id);
        return (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`model-option-${entry.id}`}
            onClick={select}
            onKeyDown={(e) => handleButtonKeyDown(e, select)}
            className={`flex w-full items-center justify-between gap-3 border p-2.5 text-left text-sm transition-colors ${
              selected ? "border-act bg-panel3 text-fg" : "border-edge text-fg hover:bg-panel3"
            }`}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{entry.id}</span>
                <span className="text-xs text-mut">{entry.label}</span>
                {entry.recommended && (
                  <span className="shrink-0 border border-lab-green/30 px-1.5 py-0 text-[10px] text-lab-green">
                    推荐
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-xs leading-[1.6] text-mut2">
                {entry.macSpeedHint} · {entry.qualityHint}
              </div>
            </div>
            <span className="shrink-0 text-xs text-mut">{entry.size}</span>
          </button>
        );
      })}
    </div>
  );
}
