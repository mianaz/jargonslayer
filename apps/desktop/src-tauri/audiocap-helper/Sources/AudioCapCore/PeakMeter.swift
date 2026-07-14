import Foundation

// S9 live-failure investigation (docs/design-explorations/
// s9-app-audio-tap-blueprint.md) — the S9.1/S9.2 spike and pipeline
// only ever verified BYTE COUNTS out of the tap (ring high-water,
// frames out, overflow/dropped-frame counters — see StatusEvents
// .StatsRecord), never AMPLITUDE. A tap silently capturing pure digital
// silence (wrong process excluded, wrong device routed, muted output,
// ...) would have produced byte counts and stats identical to a
// healthy capture. `maxAbsoluteSample` is the pure scan Writer folds
// into its own running peak/windowPeak (Writer.append); mirrors
// Interleave.swift's own "pure byte-level core, orchestration stays in
// Writer" split, so this stays directly unit-testable (PeakMeterTests.swift)
// without a live CoreAudio session or an injected FileHandle.
public enum PeakMeter {
    /// Scans `bytes` as consecutive Float32 samples and returns the
    /// maximum absolute value seen, or `0` for an empty/sub-4-byte
    /// span. Endianness-agnostic in practice: Framing v1's own wire
    /// format is already "interleaved LE f32" (Framing.swift's doc
    /// comment), and every platform this helper ships on (arm64,
    /// x86_64) is little-endian itself, so a native-byte-order load
    /// here is exactly a little-endian load — no explicit byte-swap
    /// needed (matches Framing.swift's own reasoning for its numeric
    /// fields).
    ///
    /// Channel/frame-order-agnostic BY DESIGN, same as Interleave.swift
    /// one file over: a magnitude scan doesn't care whether `bytes` is
    /// interleaved or planar, so `Writer.append` can call this on the
    /// RAW payload it was handed, before (or instead of) ever running
    /// it through Interleave.planarToInterleaved — the two conversions
    /// are independent and this one never needs to wait for the other.
    ///
    /// Any trailing 1-3 bytes that don't complete a full 4-byte sample
    /// are ignored (integer division below), same
    /// assume-well-formed-4-byte-groups posture Interleave.swift's own
    /// doc comment documents for its own byte spans.
    ///
    /// NaN-safe: Swift's `>` against NaN is always `false`, so a stray
    /// NaN sample can never falsely raise the running peak — it's
    /// simply skipped, exactly like any other non-maximal sample, no
    /// special-case needed.
    public static func maxAbsoluteSample(in bytes: UnsafeRawBufferPointer) -> Float {
        guard bytes.count >= 4, let base = bytes.baseAddress else { return 0 }
        let sampleCount = bytes.count / 4
        var result: Float = 0
        for i in 0..<sampleCount {
            let magnitude = abs(base.loadUnaligned(fromByteOffset: i * 4, as: Float32.self))
            if magnitude > result {
                result = magnitude
            }
        }
        return result
    }
}
