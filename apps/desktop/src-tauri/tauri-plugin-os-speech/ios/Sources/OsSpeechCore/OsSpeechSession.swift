// `os(iOS)`-gated at file scope, not just `@available(iOS 26.0, *)`:
// `AVAudioSession`/`AVAudioApplication`/`UIKit` don't exist in the macOS
// SDK at all (unlike `Speech`/most of `AVFoundation`, which macOS's own
// SpeechAnalyzerSession.swift pattern source ALSO uses) — no amount of
// `@available` annotation makes a missing SYMBOL resolve. Gating the
// whole file lets `swift test` still run on this Mac for the OTHER,
// genuinely cross-platform files (OsSpeechWire/LocaleResolver/
// TranscriptThrottle/OsSpeechError/OsSpeechAssetInstaller) — this file
// itself has no dedicated unit tests (same posture as
// SpeechAnalyzerSession.swift's own header comment: exercised by the
// build + the on-device smoke test instead).
#if os(iOS)
import CoreMedia
import Speech
import UIKit
@preconcurrency import AVFoundation

// S13 (docs/design-explorations/s13-ios-blueprint.md, §D6/§3 Lane B) —
// the in-process port of macOS's SpeechAnalyzerSession.run (pattern
// source: apps/desktop/src-tauri/audiocap-helper/Sources/AudioCapCore/
// SpeechAnalyzerSession.swift). Same phase ordering (mic permission ->
// locale -> asset ensure -> format negotiation -> capture start ->
// analyzer start -> results loop -> teardown), adapted for
// AVAudioEngine:
//
// - No CoreAudio process tap / SPSCByteRing / TranscribeConsumer /
//   dedicated producer Thread: AVAudioEngine's own tap callback already
//   hands us a ready-made `AVAudioPCMBuffer` per chunk and
//   `AsyncStream.Continuation.yield` is documented-safe to call from any
//   thread, so `ConverterSink.receive` converts and yields directly from
//   the tap callback — no lock-free ring needed to bridge a realtime
//   IOProc thread into Swift Concurrency the way macOS's CoreAudio tap
//   required.
// - No SPSC ring means no separate "drain the ring" step on stop either:
//   the tap's very last invoked buffer has already been converted+
//   yielded by the time `engine.stop()`/`removeTap` return, so teardown
//   goes straight from "stop capturing" to `continuation.finish()`.
// - "wait for shutdown" still uses the SAME checked-continuation idiom
//   the macOS original uses to bridge its producer Thread's own exit
//   into an `await` — here it's resumed by `requestStop(kind:message:)`
//   instead of a producer thread noticing its own stop condition.
@available(iOS 26.0, macOS 26.0, *)
public final class OsSpeechSession: @unchecked Sendable {
  public let generation: UInt64
  private let emit: (String, any Encodable) -> Void

  private let engine = AVAudioEngine()
  private var sink: ConverterSink?
  private var continuation: AsyncStream<AnalyzerInput>.Continuation?

  // F-S5 — set at the MOMENT this session actually installs the tap /
  // activates the process-shared `AVAudioSession` (configureAudioSession/
  // the tap-install call site in `run()`); `teardownAudio` undoes ONLY
  // what got flagged. Plain `var`s, no lock: both are only ever touched
  // from within `run()`'s own single Task, same posture as `sink`/
  // `continuation` right above.
  private var didInstallTap = false
  private var didActivateAudioSession = false

  // F-S3 — see `PauseGenerationBox`'s own doc comment (below) and
  // `PauseGenerationFence.shouldDrop` (PauseGenerationFence.swift) for
  // the pause-buffer-boundary race this closes.
  private let pauseFence = PauseGenerationBox(false)

  // ---- "wait for stop" — one lock guards all of: has a terminal
  // outcome been decided, what kind/message it carries (first caller
  // wins — see `requestStop`'s own doc comment for why that alone
  // implements macOS's FIX S2 "a deliberate stop must never surface as
  // a failure" semantics with no separate bookkeeping), and the
  // continuation a waiting `run()` needs resumed. ----
  private let stopLock = NSLock()
  private var stopRequested = false
  private var pendingTerminalKind: OsSpeechStatusKind = .ended
  private var pendingTerminalMessage: String?
  private var stopContinuation: CheckedContinuation<Void, Never>?

  // F-S1(a) — INDEPENDENT of `pendingTerminalKind`'s first-caller-wins
  // value: tracks "was `requestExplicitStop()` EVER called", not "did it
  // win the race to decide `pendingTerminalKind`". `emitStatus` checks
  // this on every call so a terminal kind decided by some OTHER path
  // (e.g. a converter/results-loop error that raced in first, or a
  // guard-else return that never goes through `requestStop` at all) is
  // still coerced to `.ended` for JS's stop-latch once the user has
  // asked to stop — see OsSpeechTerminalCoercion's own doc comment.
  private var explicitStopRequested = false

  private var interruptionObserver: NSObjectProtocol?
  private var routeChangeObserver: NSObjectProtocol?

  public init(generation: UInt64, emit: @escaping (String, any Encodable) -> Void) {
    self.generation = generation
    self.emit = emit
  }

  // ---- public control surface (OsSpeechPlugin.swift's stop/pause/
  // resume methods, via OsSpeechController.currentSession()) — plain
  // synchronous methods, no actor hop needed: all mutable state they
  // touch is NSLock-guarded. Idempotent by construction (`requestStop`'s
  // own first-write-wins guard; `setPaused` is a plain flag write). ----

  public func requestExplicitStop() {
    stopLock.lock()
    explicitStopRequested = true
    stopLock.unlock()
    requestStop(kind: .ended)
  }

  public func setPaused(_ paused: Bool) {
    pauseFence.setPaused(paused)
  }

  /// Runs one full transcribe session to completion. Never throws —
  /// every failure is reported as a "status" event; the only
  /// SYNCHRONOUS failure `startTranscribe` itself can reject with is the
  /// below-iOS-26 pre-check, handled one layer up (OsSpeechPlugin.swift)
  /// before this method is ever constructed.
  public func run(locale bcp47: String, contextualJSON: String?) async {
    emitStatus(.starting)

    do {
      // F-S1(b) — check `isStopRequested()` IMMEDIATELY after the mic-
      // permission await resumes, BEFORE branching on granted/denied: an
      // explicit stop that arrived while the system TCC prompt was still
      // up must abort here regardless of which way the user answered
      // that prompt (emitStatus's own F-S1(a) coercion is a backstop for
      // every OTHER path, but this one gets the earliest possible check
      // since a "denied" outcome would otherwise return before ever
      // reaching the `isStopRequested()` check below it).
      let micGranted = await requestMicPermission()
      if isStopRequested() {
        emitStatus(.ended)
        return
      }
      guard micGranted else {
        emitStatus(.permissionDenied, message: "麦克风权限被拒绝")
        return
      }
      // (no separate isStopRequested() re-check here — nothing async ran
      // between the check above and here, so it can't have gone stale)

      let resolvedLocale = try await OsSpeechLocale.resolve(bcp47: bcp47, source: .session, emit: emit)
      if isStopRequested() {
        emitStatus(.ended)
        return
      }

      let transcriber = SpeechTranscriber(locale: resolvedLocale, preset: .timeIndexedProgressiveTranscription)

      try await OsSpeechAssetInstaller.ensureInstalled(
        transcriber: transcriber,
        source: .session,
        shouldAbort: { self.isStopRequested() },
        emit: emit
      )

      guard let targetFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        emitStatus(.crashed, message: "SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith:) returned nil")
        return
      }

      // ---- contextual biasing (Q11 v1: glossary headwords only) ----
      let analysisContext = AnalysisContext()
      let contextualTerms = Self.parseContextualTerms(contextualJSON)
      if !contextualTerms.isEmpty {
        analysisContext.contextualStrings = [.general: contextualTerms]
      }

      let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
      self.continuation = continuation

      let options = SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .processLifetime)
      let analyzer = SpeechAnalyzer(modules: [transcriber], options: options)
      if !contextualTerms.isEmpty {
        try await analyzer.setContext(analysisContext)
      }

      if isStopRequested() {
        continuation.finish()
        emitStatus(.ended)
        return
      }

      // ---- AVAudioSession + tap + engine start (the mic-permission
      // TCC prompt, if not already resolved above, would surface here
      // as an `engine.start()` throw — mapped to `.crashed` below,
      // matching macOS's own "no dedicated kind, falls through" posture
      // for anything beyond the explicit pre-check). ----
      try configureAudioSession()

      let inputFormat = engine.inputNode.outputFormat(forBus: 0)
      let sink = try ConverterSink(nativeFormat: inputFormat, targetFormat: targetFormat, continuation: continuation, pauseFence: pauseFence) { [weak self] error in
        self?.requestStop(kind: error.statusKind, message: error.message)
      }
      self.sink = sink

      engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
        // Realtime-ish tap thread — Q3 parity: pause gates audio (never
        // reaches the converter/analyzer while paused), the analyzer
        // itself stays alive. F-S3: the actual snapshot-then-recheck
        // fence now lives inside `ConverterSink.receive` itself (right
        // up to the moment it yields) rather than a single check here —
        // see that method's own comments. `sink` (not `self`) is the
        // only thing this closure needs — capturing it directly (a
        // strong ref to `ConverterSink`, not `OsSpeechSession`) creates
        // no retain cycle back to `self`.
        sink.receive(buffer)
      }
      didInstallTap = true // F-S5 — flagged the instant installTap actually runs
      engine.prepare()
      try engine.start()

      registerLifecycleObservers()
      await MainActor.run { UIApplication.shared.isIdleTimerDisabled = true }

      // "starting" was already emitted above (mirrors macOS's own
      // placement: emitted once, before locale/asset even begins) —
      // "capturing" is emitted right after the engine actually starts,
      // BEFORE handing the stream to the analyzer (same ordering as
      // macOS's `try startTap(); StatusEvents.emitStatus("capturing",
      // ...); try await analyzer.start(...)`).
      emitStatus(.capturing)
      try await analyzer.start(inputSequence: stream)

      let resultsTask = Task { [emit] in
        await Self.consumeResults(transcriber: transcriber, emit: emit) { [weak self] in
          // FIX S2 parity: the results loop erroring calls the SAME
          // `requestStop` every other terminal path does — its
          // first-write-wins rule alone is what makes "a deliberate stop
          // already in flight keeps ITS OWN kind" and "the results loop
          // errored first, unprompted, so `.crashed` wins" both fall out
          // correctly with no separate bookkeeping.
          self?.requestStop(kind: .crashed)
        }
      }

      await waitForStop()

      teardownAudio()
      continuation.finish()
      await Self.finalizeAndDrain(analyzer: analyzer, resultsTask: resultsTask)

      emitFinalStatus()
    } catch is OsSpeechAbort {
      // FIX S5 parity — a deliberate stop landed while ensureInstalled
      // was still awaiting the download: no tap has been started yet at
      // this point in `run`'s own ordering, so there is nothing else to
      // tear down. Still a clean stop.
      emitStatus(.ended)
    } catch let error as OsSpeechError {
      teardownAudio()
      continuation?.finish()
      var supportedLocales: [String]?
      if case .unsupportedLocale = error {
        supportedLocales = await SpeechTranscriber.supportedLocales.map(\.identifier)
      }
      emitStatus(error.statusKind, message: error.message, supportedLocales: supportedLocales)
    } catch {
      teardownAudio()
      continuation?.finish()
      emitStatus(.crashed, message: "\(error)")
    }

    removeLifecycleObservers()
    await MainActor.run { UIApplication.shared.isIdleTimerDisabled = false }
  }

  // ---- stop/wait plumbing ----

  private func isStopRequested() -> Bool {
    stopLock.lock(); defer { stopLock.unlock() }
    return stopRequested
  }

  /// F-S1(a) — see `explicitStopRequested`'s own doc comment; read by
  /// `emitStatus` on every call.
  private func isExplicitStopRequested() -> Bool {
    stopLock.lock(); defer { stopLock.unlock() }
    return explicitStopRequested
  }

  /// First caller wins (message/kind alike) — every subsequent call is a
  /// harmless no-op beyond waking a still-waiting `waitForStop()`. This
  /// single rule is what implements macOS's FIX S2 semantics ("a
  /// deliberate stop must never surface as a failure") with no separate
  /// `duringDeliberateStop` bookkeeping: whichever of {explicit stop,
  /// interruption, route change, converter fatal error, results-loop
  /// error} calls this FIRST decides the terminal kind; every later
  /// caller — including a results-loop error arriving just after an
  /// explicit stop already claimed `.ended` — can no longer change it.
  private func requestStop(kind: OsSpeechStatusKind, message: String? = nil) {
    stopLock.lock()
    if !stopRequested {
      stopRequested = true
      pendingTerminalKind = kind
      pendingTerminalMessage = message
    }
    let waiter = stopContinuation
    stopContinuation = nil
    stopLock.unlock()
    waiter?.resume()
  }

  private func waitForStop() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      stopLock.lock()
      if stopRequested {
        stopLock.unlock()
        continuation.resume()
      } else {
        stopContinuation = continuation
        stopLock.unlock()
      }
    }
  }

  private func emitFinalStatus() {
    stopLock.lock()
    let kind = pendingTerminalKind
    let message = pendingTerminalMessage
    stopLock.unlock()
    emitStatus(kind, message: message)
  }

  /// F-S1(d) — best-effort finalize+drain, raced against a hard 2500ms
  /// deadline: `finalizeAndFinishThroughEndOfInput()` and draining
  /// `resultsTask` are NOT guaranteed to respect Swift's cooperative
  /// cancellation promptly, so a `withTaskGroup` (which implicitly
  /// awaits every child before returning, cancelled or not — no actual
  /// "abandon and move on" escape hatch) can't enforce a hard deadline
  /// here. Uses two plain UNSTRUCTURED `Task`s racing into the SAME
  /// first-writer-wins checked-continuation idiom this file already uses
  /// for `waitForStop()`; whichever finishes first resumes it and this
  /// function returns immediately — the loser (when the deadline wins)
  /// keeps running detached, best-effort, same posture the finalize
  /// catch below already accepts. 2500ms keeps margin under the JS 4s
  /// stop-latch timeout (`STOP_ENDED_TIMEOUT_MS`, osSpeech.ts) — mirrors
  /// this repo's own macOS convention "JS 4s > Rust STOP_GRACE_PERIOD 3s"
  /// (audiocap.rs/osspeech.rs), here as "JS 4s > Swift 2.5s drain
  /// deadline".
  private static func finalizeAndDrain(analyzer: SpeechAnalyzer, resultsTask: Task<Void, Never>) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let resumeOnce = ResumeOnceBox(continuation)
      Task {
        do {
          try await analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
          // Best-effort — the stream is ending either way (already
          // finish()ed before this was called); no dedicated log lane on
          // iOS to mirror this to (unlike macOS's own
          // TranscriptEvents.emitError fallback).
        }
        _ = await resultsTask.value // drain remaining finals
        resumeOnce.resume()
      }
      Task {
        try? await Task.sleep(nanoseconds: 2_500_000_000) // 2500ms deadline
        resumeOnce.resume()
      }
    }
  }

  // ---- AVAudioSession / engine lifecycle ----

  /// `.measurement` reduces system AGC/processing that hurts ASR quality
  /// (blueprint D6) — owner-tunable on device: fall back to `.default`
  /// mode here if input gain measures too low in practice. `.allowBluetoothHFP`
  /// (not the blueprint pseudocode's `.allowBluetooth`, deprecated since
  /// iOS 8.0 — caught by the iOS-target Swift build's own zero-warnings
  /// gate): same Bluetooth-mic-input behavior, current API name.
  private func configureAudioSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement, options: [.duckOthers, .allowBluetoothHFP])
    try session.setActive(true)
    didActivateAudioSession = true // F-S5 — only after setActive(true) actually succeeds
  }

  /// F-S5 — undoes ONLY what THIS session actually did: a failure before
  /// `configureAudioSession()`/the tap-install ever ran (e.g. an
  /// unsupported locale, or a stop landing mid-asset-download) must not
  /// deactivate the process-shared `AVAudioSession` — some other
  /// component may depend on it staying active, and this session never
  /// touched it in the first place.
  private func teardownAudio() {
    if didInstallTap {
      engine.inputNode.removeTap(onBus: 0)
      didInstallTap = false
    }
    engine.stop()
    sink?.stop()
    if didActivateAudioSession {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      didActivateAudioSession = false
    }
  }

  /// AVAudioApplication (not the deprecated AVAudioSession
  /// requestRecordPermission — iOS 26 floor is well past that
  /// deprecation). Denial reports `.permissionDenied` as a STATUS event,
  /// never a command-level `Err` (matches macOS's own tap-start TCC
  /// denial, which is a `status` event too, not an invoke rejection).
  private func requestMicPermission() async -> Bool {
    switch AVAudioApplication.shared.recordPermission {
    case .granted:
      return true
    case .denied:
      return false
    case .undetermined:
      return await withCheckedContinuation { continuation in
        AVAudioApplication.requestRecordPermission { granted in
          continuation.resume(returning: granted)
        }
      }
    @unknown default:
      return false
    }
  }

  /// `.began` -> stop + terminal `.ended`, no auto-resume (blueprint
  /// D6: v1 posture). Route change -> terminal `.deviceChanged` (parity
  /// with macOS's own starvation/device-changed handling — JS's
  /// `OSSPEECH_TERMINAL_STATUS_KINDS` expects the session to be OVER
  /// once this kind arrives, so this tears the session down exactly like
  /// an explicit stop, just with a different terminal kind).
  private func registerLifecycleObservers() {
    let center = NotificationCenter.default
    interruptionObserver = center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      guard let typeValue = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
        let type = AVAudioSession.InterruptionType(rawValue: typeValue), type == .began
      else { return }
      self?.requestStop(kind: .ended)
    }
    routeChangeObserver = center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
      self?.requestStop(kind: .deviceChanged)
    }
  }

  private func removeLifecycleObservers() {
    let center = NotificationCenter.default
    if let interruptionObserver { center.removeObserver(interruptionObserver) }
    if let routeChangeObserver { center.removeObserver(routeChangeObserver) }
    interruptionObserver = nil
    routeChangeObserver = nil
  }

  // ---- small helpers ----

  /// F-S1(a) — the ONE terminal-emission choke point: every `emitStatus`
  /// call (early-return guard-else branches, the bottom-of-`run()` catch
  /// blocks, AND `emitFinalStatus()`'s own post-`waitForStop()` call)
  /// routes through `OsSpeechTerminalCoercion.coerce`, so a terminal kind
  /// decided by ANY path is force-rewritten to `.ended` once the user's
  /// own explicit stop has been requested — see that function's own doc
  /// comment.
  private func emitStatus(
    _ kind: OsSpeechStatusKind, message: String? = nil, progress: Double? = nil, resolvedLocale: String? = nil, supportedLocales: [String]? = nil
  ) {
    let coerced = OsSpeechTerminalCoercion.coerce(kind: kind, message: message, explicitStopRequested: isExplicitStopRequested())
    emit(
      OsSpeechEvent.status,
      OsSpeechStatusPayload(
        kind: coerced.kind, source: .session, message: coerced.message, progress: progress, resolvedLocale: resolvedLocale, supportedLocales: supportedLocales))
  }

  /// Q11 v1: an optional JSON array of strings, capped/curated by the JS
  /// side (glossary headwords, <=100 terms) — parse it, or silently
  /// don't (the wire contract's own "invalid JSON = ignore, not fatal";
  /// unlike macOS's own `parseContextualTerms`, this drops the
  /// diagnostic-only note event since iOS's closed status-kind set has
  /// no equivalent freeform note shape to (mis)use for it).
  private static func parseContextualTerms(_ json: String?) -> [String] {
    guard let json, !json.isEmpty,
      let data = json.data(using: .utf8),
      let terms = try? JSONDecoder().decode([String].self, from: data)
    else { return [] }
    return terms
  }

  /// The concurrent results-consuming loop (mirrors macOS's own
  /// `consumeResults`): each `Result` is the full current-range
  /// progressive text for volatiles (replaces, not appends) and a
  /// range-final commit for finals. `onError` is `requestStop(kind:
  /// .crashed)` — see that method's own doc comment for why that alone
  /// is enough to implement FIX S2 correctly with no
  /// `duringDeliberateStop` parameter needed here.
  private static func consumeResults(
    transcriber: SpeechTranscriber,
    emit: @escaping (String, any Encodable) -> Void,
    onError: @escaping () -> Void
  ) async {
    var throttle = TranscriptThrottle()
    var seq: UInt64 = 0
    do {
      for try await result in transcriber.results {
        let startMs = millisecondsFrom(result.range.start.seconds)
        let endMs = millisecondsFrom(result.range.end.seconds)
        let isFinal = result.isFinal
        guard throttle.shouldEmit(final: isFinal, startMs: startMs, endMs: endMs) else { continue }
        seq += 1
        emit(OsSpeechEvent.transcript, OsSpeechTranscriptPayload(final: isFinal, seq: seq, startMs: startMs, endMs: endMs, text: String(result.text.characters)))
      }
    } catch {
      onError()
    }
  }

  /// CMTime seconds -> integer ms, same rounding rule as macOS's own
  /// `TranscriptEvents.milliseconds(fromSeconds:)`. Clamped at 0 (never
  /// negative in practice — a defensive floor, not an observed case).
  private static func millisecondsFrom(_ seconds: Double) -> UInt64 {
    UInt64(max(0, (seconds * 1_000).rounded()))
  }
}

/// F-S3 — guards `OsSpeechSession.pauseFence`'s (paused, generation)
/// pair, read together on the realtime-ish AVAudioEngine tap callback
/// thread (via `ConverterSink.receive`'s own two snapshots) and written
/// from wherever `pauseTranscribe`/`resumeTranscribe` happens to run.
/// ONE lock over BOTH fields (not two separate `LockedFlag`-style boxes)
/// so a reader never observes a torn pair — see `PauseGenerationFence
/// .shouldDrop`'s own doc comment (PauseGenerationFence.swift) for what
/// the two fields feed. `generation` bumps on EVERY `setPaused` call —
/// paused OR resumed alike, even if the value happens not to actually
/// change — so a pause that lands and is undone again between two reads
/// is still visible as "something changed" to a caller holding an older
/// snapshot.
final class PauseGenerationBox: @unchecked Sendable {
  private let lock = NSLock()
  private var paused: Bool
  private var generation: UInt64 = 0

  init(_ initial: Bool) { paused = initial }

  func setPaused(_ newValue: Bool) {
    lock.lock()
    paused = newValue
    generation += 1
    lock.unlock()
  }

  /// Atomically reads both fields together — called at buffer-receipt
  /// time AND again immediately before yield; see `ConverterSink
  /// .receive`'s own two call sites.
  func snapshot() -> (paused: Bool, generation: UInt64) {
    lock.lock(); defer { lock.unlock() }
    return (paused, generation)
  }
}

/// F-S1(d) — resumes a `CheckedContinuation<Void, Never>` at most once;
/// guards `OsSpeechSession.finalizeAndDrain`'s own two-racer (work vs
/// deadline) unstructured Tasks from a double-resume trap. Same
/// NSLock-guarded first-write-wins posture as `DownloadOutcomeBox`
/// (OsSpeechAssetInstaller.swift) / `OsSpeechSession.stopContinuation`.
final class ResumeOnceBox: @unchecked Sendable {
  private let lock = NSLock()
  private var resumed = false
  private let continuation: CheckedContinuation<Void, Never>
  init(_ continuation: CheckedContinuation<Void, Never>) { self.continuation = continuation }
  func resume() {
    lock.lock()
    let alreadyResumed = resumed
    resumed = true
    lock.unlock()
    guard !alreadyResumed else { return }
    continuation.resume()
  }
}

/// Converts the tap's own (already-real) `AVAudioPCMBuffer` to
/// `targetFormat` via ONE `AVAudioConverter` instance (carries resampler
/// state across chunks) and yields into the analyzer's input stream —
/// the iOS analog of macOS's `ConverterFrameSink`, simplified: the tap
/// callback already hands us a real `AVAudioPCMBuffer` (unlike macOS's
/// raw-ring-buffer bytes), so there is no manual source-buffer
/// allocation/byte-copy step here, only the convert-and-yield. Same
/// impossible-by-construction safety property: every allocation/
/// conversion step is nil/error-checked, ANY failure calls `onFatalError`
/// exactly once and returns WITHOUT ever calling `continuation.yield` —
/// there is no code path from a failed conversion to a yield (the SAME
/// "wrong-format buffer SIGTRAPs the process" hazard macOS's own file
/// documents applies identically here: `SpeechAnalyzer`'s input stream
/// only ever receives `outputBuffer`, always built with exactly
/// `targetFormat`).
@available(iOS 26.0, macOS 26.0, *)
final class ConverterSink: @unchecked Sendable {
  private let converter: AVAudioConverter
  private let targetFormat: AVAudioFormat
  private let continuation: AsyncStream<AnalyzerInput>.Continuation
  private let pauseFence: PauseGenerationBox
  private let onFatalError: (OsSpeechError) -> Void
  private let lock = NSLock()
  private var stopped = false

  init(
    nativeFormat: AVAudioFormat,
    targetFormat: AVAudioFormat,
    continuation: AsyncStream<AnalyzerInput>.Continuation,
    pauseFence: PauseGenerationBox,
    onFatalError: @escaping (OsSpeechError) -> Void
  ) throws {
    guard let converter = AVAudioConverter(from: nativeFormat, to: targetFormat) else {
      throw OsSpeechError.audioFormat("AVAudioConverter creation failed (native \(nativeFormat), target \(targetFormat))")
    }
    self.converter = converter
    self.targetFormat = targetFormat
    self.continuation = continuation
    self.pauseFence = pauseFence
    self.onFatalError = onFatalError
    // F-S3 — deliberately NOT torn down/recreated on pause: `converter`
    // is the ONE `AVAudioConverter` instance for this session's whole
    // lifetime (carries resampler state across chunks, see `receive`'s
    // own comment below). Resetting it across a pause would only save a
    // few ms of stale resampler priming on the FIRST post-resume buffer
    // — well below the noise floor for mic speech — at the cost of
    // losing that carried state on every other buffer. Not worth it.
  }

  /// Called from the AVAudioEngine tap callback thread only (never
  /// concurrently — AVAudioEngine invokes a given tap's block
  /// serially).
  func receive(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    let alreadyStopped = stopped
    lock.unlock()
    guard !alreadyStopped, buffer.frameLength > 0 else { return }

    // F-S3 — snapshot pause state+generation the instant this buffer is
    // admitted (cheap early exit: skip the conversion work below
    // entirely rather than doing it only to drop the result).
    let atReceipt = pauseFence.snapshot()
    guard !atReceipt.paused else { return }

    let ratio = targetFormat.sampleRate / buffer.format.sampleRate
    let outputCapacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16 // small safety pad
    guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputCapacity) else {
      fail(.audioFormat("failed to allocate output AVAudioPCMBuffer (capacity \(outputCapacity))"))
      return
    }

    // Spike-verified-on-macOS pattern, same here: one input buffer per
    // convert() call, .haveData then .noDataNow — resampler state
    // carries over to the NEXT `receive` call via the SAME converter
    // instance.
    var suppliedInput = false
    var conversionError: NSError?
    let status = converter.convert(to: outputBuffer, error: &conversionError) { _, inputStatus in
      if suppliedInput {
        inputStatus.pointee = .noDataNow
        return nil
      }
      suppliedInput = true
      inputStatus.pointee = .haveData
      return buffer
    }

    guard status != .error, conversionError == nil else {
      fail(.audioFormat("AVAudioConverter conversion failed (status \(status.rawValue)): \(conversionError?.localizedDescription ?? "unknown")"))
      return
    }
    guard outputBuffer.frameLength > 0 else { return } // legitimately nothing produced yet (priming) — not a failure

    // F-S3 — re-check IMMEDIATELY before yield: a pause (or a pause+
    // resume landing entirely within this buffer's own conversion
    // window, which `atReceipt.paused == false` alone can't see) must
    // still drop this buffer — see PauseGenerationFence's own doc
    // comment.
    let atYield = pauseFence.snapshot()
    guard !PauseGenerationFence.shouldDrop(pausedAtYield: atYield.paused, snapshotGeneration: atReceipt.generation, currentGeneration: atYield.generation) else { return }

    continuation.yield(AnalyzerInput(buffer: outputBuffer))
  }

  func stop() {
    lock.lock(); stopped = true; lock.unlock()
  }

  private func fail(_ error: OsSpeechError) {
    lock.lock()
    guard !stopped else { lock.unlock(); return }
    stopped = true
    lock.unlock()
    onFatalError(error)
  }
}
#endif
