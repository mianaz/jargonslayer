import XCTest
@testable import AudioCapCore

// S11 fix round (FIX S2/FIX S5) — `SpeechAnalyzerSession.swift`'s own
// header comment states plainly that `run`/`consumeResults`/`preinstall`/
// `ensureAssetInstalled` themselves have no dedicated unit tests (they
// touch live Speech.framework/AVFoundation objects with no fake seam) —
// that posture is UNCHANGED by this fix round. `ResultsErrorBox` and
// `DownloadOutcomeBox`, though, are small, framework-independent
// locked-box state machines (record-once/read-many, exactly like
// `StopReasonBox`/`FatalErrorBox` one file over) introduced specifically
// so `run`'s own outcome selection (FIX S2) and `ensureAssetInstalled`'s
// own poll loop (FIX S5) can each make a decision that would otherwise
// need information no longer available by the time it's needed — see
// each type's own doc comment for its full rationale. This file tests
// ONLY those boxes' own pure semantics; it is gated `@available(macOS
// 26.0, *)` purely because both types are (this file's own header
// comment applies), not because anything here touches Speech.framework.
@available(macOS 26.0, *)
final class SpeechAnalyzerSessionTests: XCTestCase {
    func testNoRecordedErrorReportsNilDuringDeliberateStop() {
        let box = ResultsErrorBox()
        XCTAssertNil(box.duringDeliberateStop, "a box nothing has ever been recorded into must report nil, not a default false/true")
    }

    func testRecordingWithNoDeliberateStopInFlightIsPreserved() {
        let box = ResultsErrorBox()
        box.record(duringDeliberateStop: false)
        XCTAssertEqual(box.duringDeliberateStop, false, "the results loop's own error is what caused shutdown — run()'s outcome selection must see `false` here to return .failure")
    }

    func testRecordingDuringAnAlreadyInFlightDeliberateStopIsPreserved() {
        let box = ResultsErrorBox()
        box.record(duringDeliberateStop: true)
        XCTAssertEqual(box.duringDeliberateStop, true, "a stop already in flight when the results loop errored — run()'s outcome selection must see `true` here to still allow the clean/success path")
    }

    /// The results loop's own `for try await` can only throw once before
    /// `consumeResults` exits, so `record` is only ever called once in
    /// real usage — this test defends the box's OWN stated "first record
    /// wins" contract (mirroring `FatalErrorBox`'s identical rationale)
    /// regardless, the same defensive posture as that sibling box.
    func testFirstRecordWinsIgnoringAnySubsequentCalls() {
        let box = ResultsErrorBox()
        box.record(duringDeliberateStop: false)
        box.record(duringDeliberateStop: true)
        XCTAssertEqual(box.duringDeliberateStop, false, "the FIRST recorded value must win, not be overwritten by a later call")

        let reverseOrderBox = ResultsErrorBox()
        reverseOrderBox.record(duringDeliberateStop: true)
        reverseOrderBox.record(duringDeliberateStop: false)
        XCTAssertEqual(reverseOrderBox.duringDeliberateStop, true, "first-wins must hold regardless of which value came first")
    }

    // ---- DownloadOutcomeBox (FIX S5) ----

    private struct FakeDownloadError: Error, Equatable {
        let detail: String
    }

    func testDownloadOutcomeBoxInitiallyReportsNoOutcome() {
        let box = DownloadOutcomeBox()
        XCTAssertNil(box.value, "the poll loop in `ensureAssetInstalled` relies on `nil` meaning \"still in flight, keep polling\"")
    }

    func testDownloadOutcomeBoxRecordsSuccess() {
        let box = DownloadOutcomeBox()
        box.record(.success(()))
        guard case .success = box.value else {
            return XCTFail("expected .success, got \(String(describing: box.value))")
        }
    }

    func testDownloadOutcomeBoxRecordsFailure() {
        let box = DownloadOutcomeBox()
        box.record(.failure(FakeDownloadError(detail: "network unreachable")))
        guard case .failure(let error) = box.value else {
            return XCTFail("expected .failure, got \(String(describing: box.value))")
        }
        XCTAssertEqual(error as? FakeDownloadError, FakeDownloadError(detail: "network unreachable"))
    }

    /// The child download Task in `ensureAssetInstalled` only ever calls
    /// `record` once (it either succeeds or catches exactly one error
    /// before returning) — this test defends the box's OWN stated
    /// "first record wins" contract regardless, the same defensive
    /// posture `ResultsErrorBox`/`FatalErrorBox` also carry.
    func testDownloadOutcomeBoxFirstRecordWinsIgnoringAnySubsequentCalls() {
        let box = DownloadOutcomeBox()
        box.record(.success(()))
        box.record(.failure(FakeDownloadError(detail: "should never be seen")))
        guard case .success = box.value else {
            return XCTFail("the FIRST recorded value (.success) must win, not be overwritten by a later .failure")
        }
    }
}
