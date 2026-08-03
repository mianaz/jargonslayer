import AVFoundation
import AudioToolbox
import XCTest
@testable import AudioCapCore

// Dual-capture mic producer — MicCapture's own pure, hardware-free
// surface: `extractChannelZeroAndPush` is a static function taking a
// plain (synthesizable, no live AVAudioEngine/TCC needed)
// AVAudioPCMBuffer + a real SPSCByteRing, specifically so this file can
// exercise the "channel 0 only, everything else discarded" contract
// directly — see that function's own header comment one file over. The
// full setup()/start()/stop() lifecycle (live AVAudioEngine, live TCC)
// is NOT tested here — same "framework-bound seam, exercised by the
// build + a manual smoke test instead" posture SpeechAnalyzerSession
// .swift/ProcessTapCapture.swift's own header comments already document.
final class MicCaptureTests: XCTestCase {
    /// A non-interleaved (planar) Float32 AVAudioPCMBuffer with
    /// `channels` channels, each filled with a DISTINCT constant value
    /// (channel N -> Float(N + 1)) so a test can assert exactly which
    /// channel's samples reached the ring. Non-interleaved matches
    /// AVAudioEngine's own real native processing format — see
    /// MicCapture.extractChannelZeroAndPush's own doc comment.
    ///
    /// Built via an explicit `kAudioChannelLayoutTag_DiscreteInOrder`
    /// channel layout rather than the plain `AVAudioFormat(commonFormat:
    /// sampleRate:channels:interleaved:)` convenience initializer —
    /// verified empirically that the latter returns `nil` for a channel
    /// count with no standard layout name (e.g. 3), which this file
    /// needs in order to prove a real "N channels, only channel 0 read"
    /// case (the spike's own 9-channel VP-enabled fact is exactly such a
    /// count).
    private func makeBuffer(channels: AVAudioChannelCount, frameCount: AVAudioFrameCount) -> AVAudioPCMBuffer {
        guard let channelLayout = AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | channels) else {
            fatalError("failed to construct a discrete AVAudioChannelLayout for testing")
        }
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, interleaved: false, channelLayout: channelLayout)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: max(frameCount, 1)),
              let channelData = buffer.floatChannelData
        else {
            fatalError("failed to construct a synthetic AVAudioPCMBuffer for testing")
        }
        buffer.frameLength = frameCount
        for channel in 0..<Int(channels) {
            let value = Float(channel + 1)
            for frame in 0..<Int(frameCount) {
                channelData[channel][frame] = value
            }
        }
        return buffer
    }

    /// Mirrors TranscribeConsumerTests'/SPSCByteRingTests' own
    /// drain-and-assert style one file over — `payload` is already raw
    /// bytes here (no ABL/UInt8-array indirection needed), so a plain
    /// `bindMemory` is enough to read it back as floats.
    private func drainedFloats(_ ring: SPSCByteRing) -> [(frameCount: UInt32, floats: [Float32])] {
        var results: [(UInt32, [Float32])] = []
        ring.drain { frameCount, payload in
            results.append((frameCount, Array(payload.bindMemory(to: Float32.self))))
        }
        return results
    }

    private func scratch(frames: Int) -> UnsafeMutableRawPointer {
        UnsafeMutableRawPointer.allocate(byteCount: frames * MemoryLayout<Float>.size, alignment: MemoryLayout<Float>.alignment)
    }

    func testExtractChannelZeroForwardsOnlyChannelZeroSamples() {
        let buffer = makeBuffer(channels: 3, frameCount: 4) // ch0=1.0, ch1=2.0, ch2=3.0
        let ring = SPSCByteRing(capacity: 1024)
        let scratchFrames = 16
        let scratchPointer = scratch(frames: scratchFrames)
        defer { scratchPointer.deallocate() }

        MicCapture.extractChannelZeroAndPush(from: buffer, scratch: scratchPointer, capacityFrames: scratchFrames, ring: ring)

        let drained = drainedFloats(ring)
        XCTAssertEqual(drained.count, 1)
        XCTAssertEqual(drained[0].frameCount, 4)
        XCTAssertEqual(drained[0].floats, [1.0, 1.0, 1.0, 1.0], "only channel 0's samples must reach the ring — channels 1/2 must never be read")
    }

    func testExtractChannelZeroClampsToCapacityFramesRatherThanOverrunningScratch() {
        let buffer = makeBuffer(channels: 1, frameCount: 10)
        let ring = SPSCByteRing(capacity: 1024)
        let scratchFrames = 4 // deliberately SMALLER than the buffer's own frameLength
        let scratchPointer = scratch(frames: scratchFrames)
        defer { scratchPointer.deallocate() }

        MicCapture.extractChannelZeroAndPush(from: buffer, scratch: scratchPointer, capacityFrames: scratchFrames, ring: ring)

        let drained = drainedFloats(ring)
        XCTAssertEqual(drained.count, 1)
        XCTAssertEqual(drained[0].frameCount, 4, "must clamp to capacityFrames rather than ever writing past the preallocated scratch buffer")
    }

    func testExtractChannelZeroWithZeroFrameLengthPushesNothing() {
        let buffer = makeBuffer(channels: 1, frameCount: 4)
        buffer.frameLength = 0 // a legitimate "nothing delivered this callback" buffer
        let ring = SPSCByteRing(capacity: 1024)
        let scratchFrames = 16
        let scratchPointer = scratch(frames: scratchFrames)
        defer { scratchPointer.deallocate() }

        MicCapture.extractChannelZeroAndPush(from: buffer, scratch: scratchPointer, capacityFrames: scratchFrames, ring: ring)

        XCTAssertTrue(drainedFloats(ring).isEmpty, "a zero-length buffer must push nothing")
    }

    func testExtractChannelZeroWithSingleChannelBufferForwardsItUnchanged() {
        let buffer = makeBuffer(channels: 1, frameCount: 3)
        let ring = SPSCByteRing(capacity: 1024)
        let scratchFrames = 16
        let scratchPointer = scratch(frames: scratchFrames)
        defer { scratchPointer.deallocate() }

        MicCapture.extractChannelZeroAndPush(from: buffer, scratch: scratchPointer, capacityFrames: scratchFrames, ring: ring)

        XCTAssertEqual(drainedFloats(ring).map(\.floats), [[1.0, 1.0, 1.0]])
    }
}
