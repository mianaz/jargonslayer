import XCTest

@testable import OsSpeechCore

// S13 (Lane B) — asserts the pinned wire payload shapes (§2/§6 F1) at
// the JSON level, not just via a round-trip decode (a round-trip through
// the SAME Swift type can't distinguish "key omitted" from "key present
// with an explicit null" — `JSONSerialization` can, since a JSON `null`
// deserializes to `NSNull`, never simply "absent").
final class OsSpeechWireTests: XCTestCase {
  private func jsonObject(_ data: Data) throws -> [String: Any] {
    try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func testTranscriptPayloadKeys() throws {
    let payload = OsSpeechTranscriptPayload(final: true, seq: 3, startMs: 100, endMs: 200, text: "hello")
    let object = try jsonObject(try JSONEncoder().encode(payload))
    XCTAssertEqual(Set(object.keys), ["final", "seq", "startMs", "endMs", "text"])
    XCTAssertEqual(object["final"] as? Bool, true)
    XCTAssertEqual(object["seq"] as? UInt64, 3)
    XCTAssertEqual(object["text"] as? String, "hello")
  }

  func testStatusPayloadOmitsNilOptionalKeysEntirely() throws {
    let payload = OsSpeechStatusPayload(kind: .starting, source: .session)
    let object = try jsonObject(try JSONEncoder().encode(payload))
    // §2's TS type has these as optional KEYS (`message?: string`), not
    // required-nullable ones — a nil value must OMIT the key, not
    // null it (contrast OsSpeechCapabilitiesPayload.reason below).
    XCTAssertEqual(Set(object.keys), ["kind", "source"])
    XCTAssertEqual(object["kind"] as? String, "starting")
    XCTAssertEqual(object["source"] as? String, "session")
  }

  func testStatusPayloadIncludesPresentOptionals() throws {
    let payload = OsSpeechStatusPayload(
      kind: .unsupportedLocale, source: .session, message: "zh-Yue", supportedLocales: ["en-US", "zh-Hans"])
    let object = try jsonObject(try JSONEncoder().encode(payload))
    XCTAssertEqual(object["message"] as? String, "zh-Yue")
    XCTAssertEqual(object["supportedLocales"] as? [String], ["en-US", "zh-Hans"])
    XCTAssertNil(object["progress"])
    XCTAssertNil(object["resolvedLocale"])
  }

  /// The CLOSED 13-kind set (§2.5) — field-exact wire strings, matching
  /// osspeech.rs's own `OsSpeechStatusKind::as_str` and the TS
  /// `OsSpeechStatusKind` union verbatim.
  func testStatusKindRawValuesMatchClosedSet() {
    let expected: [OsSpeechStatusKind: String] = [
      .starting: "starting",
      .capturing: "capturing",
      .assetChecking: "asset-checking",
      .assetDownloading: "asset-downloading",
      .assetInstalled: "asset-installed",
      .assetFailed: "asset-failed",
      .localeResolved: "locale-resolved",
      .permissionDenied: "permission-denied",
      .unsupported: "unsupported",
      .unsupportedLocale: "unsupported-locale",
      .deviceChanged: "device-changed",
      .crashed: "crashed",
      .ended: "ended",
    ]
    XCTAssertEqual(expected.count, 13)
    for (kind, raw) in expected {
      XCTAssertEqual(kind.rawValue, raw)
    }
  }

  /// §6 F1 — the ONE field on this wire that's required-nullable rather
  /// than optional-omittable: `reason` must serialize as an explicit
  /// `null`, never an omitted key, when there's no reason to report.
  func testCapabilitiesPayloadReasonIsExplicitNullNotOmitted() throws {
    let payload = OsSpeechCapabilitiesPayload(supported: true, reason: nil, locales: ["en-US"], installedLocales: [])
    let object = try jsonObject(try JSONEncoder().encode(payload))
    XCTAssertTrue(object.keys.contains("reason"), "reason key must be present even when nil")
    XCTAssertTrue(object["reason"] is NSNull, "reason must encode as JSON null, not be omitted")
  }

  func testCapabilitiesPayloadReasonPresent() throws {
    let payload = OsSpeechCapabilitiesPayload(supported: false, reason: OsSpeechFloor.unsupportedReason, locales: [], installedLocales: [])
    let object = try jsonObject(try JSONEncoder().encode(payload))
    XCTAssertEqual(object["reason"] as? String, "需要 iOS 26 或更高版本")
  }
}
