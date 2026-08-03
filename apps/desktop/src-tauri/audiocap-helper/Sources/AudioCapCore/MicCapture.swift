import AVFoundation
import AudioToolbox
import Foundation

// Dual-capture mic producer (2026-08 spike — Sources/aec-spike/main.swift
// proved the exact AVAudioEngine + tap APIs this cribs from; see that
// file's own header comment for the full go/no-go writeup) — the source
// counterpart to ProcessTapCapture.swift: instead of a CoreAudio process
// tap pulling SYSTEM audio, this pulls MICROPHONE audio via
// AVAudioEngine, with Apple's own voice processing (AEC) enabled so a
// dual system+mic session doesn't pick the speaker's own audio back up
// a second time through the mic. Spike facts this design is built on
// (verified 2026-08-02, macOS 26, M4 Max):
//   - inputNode.setVoiceProcessingEnabled(true), plus an
//     AVAudioVoiceProcessingOtherAudioDuckingConfiguration with ducking
//     forced to .min, gives ~32dB echo suppression of speaker audio at
//     the mic and coexists cleanly with a CoreAudio process tap running
//     in the same process (no stalls).
//   - With VP enabled, inputNode.outputFormat(forBus: 0) becomes 9
//     channels @ 48kHz — CHANNEL 0 is the processed voice channel; every
//     other channel is discarded here (see extractChannelZeroAndPush).
//   - VP ducks system OUTPUT ~8dB while active and fully recovers once
//     the engine stops — a known, accepted, session-scoped side effect,
//     not worked around here.
//
// Unlike ProcessTapCapture (an enum of static functions over raw
// AudioObjectIDs the CALLER threads through), this is a stateful class:
// AVAudioEngine itself, and the preallocated RT scratch buffer below,
// are genuinely per-session state with no natural raw-handle
// representation — the same shape Writer/TranscribeConsumer already use
// one file over, not ProcessTapCapture's.
public final class MicCapture {
    /// Requested tap buffer size, in frames — 4800 @ 48kHz = 100ms, the
    /// exact value the aec-spike's own runCoexist proved stable.
    /// AVAudioEngine treats this as a REQUEST, not a hard cap (the
    /// delivered buffer's frameLength can exceed it) — see
    /// `scratchCapacityFrames` below for how that's absorbed without
    /// ever allocating on the render thread.
    private static let tapBufferSize: AVAudioFrameCount = 4_800

    private let engine = AVAudioEngine()
    private let ring: SPSCByteRing

    // RT-safe scratch: preallocated once in setup(), at 2x tapBufferSize
    // frames, so the tap callback below never allocates — even on the
    // rare callback whose real frameLength exceeds the requested
    // bufferSize (extractChannelZeroAndPush clamps to this capacity
    // rather than growing it, exactly like SPSCByteRing's OWN producer
    // path never grows anything on the realtime side either).
    private var scratch: UnsafeMutableRawPointer?
    private var scratchCapacityFrames = 0

    public init(ring: SPSCByteRing) {
        self.ring = ring
    }

    deinit {
        scratch?.deallocate()
    }

    /// (a) TCC precheck -> typed error; (b) engine + best-effort voice
    /// processing; (c) tap install. Returns the mic's actual sample rate
    /// (read AFTER the voice-processing attempt, since VP changes
    /// `outputFormat(forBus: 0)` — see the inline comment below) —
    /// channel count is always 1 by construction (channel 0 only, see
    /// `extractChannelZeroAndPush`), so unlike
    /// `TapFormatDescription.channelCount` (a separate read for
    /// ProcessTapCapture, needed there because the tap's channel count
    /// genuinely varies), callers never need to ask this for one.
    public func setup() throws -> UInt32 {
        // (a) — mirrors ProcessTapCapture.start's own "this IS the TCC
        // prompt site" precedent for a not-yet-decided status: only the
        // two TERMINAL denied states are a hard error here; `.notDetermined`
        // is left to prompt naturally the first time the engine actually
        // starts, exactly like system-audio capture's own TCC prompt
        // fires from AudioDeviceStart rather than from any explicit
        // "ask for permission" call.
        let authStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        guard authStatus != .denied, authStatus != .restricted else {
            // This message IS the user-facing copy: the Rust side maps
            // mic-permission-denied onto the closed PermissionDenied
            // kind and forwards this wire `message` verbatim to JS (its
            // own error kinds never carry Rust-side literals), so the
            // polish must live here at the source. Diagnostic detail
            // (the raw authStatus) rides behind the copy for logs.
            throw AudioCapError.micPermissionDenied(
                "麦克风权限被拒绝：请在 系统设置 → 隐私与安全性 → 麦克风 中允许 JargonSlayer，然后重新开始转录（authorizationStatus=\(authStatus.rawValue)）"
            )
        }

        let input = engine.inputNode

        // (b) — best-effort: a throw here degrades gracefully (mic audio
        // still reaches the ring uncancelled, just without echo
        // suppression) rather than failing the whole session, per this
        // slice's own instruction. The ducking config is a SEPARATE,
        // macOS-14.0-only API (setVoiceProcessingEnabled's own floor is
        // lower, at or below this package's own 13.0) — only applied
        // once VP itself is confirmed enabled; setting a
        // voice-processing ducking config with no voice processing
        // active would be a meaningless no-op.
        do {
            try input.setVoiceProcessingEnabled(true)
            if #available(macOS 14.0, *) {
                input.voiceProcessingOtherAudioDuckingConfiguration =
                    AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
            }
        } catch {
            StatusEvents.emitNote(
                state: "mic-vp-unavailable",
                message: "setVoiceProcessingEnabled(true) threw (\(error)) — continuing WITHOUT voice processing (no echo suppression of speaker audio at the mic)"
            )
        }

        // (c) — `format` is read AFTER the VP attempt above: VP changes
        // outputFormat(forBus: 0) (spike fact: 9ch/48kHz once enabled),
        // so reading it any earlier would capture the PRE-VP format
        // instead of what the tap is actually about to deliver.
        let format = input.outputFormat(forBus: 0)
        let scratchFrames = Int(Self.tapBufferSize) * 2
        let scratchPointer = UnsafeMutableRawPointer.allocate(
            byteCount: scratchFrames * MemoryLayout<Float>.size,
            alignment: MemoryLayout<Float>.alignment
        )
        scratch = scratchPointer
        scratchCapacityFrames = scratchFrames

        let ring = self.ring // local copy — the closure below must never capture `self` (see its own comment)
        input.installTap(onBus: 0, bufferSize: Self.tapBufferSize, format: format) { buffer, _ in
            // REALTIME THREAD (AVAudioEngine's render thread) — same
            // discipline as ProcessTapCapture's own ioBlock one file
            // over: no allocation, no locks, no I/O, no logging past
            // this point. Capturing local `let` copies (not `self`)
            // keeps this closure from retaining the MicCapture instance
            // (which owns `engine`, which owns the tap that owns this
            // closure — a `self` capture here would be a retain cycle).
            MicCapture.extractChannelZeroAndPush(
                from: buffer, scratch: scratchPointer, capacityFrames: scratchFrames, ring: ring
            )
        }

        return UInt32(format.sampleRate)
    }

    public func start() throws {
        try engine.start()
    }

    /// Mirrors the aec-spike's own proven `engine.stop() ->
    /// input.removeTap(onBus: 0)` order. Safe to call more than once
    /// (main.swift's own callers do, mirroring ProcessTapCapture
    /// .teardown's own documented "harmless no-op" redundancy one file
    /// over) — `engine.stop()` on an already-stopped/never-started
    /// engine, and `removeTap` on a bus with no tap installed, are both
    /// documented no-ops, never a crash.
    public func stop() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
    }

    // ---- pure extraction core (RT-safe, no allocation) — a static
    // function (not a method reading `self`) specifically so it is
    // callable BOTH from the tap closure above (capturing local copies,
    // never `self`) AND directly from MicCaptureTests against a
    // synthetic AVAudioPCMBuffer + a real (small) SPSCByteRing, neither
    // of which needs live audio hardware or TCC. ----

    /// Copies channel 0 of `buffer` (clamped to `capacityFrames` — the
    /// same defensive clamp `setup()`'s own header comment on
    /// `scratchCapacityFrames` explains) into `scratch`, wraps it as a
    /// one-buffer mono AudioBufferList (the exact ABL-construction shape
    /// the aec-spike's own SilencePusher uses one file over), and pushes
    /// it into `ring`. `buffer`'s OTHER channels (1...N, when voice
    /// processing is active — spike fact: 9 total) are never read: this
    /// is the ONE place "channel 0 only" is enforced. AVAudioEngine's
    /// native processing format is non-interleaved (`floatChannelData`
    /// hands back one contiguous per-channel span), so extracting
    /// "channel 0" here is a single contiguous copy — no strided
    /// deinterleaving math needed the way Interleave.swift's own
    /// multi-channel conversion requires one file over.
    static func extractChannelZeroAndPush(
        from buffer: AVAudioPCMBuffer,
        scratch: UnsafeMutableRawPointer,
        capacityFrames: Int,
        ring: SPSCByteRing
    ) {
        guard let channelData = buffer.floatChannelData else { return }
        let frameCount = min(Int(buffer.frameLength), capacityFrames)
        guard frameCount > 0 else { return }
        let byteCount = frameCount * MemoryLayout<Float>.size
        scratch.copyMemory(from: channelData[0], byteCount: byteCount)
        var bufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(byteCount), mData: scratch)
        )
        withUnsafeMutablePointer(to: &bufferList) { pointer in
            _ = ring.tryPush(frameCount: UInt32(frameCount), buffers: UnsafeMutableAudioBufferListPointer(pointer))
        }
    }
}
