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
    }

    /// `state` is "starting" (emitted once the tap's real format is
    /// known, right before the AudioDeviceStart call that's actually
    /// gated by TCC — see main.swift's runCapture) or "capturing"
    /// (emitted right after AudioDeviceStart returns success).
    public static func emitStatus(state: String, sampleRate: UInt32, channels: UInt16) {
        emit(StatusRecord(state: state, sampleRate: sampleRate, channels: channels))
    }

    public static func emitError(_ error: AudioCapError) {
        emit(ErrorRecord(code: error.code, message: error.message))
    }

    public static func emitStats(overflows: UInt64, ringHighWater: UInt64, framesOut: UInt64) {
        emit(StatsRecord(overflows: overflows, ringHighWater: ringHighWater, framesOut: framesOut))
    }

    private static func emit(_ record: some Encodable) {
        guard var data = try? JSONEncoder().encode(record) else { return }
        data.append(0x0A) // "\n" — one record per line, NDJSON
        FileHandle.standardError.write(data)
    }
}
