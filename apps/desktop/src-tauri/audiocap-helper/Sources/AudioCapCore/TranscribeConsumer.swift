import Foundation

// S11 (§Q1/§3 Worker A) — the transcribe-mode analog of Writer.swift:
// "a dedicated producer Thread running a Writer-shaped poll loop (~4ms,
// starvation deadman, stats, dropped-frame accounting) that drains the
// ring, builds a native-format AVAudioPCMBuffer, runs AVAudioConverter,
// and continuation.yield(AnalyzerInput(buffer:))". This file is
// deliberately its OWN copy of that ~40-line poll/starvation/stats
// skeleton (Writer.swift is Must-NOT-TOUCH, and the blueprint's own
// rationale is explicit: "keeps the RT invariant and the 'state machine
// testable without CoreAudio' property while isolating the one
// framework-bound seam... behind a protocol") — the ONE thing that
// differs from Writer is what happens to a drained record: instead of
// accumulating bytes for a stdout Framing chunk, it's handed to an
// injectable `FrameSink`, whose real (production) conformance is the
// framework-bound convert+yield seam (SpeechAnalyzerSession.swift),
// while tests use a fake that just records calls.
///
/// The one piece of framework-bound work a `FrameSink` conformance does
/// (convert native PCM -> SpeechAnalyzer's negotiated format and yield
/// into its input stream) is NOT this protocol's concern — `receive` is
/// handed the exact same "native tap byte layout, already normalized to
/// interleaved" payload Writer's own `append` works with, so a fake sink
/// needs nothing more than Foundation to conform.
public protocol FrameSink {
    /// Called once per unit of audio TranscribeConsumer decides is worth
    /// forwarding — either real drained ring bytes, or synthesized
    /// all-zero silence standing in for a delta of newly-dropped frames
    /// (`insertSilenceForAnyNewlyDroppedFrames` below, exactly Writer's
    /// own F5 policy) — `payload` is always interleaved (planar tap
    /// output is converted before this is ever called, same as Writer's
    /// own `append`). Never called while paused (see
    /// `TranscribeConsumer`'s own header comment on pause semantics).
    func receive(frameCount: UInt32, payload: UnsafeRawBufferPointer)
}

/// `@unchecked Sendable`: constructed on the main session's (async)
/// context, then handed to exactly ONE dedicated producer `Thread`
/// (SpeechAnalyzerSession.swift) whose `run(shouldStop:)`/`pollOnce()`/
/// `drainRemaining()` calls are the ONLY thing that ever touches this
/// instance's mutable state afterward — never called concurrently from
/// two threads at once (the same single-consumer-thread invariant
/// Writer.swift itself relies on, just crossing an explicit thread
/// handoff here instead of being called from the same thread
/// throughout). The compiler can't see that ownership discipline, hence
/// `@unchecked` rather than a plain `Sendable` conformance.
public final class TranscribeConsumer: @unchecked Sendable {
    /// What ended `run(shouldStop:)` — identical meaning to
    /// `Writer.StopReason` (kept as its own type here rather than
    /// reusing Writer's, since Writer.swift is Must-NOT-TOUCH and this
    /// file must not need to import/depend on anything in it).
    public enum StopReason: Equatable {
        case requested
        case starved
    }

    private let ring: SPSCByteRing
    private let channels: UInt16
    private let isNonInterleaved: Bool
    private let sink: FrameSink
    /// §Q3/§A1 pause semantics: "producer keeps draining the ring but
    /// DISCARDS frames while paused (prevents ring overflow); no
    /// finalize on pause; resume re-enables yielding." Polled once per
    /// `pollOnce()` call (not per-record) so a single poll cycle is
    /// internally consistent even if the flag flips mid-cycle.
    private let isPaused: () -> Bool
    /// Injectable so tests drive the starvation/stats cadence with a
    /// fake, instantly-advanceable clock instead of real `Thread.sleep`
    /// — a deliberate departure from WriterTests' own "real Date(), just
    /// a short real timeout" style, per this slice's own test-plan ask.
    private let clock: () -> Date

    private let pollInterval: TimeInterval
    private let statsInterval: TimeInterval
    private let starvationTimeout: TimeInterval
    /// Fix C (pre-tag fix round, sustained-audio predicate): the tap's own
    /// sample rate — needed to convert `windowLoudSamples` (a raw sample
    /// COUNT, channel/frame-agnostic like PeakMeter's own scan) into a
    /// DURATION (`windowLoudMs`). Defaulted for every pre-existing test call
    /// site that only cares about peak/starvation/pause bookkeeping; the one
    /// real production call site (SpeechAnalyzerSession.run) always passes
    /// the tap's actual negotiated rate.
    private let sampleRate: UInt32
    /// Dual-capture mic producer — threaded straight through into every
    /// `StatusEvents.emitStats` call this class makes (below and in
    /// `emitFinalStats`); see StatusEvents.StatsRecord's own `channel`
    /// doc comment for the full nil-omission/dual-mode-only rationale.
    /// `nil` for every existing caller (this class's OWN pre-existing
    /// callers never passed a channel — see the defaulted init param).
    private let channel: String?

    private var framesOut: UInt64 = 0
    private var ringHighWater: UInt64 = 0
    private var peak: Float = 0
    private var windowPeak: Float = 0
    /// Fix C: raw count of samples louder than `PeakMeter.speechSampleFloor`
    /// accumulated since the last stats emission — reset alongside
    /// `windowPeak` (same cadence, same reason: "since the last emission
    /// only"). Converted to `windowLoudMs` at emission time via `sampleRate`
    /// (and `channels`, since this is a raw sample count across every
    /// interleaved channel, not a frame count).
    private var windowLoudSamples: Int = 0
    private var lastObservedDroppedFrames: UInt64 = 0
    private var lastStats: Date
    private var lastActivityTime: Date?

    public init(
        ring: SPSCByteRing,
        channels: UInt16,
        isNonInterleaved: Bool,
        sink: FrameSink,
        isPaused: @escaping () -> Bool = { false },
        pollInterval: TimeInterval = 0.004,
        starvationTimeout: TimeInterval = 3.0,
        statsInterval: TimeInterval = 5.0,
        clock: @escaping () -> Date = Date.init,
        channel: String? = nil,
        sampleRate: UInt32 = 16000
    ) {
        self.ring = ring
        self.channels = channels
        self.isNonInterleaved = isNonInterleaved
        self.sink = sink
        self.isPaused = isPaused
        self.pollInterval = pollInterval
        self.starvationTimeout = starvationTimeout
        self.statsInterval = statsInterval
        self.clock = clock
        self.lastStats = clock()
        self.channel = channel
        self.sampleRate = sampleRate
    }

    #if DEBUG
    /// Test-only peek, exactly Writer's own `debugPeakAndWindowPeak` —
    /// `StatusEvents.emitStats` has no injectable output, so this is the
    /// seam TranscribeConsumerTests uses to verify peak/windowPeak/
    /// windowLoudMs bookkeeping (including the periodic-emission reset)
    /// without capturing the real stderr NDJSON. Never called in production.
    var debugPeakAndWindowPeak: (peak: Float, windowPeak: Float, windowLoudMs: UInt32) { (peak, windowPeak, currentWindowLoudMs()) }
    #endif

    /// `windowLoudSamples` (a raw sample count) -> milliseconds, via this
    /// consumer's own `sampleRate`/`channels` — see `windowLoudSamples`'s
    /// own doc comment for why both are needed (not just sampleRate alone).
    private func currentWindowLoudMs() -> UInt32 {
        guard windowLoudSamples > 0 else { return 0 }
        let samplesPerMs = Double(sampleRate) * Double(channels) / 1000.0
        guard samplesPerMs > 0 else { return 0 }
        return UInt32(Double(windowLoudSamples) / samplesPerMs)
    }

    /// Reused UNCHANGED on the transcribe path (§2.2): the exact same
    /// `StatusEvents.emitStats` call Writer.emitFinalStats makes, with
    /// this consumer's own running counters.
    public func emitFinalStats() {
        StatusEvents.emitStats(
            overflows: ring.overflowCount(),
            ringHighWater: ringHighWater,
            framesOut: framesOut,
            droppedFrames: ring.droppedFrameCount(),
            peak: peak,
            windowPeak: windowPeak,
            channel: channel,
            windowLoudMs: currentWindowLoudMs()
        )
    }

    /// Blocks, polling the ring, until EITHER `shouldStop()` returns true
    /// (`.requested`) OR the starvation dead-man switch trips
    /// (`.starved`) — identical contract to `Writer.run(shouldStop:)`,
    /// see that method's own doc comment for the full rationale (F6).
    public func run(shouldStop: () -> Bool) -> StopReason {
        while !shouldStop() {
            if pollOnce() {
                return .starved
            }
            Thread.sleep(forTimeInterval: pollInterval)
        }
        return .requested
    }

    /// The true final drain — call only after the tap's IOProc is
    /// GUARANTEED not to fire again (main.swift's own teardown ordering,
    /// mirroring Writer.drainRemaining's own doc comment exactly).
    public func drainRemaining() {
        _ = pollOnce()
    }

    // ---- internals ----

    /// One poll cycle: drain whatever the ring currently holds, forward
    /// each record to `sink` (unless paused), account for any newly-
    /// dropped-frame delta, update high-water/stats, and report
    /// starvation. Public (unlike Writer's own private `pollOnce`) so
    /// tests can drive individual cycles directly against an injected
    /// clock, without a real sleep loop — see this class's own header
    /// comment on the injected-clock departure from WriterTests' style.
    @discardableResult
    public func pollOnce() -> Bool {
        let paused = isPaused()
        ring.drain { [self] frameCount, payload in
            handle(frameCount: frameCount, payload: payload, paused: paused)
        }
        insertSilenceForAnyNewlyDroppedFrames(paused: paused)
        ringHighWater = max(ringHighWater, UInt64(ring.approximateUsedBytes()))

        let now = clock()
        if now.timeIntervalSince(lastStats) >= statsInterval {
            StatusEvents.emitStats(
                overflows: ring.overflowCount(),
                ringHighWater: ringHighWater,
                framesOut: framesOut,
                droppedFrames: ring.droppedFrameCount(),
                peak: peak,
                windowPeak: windowPeak,
                channel: channel,
                windowLoudMs: currentWindowLoudMs()
            )
            lastStats = now
            windowPeak = 0
            windowLoudSamples = 0
        }

        if let lastActivityTime, now.timeIntervalSince(lastActivityTime) >= starvationTimeout {
            return true
        }
        return false
    }

    /// Mirrors `Writer.append` — proof-of-life/peak tracking happen
    /// regardless of pause state (draining IS still happening, and
    /// peak/windowPeak are diagnostic amplitude readouts a paused
    /// session shouldn't hide), but forwarding to `sink` (the only path
    /// that can reach the analyzer) is gated on `!paused` — §Q3: "no
    /// audio should reach SpeechAnalyzer while paused."
    private func handle(frameCount: UInt32, payload: UnsafeRawBufferPointer, paused: Bool) {
        guard frameCount > 0, payload.count > 0 else { return }
        lastActivityTime = clock()
        let scan = PeakMeter.scanWithLoudCount(in: payload)
        if scan.peak > peak { peak = scan.peak }
        if scan.peak > windowPeak { windowPeak = scan.peak }
        windowLoudSamples += scan.loudSampleCount

        guard !paused else { return }
        if isNonInterleaved {
            var interleaved = [UInt8](repeating: 0, count: payload.count)
            interleaved.withUnsafeMutableBytes { destination in
                Interleave.planarToInterleaved(planar: payload, frameCount: Int(frameCount), channels: Int(channels), into: destination)
            }
            interleaved.withUnsafeBytes { sink.receive(frameCount: frameCount, payload: $0) }
        } else {
            sink.receive(frameCount: frameCount, payload: payload)
        }
        framesOut += UInt64(frameCount)
    }

    /// Mirrors `Writer.insertSilenceForAnyNewlyDroppedFrames` (F5 policy
    /// — see that method's own doc comment for the full "never
    /// time-compress" rationale): reads the delta in the ring's
    /// cumulative `droppedFrameCount()` since the last poll and forwards
    /// exactly that many all-zero interleaved frames to `sink`, UNLESS
    /// paused (§Q3: pausing suppresses every path into the analyzer, not
    /// just real audio — synthetic silence for a drop that happened
    /// while paused is not meaningful to yield either). The delta itself
    /// is still consumed/recorded even while paused, so it can never be
    /// misattributed to a burst right after resume.
    private func insertSilenceForAnyNewlyDroppedFrames(paused: Bool) {
        let currentDropped = ring.droppedFrameCount()
        let delta = currentDropped &- lastObservedDroppedFrames
        guard delta > 0 else { return }
        lastObservedDroppedFrames = currentDropped
        lastActivityTime = clock()

        guard !paused else { return }
        let bytesPerFrame = max(1, Int(channels) * 4)
        let silence = [UInt8](repeating: 0, count: Int(delta) * bytesPerFrame)
        silence.withUnsafeBytes { sink.receive(frameCount: UInt32(truncatingIfNeeded: delta), payload: $0) }
        framesOut += delta
    }
}
