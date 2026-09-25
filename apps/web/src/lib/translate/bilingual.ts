// Whether the live translation lane should run.
//
// The demo replays recorded
// translations regardless of the user's own bilingualTranscript toggle,
// so its first-run story shows the bilingual transcript. Derived here
// instead of flipping the setting, so nothing about the demo can reach
// persisted settings (the demo overlay stash only covers `engine`).
// `demoReplay` is true only for a lane actually replaying the demo
// script: TranslateQueue passes whether its provider is the demo one,
// StatusLine passes whether the live engine is the demo. Same en->en
// guard as store.updateSettings: translating English into English is a
// no-op, demo or not.

import type { Settings } from "@jargonslayer/core/types";

export function bilingualActive(settings: Settings, demoReplay: boolean): boolean {
  if (settings.language.split("-")[0] === settings.explainLanguage) return false;
  return settings.bilingualTranscript || demoReplay;
}
