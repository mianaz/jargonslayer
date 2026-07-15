import Foundation

// S11 (§2.2) — the transcribe-mode NDJSON records, on the SAME stderr
// lane StatusEvents.swift already owns for capture mode (raw-output
// stderr, reassembled on arbitrary chunk boundaries by Rust's own
// LineReassembler — see StatusEvents.swift's own header comment). A
// NEW file/enum rather than added cases on StatusEvents (Must-NOT-TOUCH
// per the blueprint's worker split) — modeled directly on it: each
// record is a private Encodable struct with a fixed `type` field, and
// the real `emit*` functions use the exact same try?-guarded "never
// crash on a closed stderr pipe" write discipline, just duplicated here
// rather than shared (StatusEvents.emit is private to that enum) — a
// few lines of harmless duplication is a small price for keeping the
// two lanes' files fully independent, per the worker-ownership split
// this slice was designed around.
//
// Deliberately split into a PURE byte-encoding half (the `*Bytes`
// functions below — no I/O, no FileHandle, directly golden-byte
// testable, exactly Framing.swift's own `encodeXXX() -> [UInt8]` shape
// one file over) and a real-write half (the public `emit*` functions,
// untested the same way StatusEvents' own stderr write is untested):
// StatusEvents itself has no injectable output to verify actual emitted
// bytes against (its own doc comment on `emit`), so rather than invent
// one here (a bigger departure from "model on StatusEvents" than
// splitting the encode step out), TranscriptEventsTests calls the
// `*Bytes` functions directly and never touches the real stderr FileHandle.
public enum TranscriptEvents {
    private struct TranscriptRecord: Encodable {
        let type = "transcript"
        let final: Bool
        let seq: UInt64
        let startMs: Int64
        let endMs: Int64
        let text: String
    }

    /// One struct for all four asset lifecycle states (§2.2) rather than
    /// four separate record types: `progress`/`message` are `Optional`,
    /// and Swift's synthesized `Encodable` conformance calls
    /// `encodeIfPresent` for `Optional` stored properties — a `nil`
    /// field is OMITTED from the JSON entirely, not written as `null` —
    /// which is exactly what reproduces the wire contract's four
    /// different-shaped examples (`checking`/`installed` carry neither
    /// field, `downloading` carries only `progress`, `failed` only
    /// `message`) from one struct.
    private struct AssetRecord: Encodable {
        let type = "asset"
        let state: String
        let progress: Double?
        let message: String?
    }

    private struct LocaleRecord: Encodable {
        let type = "locale"
        let requested: String
        let resolved: String?
        let supported: Bool
    }

    /// `--probe-osspeech`'s one-shot line — deliberately has NO
    /// dependency on any Speech-framework type (plain String/Bool
    /// values only), so this record (and the `emitProbe`/`probeBytes`
    /// functions below) stay callable from an UNGATED context:
    /// main.swift's runProbe calls this on macOS <26 too (§2.1: "on
    /// <26, `supported:false` without spawning Speech").
    private struct ProbeRecord: Encodable {
        let type = "osspeech-probe"
        let supported: Bool
        let locales: [String]
        let installed: [String]
    }

    /// The clean-stop sentinel (§2.2: "the transcribe analog of framing
    /// EOS — Rust's `finished_seen`") — deliberately ONLY `type`+`state`,
    /// no other fields (unlike StatusEvents.StatusRecord, which always
    /// carries sampleRate/channels); see the wire contract's own
    /// single-line example.
    private struct FinishedRecord: Encodable {
        let type = "status"
        let state = "finished"
    }

    private struct ErrorRecord: Encodable {
        let type = "error"
        let code: String
        let message: String
    }

    // ---- pure encoders (golden-byte testable, no I/O) ----

    static func transcriptBytes(final: Bool, seq: UInt64, startMs: Int64, endMs: Int64, text: String) -> Data {
        encodeLine(TranscriptRecord(final: final, seq: seq, startMs: startMs, endMs: endMs, text: truncatedTo4096Bytes(text)))
    }

    static func assetCheckingBytes() -> Data {
        encodeLine(AssetRecord(state: "checking", progress: nil, message: nil))
    }

    static func assetDownloadingBytes(progress: Double) -> Data {
        encodeLine(AssetRecord(state: "downloading", progress: progress, message: nil))
    }

    static func assetInstalledBytes() -> Data {
        encodeLine(AssetRecord(state: "installed", progress: nil, message: nil))
    }

    static func assetFailedBytes(message: String) -> Data {
        encodeLine(AssetRecord(state: "failed", progress: nil, message: message))
    }

    static func localeBytes(requested: String, resolved: String?, supported: Bool) -> Data {
        encodeLine(LocaleRecord(requested: requested, resolved: resolved, supported: supported))
    }

    static func probeBytes(supported: Bool, locales: [String], installed: [String]) -> Data {
        encodeLine(ProbeRecord(supported: supported, locales: locales, installed: installed))
    }

    static func finishedBytes() -> Data {
        encodeLine(FinishedRecord())
    }

    static func errorBytes(code: String, message: String) -> Data {
        encodeLine(ErrorRecord(code: code, message: message))
    }

    // ---- production emitters (real try?-guarded stderr write) ----

    public static func emitTranscript(final: Bool, seq: UInt64, startMs: Int64, endMs: Int64, text: String) {
        write(transcriptBytes(final: final, seq: seq, startMs: startMs, endMs: endMs, text: text))
    }

    public static func emitAssetChecking() {
        write(assetCheckingBytes())
    }

    public static func emitAssetDownloading(progress: Double) {
        write(assetDownloadingBytes(progress: progress))
    }

    public static func emitAssetInstalled() {
        write(assetInstalledBytes())
    }

    public static func emitAssetFailed(message: String) {
        write(assetFailedBytes(message: message))
    }

    public static func emitLocale(requested: String, resolved: String?, supported: Bool) {
        write(localeBytes(requested: requested, resolved: resolved, supported: supported))
    }

    /// Called on EVERY macOS version (§2.1/§2.4) — see `ProbeRecord`'s
    /// own doc comment for why this function itself carries no
    /// availability gate.
    public static func emitProbe(supported: Bool, locales: [String], installed: [String]) {
        write(probeBytes(supported: supported, locales: locales, installed: installed))
    }

    public static func emitFinished() {
        write(finishedBytes())
    }

    /// Gated (unlike every other `emit*` above): `OsSpeechError` itself
    /// is `@available(macOS 26.0, *)` (it exists to map `SFSpeechError`
    /// codes — OsSpeechError.swift's own header comment), so a function
    /// taking one as a parameter can't be any less restricted. The pure
    /// `errorBytes(code:message:)` above stays ungated (plain strings)
    /// so its golden-byte test doesn't need an availability gate either.
    @available(macOS 26.0, *)
    public static func emitError(_ error: OsSpeechError) {
        write(errorBytes(code: error.code, message: error.message))
    }

    // ---- shared helpers ----

    /// CMTime seconds -> integer ms (§Q10: "CMTime seconds x 1000,
    /// rounded"). Takes a plain `Double` (callers pass `cmTime.seconds`)
    /// rather than `CMTime` itself so this file has no need to `import
    /// CoreMedia` for one arithmetic helper — every ms field on the wire
    /// goes through this SAME rounding rule rather than each call site
    /// rolling its own.
    public static func milliseconds(fromSeconds seconds: Double) -> Int64 {
        Int64((seconds * 1_000).rounded())
    }

    /// Truncates `text` to at most 4096 UTF-8 bytes (§Q2's own text
    /// guard), backing off from a raw 4096-byte cut to the nearest
    /// earlier byte that ISN'T a UTF-8 continuation byte (top two bits
    /// `10`) — i.e. the nearest earlier scalar boundary — so a
    /// multibyte character (e.g. a Han character, 3 bytes in UTF-8)
    /// straddling byte 4096 is dropped WHOLE rather than split into an
    /// invalid trailing fragment. A well-formed UTF-8 string's lead byte
    /// is never more than 3 bytes behind any continuation byte, so this
    /// loop is bounded (worst case backs off 3 bytes) and can never run
    /// past byte 0 of a valid string.
    static func truncatedTo4096Bytes(_ text: String) -> String {
        let limit = 4_096
        var bytes = Array(text.utf8)
        guard bytes.count > limit else { return text }
        var cut = limit
        while cut > 0, (bytes[cut] & 0xC0) == 0x80 {
            cut -= 1
        }
        bytes.removeSubrange(cut...)
        return String(decoding: bytes, as: UTF8.self)
    }

    /// `.sortedKeys`: JSON object-key order carries no semantic meaning
    /// to any correct parser (Rust's own serde_json matches by field
    /// name, never position) — sorting makes this file's own output
    /// byte-for-byte DETERMINISTIC, which is what actually lets
    /// TranscriptEventsTests golden-byte-assert against a fixed string
    /// at all. (Verified empirically: plain `JSONEncoder()` on this
    /// toolchain does NOT preserve struct declaration order the way an
    /// older/ObjC-backed Foundation might — confirmed by first writing
    /// these tests against declaration order and watching them fail
    /// with an unpredictable key order back, before adding this flag.)
    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    private static func encodeLine(_ record: some Encodable) -> Data {
        guard var data = try? encoder.encode(record) else { return Data() }
        data.append(0x0A) // "\n" — one record per line, NDJSON (matches StatusEvents.emit)
        return data
    }

    private static func write(_ data: Data) {
        // F12-style discipline (StatusEvents.emit's own doc comment):
        // throwing write(contentsOf:), try?-guarded — a closed parent
        // pipe must never crash this process.
        try? FileHandle.standardError.write(contentsOf: data)
    }
}
