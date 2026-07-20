import Foundation

// S13 (Lane B) — ported verbatim (pattern source: apps/desktop/
// src-tauri/audiocap-helper/Sources/AudioCapCore/TranscriptThrottle.swift,
// S11 §Q2/§1) from the macOS helper: pure throttle deciding whether a
// given transcript result is actually worth an event emission. Same
// rule: a volatile (interim) result is emitted at most every 150ms OR
// whenever the result's time range advances (start or end moved) —
// whichever comes first; a FINAL always bypasses the throttle entirely.
//
// Works over plain (startMs, endMs) integers rather than CoreMedia's
// CMTimeRange — zero framework dependency beyond Foundation, directly
// testable (see ios/Tests/TranscriptThrottleTests.swift). The
// CMTime -> ms conversion is OsSpeechSession's own job (same
// `milliseconds(fromSeconds:)` helper macOS's TranscriptEvents owns),
// not this file's.
public struct TranscriptThrottle {
  private let minInterval: TimeInterval
  private let clock: () -> Date

  private var lastEmitTime: Date?
  private var lastEmittedStartMs: UInt64?
  private var lastEmittedEndMs: UInt64?

  /// `minInterval` defaults to the spec'd 150ms; `clock` is injectable
  /// (default `Date.init`) purely so tests can drive elapsed time
  /// deterministically without a real sleep.
  public init(minInterval: TimeInterval = 0.15, clock: @escaping () -> Date = Date.init) {
    self.minInterval = minInterval
    self.clock = clock
  }

  /// Returns `true` iff this result should actually be emitted. Has side
  /// effects (records the emission) exactly when it returns `true` —
  /// callers just do `if throttle.shouldEmit(...) { emit(...) }` with no
  /// separate "now record that I emitted" step to forget.
  public mutating func shouldEmit(final: Bool, startMs: UInt64, endMs: UInt64) -> Bool {
    let now = clock()
    guard !final else {
      lastEmitTime = now
      record(startMs: startMs, endMs: endMs)
      return true
    }

    let rangeAdvanced = startMs != lastEmittedStartMs || endMs != lastEmittedEndMs
    let intervalElapsed = lastEmitTime.map { now.timeIntervalSince($0) >= minInterval } ?? true
    guard rangeAdvanced || intervalElapsed else { return false }

    lastEmitTime = now
    record(startMs: startMs, endMs: endMs)
    return true
  }

  private mutating func record(startMs: UInt64, endMs: UInt64) {
    lastEmittedStartMs = startMs
    lastEmittedEndMs = endMs
  }
}
