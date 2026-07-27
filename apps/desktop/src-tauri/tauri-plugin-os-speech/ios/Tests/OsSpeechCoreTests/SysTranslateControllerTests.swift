import Translation
import XCTest

@testable import OsSpeechCore

// Pure-logic only, per this lane's own instructions — nothing here ever
// calls `LanguageAvailability().status(from:to:)`/`TranslationSession
// .translations(from:)`/`session.prepareTranslation()` (the real
// Translation-framework round trips); `SysTranslateControllerStatusTests`
// below constructs plain `LanguageAvailability.Status` ENUM LITERALS
// (`.installed` etc.) to exercise the wire-mapping switch, which is a
// zero-cost, synchronous, no-I/O operation, not a call into the
// framework's actual translation service.

/// `SysTranslateController.statusWireValue` — byte-identical mapping to
/// main.swift's own `translateStatusWireValue` (main.swift:536-544).
/// Gated the same as the function under test: `LanguageAvailability
/// .Status` is a Translation-framework type, so this test class needs
/// the same `@available` this host (macOS 26.5, confirmed via
/// `sw_vers`/`xcrun --show-sdk-version` at implementation time) already
/// satisfies at runtime.
@available(iOS 26.0, macOS 26.0, *)
final class SysTranslateControllerStatusTests: XCTestCase {
  func testInstalledMapsToInstalled() {
    XCTAssertEqual(SysTranslateController.statusWireValue(.installed), "installed")
  }

  func testSupportedMapsToSupported() {
    XCTAssertEqual(SysTranslateController.statusWireValue(.supported), "supported")
  }

  func testUnsupportedMapsToUnsupported() {
    XCTAssertEqual(SysTranslateController.statusWireValue(.unsupported), "unsupported")
  }
  // No test for `@unknown default`: there is no way to construct a case
  // this port hasn't seen yet — same untestable-by-construction posture
  // main.swift's own pattern-source function has.
}

/// `SysTranslateRecorrelation.recorrelate` — ungated pure logic, no
/// Translation import needed for the type under test itself (only this
/// file imports Translation, for the sibling status-mapping tests
/// above).
final class SysTranslateRecorrelationTests: XCTestCase {
  func testRecorrelatesByIdPreservingOriginalItemOrder() {
    let items: [(id: String, text: String)] = [(id: "a", text: "hello"), (id: "b", text: "world")]
    // Framework's own return order deliberately reversed relative to
    // `items` — the wire contract requires order preserved against the
    // ORIGINAL items, not the framework's own batch-return order.
    let responses: [(id: String?, text: String)] = [(id: "b", text: "世界"), (id: "a", text: "你好")]
    let result = SysTranslateRecorrelation.recorrelate(items: items, responses: responses)
    XCTAssertEqual(result.map(\.id), ["a", "b"])
    XCTAssertEqual(result.map(\.text), ["你好", "世界"])
  }

  func testFallsBackToOriginalSourceTextForAMissingId() {
    let items: [(id: String, text: String)] = [(id: "a", text: "hello"), (id: "b", text: "world")]
    let responses: [(id: String?, text: String)] = [(id: "a", text: "你好")] // no response for "b"
    let result = SysTranslateRecorrelation.recorrelate(items: items, responses: responses)
    XCTAssertEqual(result.map(\.text), ["你好", "world"])
  }

  func testFirstResponseWinsOnADuplicateId() {
    let items: [(id: String, text: String)] = [(id: "a", text: "hello")]
    let responses: [(id: String?, text: String)] = [(id: "a", text: "FIRST"), (id: "a", text: "SECOND")]
    let result = SysTranslateRecorrelation.recorrelate(items: items, responses: responses)
    XCTAssertEqual(result.map(\.text), ["FIRST"])
  }

  func testNilResponseClientIdentifierIsIgnored() {
    let items: [(id: String, text: String)] = [(id: "a", text: "hello")]
    let responses: [(id: String?, text: String)] = [(id: nil, text: "orphan")]
    let result = SysTranslateRecorrelation.recorrelate(items: items, responses: responses)
    XCTAssertEqual(result.map(\.text), ["hello"]) // falls back — nothing correlates to "a"
  }
}

/// `SysTranslateGenerationGuard.shouldClear` — ungated pure logic backing
/// `stop(generation:)`'s own contract: a stale stop must never clear a
/// session a later `prepare(...)` call already replaced.
final class SysTranslateGenerationGuardTests: XCTestCase {
  func testNilRequestedGenerationAlwaysClears() {
    XCTAssertTrue(SysTranslateGenerationGuard.shouldClear(requestedGeneration: nil, currentGeneration: 5))
    XCTAssertTrue(SysTranslateGenerationGuard.shouldClear(requestedGeneration: nil, currentGeneration: 0))
  }

  func testMatchingGenerationClears() {
    XCTAssertTrue(SysTranslateGenerationGuard.shouldClear(requestedGeneration: 5, currentGeneration: 5))
  }

  func testStaleGenerationDoesNotClear() {
    XCTAssertFalse(SysTranslateGenerationGuard.shouldClear(requestedGeneration: 3, currentGeneration: 5))
  }
}

/// `SysTranslateError.description` — the two substrings JS/other lanes
/// string-match on must survive verbatim.
final class SysTranslateErrorTests: XCTestCase {
  func testNotInstalledDescriptionContainsPinnedSubstring() {
    XCTAssertTrue("\(SysTranslateError.notInstalled)".contains("not-installed"))
  }

  func testTimeoutDescriptionContainsPinnedSubstring() {
    XCTAssertTrue("\(SysTranslateError.timeout)".contains("timeout"))
  }

  func testFailedDescriptionFoldsInTheOriginalMessage() {
    XCTAssertTrue("\(SysTranslateError.failed("boom"))".contains("boom"))
  }
}
