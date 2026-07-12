// Pure decision core for Chrome's on-device Web Speech mode
// (`processLocally`, Chrome 139+) — webSpeech.ts is the thin shell
// that queries SpeechRecognition.available()/install(), caches the
// result per language, and applies whatever this decides (same
// pure-core/thin-shell split as sttSupervisor.ts and
// webSpeechSession.ts).
//
// Research: docs/research/stt-live-engines-2026-07.md item #1 (kill
// criteria: gate purely on runtime available() — esp. for zh, where
// the spec explainer lists zh-CN/zh-TW but the memo's shipped
// Chrome-139 pack enumerations were observed omitting Chinese).
//
// Verified API shapes (MDN, 2026-07):
//   SpeechRecognition.available({langs, quality?, processLocally?})
//     -> Promise<"available"|"downloadable"|"downloading"|"unavailable">
//   SpeechRecognition.install({langs, quality?, processLocally?})
//     -> Promise<boolean>
//   recognition.processLocally: boolean, settable before start()
// See webSpeech.ts's local SpeechRecognition* shims (lib.dom.d.ts
// doesn't declare any of this) for the exact typed shape.

export type OnDeviceMode = "on-device" | "cloud";

// "api-absent": SpeechRecognition.available/install don't exist at all
// on the resolved constructor (older Chrome, non-Chrome browsers, or
// a test double) — distinct from "unavailable" (the API exists and
// affirmatively reports no local model for this language), though
// both currently resolve to the same decision below.
export type OnDeviceAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable"
  | "api-absent";

export interface OnDeviceDecision {
  mode: OnDeviceMode;
  /** Fire-and-forget SpeechRecognition.install() once for this
   *  language — never mid-session (webSpeech.ts never hot-swaps a
   *  live session onto a freshly-installed model; only the NEXT
   *  session's own availability query picks it up). */
  triggerInstall: boolean;
}

/** available+pref -> on-device now; downloadable+pref -> cloud now
 *  (nothing to run on-device yet) + triggerInstall so a later session
 *  gets a chance at it; downloading (an install already in flight
 *  elsewhere)/unavailable/api-absent -> cloud, nothing to install;
 *  pref off short-circuits everything to cloud/never-install
 *  regardless of availability — a user who turned this off should
 *  never see an install kick off behind their back. */
export function decideOnDeviceMode(
  availability: OnDeviceAvailability,
  preferSetting: boolean,
): OnDeviceDecision {
  if (!preferSetting) return { mode: "cloud", triggerInstall: false };
  if (availability === "available") return { mode: "on-device", triggerInstall: false };
  if (availability === "downloadable") return { mode: "cloud", triggerInstall: true };
  return { mode: "cloud", triggerInstall: false };
}
