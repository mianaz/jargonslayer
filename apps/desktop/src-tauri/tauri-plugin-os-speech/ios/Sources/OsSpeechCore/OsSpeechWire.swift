import Foundation

// S13 (docs/design-explorations/s13-ios-blueprint.md, §2 pinned wire
// contract, Lane B) — the "transcript"/"status" event payload shapes
// delivered via `Plugin.trigger(_:data:)` (Plugin.swift's own generic
// `trigger<T: Encodable>`). Ported in SPIRIT from macOS's own
// TranscriptEvents.swift/StatusEvents.swift (§2.2/§2.5), reshaped for
// iOS's actual wire mechanism: macOS encodes stderr NDJSON that Rust's
// osspeech.rs later re-maps into these same status kinds; iOS has NO
// such Rust translation layer in between (Swift's `trigger()` reaches JS
// directly via a Channel) — so `OsSpeechStatusKind` here is what
// OsSpeechSession.swift/OsSpeechPreinstall.swift decide and emit
// directly, mirroring what osspeech.rs's status_record_kind/
// asset_record_kind/error_record_kind/exit_status_kind/final_kind
// collectively decided on macOS.
//
// Pure Foundation, no `@available` gate, no AVFoundation/Speech import —
// directly host-unit-testable (see ios/Tests/OsSpeechWireTests.swift)
// even though this SwiftPM package's platforms floor can't run on a
// non-Apple host; a plain `swift test` on this Mac still exercises it.

/// The CLOSED 13-kind set (§2.5), field-exact against macOS's own
/// `OsSpeechStatusKind` (osspeech.rs) and the TS `OsSpeechStatusKind`
/// union (apps/web/src/lib/stt/osSpeech.ts). `String` rawValue ==
/// exactly the wire string — `Codable` derives straight to/from that,
/// so a payload's `kind` field never needs a manual `.rawValue`.
public enum OsSpeechStatusKind: String, Codable, Equatable {
  case starting
  case capturing
  case assetChecking = "asset-checking"
  case assetDownloading = "asset-downloading"
  case assetInstalled = "asset-installed"
  case assetFailed = "asset-failed"
  case localeResolved = "locale-resolved"
  case permissionDenied = "permission-denied"
  case unsupported
  case unsupportedLocale = "unsupported-locale"
  case deviceChanged = "device-changed"
  case crashed
  case ended

  /// Mirrors JS's own `OSSPEECH_TERMINAL_STATUS_KINDS` (osSpeech.ts)
  /// exactly — the session is OVER once any of these arrives. Backs
  /// `OsSpeechTerminalCoercion.coerce` below (F-S1): only a TERMINAL
  /// kind is ever rewritten to `.ended`, never a progress/informational
  /// one like `.capturing`/`.assetDownloading`.
  public var isTerminal: Bool {
    switch self {
    case .ended, .crashed, .permissionDenied, .unsupported, .unsupportedLocale, .deviceChanged, .assetFailed:
      return true
    case .starting, .capturing, .assetChecking, .assetDownloading, .assetInstalled, .localeResolved:
      return false
    }
  }
}

/// F-S1(a) (S13 fix round, BLOCKER) — the JS stop() latch
/// (osSpeech.ts's `STOP_ENDED_TIMEOUT_MS`, 4s) resolves ONLY on a
/// literal `kind:"ended"` status; any OTHER terminal kind (crashed/
/// asset-failed/permission-denied/...) racing in after the user's own
/// explicit stop would otherwise force JS to burn its full 4s timeout
/// even though the session actually finished promptly. Once
/// `OsSpeechSession.requestExplicitStop()` has been called, the error
/// (if any) is moot — the user asked to stop, so every SUBSEQUENT
/// terminal emission for that session is coerced to `.ended` here,
/// regardless of which path produced it. Pure/testable (no session
/// state) — `OsSpeechSession.emitStatus` is the one real call site;
/// OsSpeechCoreTests exercises this directly.
public enum OsSpeechTerminalCoercion {
  public static func coerce(kind: OsSpeechStatusKind, message: String?, explicitStopRequested: Bool) -> (kind: OsSpeechStatusKind, message: String?) {
    guard explicitStopRequested, kind.isTerminal, kind != .ended else { return (kind, message) }
    let note = "explicit stop requested; original kind: \(kind.rawValue)"
    return (.ended, message.map { "\($0) (\(note))" } ?? note)
  }
}

/// §2.5 R2 parity — every status payload names which lane produced it
/// (a running transcribe session vs. a background preinstall), since
/// both can emit on the SAME "status" event lane and JS's session engine
/// ignores anything that isn't `.session` (osSpeech.ts's own
/// `handleStatus` guard).
public enum OsSpeechEventSource: String, Codable, Equatable {
  case session
  case preinstall
}

/// `{ final, seq, startMs, endMs, text }` — field-exact against
/// `OsSpeechTranscriptPayload` (apps/web/src/lib/stt/osSpeech.ts:74).
public struct OsSpeechTranscriptPayload: Encodable, Equatable {
  public let final: Bool
  public let seq: UInt64
  public let startMs: UInt64
  public let endMs: UInt64
  public let text: String

  public init(final: Bool, seq: UInt64, startMs: UInt64, endMs: UInt64, text: String) {
    self.final = final
    self.seq = seq
    self.startMs = startMs
    self.endMs = endMs
    self.text = text
  }
}

/// `{ kind, source, message?, progress?, resolvedLocale?, supportedLocales? }`
/// — field-exact against `OsSpeechStatusPayload` (osSpeech.ts:60).
/// Optional fields are plain Swift `Optional`s: `Encodable`'s synthesized
/// conformance calls `encodeIfPresent` for them, so a `nil` field is
/// OMITTED from the JSON entirely (matches the TS type's `message?:
/// string` — an optional KEY, not a required-nullable one like
/// `OsSpeechCapabilities.reason` on the Rust side — see that struct's
/// own doc comment for the contrast).
public struct OsSpeechStatusPayload: Encodable, Equatable {
  public let kind: OsSpeechStatusKind
  public let source: OsSpeechEventSource
  public let message: String?
  public let progress: Double?
  public let resolvedLocale: String?
  public let supportedLocales: [String]?

  public init(
    kind: OsSpeechStatusKind,
    source: OsSpeechEventSource,
    message: String? = nil,
    progress: Double? = nil,
    resolvedLocale: String? = nil,
    supportedLocales: [String]? = nil
  ) {
    self.kind = kind
    self.source = source
    self.message = message
    self.progress = progress
    self.resolvedLocale = resolvedLocale
    self.supportedLocales = supportedLocales
  }
}

/// `capabilities`'s own response shape — a MANUAL `Encodable`
/// conformance (not synthesized) because `reason` must serialize as an
/// EXPLICIT `null` when absent (§6 F1: required-nullable, matching
/// Rust's own `OsSpeechCapabilities` with no `skip_serializing_if`), and
/// Swift's synthesized `Encodable` for an `Optional` stored property
/// instead calls `encodeIfPresent` (OMITS the key on `nil` — the CORRECT
/// behavior for `OsSpeechStatusPayload`'s own optionals above, and wrong
/// for this one field). Lives in `OsSpeechCore` (not the glue target)
/// specifically so its explicit-null JSON shape is host-testable — see
/// OsSpeechCoreTests/OsSpeechWireTests.swift.
public struct OsSpeechCapabilitiesPayload: Encodable, Equatable {
  public let supported: Bool
  public let reason: String?
  public let locales: [String]
  public let installedLocales: [String]

  public init(supported: Bool, reason: String?, locales: [String], installedLocales: [String]) {
    self.supported = supported
    self.reason = reason
    self.locales = locales
    self.installedLocales = installedLocales
  }

  private enum CodingKeys: String, CodingKey {
    case supported, reason, locales, installedLocales
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(supported, forKey: .supported)
    try container.encode(reason, forKey: .reason) // NOT encodeIfPresent — explicit null when nil
    try container.encode(locales, forKey: .locales)
    try container.encode(installedLocales, forKey: .installedLocales)
  }
}

/// The two event names this plugin ever `trigger()`s — pinned (§2),
/// verified against osSpeechTransport.ts's own `OS_SPEECH_PLUGIN`/
/// `"transcript"`/`"status"` literals.
public enum OsSpeechEvent {
  public static let transcript = "transcript"
  public static let status = "status"
}

/// The one error string `startTranscribe`/`preinstall` reject with (and
/// `capabilities` reports as `reason`) below the iOS 26 floor — pinned
/// (§2/§6), byte-identical to osSpeech.ts's own `IS_IOS` branch copy
/// ("系统识别需要 iOS 26 或更高版本" is the USER-facing message built from
/// this raw reason string one layer up; this exact string is the wire
/// value both `capabilities().reason` and the command `Err` carry).
public enum OsSpeechFloor {
  public static let unsupportedReason = "需要 iOS 26 或更高版本"
  // S13.1 spike finding: past-the-floor but SpeechTranscriber definitively
  // unavailable (Simulator; hypothetical unsupported hardware) — the
  // start/preinstall runtime re-check rejects with this instead of
  // resolving into a silently stuck session.
  public static let transcriberUnavailableReason = "此设备的系统语音识别不可用"
}
