import Speech

// S11 (docs/design-explorations/s11-osspeech-blueprint.md, §2.2/§Q9) —
// the transcribe-mode analog of AudioCapError: a CLOSED set of typed
// error codes emitted as `{"type":"error","code":"...","message":"..."}`
// on the SAME stderr NDJSON lane (TranscriptEvents.emitError, this
// file's own doc comment). Deliberately a SEPARATE enum from
// AudioCapError (not an added case there) — Q9's own rationale: "keep
// AudioCapError's closed set pristine for appaudio; osspeech errors
// live in their own enum" — Rust's `error_record_kind` already
// exhaustively matches AudioCapError's seven codes, and an eighth
// unrelated-to-capture code showing up there would be exactly the kind
// of silent breakage AudioCapError's own header comment warns against.
// Tap-level failures (permission-denied/device-changed/unsupported-os)
// still ride AudioCapError UNCHANGED on the transcribe path (blueprint
// §2.2's "Reused unchanged" list) — this enum is only for the
// Speech-framework-specific failure modes that have no AudioCapError
// analog.
@available(macOS 26.0, *)
public enum OsSpeechError: Error {
    /// `AssetInstallationRequest.downloadAndInstall()` threw — the
    /// designed offline-first-start failure path (Q9: "Offline-first-
    /// start-with-uninstalled-asset is the designed failure path").
    /// Deliberately NOT narrowed to a specific underlying error type:
    /// the spike never enumerated a closed set of download-failure
    /// causes (network unreachable, disk full, cancelled, ...), so ANY
    /// throw from that one call site maps here.
    case assetDownloadFailed(String)
    /// `SpeechTranscriber.supportedLocale(equivalentTo:)` returned nil
    /// for every candidate LocaleResolver tried (LocaleResolver.swift's
    /// own fallback-candidate list) — `message` carries the originally
    /// REQUESTED BCP-47 tag (matches the wire contract's own example:
    /// `{"code":"unsupported-locale","message":"zh-Yue"}`).
    case unsupportedLocale(String)
    /// SFSpeechError `.moduleOutputFailed` / `.insufficientResources`,
    /// or any other analyzer/transcriber failure (analyzer.start,
    /// results consumption, finalize) that isn't one of the more
    /// specific cases below — the catch-all "the Speech engine itself
    /// misbehaved" bucket.
    case engineFailure(String)
    /// SFSpeechError `.incompatibleAudioFormats` / `.unexpectedAudioFormat`
    /// / `.audioDisordered`, OR (far more likely in practice, per the
    /// spike's own SIGTRAP finding) THIS helper's own AVAudioConverter
    /// creation/conversion failure — see SpeechAnalyzerSession.swift's
    /// own doc comment for why that path is impossible-by-construction
    /// rather than merely rare: a wrong-format buffer reaching
    /// SpeechAnalyzer crashes the process instead of throwing, so this
    /// case exists for the FAILURE-TO-CONVERT path (caught safely,
    /// before anything is ever yielded), not as a report of a crash
    /// that already happened.
    case audioFormat(String)
    /// SFSpeechError `.noModel` / `.assetLocaleNotAllocated` /
    /// `.tooManyAssetLocalesAllocated` / `.cannotAllocateUnsupportedLocale`
    /// — the asset EXISTS as a concept (locale is supported) but the
    /// Speech engine couldn't actually allocate/use it at runtime,
    /// distinct from `.assetDownloadFailed` (which is specifically the
    /// download/install call itself throwing).
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

    /// Maps a caught `SFSpeechError` to this taxonomy per §Q9's own
    /// grouping (see each case's own doc comment above for the exact
    /// code lists) — the fallback `.engineFailure` covers every OTHER
    /// SFSpeechError code (e.g. `.internalServiceError`,
    /// `.audioReadFailed`) this helper never expects to see on the
    /// streaming path but shouldn't crash/mis-tag if it ever does.
    /// `context` is a short caller-supplied label (e.g. "analyzer.start")
    /// folded into the message so a log reader can tell which call site
    /// actually threw, since SFSpeechError's own `localizedDescription`
    /// alone doesn't say that.
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
