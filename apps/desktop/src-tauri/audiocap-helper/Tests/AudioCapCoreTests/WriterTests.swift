import AudioToolbox
import Foundation
import XCTest
@testable import AudioCapCore

// F5 (adversarial-review fix round) — "writer logic test for the
// zero-insertion math (pure parts)". Writer's constructor takes a plain
// SPSCByteRing + value parameters (no live CoreAudio session needed —
// same posture as SPSCByteRingTests.swift) and an injectable `output`
// FileHandle, so the actual bytes it writes for a forced ring overflow
// can be captured via a Pipe and decoded here without ever touching a
// real tap/aggregate device.
final class WriterTests: XCTestCase {
    /// Builds a one-buffer (interleaved-shaped) AudioBufferList wrapping
    /// `bytes` — same shape as SPSCByteRingTests's own private helper,
    /// duplicated here (rather than shared across test files) so this
    /// file stays independently readable/self-contained.
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

    /// Decodes ONE Framing v1 chunk-or-EOS record (Framing.encodeChunk/
    /// encodeEOS's own shared seq/frameCount/byteLen prefix layout) from
    /// the front of `bytes`.
    private func decodeRecordPrefix(_ bytes: [UInt8]) -> (frameCount: UInt32, byteLen: UInt32, payload: [UInt8]) {
        precondition(bytes.count >= 16, "expected at least a 16-byte record prefix, got \(bytes.count) bytes")
        let frameCount = UInt32(bytes[8]) | UInt32(bytes[9]) << 8 | UInt32(bytes[10]) << 16 | UInt32(bytes[11]) << 24
        let byteLen = UInt32(bytes[12]) | UInt32(bytes[13]) << 8 | UInt32(bytes[14]) << 16 | UInt32(bytes[15]) << 24
        let payload = Array(bytes[16..<(16 + Int(byteLen))])
        return (frameCount, byteLen, payload)
    }

    func testDroppedFramesDuringOverflowAreInsertedAsZeroFramesInTheOutgoingStream() {
        let ring = SPSCByteRing(capacity: 32)
        let big: [UInt8] = Array(repeating: 0xFF, count: 64)
        withSingleBufferList(big) { bufferList in
            XCTAssertFalse(ring.tryPush(frameCount: 8, buffers: bufferList), "a record this large can never fit")
        }
        XCTAssertEqual(ring.droppedFrameCount(), 8)

        let pipe = Pipe()
        let writer = Writer(ring: ring, sampleRate: 48_000, channels: 1, isNonInterleaved: false, output: pipe.fileHandleForWriting)
        writer.drainRemaining() // one poll (nothing real to drain) + flush

        pipe.fileHandleForWriting.closeFile()
        let written = [UInt8](pipe.fileHandleForReading.readDataToEndOfFile())

        let (frameCount, byteLen, payload) = decodeRecordPrefix(written)
        XCTAssertEqual(frameCount, 8, "exactly the dropped frame count must be inserted, never more/less — D5's own \"never time-compress\"")
        XCTAssertEqual(byteLen, 8 * 1 * 4, "mono, interleaved f32 — 4 bytes/frame")
        XCTAssertTrue(payload.allSatisfy { $0 == 0 }, "inserted frames must be silence (all-zero), never garbage")
    }

    func testDroppedFrameDeltaIsInsertedOnlyOnceNotRepeatedOnEveryPoll() {
        // Two consecutive drainRemaining() calls with NO new overflow in
        // between must not double-insert the same dropped frames.
        let ring = SPSCByteRing(capacity: 32)
        let big: [UInt8] = Array(repeating: 0xFF, count: 64)
        withSingleBufferList(big) { bufferList in
            _ = ring.tryPush(frameCount: 8, buffers: bufferList)
        }

        let pipe = Pipe()
        let writer = Writer(ring: ring, sampleRate: 48_000, channels: 1, isNonInterleaved: false, output: pipe.fileHandleForWriting)
        writer.drainRemaining() // consumes the delta, emits frameCount=8
        writer.drainRemaining() // no NEW drops since — must emit nothing more

        pipe.fileHandleForWriting.closeFile()
        let written = [UInt8](pipe.fileHandleForReading.readDataToEndOfFile())

        // Exactly one 16-byte-prefix + 32-byte-payload record — a
        // second drainRemaining() call must not have appended another.
        XCTAssertEqual(written.count, 16 + 8 * 1 * 4, "the same dropped-frame delta must never be inserted twice")
    }

    func testNoOverflowMeansNoSilenceIsEverInserted() {
        let ring = SPSCByteRing(capacity: 1024)
        let payload: [UInt8] = [1, 2, 3, 4] // one real mono f32 frame
        withSingleBufferList(payload) { bufferList in
            XCTAssertTrue(ring.tryPush(frameCount: 1, buffers: bufferList))
        }

        let pipe = Pipe()
        let writer = Writer(ring: ring, sampleRate: 48_000, channels: 1, isNonInterleaved: false, output: pipe.fileHandleForWriting)
        writer.drainRemaining()

        pipe.fileHandleForWriting.closeFile()
        let written = [UInt8](pipe.fileHandleForReading.readDataToEndOfFile())

        let (frameCount, _, payloadOut) = decodeRecordPrefix(written)
        XCTAssertEqual(frameCount, 1, "only the one real frame — no phantom silence when nothing ever overflowed")
        XCTAssertEqual(payloadOut, payload)
    }

    // ---- F6 (adversarial-review fix round): IO-starvation dead-man
    // switch. `starvationTimeout` is injected short (tens of ms) so
    // these stay fast unit tests, never a real 3s wait. ----

    func testRunReturnsStarvedWhenNoNewRingActivityForTheConfiguredTimeout() {
        let ring = SPSCByteRing(capacity: 1024)
        let writer = Writer(
            ring: ring, sampleRate: 48_000, channels: 1, isNonInterleaved: false,
            output: FileHandle.nullDevice, starvationTimeout: 0.05
        )

        // Prime with ONE real frame so the starvation clock actually
        // starts (F6: "starvation timing starts only after the first
        // frame ever arrives") — the ring then goes silent forever
        // after, exactly like a device switch/sleep/HAL wedge (the
        // IOProc has simply stopped firing).
        let payload: [UInt8] = [1, 2, 3, 4]
        withSingleBufferList(payload) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }

        // shouldStop is `{ false }` — the ONLY way run() can ever return
        // here is via its own internal starvation detection.
        let stopReason = writer.run { false }
        XCTAssertEqual(stopReason, .starved)
    }

    func testRunNeverStarvesBeforeAnyFrameHasEverArrived() {
        // Pre-capturing phase (e.g. a user still sitting at the TCC
        // prompt, or the tap/aggregate device just hasn't started
        // delivering yet) — F6's own explicit requirement: starvation
        // must stay off no matter how much real time passes with NOTHING
        // ever having arrived. The ring here is NEVER pushed to at all.
        let ring = SPSCByteRing(capacity: 1024)
        let writer = Writer(
            ring: ring, sampleRate: 48_000, channels: 1, isNonInterleaved: false,
            output: FileHandle.nullDevice, starvationTimeout: 0.02
        )

        // A deadline well past starvationTimeout — shouldStop only
        // becomes true once genuinely EXCEEDING the starvation window,
        // so run()'s poll loop (every ~4ms) gets many chances to
        // (incorrectly, if this test is red) trip starvation first.
        let deadline = Date().addingTimeInterval(0.08)
        let stopReason = writer.run { Date() >= deadline }
        XCTAssertEqual(stopReason, .requested, "no frame ever arrived — starvation must never trip, no matter how much time passes")
    }

    func testRunStaysRequestedWhenActivityKeepsArrivingWithinTheTimeout() {
        // Healthy, continuously-active capture must never spuriously
        // starve just because SOME time has passed since Writer's own
        // construction — a new frame arrives every ~10ms here, well
        // under the 50ms starvationTimeout, for well over 2x that
        // timeout's own duration.
        let ring = SPSCByteRing(capacity: 1024)
        let writer = Writer(
            ring: ring, sampleRate: 48_000, channels: 1, isNonInterleaved: false,
            output: FileHandle.nullDevice, starvationTimeout: 0.05
        )
        let payload: [UInt8] = [1, 2, 3, 4]

        let deadline = Date().addingTimeInterval(0.12)
        var lastPush = Date.distantPast
        let stopReason = writer.run {
            let now = Date()
            if now.timeIntervalSince(lastPush) >= 0.01 {
                withSingleBufferList(payload) { bufferList in
                    _ = ring.tryPush(frameCount: 1, buffers: bufferList)
                }
                lastPush = now
            }
            return now >= deadline
        }
        XCTAssertEqual(stopReason, .requested, "continuous activity must never trip the starvation dead-man switch")
    }

    // ---- F12 (adversarial-review fix round): a closed parent pipe
    // (EPIPE) must reach `onWriteFailure` gracefully, never crash via an
    // uncaught NSException. `signal(SIGPIPE, SIG_IGN)` mirrors EXACTLY
    // what main.swift's own top-level entry point already does for the
    // real helper process — without it, a broken-pipe write could raise
    // SIGPIPE and kill the whole test process before Swift-level error
    // handling ever gets a chance to run. Safe/idempotent to call
    // repeatedly and process-wide (no test anywhere in this suite relies
    // on actually receiving a real SIGPIPE). ----

    func testAClosedOutputPipeCallsOnWriteFailureInsteadOfCrashing() {
        signal(SIGPIPE, SIG_IGN)

        let pipe = Pipe()
        pipe.fileHandleForReading.closeFile() // the "parent" is gone

        var failureCount = 0
        let writer = Writer(
            ring: SPSCByteRing(capacity: 1024), sampleRate: 48_000, channels: 1, isNonInterleaved: false,
            output: pipe.fileHandleForWriting,
            onWriteFailure: { failureCount += 1 }
        )

        // writeEOS() -> flush()'s own sibling write path; both go
        // through the same throwing write(contentsOf:) now.
        writer.writeEOS()

        XCTAssertGreaterThan(failureCount, 0, "a write to a closed pipe must be reported via onWriteFailure, not silently ignored or left to crash")
    }

    func testAClosedOutputPipeDuringFlushAlsoCallsOnWriteFailure() {
        signal(SIGPIPE, SIG_IGN)

        let ring = SPSCByteRing(capacity: 1024)
        let payload: [UInt8] = [1, 2, 3, 4]
        withSingleBufferList(payload) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }

        let pipe = Pipe()
        pipe.fileHandleForReading.closeFile()

        var failureCount = 0
        let writer = Writer(
            ring: ring, sampleRate: 48_000, channels: 1, isNonInterleaved: false,
            output: pipe.fileHandleForWriting,
            onWriteFailure: { failureCount += 1 }
        )
        writer.drainRemaining() // drains the ring, then flush()es to the closed pipe

        XCTAssertGreaterThan(failureCount, 0)
    }

    func testOnWriteFailureDefaultsToANoOpAndStillDoesNotCrash() {
        // No callback supplied — the default `{}` — a closed pipe must
        // still fail gracefully rather than needing a caller to opt in.
        signal(SIGPIPE, SIG_IGN)

        let pipe = Pipe()
        pipe.fileHandleForReading.closeFile()
        let writer = Writer(ring: SPSCByteRing(capacity: 1024), sampleRate: 48_000, channels: 1, isNonInterleaved: false, output: pipe.fileHandleForWriting)
        writer.writeEOS() // must return normally, not crash
    }
}
