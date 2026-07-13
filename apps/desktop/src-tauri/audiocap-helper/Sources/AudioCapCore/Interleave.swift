// S9.1 — writer-thread-only conversion from whatever byte layout the
// tap's AudioBufferList actually delivered (copied byte-for-byte into
// the ring by the RT IOProc — see Ring.swift's own comment) into the
// interleaved LE f32 Framing v1 requires on the wire. Deliberately NOT
// run in the IOProc (the S9.1 deliverable list's own instruction).
//
// Pure byte reshuffling: this NEVER interprets the 4-byte groups as
// actual Float values, only moves them — so it is endianness- and
// NaN-agnostic. It only assumes each channel's span is exactly
// `frameCount * 4` bytes, which holds for any 32-bit-per-channel-sample
// format (the isFloat32 check happens once, at setup, in
// ProcessTapCapture/main.swift — Interleave itself doesn't re-check
// per call, keeping this hot writer-thread path allocation-light).
public enum Interleave {
    /// Copies `planar` (N consecutive per-channel spans of `frameCount
    /// * 4` bytes each, in channel order) into `destination` in
    /// standard interleaved frame order (frame0[ch0,ch1,...],
    /// frame1[ch0,ch1,...], ...).
    public static func planarToInterleaved(
        planar: UnsafeRawBufferPointer,
        frameCount: Int,
        channels: Int,
        into destination: UnsafeMutableRawBufferPointer
    ) {
        precondition(channels > 0 && frameCount >= 0)
        precondition(planar.count == frameCount * channels * 4)
        precondition(destination.count == frameCount * channels * 4)
        guard frameCount > 0, let planarBase = planar.baseAddress, let destBase = destination.baseAddress else { return }

        let channelStride = frameCount * 4
        for channel in 0..<channels {
            let channelBase = planarBase + channel * channelStride
            for frame in 0..<frameCount {
                let dstOffset = (frame * channels + channel) * 4
                (destBase + dstOffset).copyMemory(from: channelBase + frame * 4, byteCount: 4)
            }
        }
    }
}
