// F3 fix (Sol MEDIUM / Opus LOW, fieldtest-a review): pure decision for
// page.tsx's wizardVisible transition watcher, pulled into its own file
// so it's directly unit-testable WITHOUT importing page.tsx itself —
// that module's own import graph (Header/TranscriptPanel/CardsPanel/…,
// ~15 heavy children) would need mocking just like app/review/__tests__/
// page.test.tsx already does for its much smaller tree, which isn't
// worth it for one 3-line decision. See page.tsx's own effect comment
// for the full rationale (both-overlays-mounted race, accepted skip-
// window residual).

/** Two transition arms, otherwise a pass-through:
 *   - wizard just appeared (false->true): close the tutorial so the two
 *     full-screen overlays (wizard + tutorial) are never both mounted.
 *   - wizard just stopped covering the screen (true->false): reopen the
 *     tutorial, but only if it's still due (shouldShowTutorialNow). */
export function nextHelpOpenForWizardTransition(
  prevWizardVisible: boolean,
  wizardVisible: boolean,
  helpOpen: boolean,
  shouldShowTutorialNow: boolean,
): boolean {
  if (!prevWizardVisible && wizardVisible) return false;
  if (prevWizardVisible && !wizardVisible && shouldShowTutorialNow) return true;
  return helpOpen;
}
