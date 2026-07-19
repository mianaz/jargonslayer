import XCTest

@testable import OsSpeechCore

/// F-S3 — the 4 combinations `ConverterSink.receive`'s own yield-site
/// recheck can observe (see PauseGenerationFence.swift's own doc
/// comment for the pause-buffer-boundary race this closes).
final class PauseGenerationFenceTests: XCTestCase {
  func testNormalKeepsBuffer() {
    // Not paused at yield, generation unchanged since the snapshot.
    XCTAssertFalse(PauseGenerationFence.shouldDrop(pausedAtYield: false, snapshotGeneration: 1, currentGeneration: 1))
  }

  func testPausedAtYieldDropsBuffer() {
    // Paused right now, even though the generation hasn't moved.
    XCTAssertTrue(PauseGenerationFence.shouldDrop(pausedAtYield: true, snapshotGeneration: 1, currentGeneration: 1))
  }

  func testGenerationChangedDropsBufferEvenIfNotPausedAtYield() {
    // Not paused NOW, but the generation moved — a pause+resume landed
    // entirely within this buffer's own conversion window.
    XCTAssertTrue(PauseGenerationFence.shouldDrop(pausedAtYield: false, snapshotGeneration: 1, currentGeneration: 2))
  }

  func testPausedAndGenerationChangedDropsBuffer() {
    XCTAssertTrue(PauseGenerationFence.shouldDrop(pausedAtYield: true, snapshotGeneration: 1, currentGeneration: 3))
  }
}
