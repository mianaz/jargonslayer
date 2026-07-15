import XCTest
@testable import AudioCapCore

// S11 (§Q2) — TranscriptThrottle is pure (no CoreAudio, no Speech, no
// real I/O): every test drives it with a manually-advanced `var now`
// closure (same injected-clock style as TranscribeConsumerTests), never
// a real sleep.
final class TranscriptThrottleTests: XCTestCase {
    func testFirstVolatileAlwaysEmitsRegardlessOfState() {
        var throttle = TranscriptThrottle(minInterval: 0.15, clock: { Date(timeIntervalSince1970: 0) })
        XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 100))
    }

    func testSecondIdenticalVolatileWithinTheIntervalIsSuppressed() {
        var now = Date(timeIntervalSince1970: 1_000)
        var throttle = TranscriptThrottle(minInterval: 0.15, clock: { now })
        XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 100))

        now = now.addingTimeInterval(0.05) // well under 150ms
        XCTAssertFalse(throttle.shouldEmit(final: false, startMs: 0, endMs: 100), "same range, under the interval — must be suppressed")
    }

    func testVolatileEmitsOnceTheIntervalElapsesEvenWithNoRangeChange() {
        var now = Date(timeIntervalSince1970: 1_000)
        var throttle = TranscriptThrottle(minInterval: 0.15, clock: { now })
        XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 100))

        now = now.addingTimeInterval(0.2) // past 150ms
        XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 100), "same range, but the 150ms cap alone must be enough to let it through")
    }

    func testVolatileEmitsImmediatelyWhenTheRangeAdvancesEvenBeforeTheIntervalElapses() {
        let now = Date(timeIntervalSince1970: 1_000)
        var throttle = TranscriptThrottle(minInterval: 0.15, clock: { now })
        XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 100))

        // No clock advance at all — only the range changed (endMs grew,
        // e.g. a longer progressive prefix).
        XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 140), "a range advance must bypass the 150ms floor")
    }

    func testStartMsAdvancingAloneAlsoCountsAsARangeAdvance() {
        var throttle = TranscriptThrottle(minInterval: 0.15, clock: { Date(timeIntervalSince1970: 1_000) })
        XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 100))
        XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 20, endMs: 100), "a changed START (new range beginning) must also count as an advance")
    }

    func testRepeatedIdenticalVolatilesWithNoTimeAdvanceAreAllSuppressedAfterTheFirst() {
        var throttle = TranscriptThrottle(minInterval: 0.15, clock: { Date(timeIntervalSince1970: 1_000) })
        XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 100))
        XCTAssertFalse(throttle.shouldEmit(final: false, startMs: 0, endMs: 100))
        XCTAssertFalse(throttle.shouldEmit(final: false, startMs: 0, endMs: 100))
        XCTAssertFalse(throttle.shouldEmit(final: false, startMs: 0, endMs: 100))
    }

    // ---- finals always bypass ----

    func testFinalAlwaysEmitsEvenWithNoRangeChangeAndNoTimeElapsed() {
        var throttle = TranscriptThrottle(minInterval: 0.15, clock: { Date(timeIntervalSince1970: 1_000) })
        XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 100))
        XCTAssertTrue(throttle.shouldEmit(final: true, startMs: 0, endMs: 100), "a final must never be throttled, even for the exact same range the just-emitted volatile had")
    }

    func testConsecutiveFinalsEachAlwaysEmit() {
        var throttle = TranscriptThrottle(minInterval: 0.15, clock: { Date(timeIntervalSince1970: 1_000) })
        XCTAssertTrue(throttle.shouldEmit(final: true, startMs: 0, endMs: 100))
        XCTAssertTrue(throttle.shouldEmit(final: true, startMs: 100, endMs: 200))
        XCTAssertTrue(throttle.shouldEmit(final: true, startMs: 100, endMs: 200), "even a (contrived) repeat final must still pass — finals bypass the throttle unconditionally")
    }

    func testAFinalUpdatesThrottleStateSoTheNextVolatileForItsOwnRangeIsThrottledNormally() {
        var now = Date(timeIntervalSince1970: 1_000)
        var throttle = TranscriptThrottle(minInterval: 0.15, clock: { now })
        XCTAssertTrue(throttle.shouldEmit(final: true, startMs: 0, endMs: 100))

        // A stray subsequent volatile for the SAME already-finalized range,
        // arriving immediately after — must be throttled exactly like any
        // other no-op repeat (the final counted as "the last emission").
        XCTAssertFalse(throttle.shouldEmit(final: false, startMs: 0, endMs: 100))

        now = now.addingTimeInterval(0.2)
        XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 0, endMs: 100), "past the interval since the final, even a same-range volatile is allowed through again")
    }

    func testANewRangeAfterAFinalEmitsImmediately() {
        var throttle = TranscriptThrottle(minInterval: 0.15, clock: { Date(timeIntervalSince1970: 1_000) })
        XCTAssertTrue(throttle.shouldEmit(final: true, startMs: 0, endMs: 100))
        XCTAssertTrue(throttle.shouldEmit(final: false, startMs: 100, endMs: 120), "the first volatile of a NEW range (new utterance) must not wait out the 150ms floor")
    }
}
