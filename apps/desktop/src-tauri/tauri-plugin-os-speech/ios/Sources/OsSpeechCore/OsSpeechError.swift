import Speech

// S13 (Lane B) — ported near-verbatim (pattern source: apps/desktop/
// src-tauri/audiocap-helper/Sources/AudioCapCore/OsSpeechError.swift,
// S11 §2.2/§Q9) from the macOS helper: a CLOSED set of typed
// Speech-framework failure modes. Two macOS-only cases are dropped —
// there is no CoreAudio process tap on iOS, so the tap-level
// permission-denied/device-changed/unsupported-os codes macOS reuses
// from `AudioCapError` have their OWN iOS-native origin instead
// (AVAudioApplication mic-permission result / AVAudioSession
// route-change notification) and map straight to
// `OsSpeechStatusKind.permissionDenied`/`.deviceChanged` without ever
// needing a typed Swift `Error` case of their own — see
// OsSpeechSession.swift's own mic-permission/route-change handling.
@available(iOS 26.0, macOS 26.0, *)
public enum OsSpeechError: Error {
  /// `AssetInstallationRequest.downloadAndInstall()` threw — the
  /// designed offline-first-start failure path.
  case assetDownloadFailed(String)
  /// `SpeechTranscriber.supportedLocale(equivalentTo:)` returned nil for
  /// every candidate `LocaleResolver` tried — `message` carries the
  /// originally REQUESTED BCP-47 tag (matches the wire contract's own
  /// example).
  case unsupportedLocale(String)
  /// SFSpeechError `.moduleOutputFailed` / `.insufficientResources`, or
  /// any other analyzer/transcriber failure that isn't one of the more
  /// specific cases below.
  case engineFailure(String)
  /// SFSpeechError `.incompatibleAudioFormats` / `.unexpectedAudioFormat`
  /// / `.audioDisordered`, OR this plugin's own AVAudioConverter
  /// creation/conversion failure — see OsSpeechSession.swift's
  /// `ConverterSink` for why that path is impossible-by-construction
  /// rather than merely rare (a wrong-format buffer reaching
  /// SpeechAnalyzer crashes the process instead of throwing).
  case audioFormat(String)
  /// SFSpeechError `.noModel` / `.assetLocaleNotAllocated` /
  /// `.tooManyAssetLocalesAllocated` / `.cannotAllocateUnsupportedLocale`
  /// — the asset EXISTS as a concept (locale is supported) but the
  /// Speech engine couldn't actually allocate/use it at runtime,
  /// distinct from `.assetDownloadFailed`.
  case assetUnavailable(String)

  public var code: String {
    switch self {
    case .assetDownloadFailed: return "asset-download-failed"
    case .unsupportedLocale: return "unsupported-locale"
    case .engineFailure: return "engine-failure"
    case .audioFormat: return "audio-format"
    case .assetUnavailable: return "asset-unavailable"
    }
  }

  public var message: String {
    switch self {
    case .assetDownloadFailed(let message),
      .unsupportedLocale(let message),
      .engineFailure(let message),
      .audioFormat(let message),
      .assetUnavailable(let message):
      return message
    }
  }

  /// Maps a caught `SFSpeechError` to this taxonomy — the fallback
  /// `.engineFailure` covers every OTHER SFSpeechError code this plugin
  /// never expects to see on the streaming path but shouldn't crash/
  /// mis-tag if it ever does. `context` is a short caller-supplied label
  /// (e.g. "analyzer.start") folded into the message so a log reader can
  /// tell which call site actually threw.
  public static func from(_ error: Error, context: String) -> OsSpeechError {
    guard let speechError = error as? SFSpeechError else {
      return .engineFailure("\(context) failed: \(error)")
    }
    let detail = "\(context) failed: \(speechError)"
    switch speechError.code {
    case .noModel, .assetLocaleNotAllocated, .tooManyAssetLocalesAllocated, .cannotAllocateUnsupportedLocale:
      return .assetUnavailable(detail)
    case .incompatibleAudioFormats, .unexpectedAudioFormat, .audioDisordered:
      return .audioFormat(detail)
    case .moduleOutputFailed, .insufficientResources:
      return .engineFailure(detail)
    default:
      return .engineFailure(detail)
    }
  }
}

/// The status kind this plugin maps every `OsSpeechError` case to when
/// emitting a terminal "status" event — mirrors osspeech.rs's own
/// `error_record_kind` (macOS): only `unsupportedLocale`/
/// `assetDownloadFailed`/`assetUnavailable` have a dedicated kind;
/// `engineFailure`/`audioFormat` fall through to `.crashed` (same
/// "no kind of their own" posture that file's doc comment describes).
@available(iOS 26.0, macOS 26.0, *)
extension OsSpeechError {
  public var statusKind: OsSpeechStatusKind {
    switch self {
    case .unsupportedLocale: return .unsupportedLocale
    case .assetDownloadFailed, .assetUnavailable: return .assetFailed
    case .engineFailure, .audioFormat: return .crashed
    }
  }
}
