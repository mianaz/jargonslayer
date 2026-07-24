// F3 fix (Sol MEDIUM / Opus LOW, fieldtest-a review) — page.tsx itself
// has no component test harness in this repo (see wizardHelpTransition.ts's
// own header comment for why), so this pins the extracted pure decision
// directly. Covers both transition arms plus the pass-through no-
// transition case.

import { describe, expect, it } from "vitest";
import { nextHelpOpenForWizardTransition } from "../wizardHelpTransition";

describe("nextHelpOpenForWizardTransition — F3 both-overlays-mounted fix", () => {
  it("wizard just appeared (false->true): closes the tutorial even if it was open", () => {
    expect(nextHelpOpenForWizardTransition(false, true, true, true)).toBe(false);
  });

  it("wizard just appeared (false->true): stays closed if it already was", () => {
    expect(nextHelpOpenForWizardTransition(false, true, false, true)).toBe(false);
  });

  it("wizard just stopped covering the screen (true->false) + still due: reopens the tutorial", () => {
    expect(nextHelpOpenForWizardTransition(true, false, false, true)).toBe(true);
  });

  it("wizard just stopped covering the screen (true->false) + no longer due: stays whatever it was", () => {
    expect(nextHelpOpenForWizardTransition(true, false, false, false)).toBe(false);
  });

  it("no transition (visible the whole time): passes helpOpen through unchanged", () => {
    expect(nextHelpOpenForWizardTransition(true, true, true, true)).toBe(true);
    expect(nextHelpOpenForWizardTransition(true, true, false, true)).toBe(false);
  });

  it("no transition (hidden the whole time): passes helpOpen through unchanged", () => {
    expect(nextHelpOpenForWizardTransition(false, false, true, false)).toBe(true);
    expect(nextHelpOpenForWizardTransition(false, false, false, false)).toBe(false);
  });
});
