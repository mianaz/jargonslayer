import XCTest
@testable import AudioCapCore

// S11 (§2.3/§A1) — StdinCommandMonitor's line parsing/pause-state
// machine, exercised entirely SYNCHRONOUSLY: `classify(_:)` is a pure
// static function, and `feed(_:)`/`readOnce()` are driven directly
// against in-memory `Data`/a real `Pipe()` with data already written
// (or already closed) — a read against a Pipe that already has bytes
// buffered (or is already EOF) returns immediately, so nothing here
// spins the real background thread `start()` would, and nothing waits
// on wall time (same posture as WriterTests' own Pipe()-based tests).
final class StdinCommandMonitorTests: XCTestCase {
    // ---- classify(_:) — pure line parsing ----

    func testClassifyRecognizesPause() {
        XCTAssertEqual(StdinCommandMonitor.classify("pause"), .pause)
    }

    func testClassifyRecognizesResume() {
        XCTAssertEqual(StdinCommandMonitor.classify("resume"), .resume)
    }

    func testClassifyTreatsUnrecognizedLinesAsUnknown() {
        XCTAssertEqual(StdinCommandMonitor.classify("foo"), .unknown("foo"))
        XCTAssertEqual(StdinCommandMonitor.classify(""), .unknown(""))
    }

    func testClassifyIsCaseSensitiveAndHasNoWhitespaceTolerance() {
        // §2.3 specifies the exact bytes `pause\n`/`resume\n` — no
        // fuzzy matching.
        XCTAssertEqual(StdinCommandMonitor.classify("Pause"), .unknown("Pause"))
        XCTAssertEqual(StdinCommandMonitor.classify("PAUSE"), .unknown("PAUSE"))
        XCTAssertEqual(StdinCommandMonitor.classify(" pause"), .unknown(" pause"))
        XCTAssertEqual(StdinCommandMonitor.classify("pause "), .unknown("pause "))
    }

    // ---- feed(_:) — buffering/dispatch across chunk boundaries ----

    func testFeedASingleCompleteLineTogglesPauseState() {
        var eofCount = 0
        let monitor = StdinCommandMonitor(onEOF: { eofCount += 1 })
        XCTAssertFalse(monitor.isPaused())

        monitor.feed(Data("pause\n".utf8))
        XCTAssertTrue(monitor.isPaused())

        monitor.feed(Data("resume\n".utf8))
        XCTAssertFalse(monitor.isPaused())
        XCTAssertEqual(eofCount, 0, "feed(_:) must never itself invoke onEOF")
    }

    func testFeedBuffersAPartialLineAcrossMultipleChunksBeforeApplyingIt() {
        let monitor = StdinCommandMonitor(onEOF: {})
        monitor.feed(Data("pau".utf8))
        XCTAssertFalse(monitor.isPaused(), "no complete line yet — nothing should be applied")

        monitor.feed(Data("se\n".utf8))
        XCTAssertTrue(monitor.isPaused(), "the line completes only once the newline arrives")
    }

    func testFeedDispatchesMultipleLinesDeliveredInOneChunk() {
        let monitor = StdinCommandMonitor(onEOF: {})
        monitor.feed(Data("pause\nresume\n".utf8))
        XCTAssertFalse(monitor.isPaused(), "both lines in the SAME chunk must be applied in order — resume last wins")
    }

    func testFeedIgnoresUnknownLinesLeavingPauseStateUntouched() {
        let monitor = StdinCommandMonitor(onEOF: {})
        monitor.feed(Data("pause\n".utf8))
        XCTAssertTrue(monitor.isPaused())

        monitor.feed(Data("banana\n".utf8))
        XCTAssertTrue(monitor.isPaused(), "an unrecognized line must be silently ignored, not clear the pause state")
    }

    func testFeedLeavesATrailingPartialLineBufferedForTheNextCall() {
        let monitor = StdinCommandMonitor(onEOF: {})
        monitor.feed(Data("resume\npau".utf8)) // one complete line + one partial
        XCTAssertFalse(monitor.isPaused())

        monitor.feed(Data("se\n".utf8)) // completes the partial line
        XCTAssertTrue(monitor.isPaused())
    }

    // ---- readOnce() — the real production entry point, driven against
    // a Pipe() synchronously (data already written/closed, so no real
    // blocking read ever happens here). ----

    func testReadOnceAppliesACommandAlreadyWrittenToThePipe() {
        let pipe = Pipe()
        pipe.fileHandleForWriting.write(Data("pause\n".utf8))
        let monitor = StdinCommandMonitor(input: pipe.fileHandleForReading, onEOF: {})

        XCTAssertTrue(monitor.readOnce())
        XCTAssertTrue(monitor.isPaused())
    }

    func testReadOnceReturnsFalseAndInvokesOnEOFWhenThePipeIsClosed() {
        let pipe = Pipe()
        pipe.fileHandleForWriting.closeFile() // EOF, no data ever written

        var eofCount = 0
        let monitor = StdinCommandMonitor(input: pipe.fileHandleForReading, onEOF: { eofCount += 1 })

        XCTAssertFalse(monitor.readOnce())
        XCTAssertEqual(eofCount, 1)
    }

    func testReadOnceDoesNotInvokeOnEOFWhenDataIsAvailable() {
        let pipe = Pipe()
        pipe.fileHandleForWriting.write(Data("resume\n".utf8))

        var eofCount = 0
        let monitor = StdinCommandMonitor(input: pipe.fileHandleForReading, onEOF: { eofCount += 1 })

        XCTAssertTrue(monitor.readOnce())
        XCTAssertEqual(eofCount, 0)
    }
}
