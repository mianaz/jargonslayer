import Foundation

// S9.1 — the non-realtime consumer side: "Writer thread: polls the ring
// every ~4 ms, drains to stdout using framing v1..., emits a `stats`
// NDJSON record to stderr every ~5 s." Deliberately CoreAudio-agnostic
// (takes plain sampleRate/channels/isNonInterleaved values, computed
// once by the caller from the tap's ASBD) so it stays testable without
// any live CoreAudio session, even though a dedicated Writer test isn't
// part of this slice's required test list.
public final class Writer {
    private let ring: SPSCByteRing
    private let channels: UInt16
    private let isNonInterleaved: Bool
    private let output: FileHandle

    private var seq: UInt64 = 0
    private var framesOut: UInt64 = 0
    private var ringHighWater: UInt64 = 0
    // S9 live-failure investigation — PeakMeter.maxAbsoluteSample
    // folded into a running session-lifetime max (`peak`, never reset)
    // and a since-last-stats-emission max (`windowPeak`, reset to 0
    // right after each emission — see pollOnce/emitFinalStats). See
    // PeakMeter.swift's own header comment for why this exists: byte
    // counts alone can't distinguish a healthy capture from a tap
    // silently receiving pure digital silence.
    private var peak: Float = 0
    private var windowPeak: Float = 0
    // F5 (adversarial-review fix round) — the ring's own cumulative,
    // never-reset droppedFrameCount() as of the last poll; the DELTA
    // since this is what gets inserted as zero frames each cycle (see
    // insertSilenceForAnyNewlyDroppedFrames's own doc comment).
    private var lastObservedDroppedFrames: UInt64 = 0

    // Interleaved-f32 bytes accumulated since the last stdout flush, and
    // how many frames that represents — flushed as one Framing.encodeChunk
    // record once the accumulator reaches ~20ms of audio (the middle of
    // the spec's "target ~10-50ms of audio per chunk") or maxFlushLatency
    // has elapsed since the last flush, whichever comes first (the
    // latter bounds latency if the source is trickling in slowly).
    private var accumulated: [UInt8] = []
    private var accumulatedFrameCount: UInt32 = 0
    private let targetChunkBytes: Int
    private let maxFlushLatency: TimeInterval = 0.05

    private var lastFlush = Date()
    private var lastStats = Date()
    // Injectable (default 5s, the real spec'd cadence) purely so tests
    // can exercise the periodic-emission/windowPeak-reset behavior
    // without a real 5-second wait — same rationale as
    // `starvationTimeout`'s own injectable default just below.
    private let statsInterval: TimeInterval
    private let pollInterval: TimeInterval = 0.004

    // F6 (adversarial-review fix round) — IO-starvation dead-man switch.
    // `lastActivityTime` stays `nil` until the FIRST real signal of life
    // from the ring (a drained frame OR a newly-observed drop — either
    // proves the IOProc is still actually firing on the device clock),
    // which is exactly what keeps starvation detection OFF during the
    // pre-capturing phase (e.g. a user still sitting at the TCC prompt)
    // per this fix's own requirement. `starvationTimeout` is injectable
    // (default 3s, the real spec'd value) purely so tests can exercise
    // this without a real 3-second wait — same rationale as `output`'s
    // own injectable default just above.
    private var lastActivityTime: Date?
    private let starvationTimeout: TimeInterval

    // F12 (adversarial-review fix round) — invoked once per FAILED
    // stdout write (flush/writeEOS below), never more than that call's
    // own failure. Defaults to a no-op so existing/test callers that
    // don't care keep working unchanged; main.swift's real production
    // wiring passes `shutdown.requestShutdownFromWriteFailure` (see
    // that method's own doc comment) so a closed parent pipe (EPIPE —
    // the parent read our stdout and is gone) is treated exactly like
    // any other shutdown trigger (SIGTERM/SIGINT/stdin-EOF), reaching
    // the SAME graceful teardown path, instead of the write itself
    // crashing the process via an uncaught NSException (the failure
    // mode `FileHandle.write(_:)`, no longer used below, was prone to).
    private let onWriteFailure: () -> Void

    /// What ended `run(shouldStop:)` — see that function's own doc
    /// comment.
    public enum StopReason: Equatable {
        case requested
        case starved
    }

    public init(
        ring: SPSCByteRing,
        sampleRate: UInt32,
        channels: UInt16,
        isNonInterleaved: Bool,
        output: FileHandle = .standardOutput,
        starvationTimeout: TimeInterval = 3.0,
        statsInterval: TimeInterval = 5.0,
        onWriteFailure: @escaping () -> Void = {}
    ) {
        self.ring = ring
        self.channels = channels
        self.isNonInterleaved = isNonInterleaved
        self.output = output
        self.starvationTimeout = starvationTimeout
        self.statsInterval = statsInterval
        self.onWriteFailure = onWriteFailure
        let bytesPerFrame = max(1, Int(channels) * 4)
        self.targetChunkBytes = max(bytesPerFrame, Int(Double(sampleRate) * 0.02) * bytesPerFrame)
    }

    #if DEBUG
    /// Test-only peek at the running peak/windowPeak — StatusEvents
    /// .emitStats has no injectable output the way `output`/
    /// `onWriteFailure` above do (see PeakMeterTests.swift's own header
    /// comment), so this is the seam WriterTests.swift uses to verify
    /// peak/windowPeak actually get folded from drained ring data.
    /// Never called in production (excluded from release builds by the
    /// `#if DEBUG` itself) — mirrors audiocap.rs's own `#[cfg(test)]`-only
    /// `AudiocapState.should_attach_child`, the same "test-only accessor
    /// for otherwise-private state" idiom one layer down the pipeline.
    var debugPeakAndWindowPeak: (peak: Float, windowPeak: Float) { (peak, windowPeak) }
    #endif

    /// Emits one last `stats` record reflecting everything up through
    /// the true final drain (Writer.drainRemaining) — called by
    /// main.swift right before writeEOS, so a log reader's last-seen
    /// stats line for a session is never more than one drain-cycle
    /// stale the way the periodic ~5s cadence alone could leave it.
    public func emitFinalStats() {
        StatusEvents.emitStats(
            overflows: ring.overflowCount(),
            ringHighWater: ringHighWater,
            framesOut: framesOut,
            droppedFrames: ring.droppedFrameCount(),
            peak: peak,
            windowPeak: windowPeak
        )
    }

    /// Blocks, polling the ring, until EITHER `shouldStop()` returns true
    /// (`.requested`) OR F6's own IO-starvation dead-man switch trips
    /// (`.starved`: no new ring activity — no drained frame, no
    /// newly-observed drop — for `starvationTimeout` since the first
    /// frame ever arrived; device switched, system slept, or the HAL
    /// otherwise wedged, since the IOProc fires on the device clock even
    /// for silent audio). Either way this does NOT do a final drain
    /// itself. That's deliberate: the IOProc can still legally fire (and
    /// push more audio into the ring) right up until AudioDeviceStop
    /// actually takes effect, which hasn't happened yet at the moment
    /// this returns — see `drainRemaining()`'s own comment for why that
    /// call, not this loop, is where the true last drain belongs. Does
    /// NOT write the EOS record either — the caller writes that only
    /// after CoreAudio teardown has actually run, per the S9.1 teardown
    /// order (see main.swift) — and, per F6, never at all for a
    /// `.starved` return (an EOS record claims a clean, complete stream,
    /// which a starvation-truncated one is not; main.swift emits a typed
    /// `device-changed` error and exits nonzero instead).
    public func run(shouldStop: () -> Bool) -> StopReason {
        while !shouldStop() {
            if pollOnce() {
                return .starved
            }
            Thread.sleep(forTimeInterval: pollInterval)
        }
        return .requested
    }

    /// The TRUE final drain+flush — call this only AFTER AudioDeviceStop
    /// has already returned (main.swift's own ordering: stop -> this ->
    /// destroy IOProc -> ...), which is CoreAudio's own guarantee that
    /// the IOProc will not be invoked again. Calling this instead
    /// immediately after `run()` returns (i.e. before AudioDeviceStop)
    /// would leave a real, if usually tiny, window where the IOProc
    /// could still push audio into the ring that nothing ever drains —
    /// silently lost, not represented as a drop/overflow either, since
    /// the ring itself had room for it.
    public func drainRemaining() {
        // Return value (starvation) is meaningless here: this runs once,
        // after teardown has already begun — nothing left to decide
        // based on it either way.
        _ = pollOnce()
        flush()
    }

    public func writeEOS() {
        // F12: throwing write(contentsOf:), never the exception-raising
        // write(_:) — see `onWriteFailure`'s own doc comment.
        do {
            try output.write(contentsOf: Data(Framing.encodeEOS(seq: seq)))
        } catch {
            onWriteFailure()
        }
    }

    // ---- internals ----

    /// Returns `true` the moment F6's starvation timeout is newly
    /// exceeded (checked every call, i.e. every ~4ms via `run`'s own
    /// poll loop) — `run` is the only caller that acts on this;
    /// `drainRemaining` ignores it (see that function's own comment).
    @discardableResult
    private func pollOnce() -> Bool {
        ring.drain { [self] frameCount, payload in
            append(frameCount: frameCount, payload: payload)
        }
        // F5: appended AFTER draining whatever real audio the ring
        // already held — chronologically correct, since an overflow can
        // only happen once the ring is already full, i.e. the dropped
        // frames are newer than anything drain() above just pulled out
        // and older than whatever the next successful push resumes
        // with.
        insertSilenceForAnyNewlyDroppedFrames()
        ringHighWater = max(ringHighWater, UInt64(ring.approximateUsedBytes()))

        let now = Date()
        if accumulatedFrameCount > 0,
           accumulated.count >= targetChunkBytes || now.timeIntervalSince(lastFlush) >= maxFlushLatency {
            flush()
        }
        if now.timeIntervalSince(lastStats) >= statsInterval {
            StatusEvents.emitStats(
                overflows: ring.overflowCount(),
                ringHighWater: ringHighWater,
                framesOut: framesOut,
                droppedFrames: ring.droppedFrameCount(),
                peak: peak,
                windowPeak: windowPeak
            )
            lastStats = now
            // S9 live-failure investigation: `windowPeak` is "since the
            // LAST emission" by definition — reset right after this
            // emission reads it, so the NEXT periodic record reflects
            // only what happened in the window that follows. `peak`
            // (session-lifetime) is deliberately untouched here.
            windowPeak = 0
        }

        // F6: `lastActivityTime` is nil until the first-ever sign of
        // life from the ring (see that property's own doc comment) —
        // this is what keeps starvation detection off during the
        // pre-capturing phase.
        if let lastActivityTime, now.timeIntervalSince(lastActivityTime) >= starvationTimeout {
            return true
        }
        return false
    }

    /// F5 (adversarial-review fix round, risk register item 3/10: "ring
    /// overflow policy = drop + count + silence-insertion downstream" /
    /// "never time-compress"): reads the DELTA in the ring's cumulative
    /// droppedFrameCount() since the last poll and inserts exactly that
    /// many zero interleaved-f32 frames into `accumulated` — the SAME
    /// buffer real drained audio also accumulates into, at the native
    /// sample rate, BEFORE framing (Framing.encodeChunk never
    /// distinguishes real from inserted-silence frames; downstream,
    /// neither does Rust). Without this, an overflow would silently
    /// compress elapsed time: frameCount-driven timestamps on both the
    /// Rust and transcript sides would drift earlier by exactly the
    /// dropped duration, with nothing on the wire ever indicating it
    /// happened. Idempotent across repeated polls with no NEW overflow
    /// in between (delta is 0, a no-op) — never double-inserts the same
    /// drop.
    private func insertSilenceForAnyNewlyDroppedFrames() {
        let currentDropped = ring.droppedFrameCount()
        let delta = currentDropped &- lastObservedDroppedFrames
        guard delta > 0 else { return }
        lastObservedDroppedFrames = currentDropped
        // F6: a drop is proof the IOProc IS still firing (it's the
        // RING that's out of room, not the device gone silent/switched)
        // — counts as activity for starvation purposes exactly like a
        // real drained frame does, right below in `append`.
        lastActivityTime = Date()

        let bytesPerFrame = max(1, Int(channels) * 4)
        accumulated.append(contentsOf: repeatElement(0, count: Int(delta) * bytesPerFrame))
        accumulatedFrameCount += UInt32(truncatingIfNeeded: delta)
    }

    private func append(frameCount: UInt32, payload: UnsafeRawBufferPointer) {
        guard frameCount > 0, payload.count > 0 else { return }
        // F6: proof of life for the starvation dead-man switch — see
        // `lastActivityTime`'s own doc comment.
        lastActivityTime = Date()
        // S9 live-failure investigation: scanned on the RAW payload,
        // before the isNonInterleaved branch below ever runs —
        // PeakMeter.maxAbsoluteSample is channel/frame-order-agnostic
        // (see its own doc comment), so this doesn't need to wait for
        // (or duplicate work with) Interleave.planarToInterleaved.
        let sample = PeakMeter.maxAbsoluteSample(in: payload)
        if sample > peak { peak = sample }
        if sample > windowPeak { windowPeak = sample }
        if isNonInterleaved {
            var interleaved = [UInt8](repeating: 0, count: payload.count)
            interleaved.withUnsafeMutableBytes { destination in
                Interleave.planarToInterleaved(planar: payload, frameCount: Int(frameCount), channels: Int(channels), into: destination)
            }
            accumulated.append(contentsOf: interleaved)
        } else {
            accumulated.append(contentsOf: payload)
        }
        accumulatedFrameCount += frameCount
    }

    private func flush() {
        guard accumulatedFrameCount > 0 else { return }
        let record = Framing.encodeChunk(seq: seq, frameCount: accumulatedFrameCount, payload: accumulated)
        // F12: throwing write(contentsOf:), never the exception-raising
        // write(_:) — a closed parent pipe (EPIPE) must reach
        // `onWriteFailure` as a normal Swift error, not crash this
        // process via an uncaught NSException. Bookkeeping below still
        // advances regardless of success/failure — seq must stay
        // monotonic, and there's no value in re-attempting the same
        // bytes on a later flush call before shutdown actually takes
        // effect.
        do {
            try output.write(contentsOf: Data(record))
        } catch {
            onWriteFailure()
        }
        framesOut += UInt64(accumulatedFrameCount)
        seq += 1
        accumulated.removeAll(keepingCapacity: true)
        accumulatedFrameCount = 0
        lastFlush = Date()
    }
}
