import XCTest
@testable import AudioCapCore

// S9 live-failure investigation (docs/design-explorations/
// s9-app-audio-tap-blueprint.md) — direct tests of the pure byte-scan
// PeakMeter.swift's own header comment calls out as the testable core
// (Writer's own peak/windowPeak bookkeeping around it has no injectable
// stderr sink to assert against — same "verify the pure core directly,
// not through a live StatusEvents write" posture FramingTests.swift
// already takes for Framing.swift).
final class PeakMeterTests: XCTestCase {
    /// Builds a raw byte span over `floats` (native/little-endian, same
    /// as every platform this helper ships on) and hands it to `body`.
    private func withBytes<T>(_ floats: [Float32], _ body: (UnsafeRawBufferPointer) -> T) -> T {
        floats.withUnsafeBytes(body)
    }

    func testEmptyBufferIsZero() {
        let bytes: [UInt8] = []
        bytes.withUnsafeBytes { buffer in
            XCTAssertEqual(PeakMeter.maxAbsoluteSample(in: buffer), 0)
        }
    }

    func testBufferShorterThanOneSampleIsZero() {
        let bytes: [UInt8] = [1, 2, 3] // 3 bytes — not even one full f32
        bytes.withUnsafeBytes { buffer in
            XCTAssertEqual(PeakMeter.maxAbsoluteSample(in: buffer), 0)
        }
    }

    func testAllZeroSamplesIsZero() {
        withBytes([0, 0, 0, 0]) { buffer in
            XCTAssertEqual(PeakMeter.maxAbsoluteSample(in: buffer), 0)
        }
    }

    func testSinglePositiveSampleReturnsItself() {
        withBytes([0.42]) { buffer in
            XCTAssertEqual(PeakMeter.maxAbsoluteSample(in: buffer), 0.42, accuracy: 0.0001)
        }
    }

    func testSingleNegativeSampleReturnsItsMagnitude() {
        withBytes([-0.75]) { buffer in
            XCTAssertEqual(PeakMeter.maxAbsoluteSample(in: buffer), 0.75, accuracy: 0.0001)
        }
    }

    func testPicksTheMaximumMagnitudeRegardlessOfPosition() {
        withBytes([0.1, -0.9, 0.3, -0.2]) { buffer in
            XCTAssertEqual(PeakMeter.maxAbsoluteSample(in: buffer), 0.9, accuracy: 0.0001)
        }
        // Max at the FRONT, not just picked because it's scanned last —
        // pins that this is a true running max, not an accidental
        // "last write wins".
        withBytes([-0.9, 0.1, 0.3, 0.2]) { buffer in
            XCTAssertEqual(PeakMeter.maxAbsoluteSample(in: buffer), 0.9, accuracy: 0.0001)
        }
    }

    func testTrailingPartialSampleIsIgnoredNotOutOfBounds() {
        // 2 full f32 samples (8 bytes) + 3 trailing bytes that don't
        // complete a third sample — must never read/crash past them.
        var bytes = [UInt8]()
        withBytes([0.2, 0.5]) { buffer in bytes = Array(buffer) }
        bytes.append(contentsOf: [0xFF, 0xFF, 0xFF])
        bytes.withUnsafeBytes { buffer in
            XCTAssertEqual(PeakMeter.maxAbsoluteSample(in: buffer), 0.5, accuracy: 0.0001)
        }
    }

    func testNaNSampleNeverFalselyRaisesThePeak() {
        // NaN-vs-NaN and NaN-vs-anything comparisons are always false in
        // IEEE 754 / Swift — a stray NaN sample (e.g. a resampler edge
        // case upstream) must be silently skipped, never adopted as the
        // "maximum".
        withBytes([Float32.nan, 0.5]) { buffer in
            XCTAssertEqual(PeakMeter.maxAbsoluteSample(in: buffer), 0.5, accuracy: 0.0001)
        }
        withBytes([0.5, Float32.nan]) { buffer in
            XCTAssertEqual(PeakMeter.maxAbsoluteSample(in: buffer), 0.5, accuracy: 0.0001)
        }
    }

    func testAllNaNSamplesReturnsZeroNeverNaNItself() {
        // `result` starts at 0 and nothing ever beats it (every `>`
        // against NaN is false) — the returned peak stays the initial
        // 0, not NaN itself propagating out.
        withBytes([Float32.nan, Float32.nan]) { buffer in
            XCTAssertEqual(PeakMeter.maxAbsoluteSample(in: buffer), 0)
        }
    }

    func testFullScaleMagnitudeIsReported() {
        withBytes([1.0, -1.0]) { buffer in
            XCTAssertEqual(PeakMeter.maxAbsoluteSample(in: buffer), 1.0, accuracy: 0.0001)
        }
    }
}
