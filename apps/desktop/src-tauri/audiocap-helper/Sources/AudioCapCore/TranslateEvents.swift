import Foundation

// v0.6 (Apple on-device translate lane) — the --probe-translate/
// --translate modes' own stderr NDJSON records, on the SAME raw-output
// stderr lane StatusEvents.swift/TranscriptEvents.swift already own (see
// StatusEvents.swift's own header comment for the wire convention: one
// JSON object + one '\n' per record, reassembled by Rust's own
// LineReassembler on arbitrary chunk boundaries). A NEW file/enum for the
// same reason TranscriptEvents itself is its own file (that file's own
// header comment: each mode's wire contract lives independently) —
// tagged "kind" rather than every other mode's "type", per this lane's
// own pinned wire contract (the Rust side — apps/desktop/src-tauri/src/
// systranslate.rs — is coded directly against these four exact shapes,
// not to be deviated from). Modeled on StatusEvents.swift's plain
// struct+emit shape (no pure/impure split, no `.sortedKeys`) rather than
// TranscriptEvents.swift's golden-byte-testable split: this lane has no
// Swift-side unit tests of its own (verified live instead — see
// main.swift's --probe-translate/--translate entry points), so the extra
// split has nothing to buy here.
public enum TranslateEvents {
    private struct ProbeRecord: Encodable {
        let kind = "probe"
        let osSupported: Bool
        let status: String
    }

    private struct ReadyRecord: Encodable {
        let kind = "ready"
    }

    /// One translated segment — the `result` record's own `translations`
    /// array shape (`{"id":...,"text":...}`), encode-only (main.swift
    /// never decodes this shape back; TranslateRequestLine.Segment, in
    /// main.swift, is the decode-only analog for the INCOMING side).
    public struct TranslationOut: Encodable {
        public let id: String
        public let text: String

        public init(id: String, text: String) {
            self.id = id
            self.text = text
        }
    }

    private struct ResultRecord: Encodable {
        let kind = "result"
        let id: String
        let translations: [TranslationOut]
    }

    /// `id` is `nil` (and therefore OMITTED from the wire, not written as
    /// `null` — Swift's synthesized Encodable conformance calls
    /// `encodeIfPresent` for an Optional stored property, the same
    /// behavior TranscriptEvents.swift's own header comment documents)
    /// for a startup-level failure with no request to correlate against
    /// (e.g. a malformed stdin line, never even decoded far enough to
    /// learn its own id) — every PER-REQUEST error carries that
    /// request's real id instead.
    private struct ErrorRecord: Encodable {
        let kind = "error"
        let id: String?
        let code: String
        let message: String
    }

    public static func emitProbe(osSupported: Bool, status: String) {
        emit(ProbeRecord(osSupported: osSupported, status: status))
    }

    public static func emitReady() {
        emit(ReadyRecord())
    }

    public static func emitResult(id: String, translations: [TranslationOut]) {
        emit(ResultRecord(id: id, translations: translations))
    }

    public static func emitError(id: String?, code: String, message: String) {
        emit(ErrorRecord(id: id, code: code, message: message))
    }

    private static func emit(_ record: some Encodable) {
        guard var data = try? JSONEncoder().encode(record) else { return }
        data.append(0x0A) // "\n" — one record per line, NDJSON
        // F12-style discipline (StatusEvents.emit's own doc comment):
        // throwing write(contentsOf:), try?-guarded — a closed parent
        // pipe must never crash this process.
        try? FileHandle.standardError.write(contentsOf: data)
    }
}
