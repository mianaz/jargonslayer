import XCTest
@testable import AudioCapCore

// Dual-capture mic producer — golden-byte coverage for
// `StatusEvents.statsBytes`, the pure encoder split out specifically so
// the new `channel` field's emission shape is testable at all (that
// function's own doc comment): the SAME "no injectable output, so test
// a pure `*Bytes` half instead" posture TranscriptEventsTests.swift
// already established one file over. StatusEvents' OTHER record types
// (StatusRecord/ErrorRecord/NoteRecord) have no equivalent pure encoder
// and no tests of their own today — this file is deliberately scoped to
// just the one new field.
final class StatusEventsTests: XCTestCase {
    private func string(_ data: Data) -> String {
        String(decoding: data, as: UTF8.self)
    }

    func testStatsBytesOmitsChannelWhenNil() {
        let data = StatusEvents.statsBytes(overflows: 0, ringHighWater: 0, framesOut: 0, droppedFrames: 0, peak: 0, windowPeak: 0)
        XCTAssertFalse(string(data).contains("channel"), "a nil channel must be omitted entirely, not written as null — single-source/capture-mode stats must stay byte-identical to today's protocol")
    }

    func testStatsBytesIncludesChannelWhenNonNil() {
        let data = StatusEvents.statsBytes(overflows: 1, ringHighWater: 2, framesOut: 3, droppedFrames: 4, peak: 0.5, windowPeak: 0.25, channel: "mic")
        XCTAssertEqual(
            string(data),
            #"{"channel":"mic","droppedFrames":4,"framesOut":3,"overflows":1,"peak":0.5,"ringHighWater":2,"type":"stats","windowPeak":0.25}"# + "\n"
        )
    }

    func testStatsBytesRoundsPeakAndWindowPeakToThreeDecimals() {
        let data = StatusEvents.statsBytes(overflows: 0, ringHighWater: 0, framesOut: 0, droppedFrames: 0, peak: 0.123_456, windowPeak: 0.987_654, channel: "system")
        XCTAssertEqual(
            string(data),
            #"{"channel":"system","droppedFrames":0,"framesOut":0,"overflows":0,"peak":0.123,"ringHighWater":0,"type":"stats","windowPeak":0.988}"# + "\n"
        )
    }

    // ---- windowLoudMs (Fix C, pre-tag fix round) ----

    func testStatsBytesOmitsWindowLoudMsWhenNil() {
        let data = StatusEvents.statsBytes(overflows: 0, ringHighWater: 0, framesOut: 0, droppedFrames: 0, peak: 0, windowPeak: 0)
        XCTAssertFalse(string(data).contains("windowLoudMs"), "a nil windowLoudMs must be omitted entirely — Writer's own capture-mode stats never pass one, and must stay byte-identical to before this field existed")
    }

    func testStatsBytesIncludesWindowLoudMsWhenNonNil() {
        let data = StatusEvents.statsBytes(overflows: 1, ringHighWater: 2, framesOut: 3, droppedFrames: 4, peak: 0.5, windowPeak: 0.25, channel: "mic", windowLoudMs: 1200)
        XCTAssertEqual(
            string(data),
            #"{"channel":"mic","droppedFrames":4,"framesOut":3,"overflows":1,"peak":0.5,"ringHighWater":2,"type":"stats","windowLoudMs":1200,"windowPeak":0.25}"# + "\n",
            "sortedKeys places windowLoudMs alphabetically between type and windowPeak"
        )
    }
}
