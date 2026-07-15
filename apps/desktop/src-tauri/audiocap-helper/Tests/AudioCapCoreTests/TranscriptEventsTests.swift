import XCTest
@testable import AudioCapCore

// S11 (§2.2) — golden-byte NDJSON tests against the pure `*Bytes`
// encoders (TranscriptEvents.swift's own header comment on why these
// are split out from the real stderr-writing `emit*` functions:
// StatusEvents itself has no injectable output either, so this file
// never touches the real stderr FileHandle at all — exactly
// FramingTests.swift's own "pure function, no CoreAudio" posture one
// file over, just for JSON instead of the binary Framing wire).
//
// Expected strings below are in ALPHABETICAL key order (`type` last,
// not first, in every record): TranscriptEvents' own encoder forces
// `.sortedKeys` specifically so this file can assert a fixed byte
// sequence at all — see that encoder's own doc comment for why plain
// `JSONEncoder()` key order on this toolchain turned out NOT to match
// struct declaration order (discovered by these tests failing against
// declaration-order expectations before `.sortedKeys` was added).
final class TranscriptEventsTests: XCTestCase {
    private func string(_ data: Data) -> String {
        String(decoding: data, as: UTF8.self)
    }

    func testTranscriptVolatileGoldenBytes() {
        let data = TranscriptEvents.transcriptBytes(final: false, seq: 12, startMs: 3200, endMs: 4100, text: "jargon slayer")
        XCTAssertEqual(string(data), #"{"endMs":4100,"final":false,"seq":12,"startMs":3200,"text":"jargon slayer","type":"transcript"}"# + "\n")
    }

    func testTranscriptFinalGoldenBytes() {
        let data = TranscriptEvents.transcriptBytes(final: true, seq: 13, startMs: 0, endMs: 4920, text: "Jargon slayer is a tool.")
        XCTAssertEqual(string(data), #"{"endMs":4920,"final":true,"seq":13,"startMs":0,"text":"Jargon slayer is a tool.","type":"transcript"}"# + "\n")
    }

    func testAssetCheckingGoldenBytesOmitsProgressAndMessage() {
        let data = TranscriptEvents.assetCheckingBytes()
        XCTAssertEqual(string(data), #"{"state":"checking","type":"asset"}"# + "\n")
    }

    func testAssetDownloadingGoldenBytesIncludesOnlyProgress() {
        let data = TranscriptEvents.assetDownloadingBytes(progress: 0.42)
        XCTAssertEqual(string(data), #"{"progress":0.42,"state":"downloading","type":"asset"}"# + "\n")
    }

    func testAssetInstalledGoldenBytesOmitsProgressAndMessage() {
        let data = TranscriptEvents.assetInstalledBytes()
        XCTAssertEqual(string(data), #"{"state":"installed","type":"asset"}"# + "\n")
    }

    func testAssetFailedGoldenBytesIncludesOnlyMessage() {
        let data = TranscriptEvents.assetFailedBytes(message: "network unreachable")
        XCTAssertEqual(string(data), #"{"message":"network unreachable","state":"failed","type":"asset"}"# + "\n")
    }

    func testLocaleResolvedGoldenBytes() {
        let data = TranscriptEvents.localeBytes(requested: "zh-Hans", resolved: "zh_CN", supported: true)
        XCTAssertEqual(string(data), #"{"requested":"zh-Hans","resolved":"zh_CN","supported":true,"type":"locale"}"# + "\n")
    }

    func testLocaleUnsupportedGoldenBytesOmitsResolved() {
        let data = TranscriptEvents.localeBytes(requested: "zh-Yue", resolved: nil, supported: false)
        XCTAssertEqual(string(data), #"{"requested":"zh-Yue","supported":false,"type":"locale"}"# + "\n")
    }

    func testProbeGoldenBytes() {
        let data = TranscriptEvents.probeBytes(supported: true, locales: ["zh_CN", "zh_TW", "en_US"], installed: ["en_US"])
        XCTAssertEqual(string(data), #"{"installed":["en_US"],"locales":["zh_CN","zh_TW","en_US"],"supported":true,"type":"osspeech-probe"}"# + "\n")
    }

    func testProbeUnsupportedGoldenBytesWithEmptyArrays() {
        let data = TranscriptEvents.probeBytes(supported: false, locales: [], installed: [])
        XCTAssertEqual(string(data), #"{"installed":[],"locales":[],"supported":false,"type":"osspeech-probe"}"# + "\n")
    }

    func testFinishedGoldenBytes() {
        let data = TranscriptEvents.finishedBytes()
        XCTAssertEqual(string(data), #"{"state":"finished","type":"status"}"# + "\n")
    }

    func testErrorGoldenBytes() {
        let data = TranscriptEvents.errorBytes(code: "unsupported-locale", message: "zh-Yue")
        XCTAssertEqual(string(data), #"{"code":"unsupported-locale","message":"zh-Yue","type":"error"}"# + "\n")
    }

    // ---- CMTime seconds -> ms (§Q10) ----

    func testMillisecondsFromSecondsRoundsToNearestInteger() {
        XCTAssertEqual(TranscriptEvents.milliseconds(fromSeconds: 3.2), 3_200)
        XCTAssertEqual(TranscriptEvents.milliseconds(fromSeconds: 4.9204), 4_920)
        XCTAssertEqual(TranscriptEvents.milliseconds(fromSeconds: 0.0005), 1, "rounds half-up, not truncates")
        XCTAssertEqual(TranscriptEvents.milliseconds(fromSeconds: 0), 0)
    }

    // ---- 4096-byte UTF-8-boundary-safe truncation ----

    func testTextUnderTheLimitIsReturnedUnchanged() {
        let text = String(repeating: "a", count: 100)
        XCTAssertEqual(TranscriptEvents.truncatedTo4096Bytes(text), text)
    }

    func testTextExactlyAtTheLimitIsReturnedUnchanged() {
        let text = String(repeating: "a", count: 4_096)
        XCTAssertEqual(TranscriptEvents.truncatedTo4096Bytes(text).utf8.count, 4_096)
        XCTAssertEqual(TranscriptEvents.truncatedTo4096Bytes(text), text)
    }

    func testTextOverTheLimitOnAPureAsciiBoundaryIsCutCleanlyAtExactly4096Bytes() {
        let text = String(repeating: "a", count: 5_000)
        let truncated = TranscriptEvents.truncatedTo4096Bytes(text)
        XCTAssertEqual(truncated.utf8.count, 4_096)
        XCTAssertEqual(truncated, String(repeating: "a", count: 4_096))
    }

    /// The load-bearing case: a 3-byte UTF-8 character ("中", U+4E2D)
    /// straddling the 4096-byte cut must be dropped WHOLE, never split
    /// into an invalid trailing fragment. Bytes 0..<4095 are plain ASCII
    /// 'a' (4095 bytes); "中" occupies bytes 4095/4096/4097; a trailing
    /// "b" follows at byte 4098 — so a naive byte-4096 cut would land
    /// exactly on "中"'s SECOND byte (a continuation byte).
    func testMultibyteCharacterStraddlingThe4096ByteBoundaryIsDroppedWholeNotSplit() {
        let text = String(repeating: "a", count: 4_095) + "中" + "b"
        XCTAssertEqual(text.utf8.count, 4_099, "sanity: 4095 + 3 (中) + 1 (b)")

        let truncated = TranscriptEvents.truncatedTo4096Bytes(text)
        XCTAssertEqual(truncated, String(repeating: "a", count: 4_095), "both '中' and the trailing 'b' must be dropped — the multibyte char cannot be partially kept")
        XCTAssertEqual(truncated.utf8.count, 4_095)
        // Every remaining byte must be valid, re-decodable UTF-8 (no
        // U+FFFD replacement characters from a split sequence).
        XCTAssertFalse(truncated.unicodeScalars.contains(Unicode.Scalar(0xFFFD)!))
    }

    /// A multibyte character that fits ENTIRELY within the first 4096
    /// bytes (ending exactly ON the boundary) must be kept whole.
    func testMultibyteCharacterEndingExactlyOnThe4096ByteBoundaryIsKept() {
        let text = String(repeating: "a", count: 4_093) + "中" // 4093 + 3 = 4096 exactly
        XCTAssertEqual(text.utf8.count, 4_096)
        let truncated = TranscriptEvents.truncatedTo4096Bytes(text)
        XCTAssertEqual(truncated, text, "already at exactly the limit — nothing to truncate")
    }

    func testTranscriptBytesAppliesTruncationToTheTextField() {
        let longText = String(repeating: "a", count: 5_000)
        let data = TranscriptEvents.transcriptBytes(final: true, seq: 1, startMs: 0, endMs: 1_000, text: longText)
        let expectedText = String(repeating: "a", count: 4_096)
        XCTAssertEqual(string(data), #"{"endMs":1000,"final":true,"seq":1,"startMs":0,"text":""# + expectedText + #"","type":"transcript"}"# + "\n")
    }
}
