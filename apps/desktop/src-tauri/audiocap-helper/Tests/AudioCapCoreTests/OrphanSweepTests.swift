import XCTest
@testable import AudioCapCore

// S9.2 — pure-logic-only test for the `--sweep-orphans` ownership check
// (isOwnedAggregateUID): no live HAL calls, matching this package's own
// "no live tap run by workers" rule extended to "no live aggregate-
// device enumeration in tests" either — a bare dev checkout/CI has no
// guarantee ANY aggregate device exists to enumerate. OrphanSweep
// .sweep() itself (the actual enumerate+destroy CoreAudio orchestration)
// is therefore untested here, same posture as ProcessTapCapture's own
// live CoreAudio calls.
final class OrphanSweepTests: XCTestCase {
    func testAcceptsAUIDWithExactlyTheOwnedPrefix() {
        XCTAssertTrue(OrphanSweep.isOwnedAggregateUID("com.bioinfospace.jargonslayer.audiocap.\(UUID().uuidString)"))
    }

    func testAcceptsTheBarePrefixItself() {
        XCTAssertTrue(OrphanSweep.isOwnedAggregateUID(OrphanSweep.ownedAggregateUIDPrefix))
    }

    func testRejectsAUIDThatMerelyExtendsThePrefixWithoutTheTrailingDot() {
        // "...audiocap-v2.xyz" contains the STRING "...audiocap" as a
        // prefix but not the exact "...audiocap." this helper's own
        // aggregate devices always carry (main.swift's aggregateUID
        // construction) — a sibling/future bundle ID must never match.
        XCTAssertFalse(OrphanSweep.isOwnedAggregateUID("com.bioinfospace.jargonslayer.audiocap-v2.abc"))
    }

    func testRejectsUnrelatedDeviceUIDs() {
        XCTAssertFalse(OrphanSweep.isOwnedAggregateUID("BuiltInSpeakerDevice"))
        XCTAssertFalse(OrphanSweep.isOwnedAggregateUID("com.apple.airplay.some-device"))
    }

    func testRejectsAUIDThatOnlyContainsThePrefixInTheMiddle() {
        XCTAssertFalse(OrphanSweep.isOwnedAggregateUID("evil.com.bioinfospace.jargonslayer.audiocap.xyz"))
    }

    func testRejectsAnEmptyUID() {
        XCTAssertFalse(OrphanSweep.isOwnedAggregateUID(""))
    }

    func testRejectsACaseVariantOfThePrefix() {
        // hasPrefix is case-sensitive, and this prefix must stay an
        // exact byte match — a case-mismatched UID is not "ours".
        XCTAssertFalse(OrphanSweep.isOwnedAggregateUID("COM.BIOINFOSPACE.JARGONSLAYER.AUDIOCAP.xyz"))
    }
}
