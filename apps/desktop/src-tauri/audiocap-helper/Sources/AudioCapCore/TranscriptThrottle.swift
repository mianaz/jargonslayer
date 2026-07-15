import Foundation

// S11 (§Q2/§1) — pure throttle deciding whether a given transcript
// result is actually worth an NDJSON emission. Spike measured ~4.6
// volatile results/s with per-token bursts (s11-spike-findings-
// speechanalyzer.md's own "Streaming pipeline" section) — emitting every
// single one would flood the stderr NDJSON lane for no UI benefit (each
// volatile is the FULL current-range progressive text, so only the
// latest one before a repaint matters). Rule (§Q2): a volatile is
// emitted at most every 150ms OR whenever the result's time range
// advances (start or end moved) — whichever comes first; a FINAL always
// bypasses the throttle entirely (finals are rare — spike: one every few
// seconds at semantic boundaries — and must never be dropped, matching
// D2/D5's own "never drop a final" posture one layer down the pipeline).
//
// Deliberately works over plain (startMs, endMs) integers rather than
// CoreMedia's CMTimeRange: this keeps the throttle importable/testable
// with zero framework dependency beyond Foundation (no CoreMedia, no
// Speech, no `@available` gate needed on the type itself) — the
// CMTimeRange -> ms conversion is the SpeechAnalyzerSession/TranscriptEvents
// seam's job (TranscriptEvents.milliseconds(from:)), not this file's.
public struct TranscriptThrottle {
    private let minInterval: TimeInterval
    private let clock: () -> Date

    private var lastEmitTime: Date?
    private var lastEmittedStartMs: Int64?
    private var lastEmittedEndMs: Int64?

    /// `minInterval` defaults to the spec'd 150ms; `clock` is injectable
    /// (default `Date.init`) purely so tests can drive elapsed time
    /// deterministically without a real sleep — same rationale as every
    /// other injectable clock/timeout in this package (Writer's
    /// `starvationTimeout`, TranscribeConsumer's own `clock`).
    public init(minInterval: TimeInterval = 0.15, clock: @escaping () -> Date = Date.init) {
        self.minInterval = minInterval
        self.clock = clock
    }

    /// Returns `true` iff this result should actually be emitted as NDJSON.
    /// Has side effects (records the emission) exactly when it returns
    /// `true` — mirrors `TranscribeConsumer.pollOnce`'s own
    /// call-and-it-updates-state shape, so callers just do
    /// `if throttle.shouldEmit(...) { TranscriptEvents.emitTranscript(...) }`
    /// with no separate "now record that I emitted" step to forget.
    public mutating func shouldEmit(final: Bool, startMs: Int64, endMs: Int64) -> Bool {
        let now = clock()
        guard !final else {
            lastEmitTime = now
            record(startMs: startMs, endMs: endMs)
            return true
        }

        let rangeAdvanced = startMs != lastEmittedStartMs || endMs != lastEmittedEndMs
        let intervalElapsed = lastEmitTime.map { now.timeIntervalSince($0) >= minInterval } ?? true
        guard rangeAdvanced || intervalElapsed else { return false }

        lastEmitTime = now
        record(startMs: startMs, endMs: endMs)
        return true
    }

    private mutating func record(startMs: Int64, endMs: Int64) {
        lastEmittedStartMs = startMs
        lastEmittedEndMs = endMs
    }
}
