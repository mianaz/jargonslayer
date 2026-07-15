import AudioToolbox
import XCTest
@testable import AudioCapCore

// S11 (§Q1/§3 Worker A) — TranscribeConsumer's own poll/starvation/
// stats/pause-discard/dropped-frame state machine, exercised entirely
// through a `FakeFrameSink` + an INJECTED, manually-advanced clock (a
// deliberate departure from WriterTests' own "real Date(), just a short
// real timeout" style — see TranscribeConsumer's own header comment):
// every test below calls `pollOnce()` directly and advances a captured
// `var now` between calls, so nothing here ever sleeps or waits on wall
// time.
final class TranscribeConsumerTests: XCTestCase {
    /// Records every `receive` call verbatim — mirrors WriterTests'
    /// own `Pipe()`-based observation, just in-memory instead of via a
    /// real FileHandle (TranscribeConsumer never touches stdout at all).
    private final class FakeFrameSink: FrameSink {
        private(set) var received: [(frameCount: UInt32, payload: [UInt8])] = []
        func receive(frameCount: UInt32, payload: UnsafeRawBufferPointer) {
            received.append((frameCount, Array(payload)))
        }
    }

    /// Same shape as WriterTests'/SPSCByteRingTests' own private helper
    /// — duplicated here so this file stays independently readable.
    private func withSingleBufferList(_ bytes: [UInt8], _ body: (UnsafeMutableAudioBufferListPointer) -> Void) {
        let ablPointer = AudioBufferList.allocate(maximumBuffers: 1)
        defer { free(ablPointer.unsafeMutablePointer) }
        bytes.withUnsafeBufferPointer { bufferPointer in
            ablPointer[0] = AudioBuffer(
                mNumberChannels: 1,
                mDataByteSize: UInt32(bytes.count),
                mData: UnsafeMutableRawPointer(mutating: bufferPointer.baseAddress)
            )
            body(ablPointer)
        }
    }

    private func floatBytes(_ floats: [Float32]) -> [UInt8] {
        floats.withUnsafeBytes { Array($0) }
    }

    private func asFloats(_ bytes: [UInt8]) -> [Float32] {
        bytes.withUnsafeBytes { Array($0.bindMemory(to: Float32.self)) }
    }

    // ---- drain order ----

    func testDrainOrderForwardsRecordsToSinkInFIFOOrder() {
        let ring = SPSCByteRing(capacity: 1024)
        for value in 0..<5 {
            withSingleBufferList([UInt8(value)]) { bufferList in
                XCTAssertTrue(ring.tryPush(frameCount: 1, buffers: bufferList))
            }
        }
        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(ring: ring, channels: 1, isNonInterleaved: false, sink: sink)
        consumer.drainRemaining()

        XCTAssertEqual(sink.received.map { $0.payload[0] }, [0, 1, 2, 3, 4], "records must reach the sink in the SAME FIFO order the ring drained them")
    }

    func testInterleavedTapPayloadIsForwardedByteForByteUnchanged() {
        let ring = SPSCByteRing(capacity: 1024)
        let payload = floatBytes([0.25, -0.5])
        withSingleBufferList(payload) { bufferList in
            XCTAssertTrue(ring.tryPush(frameCount: 1, buffers: bufferList))
        }
        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(ring: ring, channels: 2, isNonInterleaved: false, sink: sink)
        consumer.drainRemaining()

        XCTAssertEqual(sink.received.count, 1)
        XCTAssertEqual(sink.received[0].frameCount, 1)
        XCTAssertEqual(sink.received[0].payload, payload)
    }

    func testNonInterleavedPlanarPayloadIsInterleavedBeforeReachingSink() {
        // 2 channels, 2 frames, planar (channel-major): ch0=[1.0, 2.0],
        // ch1=[3.0, 4.0] -> expected interleaved frame order:
        // [ch0f0, ch1f0, ch0f1, ch1f1] = [1.0, 3.0, 2.0, 4.0].
        let ring = SPSCByteRing(capacity: 1024)
        let planar = floatBytes([1.0, 2.0, 3.0, 4.0])
        withSingleBufferList(planar) { bufferList in
            XCTAssertTrue(ring.tryPush(frameCount: 2, buffers: bufferList))
        }
        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(ring: ring, channels: 2, isNonInterleaved: true, sink: sink)
        consumer.drainRemaining()

        XCTAssertEqual(sink.received.count, 1)
        XCTAssertEqual(sink.received[0].frameCount, 2)
        XCTAssertEqual(asFloats(sink.received[0].payload), [1.0, 3.0, 2.0, 4.0])
    }

    // ---- starvation (injected clock, no real sleeping) ----

    func testStarvationTripsAfterConfiguredTimeoutOnceActivityHasStarted() {
        let ring = SPSCByteRing(capacity: 1024)
        var now = Date(timeIntervalSince1970: 1_000)
        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(
            ring: ring, channels: 1, isNonInterleaved: false, sink: sink,
            starvationTimeout: 3.0, clock: { now }
        )

        withSingleBufferList([1, 2, 3, 4]) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }
        XCTAssertFalse(consumer.pollOnce(), "the very first poll, right at the activity, must not itself report starvation")

        now = now.addingTimeInterval(3.5) // past starvationTimeout, no new activity since
        XCTAssertTrue(consumer.pollOnce(), "no new ring activity for longer than starvationTimeout must trip starvation")
    }

    func testNoStarvationBeforeAnyActivityRegardlessOfHowFarTheClockAdvances() {
        let ring = SPSCByteRing(capacity: 1024) // never pushed to at all
        var now = Date(timeIntervalSince1970: 1_000)
        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(
            ring: ring, channels: 1, isNonInterleaved: false, sink: sink,
            starvationTimeout: 1.0, clock: { now }
        )

        now = now.addingTimeInterval(100) // WAY past starvationTimeout
        XCTAssertFalse(consumer.pollOnce(), "starvation must never trip before the first sign of ring activity, no matter the elapsed time")
    }

    func testActivityResetsTheStarvationClockPreventingATripEvenPastTheOriginalDeadline() {
        let ring = SPSCByteRing(capacity: 1024)
        var now = Date(timeIntervalSince1970: 1_000)
        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(
            ring: ring, channels: 1, isNonInterleaved: false, sink: sink,
            starvationTimeout: 1.0, clock: { now }
        )
        withSingleBufferList([1, 2, 3, 4]) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }
        _ = consumer.pollOnce()

        now = now.addingTimeInterval(0.9) // under the 1.0s timeout
        withSingleBufferList([5, 6, 7, 8]) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }
        XCTAssertFalse(consumer.pollOnce(), "fresh activity within the timeout must reset the starvation clock")

        now = now.addingTimeInterval(0.9) // 1.8s since the FIRST poll, but only 0.9s since the reset
        XCTAssertFalse(consumer.pollOnce(), "must not starve — under 1.0s has passed since the LAST activity")
    }

    // ---- pause-discard (§Q3) ----

    func testPauseDiscardsRealAudioFromTheSinkButStillDrainsTheRing() {
        let ring = SPSCByteRing(capacity: 1024)
        var paused = true
        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(ring: ring, channels: 1, isNonInterleaved: false, sink: sink, isPaused: { paused })

        withSingleBufferList([1, 2, 3, 4]) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }
        consumer.drainRemaining()
        XCTAssertTrue(sink.received.isEmpty, "no audio must reach the sink while paused")

        // The ring itself must have been drained regardless (prevents
        // overflow) — pushing again and unpausing should surface ONLY
        // the new push, never the discarded one replaying.
        paused = false
        withSingleBufferList([9, 9, 9, 9]) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }
        consumer.drainRemaining()
        XCTAssertEqual(sink.received.count, 1)
        XCTAssertEqual(sink.received[0].payload, [9, 9, 9, 9])
    }

    func testPauseStillCountsAsRingActivityPreventingSpuriousStarvation() {
        let ring = SPSCByteRing(capacity: 1024)
        var now = Date(timeIntervalSince1970: 1_000)
        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(
            ring: ring, channels: 1, isNonInterleaved: false, sink: sink,
            isPaused: { true }, starvationTimeout: 1.0, clock: { now }
        )

        withSingleBufferList([1, 2, 3, 4]) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }
        _ = consumer.pollOnce()

        now = now.addingTimeInterval(0.5)
        withSingleBufferList([1, 2, 3, 4]) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }
        XCTAssertFalse(consumer.pollOnce(), "draining while paused is still real ring activity — must not starve")
        XCTAssertTrue(sink.received.isEmpty, "still nothing forwarded, even though the ring keeps getting drained")
    }

    // ---- dropped-frame accounting (F5 parity) ----

    func testDroppedFramesDuringOverflowAreForwardedAsZeroFrameSilence() {
        let ring = SPSCByteRing(capacity: 32)
        let big = [UInt8](repeating: 0xFF, count: 64)
        withSingleBufferList(big) { bufferList in
            XCTAssertFalse(ring.tryPush(frameCount: 8, buffers: bufferList), "a record this large can never fit")
        }
        XCTAssertEqual(ring.droppedFrameCount(), 8)

        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(ring: ring, channels: 1, isNonInterleaved: false, sink: sink)
        consumer.drainRemaining()

        XCTAssertEqual(sink.received.count, 1)
        XCTAssertEqual(sink.received[0].frameCount, 8, "exactly the dropped frame count must be forwarded, never more/less")
        XCTAssertEqual(sink.received[0].payload, [UInt8](repeating: 0, count: 8 * 1 * 4), "forwarded frames must be silence (all-zero), never garbage")
    }

    func testDroppedFrameDeltaIsForwardedOnlyOnceNotRepeatedOnEveryPoll() {
        let ring = SPSCByteRing(capacity: 32)
        let big = [UInt8](repeating: 0xFF, count: 64)
        withSingleBufferList(big) { bufferList in
            _ = ring.tryPush(frameCount: 8, buffers: bufferList)
        }
        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(ring: ring, channels: 1, isNonInterleaved: false, sink: sink)
        consumer.drainRemaining() // consumes the delta, forwards frameCount=8
        consumer.drainRemaining() // no NEW drops since — must forward nothing more

        XCTAssertEqual(sink.received.count, 1, "the same dropped-frame delta must never be forwarded twice")
    }

    func testDroppedFrameSilenceIsNotForwardedWhilePausedButTheDeltaIsStillConsumed() {
        let ring = SPSCByteRing(capacity: 32)
        var paused = true
        let big = [UInt8](repeating: 0xFF, count: 64)
        withSingleBufferList(big) { bufferList in
            _ = ring.tryPush(frameCount: 8, buffers: bufferList)
        }
        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(ring: ring, channels: 1, isNonInterleaved: false, sink: sink, isPaused: { paused })
        consumer.drainRemaining()
        XCTAssertTrue(sink.received.isEmpty, "dropped-frame silence must not reach the sink while paused")

        // Resuming afterward must NOT replay the already-consumed delta.
        paused = false
        consumer.drainRemaining()
        XCTAssertTrue(sink.received.isEmpty, "the delta was already consumed while paused — resuming must not retroactively forward it")
    }

    // ---- stats cadence (windowPeak reset, StatusEvents.emitStats has
    // no injectable output — same DEBUG-only accessor idiom WriterTests
    // itself relies on) ----

    #if DEBUG
    func testWindowPeakResetsAfterAPeriodicStatsEmissionButPeakDoesNot() {
        let ring = SPSCByteRing(capacity: 1024)
        var now = Date(timeIntervalSince1970: 1_000)
        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(
            ring: ring, channels: 1, isNonInterleaved: false, sink: sink,
            statsInterval: 5.0, clock: { now }
        )

        withSingleBufferList(floatBytes([0.5])) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }
        consumer.drainRemaining()
        XCTAssertEqual(consumer.debugPeakAndWindowPeak.windowPeak, 0.5, accuracy: 0.0001)

        now = now.addingTimeInterval(6) // past the 5s statsInterval

        withSingleBufferList(floatBytes([0.05])) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }
        consumer.drainRemaining() // drains the quiet sample, THEN notices statsInterval elapsed and resets windowPeak

        let (peak, windowPeak) = consumer.debugPeakAndWindowPeak
        XCTAssertEqual(peak, 0.5, accuracy: 0.0001, "session-lifetime peak must still remember the earlier loud sample")
        XCTAssertEqual(windowPeak, 0, "windowPeak must be reset once a periodic emission has happened")
    }

    func testPeakNeverDecreasesAcrossMultipleDrainsEvenAfterAQuieterOne() {
        let ring = SPSCByteRing(capacity: 1024)
        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(ring: ring, channels: 1, isNonInterleaved: false, sink: sink)

        withSingleBufferList(floatBytes([0.8])) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }
        consumer.drainRemaining()
        XCTAssertEqual(consumer.debugPeakAndWindowPeak.peak, 0.8, accuracy: 0.0001)

        withSingleBufferList(floatBytes([0.1])) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }
        consumer.drainRemaining()
        XCTAssertEqual(consumer.debugPeakAndWindowPeak.peak, 0.8, accuracy: 0.0001, "a later, quieter chunk must never lower the running peak")
    }
    #endif

    // ---- run(shouldStop:) / drainRemaining basic contract ----

    func testRunReturnsRequestedAssoonAsShouldStopBecomesTrue() {
        let ring = SPSCByteRing(capacity: 1024)
        let sink = FakeFrameSink()
        let consumer = TranscribeConsumer(ring: ring, channels: 1, isNonInterleaved: false, sink: sink, pollInterval: 0.001)
        let stopReason = consumer.run { true }
        XCTAssertEqual(stopReason, .requested)
    }
}
