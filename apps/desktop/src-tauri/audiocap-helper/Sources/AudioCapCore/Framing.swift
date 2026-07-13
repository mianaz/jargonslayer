import Foundation

// S9.1 — the stdout wire format toward the Rust sidecar supervisor
// (D5: "Framing v1 (stdout, all little-endian, versioned)"). Pure byte
// encoding, no CoreAudio, no I/O — this is the piece the blueprint
// explicitly calls out for a `swift test` golden-bytes test (see
// Tests/AudioCapCoreTests/FramingTests.swift). main.swift is the only
// production caller; it writes the returned byte arrays straight to
// FileHandle.standardOutput.
public enum Framing {
    /// "JSAC" (JargonSlayer Audio Capture), ASCII, written as-is (magic
    /// bytes aren't numeric so there's no endianness question for this
    /// field itself — only the numeric fields after it need explicit
    /// little-endian encoding).
    public static let magic: [UInt8] = [0x4A, 0x53, 0x41, 0x43]

    public static let version: UInt16 = 1

    /// The only format this helper ever declares on the wire: fixed,
    /// interleaved little-endian Float32 — D5's "format u16 (fixed:
    /// interleaved LE f32 — helper converts whatever the tap delivers;
    /// never ship raw AudioBufferList reconstruction)". Whatever the tap
    /// actually delivers (see ProcessTapCapture/Interleave's own
    /// comments) is normalized to this on the writer thread before any
    /// byte reaches Framing.encodeChunk.
    public static let formatInterleavedFloat32: UInt16 = 1

    /// Written once, before the first chunk record.
    public static func encodeStreamHeader(sampleRate: UInt32, channels: UInt16) -> [UInt8] {
        var bytes = magic
        bytes += littleEndianBytes(version)
        bytes += littleEndianBytes(formatInterleavedFloat32)
        bytes += littleEndianBytes(sampleRate)
        bytes += littleEndianBytes(channels)
        bytes += littleEndianBytes(UInt16(0)) // reserved
        return bytes
    }

    /// One chunk record: {seq u64, frame_count u32, byte_len u32,
    /// payload}. `payload` is assumed already interleaved LE f32 (the
    /// writer thread's job, not this function's — Framing itself never
    /// touches CoreAudio types).
    public static func encodeChunk(seq: UInt64, frameCount: UInt32, payload: [UInt8]) -> [UInt8] {
        var bytes = littleEndianBytes(seq)
        bytes += littleEndianBytes(frameCount)
        bytes += littleEndianBytes(UInt32(payload.count))
        bytes += payload
        return bytes
    }

    /// The explicit EOS record on clean stop — same shape as a chunk
    /// record with frame_count=0, byte_len=0, and (since byte_len is 0)
    /// no payload bytes follow. `seq` continues the SAME monotonic
    /// sequence as the chunk records that preceded it, so a consumer
    /// can tell "no chunks were dropped right before EOS" from the
    /// sequence alone.
    public static func encodeEOS(seq: UInt64) -> [UInt8] {
        var bytes = littleEndianBytes(seq)
        bytes += littleEndianBytes(UInt32(0))
        bytes += littleEndianBytes(UInt32(0))
        return bytes
    }

    private static func littleEndianBytes<T: FixedWidthInteger>(_ value: T) -> [UInt8] {
        withUnsafeBytes(of: value.littleEndian) { Array($0) }
    }
}
