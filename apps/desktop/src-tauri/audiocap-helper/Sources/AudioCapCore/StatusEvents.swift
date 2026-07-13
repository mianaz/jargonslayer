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

    public static func emitStats(overflows: UInt64, ringHighWater: UInt64, framesOut: UInt64, droppedFrames: UInt64) {
        emit(StatsRecord(overflows: overflows, ringHighWater: ringHighWater, framesOut: framesOut, droppedFrames: droppedFrames))
    }

    private static func emit(_ record: some Encodable) {
        guard var data = try? JSONEncoder().encode(record) else { return }
        data.append(0x0A) // "\n" — one record per line, NDJSON
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
