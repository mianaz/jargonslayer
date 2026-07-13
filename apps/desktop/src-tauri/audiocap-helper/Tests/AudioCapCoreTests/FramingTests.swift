import XCTest
@testable import AudioCapCore

// S9.1 deliverable list: "Swift unit test (`swift test`): framing
// encoder golden-bytes test (header + one chunk + EOS), pure function,
// no CoreAudio." Framing.swift touches no CoreAudio API at all, so this
// runs the same in CI (no CoreAudio session available there — see the
// blueprint's own "Slices" preamble) as on a dev machine.
final class FramingTests: XCTestCase {
    func testStreamHeaderGoldenBytes() {
        let header = Framing.encodeStreamHeader(sampleRate: 48_000, channels: 2)
        XCTAssertEqual(header, [
            0x4A, 0x53, 0x41, 0x43, // magic "JSAC"
            0x01, 0x00, // version = 1 (LE u16)
            0x01, 0x00, // format = 1, interleaved f32 (LE u16)
            0x80, 0xBB, 0x00, 0x00, // sampleRate = 48000 (LE u32)
            0x02, 0x00, // channels = 2 (LE u16)
            0x00, 0x00, // reserved
        ])
        XCTAssertEqual(header.count, 16)
    }

    func testChunkRecordGoldenBytes() {
        let payload: [UInt8] = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]
        let chunk = Framing.encodeChunk(seq: 1, frameCount: 1, payload: payload)
        XCTAssertEqual(chunk, [
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // seq = 1 (LE u64)
            0x01, 0x00, 0x00, 0x00, // frameCount = 1 (LE u32)
            0x08, 0x00, 0x00, 0x00, // byteLen = 8 (LE u32)
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, // payload
        ])
    }

    func testEOSRecordGoldenBytes() {
        let eos = Framing.encodeEOS(seq: 2)
        XCTAssertEqual(eos, [
            0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // seq = 2 (LE u64)
            0x00, 0x00, 0x00, 0x00, // frameCount = 0
            0x00, 0x00, 0x00, 0x00, // byteLen = 0
        ])
        XCTAssertEqual(eos.count, 16)
    }

    /// Header + one chunk + EOS concatenated, as a downstream reader
    /// (S9.2's Rust sidecar supervisor) would actually see them arrive
    /// on stdout in sequence.
    func testFullStreamGoldenBytes() {
        var stream: [UInt8] = []
        stream += Framing.encodeStreamHeader(sampleRate: 16_000, channels: 1)
        stream += Framing.encodeChunk(seq: 0, frameCount: 2, payload: [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22])
        stream += Framing.encodeEOS(seq: 1)

        XCTAssertEqual(stream, [
            // header
            0x4A, 0x53, 0x41, 0x43,
            0x01, 0x00,
            0x01, 0x00,
            0x80, 0x3E, 0x00, 0x00, // 16000 (LE u32)
            0x01, 0x00,
            0x00, 0x00,
            // chunk seq=0, frameCount=2, byteLen=8
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x02, 0x00, 0x00, 0x00,
            0x08, 0x00, 0x00, 0x00,
            0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22,
            // EOS seq=1
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
        ])
    }
}
