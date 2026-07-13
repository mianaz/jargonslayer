import CoreAudio

// S9.1 — small pure helpers over the AudioStreamBasicDescription this
// helper reads back once from kAudioTapPropertyFormat
// (ProcessTapCapture.createProcessTap). Kept separate from
// ProcessTapCapture.swift because these are pure functions over a
// value type (testable without any live CoreAudio session), unlike the
// rest of that file.
public enum TapFormatDescription {
    /// True when the tap's declared format is Float32 samples — the
    /// only sample representation this helper knows how to forward
    /// (Framing v1's format u16 is fixed to interleaved LE f32; see
    /// that file's own comment). Process taps are documented/observed
    /// to deliver Float32 (CoreAudio's own canonical processing
    /// format) — this check exists so a surprise on some future OS
    /// revision fails LOUDLY (a typed error) instead of silently
    /// mis-encoding non-float samples as if they were floats.
    public static func isFloat32(_ asbd: AudioStreamBasicDescription) -> Bool {
        asbd.mFormatID == kAudioFormatLinearPCM
            && asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
            && asbd.mBitsPerChannel == 32
    }

    /// True when each channel is its own separate buffer in the
    /// AudioBufferList (mNumberBuffers == channel count, each
    /// frameCount * 4 bytes) rather than one interleaved buffer. Process
    /// taps have been observed/documented (see ProcessTapCapture's own
    /// comment on what this helper logs at "starting") to deliver
    /// non-interleaved float32 — CoreAudio's general canonical layout —
    /// but this is read from the ACTUAL tap format at setup, never
    /// assumed, and Interleave.swift's conversion is applied
    /// unconditionally based on this flag rather than a hardcoded
    /// assumption either way.
    public static func isNonInterleaved(_ asbd: AudioStreamBasicDescription) -> Bool {
        asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
    }

    public static func channelCount(_ asbd: AudioStreamBasicDescription) -> Int {
        Int(asbd.mChannelsPerFrame)
    }
}
