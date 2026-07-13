import AudioToolbox
import XCTest
@testable import AudioCapCore

// Not part of the S9.1 deliverable list's one required test (the
// framing encoder), but added as cheap insurance: SPSCByteRing is the
// highest-risk hand-rolled logic in this slice (lock-free, wraparound
// byte math backing the RT IOProc's only interface to the outside
// world) and, like Framing, is fully exercisable without any CoreAudio
// session — no live tap, no AudioObjectID, just a synthetic
// AudioBufferList built in-process.
final class SPSCByteRingTests: XCTestCase {
    /// Builds a one-buffer (interleaved-shaped) AudioBufferList wrapping
    /// `bytes`, calls `body`, then frees the temporary allocation —
    /// mirrors the general shape CoreAudio hands the real IOProc, just
    /// synthesized here instead of tap-sourced.
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

    func testPushThenDrainRoundTripsBytesAndFrameCount() {
        let ring = SPSCByteRing(capacity: 1024)
        let payload: [UInt8] = [1, 2, 3, 4, 5, 6, 7, 8]

        withSingleBufferList(payload) { bufferList in
            XCTAssertTrue(ring.tryPush(frameCount: 2, buffers: bufferList))
        }

        var seen: [(UInt32, [UInt8])] = []
        ring.drain { frameCount, payload in
            seen.append((frameCount, Array(payload)))
        }

        XCTAssertEqual(seen.count, 1)
        XCTAssertEqual(seen[0].0, 2)
        XCTAssertEqual(seen[0].1, payload)
    }

    func testDrainWithNothingPushedYieldsNoRecords() {
        let ring = SPSCByteRing(capacity: 1024)
        var callCount = 0
        ring.drain { _, _ in callCount += 1 }
        XCTAssertEqual(callCount, 0)
    }

    func testMultiplePushesDrainInFIFOOrder() {
        let ring = SPSCByteRing(capacity: 1024)
        for value in 0..<5 {
            withSingleBufferList([UInt8(value)]) { bufferList in
                XCTAssertTrue(ring.tryPush(frameCount: 1, buffers: bufferList))
            }
        }

        var seen: [UInt8] = []
        ring.drain { _, payload in
            seen.append(payload[payload.startIndex])
        }
        XCTAssertEqual(seen, [0, 1, 2, 3, 4])
    }

    func testOverflowIsDroppedAndCountedNotPartiallyWritten() {
        // Small ring: an 8-byte header alone barely fits once; a second
        // push with any payload can't possibly fit alongside it.
        let ring = SPSCByteRing(capacity: 16)
        let big: [UInt8] = Array(repeating: 0xFF, count: 64)

        withSingleBufferList(big) { bufferList in
            XCTAssertFalse(ring.tryPush(frameCount: 16, buffers: bufferList), "a record larger than the whole ring must never be written, partially or otherwise")
        }
        XCTAssertEqual(ring.overflowCount(), 1)

        var callCount = 0
        ring.drain { _, _ in callCount += 1 }
        XCTAssertEqual(callCount, 0, "a dropped record must never surface as a partial/corrupt record on drain")
    }

    func testWraparoundPreservesByteContentAcrossTheRingBoundary() {
        // Capacity chosen so a few small pushes land the write position
        // near the end of the buffer, forcing the next push's payload to
        // straddle the wraparound boundary.
        let ring = SPSCByteRing(capacity: 32)
        withSingleBufferList([1, 2, 3, 4]) { bufferList in
            _ = ring.tryPush(frameCount: 1, buffers: bufferList)
        }
        ring.drain { _, _ in } // free that space back up (head catches up to tail)

        let wrapping: [UInt8] = [10, 20, 30, 40, 50, 60, 70, 80]
        withSingleBufferList(wrapping) { bufferList in
            XCTAssertTrue(ring.tryPush(frameCount: 2, buffers: bufferList))
        }

        var seen: [UInt8] = []
        ring.drain { _, payload in seen = Array(payload) }
        XCTAssertEqual(seen, wrapping)
    }
}
