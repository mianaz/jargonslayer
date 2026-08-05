import Foundation

// S9.1 — typed NDJSON records on stderr (D5 / D6). Rust reassembles
// these across arbitrary raw stderr chunk boundaries (set_raw_out(true)
// applies to stderr too — see the S9.1 spike hook, uv.rs's emit_uv_log
// lane) since this helper is spawned with raw output; JSONEncoder here
// only has to guarantee each record is one well-formed JSON object
// followed by exactly one "\n" — reassembly on split boundaries is the
// PARENT's job, not this helper's.
public enum StatusEvents {
    private struct StatusRecord: Encodable {
        let type = "status"
        let state: String
        let sampleRate: UInt32
        let channels: UInt16
    }

    private struct ErrorRecord: Encodable {
        let type = "error"
        let code: String
        let message: String
    }

    private struct StatsRecord: Encodable {
        let type = "stats"
        let overflows: UInt64
        let ringHighWater: UInt64
        let framesOut: UInt64
        /// F5 (adversarial-review fix round) — cumulative AUDIO FRAMES
        /// dropped across every ring overflow (SPSCByteRing
        /// .droppedFrameCount's own doc comment), distinct from
        /// `overflows`' rejected-CALLBACK count.
        let droppedFrames: UInt64
        /// S9 live-failure investigation — maximum absolute sample
        /// value (PeakMeter.maxAbsoluteSample) seen since SESSION START
        /// (Writer's own running `peak`), never reset. Rounded to 3
        /// decimals (`round3` below) — plenty of precision for "is this
        /// tap capturing real audio or digital silence", not meant as
        /// an exact metering value.
        let peak: Double
        /// Same scan, but since the LAST stats emission only (Writer's
        /// own `windowPeak`, reset by the caller right after each
        /// emission) — lets a log reader see a recent silence window
        /// even in an otherwise loud session (`peak` alone can't: it
        /// only ever goes up).
        let windowPeak: Double
        /// Pre-tag fix round (Fix C, sustained-audio predicate): milliseconds
        /// of speech-level audio (PeakMeter.speechSampleFloor) within the
        /// SAME window as `windowPeak`, distinct from it — `windowPeak` is a
        /// single-sample max (one keystroke/cough can set it), this is a
        /// DURATION. `nil` (omitted, via Swift's synthesized
        /// `encodeIfPresent`, same as `channel` below) for Writer's own
        /// capture-mode stats — Writer.swift is Must-NOT-TOUCH and its stats
        /// don't feed the mid-session STT liveness watchdog this field
        /// exists for; only TranscribeConsumer's transcribe-mode stats ever
        /// pass a real value.
        let windowLoudMs: UInt32?
        /// Dual-capture mic producer — "mic" | "system" | nil (omitted
        /// via Swift's synthesized `encodeIfPresent` for an Optional
        /// stored property, same as every other optional field in this
        /// file/TranscriptEvents.swift's own AssetRecord — see that
        /// type's own doc comment). `nil` for every existing caller
        /// (Writer.swift's own capture-mode stats, and any single-source
        /// transcribe session) — only dual mode's two concurrently
        /// running TranscribeConsumer instances, one per channel, ever
        /// pass a real value here, which is how a reader tells the two
        /// interleaved stats streams apart (and specifically how a
        /// nonzero mic `peak` is verified live, per this slice's own
        /// requirement).
        let channel: String?
    }

    /// Freeform informational status (still `type:"status"`, one
    /// `state` + human-readable `message`) — for conditions worth
    /// surfacing that aren't part of the starting/capturing lifecycle,
    /// e.g. "exclude-pid-inactive" (translateExcludePID's nil case).
    private struct NoteRecord: Encodable {
        let type = "status"
        let state: String
        let message: String
    }

    /// `state` is "starting" (emitted once the tap's real format is
    /// known, right before the AudioDeviceStart call that's actually
    /// gated by TCC — see main.swift's runCapture) or "capturing"
    /// (emitted right after AudioDeviceStart returns success).
    public static func emitStatus(state: String, sampleRate: UInt32, channels: UInt16) {
        emit(StatusRecord(state: state, sampleRate: sampleRate, channels: channels))
    }

    public static func emitNote(state: String, message: String) {
        emit(NoteRecord(state: state, message: message))
    }

    public static func emitError(_ error: AudioCapError) {
        emit(ErrorRecord(code: error.code, message: error.message))
    }

    public static func emitStats(
        overflows: UInt64,
        ringHighWater: UInt64,
        framesOut: UInt64,
        droppedFrames: UInt64,
        peak: Float,
        windowPeak: Float,
        channel: String? = nil,
        windowLoudMs: UInt32? = nil
    ) {
        write(statsBytes(
            overflows: overflows,
            ringHighWater: ringHighWater,
            framesOut: framesOut,
            droppedFrames: droppedFrames,
            peak: peak,
            windowPeak: windowPeak,
            channel: channel,
            windowLoudMs: windowLoudMs
        ))
    }

    /// Pure encoder, golden-byte testable (StatusEventsTests.swift) —
    /// the same "no injectable output, so split a pure `*Bytes` half out
    /// of the real write" shape TranscriptEvents.swift already
    /// established one file over (that file's own header comment),
    /// scoped to JUST the stats record: `StatusRecord`/`ErrorRecord`/
    /// `NoteRecord` keep going through the plain, declaration-order
    /// `emit(_:)` below unchanged, since nothing tests THEIR byte order
    /// today either. `.sortedKeys` here for the same reason
    /// TranscriptEvents' own encoder needs it: plain `JSONEncoder()` key
    /// order on this toolchain is not declaration order and not
    /// reliably reproducible, which is what actually lets a golden-byte
    /// test assert a fixed string at all.
    static func statsBytes(
        overflows: UInt64,
        ringHighWater: UInt64,
        framesOut: UInt64,
        droppedFrames: UInt64,
        peak: Float,
        windowPeak: Float,
        channel: String? = nil,
        windowLoudMs: UInt32? = nil
    ) -> Data {
        guard var data = try? sortedEncoder.encode(StatsRecord(
            overflows: overflows,
            ringHighWater: ringHighWater,
            framesOut: framesOut,
            droppedFrames: droppedFrames,
            peak: round3(peak),
            windowPeak: round3(windowPeak),
            windowLoudMs: windowLoudMs,
            channel: channel
        )) else { return Data() }
        data.append(0x0A) // "\n" — one record per line, NDJSON (matches emit(_:) below)
        return data
    }

    private static let sortedEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    /// Rounds to 3 decimal places ("floats rounded to 3 decimals is
    /// fine" — this is a diagnostic amplitude readout, not a metering
    /// value) — applied once, right before encoding, so `StatsRecord`
    /// itself always carries the exact wire-ready value.
    private static func round3(_ value: Float) -> Double {
        (Double(value) * 1000).rounded() / 1000
    }

    private static func emit(_ record: some Encodable) {
        guard var data = try? JSONEncoder().encode(record) else { return }
        data.append(0x0A) // "\n" — one record per line, NDJSON
        write(data)
    }

    private static func write(_ data: Data) {
        // F12 (adversarial-review fix round): throwing write(contentsOf:),
        // never the exception-raising write(_:) — a closed parent pipe
        // (EPIPE, e.g. the parent died) must never crash this process
        // via an uncaught NSException. `try?` (not typed handling like
        // Writer's own flush/writeEOS): there is no shutdown-request
        // wiring reachable from this static/stateless enum, and a
        // stderr write failing on its own is not, by itself, this
        // helper's primary "the parent is gone" signal (stdout's own
        // write failures are — see Writer.onWriteFailure) — silently
        // dropping one NDJSON line is the correct degraded behavior.
        try? FileHandle.standardError.write(contentsOf: data)
    }
}
