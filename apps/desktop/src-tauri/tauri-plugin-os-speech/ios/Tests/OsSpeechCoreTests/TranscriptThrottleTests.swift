import XCTest

@testable import OsSpeechCore

final class TranscriptThrottleTests: XCTestCase {
  func testFinalAlwaysEmitsEvenWithAnUnchangedRange() {
    var throttle = TranscriptThrottle()
    XCTAssertTrue(throttle.shouldEmit(final: true, startMs: 0, endMs: 100))
    XCTAssertTrue(throttle.shouldEmit(final: true, startMs: 0, endMs: 100))
  }

  func testVolatileSuppressedWithinIntervalOnAnUnchangedRange() {
    let now = Date(timeIntervalSince1970: 0)
    var throttle = TranscriptThrottle(minInterval: 0.15, clock: { now })
    XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 50)) // first call always emits
    XCTAssertFalse(throttle.shouldEmit(final: false, startMs: 0, endMs: 50)) // same range, no time elapsed
  }

  func testVolatileEmitsWhenRangeAdvancesEvenBeforeIntervalElapses() {
    let now = Date(timeIntervalSince1970: 0)
    var throttle = TranscriptThrottle(minInterval: 0.15, clock: { now })
    XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 50))
    XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 60)) // endMs advanced
  }

  func testVolatileEmitsAfterIntervalElapsesOnAnUnchangedRange() {
    var now = Date(timeIntervalSince1970: 0)
    var throttle = TranscriptThrottle(minInterval: 0.15, clock: { now })
    XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 50))
    now = now.addingTimeInterval(0.2)
    XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 50))
  }
}
