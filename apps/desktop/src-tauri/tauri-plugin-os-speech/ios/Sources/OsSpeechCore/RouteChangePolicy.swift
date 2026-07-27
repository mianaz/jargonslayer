import Foundation

// Field bug (iOS TestFlight, v0.6.0) — OsSpeechSession.swift used to
// treat EVERY AVAudioSession.routeChangeNotification as terminal
// (`.deviceChanged`). On-device, benign route notifications
// (`.categoryChange` / `.routeConfigurationChange` / `.override`)
// routinely fire ~3s after session activation as the system settles the
// route post-activation — recognition died ~3s into every capture with a
// spurious device-changed error, repeatedly. This file is the extracted
// reason->decision policy (mirrors PauseGenerationFence.swift's own
// "pure decision, zero framework dependency" posture): only a route
// change that ACTUALLY breaks capture is terminal.
//
// `reasonRaw` is the notification's raw `AVAudioSessionRouteChangeReasonKey`
// UInt, matched directly against `AVAudioSession.RouteChangeReason`'s own
// documented, stable rawValues rather than importing AVFoundation here —
// AVAudioSession doesn't exist in the macOS SDK at all (OsSpeechSession.swift's
// own header comment), so importing it would drag this policy back into the
// iOS-only, untested-on-host bucket TranscriptThrottle/PauseGenerationFence
// were deliberately pulled OUT of. `oldDeviceUnavailable == 2` and
// `noSuitableRouteForCategory == 7` are Apple's own published rawValues
// (AVFAudio's AVAudioSession.h) and have never moved since the enum shipped.
public enum RouteChangeAction: Equatable {
  case ignore
  case stop(reasonLabel: String)
}

public enum RouteChangePolicy {
  private static let oldDeviceUnavailableRaw: UInt = 2
  private static let noSuitableRouteForCategoryRaw: UInt = 7

  /// Terminal ONLY for the two reasons that mean capture actually broke:
  /// the active input disappeared (`oldDeviceUnavailable`) or nothing
  /// left satisfies `.record` (`noSuitableRouteForCategory`). Every other
  /// reason — `.newDeviceAvailable`, `.categoryChange`, `.override`,
  /// `.routeConfigurationChange`, `.wakeFromSleep`, `.unknown` — and a
  /// nil/unparseable rawValue (a reason iOS adds later, or a malformed
  /// notification) are all `.ignore`d, never defaulted to terminal.
  public static func routeChangeAction(reasonRaw: UInt?) -> RouteChangeAction {
    guard let reasonRaw else { return .ignore }
    switch reasonRaw {
    case oldDeviceUnavailableRaw: return .stop(reasonLabel: "oldDeviceUnavailable")
    case noSuitableRouteForCategoryRaw: return .stop(reasonLabel: "noSuitableRouteForCategory")
    default: return .ignore
    }
  }
}
