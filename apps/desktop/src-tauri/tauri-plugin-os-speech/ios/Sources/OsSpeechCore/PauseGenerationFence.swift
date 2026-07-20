// S13 fix round (F-S3, HIGH) — the tap callback's own pause-boundary
// drop/keep decision, extracted pure so it's host-testable without an
// AVAudioEngine (mirrors TranscriptThrottle.swift's own "pure decision,
// zero framework dependency" posture).
//
// Problem this closes: `OsSpeechSession`'s AVAudioEngine tap previously
// checked its `paused` flag ONCE, before conversion — an in-flight tap
// callback could still yield audio admitted just after `setPaused(true)`
// landed, and a pause+resume that both happen to fall WITHIN one
// 4096-frame buffer's own processing window was admitted entirely (the
// single pre-conversion check can't see a pause that came and went
// before it re-checked, because it never re-checks).
//
// Fix: a monotonic generation counter (`PauseGenerationBox`,
// OsSpeechSession.swift) bumped on EVERY `setPaused` call, paused OR
// resumed alike. The tap callback snapshots (paused, generation)
// together at buffer receipt, then re-snapshots immediately before the
// actual yield — `shouldDrop` below decides from those two reads: drop
// if paused NOW, or if the generation moved at all since the snapshot
// (a pause that landed and was already undone again within this same
// buffer's window still changed the generation, so it's still caught
// even though `pausedAtYield` alone would read `false`).
public enum PauseGenerationFence {
  public static func shouldDrop(pausedAtYield: Bool, snapshotGeneration: UInt64, currentGeneration: UInt64) -> Bool {
    pausedAtYield || currentGeneration != snapshotGeneration
  }
}
