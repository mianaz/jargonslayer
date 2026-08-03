import XCTest
@testable import AudioCapCore

// Dual-capture mic producer — TranscribeSource.swift's own header
// comment: `init?(rawValue:)` (compiler-synthesized) IS the small pure
// parse function this slice's own test list asks for; this file proves
// it behaves the way main.swift's `parseArguments` needs it to
// (unknown/absent values are main.swift's own concern — see that
// function's own comment at its `--source` validation site — this file
// only covers the type's own closed-set parsing).
final class TranscribeSourceTests: XCTestCase {
    func testEachKnownValueParsesToItsOwnCase() {
        XCTAssertEqual(TranscribeSource(rawValue: "system"), .system)
        XCTAssertEqual(TranscribeSource(rawValue: "mic"), .mic)
        XCTAssertEqual(TranscribeSource(rawValue: "dual"), .dual)
    }

    func testUnknownOrEmptyValuesAreNil() {
        XCTAssertNil(TranscribeSource(rawValue: "bogus"))
        XCTAssertNil(TranscribeSource(rawValue: ""))
    }

    func testParsingIsCaseSensitive() {
        XCTAssertNil(TranscribeSource(rawValue: "System"), "must not accept a differently-cased value")
        XCTAssertNil(TranscribeSource(rawValue: "MIC"))
    }
}
