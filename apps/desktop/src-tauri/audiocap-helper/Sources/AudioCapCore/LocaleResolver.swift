import Foundation

// S11 (§Q4/§3 Worker A) — resolves the CLI's `--locale` (a BCP-47 tag,
// e.g. "zh-Hans", "en-US") to the Locale SpeechTranscriber actually
// supports, driving both the `{"type":"locale",...}` NDJSON emission
// and the `unsupported-locale` typed-error path. Split in two, same
// spirit as TranscribeConsumer/FrameSink one file over: a SEAM protocol
// (`LocaleEquivalenceProviding`) wraps the one line that actually needs
// live Speech.framework/macOS 26 (`SpeechTranscriber.supportedLocale(
// equivalentTo:)`, spike-verified to map BCP-47 cleanly — zh-Hans->zh_CN,
// en-US->en_US — s11-spike-findings-speechanalyzer.md's own "Locale
// coverage" section), while the FALLBACK-CANDIDATE logic below is pure
// Foundation (no Speech import, no availability gate) and directly unit
// tested with a fake provider.
public protocol LocaleEquivalenceProviding {
    /// Mirrors `SpeechTranscriber.supportedLocale(equivalentTo:)`'s own
    /// signature exactly (async, optional return) so the real
    /// production conformance (SpeechAnalyzerSession.swift,
    /// `@available(macOS 26.0, *)`) is a one-line pass-through.
    func supportedLocale(equivalentTo locale: Locale) async -> Locale?
}

public struct LocaleResolver {
    public enum Resolution: Equatable {
        case resolved(requested: String, resolved: Locale)
        case unsupported(requested: String)

        public static func == (lhs: Resolution, rhs: Resolution) -> Bool {
            switch (lhs, rhs) {
            case let (.resolved(lRequested, lResolved), .resolved(rRequested, rResolved)):
                return lRequested == rRequested && lResolved.identifier == rResolved.identifier
            case let (.unsupported(lRequested), .unsupported(rRequested)):
                return lRequested == rRequested
            default:
                return false
            }
        }
    }

    private let provider: LocaleEquivalenceProviding

    public init(provider: LocaleEquivalenceProviding) {
        self.provider = provider
    }

    /// Tries `bcp47` itself first, then progressively broader fallback
    /// candidates (`fallbackCandidates(for:)` below) — e.g. a fully
    /// region-qualified tag the provider doesn't recognize directly
    /// (say "zh-Hans-SG") still resolves via its script-level parent
    /// ("zh-Hans") without the CALLER needing to know that broader tag
    /// exists. Returns the FIRST candidate the provider resolves;
    /// `.unsupported` only once EVERY candidate, including `bcp47`
    /// itself, comes back nil.
    public func resolve(bcp47: String) async -> Resolution {
        for candidate in Self.fallbackCandidates(for: bcp47) {
            if let resolved = await provider.supportedLocale(equivalentTo: Locale(identifier: candidate)) {
                return .resolved(requested: bcp47, resolved: resolved)
            }
        }
        return .unsupported(requested: bcp47)
    }

    /// Pure, no seam/async needed — directly testable. Produces `bcp47`
    /// itself followed by each progressively-shorter hyphen-separated
    /// prefix (dropping one trailing subtag at a time), e.g.
    /// "zh-Hans-SG" -> ["zh-Hans-SG", "zh-Hans", "zh"]. A single-subtag
    /// input (no hyphen, e.g. "zh") yields just `[bcp47]` — nothing left
    /// to broaden. Never empty: `bcp47` itself is always the first
    /// candidate, even for a malformed/empty input.
    static func fallbackCandidates(for bcp47: String) -> [String] {
        var candidates = [bcp47]
        var components = bcp47.split(separator: "-").map(String.init)
        while components.count > 1 {
            components.removeLast()
            candidates.append(components.joined(separator: "-"))
        }
        return candidates
    }
}
