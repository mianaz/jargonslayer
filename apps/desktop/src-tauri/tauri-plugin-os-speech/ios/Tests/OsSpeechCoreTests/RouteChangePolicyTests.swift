import XCTest

@testable import OsSpeechCore

/// Field bug (iOS TestFlight, v0.6.0) — see RouteChangePolicy.swift's own
/// doc comment. Terminal for exactly the 2 raw reasons that mean capture
/// actually broke; every other reason (and nil) is ignored.
final class RouteChangePolicyTests: XCTestCase {
  func testOldDeviceUnavailableStops() {
    XCTAssertEqual(RouteChangePolicy.routeChangeAction(reasonRaw: 2), .stop(reasonLabel: "oldDeviceUnavailable"))
  }

  func testNoSuitableRouteForCategoryStops() {
    XCTAssertEqual(RouteChangePolicy.routeChangeAction(reasonRaw: 7), .stop(reasonLabel: "noSuitableRouteForCategory"))
  }

  func testBenignReasonsAreIgnored() {
    // unknown, newDeviceAvailable, categoryChange, override, wakeFromSleep, routeConfigurationChange
    for reasonRaw: UInt in [0, 1, 3, 4, 6, 8] {
      XCTAssertEqual(RouteChangePolicy.routeChangeAction(reasonRaw: reasonRaw), .ignore)
    }
  }

  func testUnparseableReasonIsIgnored() {
    XCTAssertEqual(RouteChangePolicy.routeChangeAction(reasonRaw: 999), .ignore)
  }

  func testNilReasonIsIgnored() {
    XCTAssertEqual(RouteChangePolicy.routeChangeAction(reasonRaw: nil), .ignore)
  }
}
