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
    private let statsInterval: TimeInterval = 5.0
    private let pollInterval: TimeInterval = 0.004

    public init(ring: SPSCByteRing, sampleRate: UInt32, channels: UInt16, isNonInterleaved: Bool, output: FileHandle = .standardOutput) {
        self.ring = ring
        self.channels = channels
        self.isNonInterleaved = isNonInterleaved
        self.output = output
        let bytesPerFrame = max(1, Int(channels) * 4)
        self.targetChunkBytes = max(bytesPerFrame, Int(Double(sampleRate) * 0.02) * bytesPerFrame)
    }

    /// Emits one last `stats` record reflecting everything up through
    /// the true final drain (Writer.drainRemaining) — called by
    /// main.swift right before writeEOS, so a log reader's last-seen
    /// stats line for a session is never more than one drain-cycle
    /// stale the way the periodic ~5s cadence alone could leave it.
    public func emitFinalStats() {
        StatusEvents.emitStats(overflows: ring.overflowCount(), ringHighWater: ringHighWater, framesOut: framesOut)
    }

    /// Blocks, polling the ring, until `shouldStop()` returns true, then
    /// returns — it does NOT do a final drain itself. That's deliberate:
    /// the IOProc can still legally fire (and push more audio into the
    /// ring) right up until AudioDeviceStop actually takes effect, which
    /// hasn't happened yet at the moment `shouldStop()` first turns
    /// true — see `drainRemaining()`'s own comment for why that call,
    /// not this loop, is where the true last drain belongs. Does NOT
    /// write the EOS record either — the caller writes that only after
    /// CoreAudio teardown has actually run, per the S9.1 teardown order
    /// (see main.swift).
    public func run(shouldStop: () -> Bool) {
        while !shouldStop() {
            pollOnce()
            Thread.sleep(forTimeInterval: pollInterval)
        }
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
        pollOnce()
        flush()
    }

    public func writeEOS() {
        output.write(Data(Framing.encodeEOS(seq: seq)))
    }

    // ---- internals ----

    private func pollOnce() {
        ring.drain { [self] frameCount, payload in
            append(frameCount: frameCount, payload: payload)
        }
        ringHighWater = max(ringHighWater, UInt64(ring.approximateUsedBytes()))

        let now = Date()
        if accumulatedFrameCount > 0,
           accumulated.count >= targetChunkBytes || now.timeIntervalSince(lastFlush) >= maxFlushLatency {
            flush()
        }
        if now.timeIntervalSince(lastStats) >= statsInterval {
            StatusEvents.emitStats(overflows: ring.overflowCount(), ringHighWater: ringHighWater, framesOut: framesOut)
            lastStats = now
        }
    }

    private func append(frameCount: UInt32, payload: UnsafeRawBufferPointer) {
        guard frameCount > 0, payload.count > 0 else { return }
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
        output.write(Data(record))
        framesOut += UInt64(accumulatedFrameCount)
        seq += 1
        accumulated.removeAll(keepingCapacity: true)
        accumulatedFrameCount = 0
        lastFlush = Date()
    }
}
