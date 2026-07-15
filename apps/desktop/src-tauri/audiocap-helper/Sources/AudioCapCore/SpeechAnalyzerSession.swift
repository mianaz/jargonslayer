import Foundation
import CoreMedia
import Speech
@preconcurrency import AVFoundation

// S11 (§Q1/§3 Worker A) — the one framework-bound seam the blueprint
// calls out explicitly: everything in this file only exists because it
// has to touch live Speech.framework/AVFoundation objects, which is
// exactly why it's kept as small and as separate as possible from
// TranscribeConsumer (pure poll-loop skeleton, fully unit tested) and
// TranscriptEvents/TranscriptThrottle/LocaleResolver (pure, fully unit
// tested). `AnalyzerSeam` is the abstraction boundary main.swift's
// runTranscribe depends on; `SpeechAnalyzerSession` is the one real
// (fake-injectable in principle, per the blueprint's own phrasing)
// conformance. No dedicated unit tests exist for this file itself (the
// slice's own test list names five OTHER pure pieces, not this one) —
// it's exercised by the build + the on-device `--probe-osspeech`/manual
// smoke test instead, same posture as ProcessTapCapture.swift (also
// untested by `swift test`, verified live).
@available(macOS 26.0, *)
public protocol AnalyzerSeam {
    /// Runs ONE full transcribe session to completion: locale resolve ->
    /// asset ensure -> format negotiation -> `startTap()` -> analyzer
    /// start -> results loop (throttled NDJSON) -> on shutdown: finalize
    /// -> drain -> stats -> finished/error -> return. `startTap` is a
    /// closure (not a direct ProcessTapCapture call) so the CoreAudio
    /// object lifecycle stays entirely owned by main.swift (mirroring
    /// runCapture exactly — see that function's own comment) while this
    /// seam only decides WHEN to actually start the device, per §Q1's
    /// own ordering ("asset ensure ... tap start ... analyzer.start").
    /// `stopTap` is called exactly once, right after the producer thread
    /// has fully stopped and BEFORE the true final ring drain — the same
    /// "AudioDeviceStop must return before the last drain runs" invariant
    /// Writer.drainRemaining/TranscribeConsumer.drainRemaining's own doc
    /// comments establish (a drain before the device is actually stopped
    /// would leave a window where the IOProc could still push audio into
    /// the ring that nothing ever drains). Caller (main.swift) still owns
    /// full IOProc/aggregate/tap DESTRUCTION after this returns,
    /// unconditionally (calling `stopDevice` again there too is harmless
    /// — ProcessTapCapture.teardown's own doc comment already documents
    /// that redundancy), exactly like runCapture's own catch-all teardown.
    func run(
        locale bcp47: String,
        contextualJSON: String?,
        durationSeconds: Double?,
        ring: SPSCByteRing,
        channels: UInt16,
        isNonInterleaved: Bool,
        sampleRate: UInt32,
        shutdown: ShutdownSignal,
        isPaused: @escaping () -> Bool,
        startTap: @escaping () throws -> Void,
        stopTap: @escaping () -> Void
    ) async -> SpeechSessionOutcome

    /// `--preinstall-osspeech`'s own flow (§A2/§Q5): locale resolve +
    /// asset ensure only — no tap, no analyzer, no results loop. Emits
    /// the same `{"type":"status","state":"finished"}` sentinel as `run`
    /// on success (§2.2 makes no distinction for a background warm-up
    /// session — it's still "the transcribe analog of framing EOS", just
    /// for an asset-only session).
    func preinstall(locale bcp47: String) async -> SpeechSessionOutcome
}

/// What main.swift's runTranscribe does with the finished session —
/// deliberately just the two exit codes runCapture itself ever produces
/// (0/1): every OTHER distinction (starved vs. locale-unsupported vs.
/// asset-download-failed vs. a mid-session engine failure) has ALREADY
/// been emitted as its own typed NDJSON record by `run` itself before
/// returning, so the caller genuinely needs nothing more granular than
/// this to pick an exit code.
@available(macOS 26.0, *)
public enum SpeechSessionOutcome {
    case success
    case failure
}

/// Wraps `SpeechTranscriber.supportedLocale(equivalentTo:)` — the one
/// line LocaleResolver's own seam protocol exists to isolate (spike-
/// verified BCP-47 mapping; see LocaleResolver.swift's own header
/// comment).
@available(macOS 26.0, *)
struct SpeechTranscriberLocaleProvider: LocaleEquivalenceProviding {
    func supportedLocale(equivalentTo locale: Locale) async -> Locale? {
        await SpeechTranscriber.supportedLocale(equivalentTo: locale)
    }
}

@available(macOS 26.0, *)
public final class SpeechAnalyzerSession: AnalyzerSeam {
    public init() {}

    public func run(
        locale bcp47: String,
        contextualJSON: String?,
        durationSeconds: Double?,
        ring: SPSCByteRing,
        channels: UInt16,
        isNonInterleaved: Bool,
        sampleRate: UInt32,
        shutdown: ShutdownSignal,
        isPaused: @escaping () -> Bool,
        startTap: @escaping () throws -> Void,
        stopTap: @escaping () -> Void
    ) async -> SpeechSessionOutcome {
        do {
            // ---- locale (§Q4) ----
            let resolver = LocaleResolver(provider: SpeechTranscriberLocaleProvider())
            let resolvedLocale: Locale
            switch await resolver.resolve(bcp47: bcp47) {
            case .resolved(_, let locale):
                resolvedLocale = locale
                TranscriptEvents.emitLocale(requested: bcp47, resolved: locale.identifier, supported: true)
            case .unsupported:
                TranscriptEvents.emitLocale(requested: bcp47, resolved: nil, supported: false)
                throw OsSpeechError.unsupportedLocale(bcp47)
            }

            let transcriber = SpeechTranscriber(locale: resolvedLocale, preset: .timeIndexedProgressiveTranscription)

            // ---- asset (§Q5/spike "Asset model") ----
            // FIX S5 (S11 fix round) — `shutdown.isRequested` makes a
            // stop landing DURING the (measured up to 16.7s cold) asset
            // download abortable instead of parking uninterruptibly
            // until Rust's 3s stop-grace SIGKILL watchdog fires (which
            // bypasses this session's own teardown/`stopTap` entirely —
            // see `ensureAssetInstalled`'s own doc comment).
            try await ensureAssetInstalled(transcriber: transcriber, shouldAbort: shutdown.isRequested)

            // ---- format negotiation — the SIGTRAP-hazard boundary
            // (blueprint's own #1 risk): `nativeFormat` describes
            // exactly the byte layout TranscribeConsumer's FrameSink
            // calls hand us (interleaved Float32, same sampleRate/
            // channels as the tap's own ASBD — see main.swift's
            // runTranscribe for where those numbers come from). Any nil
            // here is reported as `OsSpeechError.audioFormat` and NEVER
            // reached again once past this point without a working
            // converter in hand — see ConverterFrameSink's own header
            // comment for why the actual per-buffer conversion is
            // "impossible-by-construction" rather than merely rare. ----
            guard let nativeFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate),
                channels: AVAudioChannelCount(channels), interleaved: true
            ) else {
                throw OsSpeechError.audioFormat("failed to build native AVAudioFormat (sampleRate \(sampleRate), channels \(channels))")
            }
            guard let targetFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
                throw OsSpeechError.audioFormat("SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith:) returned nil")
            }

            // ---- contextual biasing (§Q11 — v1: glossary headwords only) ----
            let analysisContext = AnalysisContext()
            let contextualTerms = parseContextualTerms(contextualJSON)
            if !contextualTerms.isEmpty {
                analysisContext.contextualStrings = [.general: contextualTerms]
            }

            // ---- stream + analyzer ----
            let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
            let fatalBox = FatalErrorBox()
            let sink = try ConverterFrameSink(nativeFormat: nativeFormat, targetFormat: targetFormat, continuation: continuation) { error in
                fatalBox.record(error)
                continuation.finish()
                // Reuses ShutdownSignal's own write-failure entry point
                // purely for its mechanical "set the shared atomic
                // requested flag" effect (Must-NOT-TOUCH that file) —
                // see that method's own doc comment: a write failure and
                // a fatal conversion error are both "something the
                // parent needs to hear about is now unrecoverable, begin
                // graceful teardown", just observed from different call
                // sites.
                shutdown.requestShutdownFromWriteFailure()
            }

            // FIX S1 (S11 fix round) — the modules-only initializer does
            // NOT itself begin analysis (unlike the `inputSequence:`
            // initializer, which per the SDK's own documentation ALREADY
            // starts consuming that sequence the moment the analyzer is
            // constructed) — verified against the SDK swiftinterface
            // (Speech.swiftmodule/arm64e-apple-macos.swiftinterface):
            // `init(modules:options:)` has no `inputSequence`/
            // `analysisContext` parameter at all, so `setContext` below
            // is the ONLY way to apply contextual biasing to an analyzer
            // built this way. The single `analyzer.start(inputSequence:)`
            // call further down (after `startTap()`) is THE one and only
            // place analysis actually begins — see the spike's own
            // "Streaming pipeline" finding for this exact shape. The
            // PRIOR shape here (constructing via `inputSequence:` and
            // THEN also calling `.start(inputSequence:)`) double-started
            // analysis over the same single-consumer AsyncStream.
            let options = SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .processLifetime)
            let analyzer = SpeechAnalyzer(modules: [transcriber], options: options)
            if !contextualTerms.isEmpty {
                try await analyzer.setContext(analysisContext)
            }

            // ---- tap start — AFTER asset+converter are ready (§Q1's
            // own ordering: "asset ensure ... tap start ...
            // analyzer.start"); "starting" was already emitted by
            // main.swift right after tap/aggregate/IOProc creation
            // (format known), mirroring runCapture's own placement. ----
            try startTap()
            StatusEvents.emitStatus(state: "capturing", sampleRate: sampleRate, channels: channels)

            try await analyzer.start(inputSequence: stream)

            // ---- producer thread (§Q1: "a dedicated producer Thread") ----
            let consumer = TranscribeConsumer(
                ring: ring, channels: channels, isNonInterleaved: isNonInterleaved,
                sink: sink, isPaused: isPaused
            )
            let durationDeadline = durationSeconds.map { Date().addingTimeInterval($0) }
            func shouldStopProducing() -> Bool {
                shutdown.isRequested() || (durationDeadline.map { Date() >= $0 } ?? false)
            }
            let stopReasonBox = StopReasonBox()

            // ---- results loop (concurrent child task — runs until the
            // stream is finish()ed + finalized below, NOT tied to
            // `shouldStopProducing` itself: spike's own finding is that
            // finals can keep arriving after the LAST buffer is yielded,
            // right up through finalizeAndFinishThroughEndOfInput). ----
            let resultsErrorBox = ResultsErrorBox()
            let resultsTask = Task {
                await Self.consumeResults(transcriber: transcriber, shutdown: shutdown, resultsError: resultsErrorBox)
            }

            // Starts the producer thread and suspends THIS async context
            // (no cooperative-pool thread blocked — a genuine `await`
            // suspension, resumed from whichever thread calls
            // `continuation.resume()`) until the producer thread's OWN
            // `shouldStopProducing` condition trips (shutdown requested
            // or duration reached) and `consumer.run` returns — this IS
            // "wait for shutdown", since that's exactly the producer
            // thread's exit condition; no separate polling loop needed.
            // Foundation's `Thread` has no `join()`/async-aware wait, so
            // a checked continuation is the idiomatic Swift-Concurrency
            // bridge (unlike a raw `DispatchSemaphore.wait()`, which is
            // flagged unavailable from an async context precisely
            // because it blocks the calling thread instead of
            // suspending).
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let producerThread = Thread {
                    stopReasonBox.record(consumer.run(shouldStop: shouldStopProducing))
                    continuation.resume()
                }
                producerThread.name = "jargonslayer-audiocap.osspeech-producer"
                producerThread.start()
            }

            // MUST happen before the true final ring drain right below
            // (see this protocol requirement's own doc comment) — the
            // producer thread has already fully stopped (the semaphore
            // above only signals AFTER `consumer.run` itself returns),
            // so there is no concurrent `pollOnce()` caller left by the
            // time `stopTap()` runs.
            stopTap()

            // ---- teardown (§2.7's own trio, transcribe analog, FIX S3
            // reordering — S11 fix round): the true final ring drain
            // (`consumer.drainRemaining()`) MUST run BEFORE
            // `continuation.finish()`, not after: `drainRemaining` ends
            // by calling `sink.receive` -> `ConverterFrameSink.receive`
            // -> `continuation.yield(...)` for whatever tail audio was
            // still sitting in the ring, and `AsyncStream.Continuation
            // .yield` silently drops anything yielded AFTER `finish()`
            // has already been called on that same continuation — the
            // PRIOR ordering here (finish() then drainRemaining()) made
            // that final yield dead code, silently losing up to a few
            // tens of ms of trailing audio right before finalize. New
            // order: stopTap() -> drainRemaining() (tail yields INTO the
            // still-live stream) -> continuation.finish() ->
            // finalizeAndFinishThroughEndOfInput (~0.1s measured) ->
            // await resultsTask (drain remaining finals) -> stats ->
            // finished/error. ----
            consumer.drainRemaining()
            continuation.finish()
            do {
                try await analyzer.finalizeAndFinishThroughEndOfInput()
            } catch {
                // Best-effort: the stream is ending either way (we just
                // finish()ed it above) — a finalize failure here doesn't
                // change the teardown path, only gets logged via the
                // SAME error-mapping the results loop itself uses below.
                TranscriptEvents.emitError(.from(error, context: "finalizeAndFinishThroughEndOfInput"))
            }
            _ = await resultsTask.value // drain remaining finals
            consumer.emitFinalStats()
            await SpeechModels.endRetention() // best-effort (§Q12), guarded

            if let fatal = fatalBox.value {
                TranscriptEvents.emitError(fatal)
                return .failure
            }
            switch stopReasonBox.value {
            case .requested:
                // FIX S2 (S11 fix round) — `stopReasonBox == .requested`
                // is ALSO what a results-loop error itself produces (it
                // calls the SAME `shutdown.requestShutdownFromWriteFailure()`
                // the producer thread's `shouldStopProducing` observes),
                // so this case alone can no longer be trusted as "a clean
                // stop". `resultsErrorBox.duringDeliberateStop == false`
                // means the results loop's OWN error is what caused this
                // shutdown (no stdin-EOF/SIGTERM had landed yet when it
                // was caught) — that must surface as a failure, not a
                // clean "finished" sentinel (the error record itself was
                // already emitted inside `consumeResults`' own catch
                // block — do NOT also emit it here, that would double-
                // emit). `duringDeliberateStop == true` (or no results
                // error at all) means either nothing went wrong, or the
                // user had ALREADY asked to stop before the results loop
                // errored (e.g. during the finalize/drain window below)
                // — a deliberate stop must never surface as a failure,
                // so that case still falls through to the clean path.
                if let duringDeliberateStop = resultsErrorBox.duringDeliberateStop, !duringDeliberateStop {
                    return .failure
                }
                TranscriptEvents.emitFinished()
                return .success
            case .starved:
                // Mirrors runCapture's OWN F6 handling exactly (main.swift's
                // .starved branch): typed device-changed error, NO
                // finished sentinel (a starvation-truncated stream isn't
                // a clean one).
                StatusEvents.emitError(.deviceChanged("音频设备停止供给（设备切换或系统休眠）— 请重新开始转录"))
                return .failure
            }
        } catch is AssetDownloadAborted {
            // FIX S5 (S11 fix round) — a deliberate stop landed while
            // `ensureAssetInstalled` was still awaiting the download,
            // NOT a download failure: no tap has been started yet at
            // this point in `run`'s own ordering (asset-ensure happens
            // BEFORE `startTap()`), so there is nothing else to tear
            // down beyond what main.swift's own unconditional
            // `ProcessTapCapture.teardown` catch-all already does
            // regardless of outcome. Still emit the SAME clean-stop
            // sentinel every other deliberate-stop path emits, so Rust's
            // `finished_seen` maps this to `ended`, never `crashed` —
            // see `ensureAssetInstalled`'s own doc comment for why this
            // is the ONLY case that reaches here (a genuine network/
            // asset failure still throws `OsSpeechError.assetDownloadFailed`,
            // handled by the very next arm).
            TranscriptEvents.emitFinished()
            return .success
        } catch let error as OsSpeechError {
            TranscriptEvents.emitError(error)
            return .failure
        } catch let error as AudioCapError {
            // FIX S4 (S11 fix round) — `startTap()` (the TCC prompt site,
            // ProcessTapCapture.start -> AudioDeviceStart) can throw a
            // tap-level `AudioCapError` (permission-denied/device-changed
            // /...) — WITHOUT this arm, that fell through to the generic
            // `catch` below, which maps EVERY error to a generic
            // `engine-failure`-flavored record via `OsSpeechError.from`,
            // losing the specific wire code JS's permission-denied copy
            // path keys off. `StatusEvents.emitError` (not
            // `TranscriptEvents.emitError`, which only takes an
            // `OsSpeechError`) preserves the exact same tap-level wire
            // codes/shape §2.2's own "reused unchanged" list describes —
            // consistent with this file's OWN `.starved` arm just above,
            // which already emits a tap-flavored `AudioCapError` the same
            // way.
            StatusEvents.emitError(error)
            return .failure
        } catch {
            TranscriptEvents.emitError(.from(error, context: "session"))
            return .failure
        }
    }

    public func preinstall(locale bcp47: String) async -> SpeechSessionOutcome {
        do {
            let resolver = LocaleResolver(provider: SpeechTranscriberLocaleProvider())
            let resolvedLocale: Locale
            switch await resolver.resolve(bcp47: bcp47) {
            case .resolved(_, let locale):
                resolvedLocale = locale
                TranscriptEvents.emitLocale(requested: bcp47, resolved: locale.identifier, supported: true)
            case .unsupported:
                TranscriptEvents.emitLocale(requested: bcp47, resolved: nil, supported: false)
                throw OsSpeechError.unsupportedLocale(bcp47)
            }
            let transcriber = SpeechTranscriber(locale: resolvedLocale, preset: .timeIndexedProgressiveTranscription)
            // `{ false }`: `--preinstall-osspeech` (main.swift's own
            // `runPreinstall`) constructs no `ShutdownSignal` at all
            // today — there is no real stop signal to observe here, so
            // this preserves `preinstall`'s EXACT prior behavior (never
            // aborts mid-download) rather than inventing one that would
            // never actually fire. `run`'s own call site above passes
            // the real `shutdown.isRequested` — see `ensureAssetInstalled`'s
            // own doc comment (FIX S5, S11 fix round).
            try await ensureAssetInstalled(transcriber: transcriber, shouldAbort: { false })
            TranscriptEvents.emitFinished()
            return .success
        } catch let error as OsSpeechError {
            TranscriptEvents.emitError(error)
            return .failure
        } catch {
            TranscriptEvents.emitError(.from(error, context: "preinstall"))
            return .failure
        }
    }

    // ---- private helpers ----

    /// §Q5/spike "Asset model": `AssetInventory.status(forModules:)` is
    /// PER-MODULE-CONFIGURATION (querying with `transcriber` itself,
    /// exactly the module that will actually run, per the spike's own
    /// "always query with the exact module config you will run" rule) —
    /// installs (checking/downloading-with-progress/installed/failed
    /// events) only if not already installed; a re-run when already
    /// installed is a fast, event-only no-op (spike: "no download").
    ///
    /// FIX S5 (S11 fix round) — `downloadAndInstall()` (measured up to
    /// 16.7s on a cold locale, spike findings) now runs in its OWN
    /// unstructured child `Task`, specifically so this method can WALK
    /// AWAY from it — never `await` its actual completion — the moment
    /// `shouldAbort()` trips, rather than parking uninterruptibly until
    /// either the download finishes or Rust's 3s stop-grace SIGKILL
    /// watchdog fires first (which bypasses `run`'s own teardown —
    /// `stopTap`/drain/finalize never run). The SAME 200ms cadence that
    /// already existed for progress emission doubles as the abort-check
    /// cadence (no second timer). `downloadTask.cancel()` +
    /// `progress.cancel()` are both fired as best-effort hygiene
    /// (`AssetInstallationRequest: ProgressReporting`, and
    /// Foundation's own cancellable-`Progress` contract is the
    /// documented way a `ProgressReporting` operation is told to stop —
    /// verified against the SDK: `Progress.cancel()`/`isCancellable`/
    /// `isCancelled` all exist) — but this loop's own RESPONSIVENESS to
    /// `shouldAbort()` never depends on either actually being honored
    /// promptly by the OS asset manager (unverified against a live cold
    /// download by this fix round — flagged for the on-device smoke
    /// test, same posture as the blueprint's own §4.5 format-safety
    /// gate): once this method returns, `run` proceeds straight to its
    /// own teardown and the whole process exits shortly after regardless
    /// of whether the orphaned download task ever notices cancellation.
    private func ensureAssetInstalled(transcriber: SpeechTranscriber, shouldAbort: () -> Bool) async throws {
        TranscriptEvents.emitAssetChecking()
        let status = await AssetInventory.status(forModules: [transcriber])
        guard status != .installed else {
            TranscriptEvents.emitAssetInstalled()
            return
        }
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
            throw OsSpeechError.assetUnavailable("AssetInventory.assetInstallationRequest(supporting:) returned nil for a non-installed module")
        }

        // `outcomeBox` (not `downloadTask.isCancelled`/`.value`) is what
        // this method's own poll loop checks below — a plain `Task` has
        // no non-blocking "have you finished yet" property, only
        // `isCancelled` ("was cancellation REQUESTED", never "has it
        // actually stopped") — so the child Task records its own outcome
        // here the instant it's known, decoupling "did the download
        // finish" from this loop's independent ~200ms cadence.
        let outcomeBox = DownloadOutcomeBox()
        let downloadTask = Task {
            do {
                try await request.downloadAndInstall()
                outcomeBox.record(.success(()))
            } catch {
                outcomeBox.record(.failure(error))
            }
        }

        // Progress polling via fractionCompleted (spike: totalUnitCount
        // is misleading/0-1 — poll fractionCompleted instead), on the
        // SAME poll-driven posture as every other periodic mechanism in
        // this helper rather than a one-off KVO observer — now ALSO the
        // abort-check cadence (§FIX S5, see this method's own header
        // comment).
        let progress = request.progress
        var lastEmitted = -1.0
        while outcomeBox.value == nil {
            if shouldAbort() {
                downloadTask.cancel()
                progress.cancel()
                throw AssetDownloadAborted()
            }
            let fraction = progress.fractionCompleted
            if fraction - lastEmitted >= 0.01 {
                TranscriptEvents.emitAssetDownloading(progress: fraction)
                lastEmitted = fraction
            }
            try? await Task.sleep(nanoseconds: 200_000_000) // 200ms
        }

        if case .failure(let error) = outcomeBox.value {
            // §Q9: the designed offline-first-start failure path.
            throw OsSpeechError.assetDownloadFailed("asset download/install failed: \(error)")
        }
        TranscriptEvents.emitAssetInstalled()
    }

    /// §Q11 v1: an optional JSON array of strings, capped/curated by the
    /// JS side (glossary headwords, <=100 terms) — this helper's own job
    /// is just "parse it, or don't" per the wire contract's own
    /// "Invalid JSON = ignore with a note event, not fatal." A free
    /// function (not an instance method) — needs no `self`, keeping it
    /// trivially callable from `run` without any capture concerns.
    private func parseContextualTerms(_ json: String?) -> [String] {
        guard let json, !json.isEmpty else { return [] }
        guard let data = json.data(using: .utf8),
              let terms = try? JSONDecoder().decode([String].self, from: data) else {
            StatusEvents.emitNote(
                state: "contextual-json-invalid",
                message: "--contextual-json was not a valid JSON array of strings; ignoring (no biasing terms applied)"
            )
            return []
        }
        return terms
    }

    /// The concurrent results-consuming loop (§Q2/§Q10): each `Result`
    /// is the FULL current-range progressive text for volatiles
    /// (replaces, not appends) and a range-final commit for finals
    /// (spike-confirmed: finals are strictly range-ordered/contiguous).
    /// A `static` function (not an instance method) — captures nothing
    /// from `self`, sidestepping any Sendable-capture question for the
    /// `Task { }` closure that runs it.
    private static func consumeResults(transcriber: SpeechTranscriber, shutdown: ShutdownSignal, resultsError: ResultsErrorBox) async {
        var throttle = TranscriptThrottle()
        var seq: UInt64 = 0
        do {
            for try await result in transcriber.results {
                let startMs = TranscriptEvents.milliseconds(fromSeconds: result.range.start.seconds)
                let endMs = TranscriptEvents.milliseconds(fromSeconds: result.range.end.seconds)
                let isFinal = result.isFinal
                guard throttle.shouldEmit(final: isFinal, startMs: startMs, endMs: endMs) else { continue }
                seq += 1
                TranscriptEvents.emitTranscript(final: isFinal, seq: seq, startMs: startMs, endMs: endMs, text: String(result.text.characters))
            }
        } catch {
            // FIX S2 (S11 fix round) — read `shutdown.isRequested()`
            // BEFORE this catch block's own `requestShutdownFromWriteFailure()`
            // call flips that same flag: this is the ONLY way (given
            // `ShutdownSignal`'s single boolean flag, no "who/why"
            // tracking, and Must-NOT-TOUCH) to tell "a deliberate stop
            // was already in flight when the engine errored" apart from
            // "this error is what's driving the shutdown" — see
            // `ResultsErrorBox`'s own doc comment and `run`'s own outcome
            // -selection switch for how that distinction is used.
            let duringDeliberateStop = shutdown.isRequested()
            TranscriptEvents.emitError(.from(error, context: "transcriber.results"))
            resultsError.record(duringDeliberateStop: duringDeliberateStop)
            shutdown.requestShutdownFromWriteFailure()
        }
    }
}

/// FIX S2 (S11 fix round) — records whether `consumeResults`' own catch
/// block (the results loop erroring, e.g. `.moduleOutputFailed`) fired
/// WHILE a deliberate external stop (stdin-EOF/SIGTERM, observed via
/// `shutdown.isRequested()` at the exact moment the error was caught) had
/// already been requested. Without this, `run`'s own outcome selection
/// cannot tell "the engine itself failed" (a results-loop error is the
/// FIRST thing to request shutdown — must surface as `.failure`, never a
/// clean `finished` sentinel, since the helper would otherwise exit 0
/// having also emitted `finished`, which Rust maps straight to a clean
/// "ended" — masking the failure entirely) apart from "the user already
/// asked to stop, and the results loop merely errored as a side effect of
/// that same teardown (e.g. during the finalize/drain window)" — a
/// deliberate stop must never surface as a failure. Written at most once
/// (the results loop's `for try await` can only throw once before
/// exiting), read at most once, from `run`'s own async context after
/// `resultsTask` has already completed — a lock (not the C11 atomics
/// shim) is fine here, same posture as `StopReasonBox`/`FatalErrorBox`
/// below. Not `private`: `AudioCapCoreTests` exercises this box's own
/// pure record/read semantics directly via `@testable import` (the
/// surrounding `run`/`consumeResults` methods themselves stay untestable
/// without a live Speech.framework — see this file's own header
/// comment).
@available(macOS 26.0, *)
final class ResultsErrorBox: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedDuringDeliberateStop: Bool?
    func record(duringDeliberateStop: Bool) {
        lock.lock(); defer { lock.unlock() }
        if recordedDuringDeliberateStop == nil { recordedDuringDeliberateStop = duringDeliberateStop }
    }
    /// `nil` = no results-loop error occurred at all; otherwise whether
    /// it happened while a deliberate stop was already in flight.
    var duringDeliberateStop: Bool? {
        lock.lock(); defer { lock.unlock() }
        return recordedDuringDeliberateStop
    }
}

/// Plain locked boxes for the two values that need to cross from the
/// producer `Thread`/error-callback closures back to `run`'s own scope
/// after `producerStopped.wait()` — a lock (not the C11 atomics shim)
/// is fine here: written at most once, read at most once, never on any
/// RT-sensitive path (this is the transcribe-mode producer thread, not
/// the CoreAudio IOProc).
@available(macOS 26.0, *)
private final class StopReasonBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = TranscribeConsumer.StopReason.requested
    func record(_ value: TranscribeConsumer.StopReason) {
        lock.lock(); defer { lock.unlock() }
        stored = value
    }
    var value: TranscribeConsumer.StopReason {
        lock.lock(); defer { lock.unlock() }
        return stored
    }
}

@available(macOS 26.0, *)
private final class FatalErrorBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: OsSpeechError?
    func record(_ error: OsSpeechError) {
        lock.lock(); defer { lock.unlock() }
        if stored == nil { stored = error } // first fatal error wins
    }
    var value: OsSpeechError? {
        lock.lock(); defer { lock.unlock() }
        return stored
    }
}

/// FIX S5 (S11 fix round) — publishes `ensureAssetInstalled`'s own child
/// download `Task`'s eventual outcome (success or the thrown error)
/// WITHOUT that method's poll loop ever having to `await`/block on the
/// Task itself — see that method's own header comment for why blocking
/// there would defeat the whole point of making the download abortable.
/// Written at most once, from the child Task's own body; read every
/// ~200ms by the poll loop purely to notice "the download already
/// finished on its own" and stop polling. `Result<Void, Error>` (not a
/// bespoke enum): a plain stdlib type already shaped exactly right, same
/// "first write wins" / NSLock posture as `StopReasonBox`/`FatalErrorBox`/
/// `ResultsErrorBox` above. Not `private`: `AudioCapCoreTests` exercises
/// this box's own pure record/read semantics directly via `@testable
/// import`, same posture as `ResultsErrorBox` (the surrounding
/// `ensureAssetInstalled`/poll-loop-and-`shouldAbort` integration itself
/// stays untestable without a live/fake `AssetInstallationRequest` — see
/// that method's own header comment).
@available(macOS 26.0, *)
final class DownloadOutcomeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Result<Void, Error>?
    func record(_ result: Result<Void, Error>) {
        lock.lock(); defer { lock.unlock() }
        if stored == nil { stored = result }
    }
    var value: Result<Void, Error>? {
        lock.lock(); defer { lock.unlock() }
        return stored
    }
}

/// FIX S5 (S11 fix round) — an internal-only control-flow signal: never
/// emitted on the wire, never an `OsSpeechError`/`AudioCapError`. Thrown
/// by `ensureAssetInstalled` exactly when `shouldAbort()` fires while its
/// download is still in flight; caught by `run`'s own top-level catch
/// chain to distinguish "the user stopped mid-download" (clean stop —
/// finished sentinel, `.success`) from a REAL download failure
/// (`OsSpeechError.assetDownloadFailed`, unchanged, thrown from the SAME
/// method for every other error). `preinstall`'s own call site can never
/// trigger this (its `shouldAbort` closure is a permanent `{ false }` —
/// see that call site's own comment for why).
@available(macOS 26.0, *)
private struct AssetDownloadAborted: Error {}

// ---- the one framework-bound seam: native PCM -> SpeechAnalyzer's
// negotiated format, one AVAudioConverter, never yielding on failure ----

/// Converts TranscribeConsumer's drained (already-interleaved-Float32)
/// payload to `targetFormat` via ONE `AVAudioConverter` instance (spike:
/// "converter instance carries resampler state across chunks") and
/// yields into the analyzer's input stream. This is THE
/// impossible-by-construction boundary the blueprint's #1 risk is about
/// — s11-spike-findings-speechanalyzer.md's own words: "feeding
/// SpeechAnalyzer a wrong-format stream buffer SIGTRAPs the process...
/// a process crash, NOT a thrown error." Every allocation/conversion
/// step below is nil/error-checked; ANY failure calls `onFatalError`
/// exactly once and returns WITHOUT ever calling `continuation.yield` —
/// there is no code path from a failed conversion to a yield.
@available(macOS 26.0, *)
final class ConverterFrameSink: FrameSink {
    private let converter: AVAudioConverter
    private let nativeFormat: AVAudioFormat
    private let targetFormat: AVAudioFormat
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let onFatalError: (OsSpeechError) -> Void
    private var stopped = false

    init(
        nativeFormat: AVAudioFormat,
        targetFormat: AVAudioFormat,
        continuation: AsyncStream<AnalyzerInput>.Continuation,
        onFatalError: @escaping (OsSpeechError) -> Void
    ) throws {
        guard let converter = AVAudioConverter(from: nativeFormat, to: targetFormat) else {
            throw OsSpeechError.audioFormat("AVAudioConverter creation failed (native \(nativeFormat), target \(targetFormat))")
        }
        self.converter = converter
        self.nativeFormat = nativeFormat
        self.targetFormat = targetFormat
        self.continuation = continuation
        self.onFatalError = onFatalError
    }

    /// Called from TranscribeConsumer's producer thread only (never
    /// concurrently — same single-consumer-thread invariant Writer's own
    /// `append` relies on).
    func receive(frameCount: UInt32, payload: UnsafeRawBufferPointer) {
        guard !stopped, frameCount > 0 else { return }

        guard let sourceBuffer = AVAudioPCMBuffer(pcmFormat: nativeFormat, frameCapacity: frameCount),
              let sourceChannel = sourceBuffer.floatChannelData else {
            fail(.audioFormat("failed to allocate source AVAudioPCMBuffer (frameCount \(frameCount))"))
            return
        }
        sourceBuffer.frameLength = frameCount

        let expectedByteCount = Int(frameCount) * Int(nativeFormat.channelCount) * 4 // Float32 = 4 bytes/sample
        guard payload.count == expectedByteCount, let payloadBase = payload.baseAddress else {
            fail(.audioFormat("payload byte count \(payload.count) != expected \(expectedByteCount) for frameCount \(frameCount)"))
            return
        }
        UnsafeMutableRawPointer(sourceChannel[0]).copyMemory(from: payloadBase, byteCount: payload.count)

        let ratio = targetFormat.sampleRate / nativeFormat.sampleRate
        let outputCapacity = AVAudioFrameCount((Double(frameCount) * ratio).rounded(.up)) + 16 // small safety pad
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputCapacity) else {
            fail(.audioFormat("failed to allocate output AVAudioPCMBuffer (capacity \(outputCapacity))"))
            return
        }

        // Spike-verified pattern: "one input buffer per convert call,
        // .haveData then .noDataNow" — `sourceBuffer` is supplied
        // exactly once; the second (and any further) input-block call
        // within this SAME convert() invocation reports .noDataNow
        // (NOT .endOfStream, which would end the converter's own
        // internal stream state rather than just this one chunk — the
        // resampler state must carry over to the NEXT `receive` call).
        var suppliedInput = false
        var conversionError: NSError?
        let status = converter.convert(to: outputBuffer, error: &conversionError) { _, inputStatus in
            if suppliedInput {
                inputStatus.pointee = .noDataNow
                return nil
            }
            suppliedInput = true
            inputStatus.pointee = .haveData
            return sourceBuffer
        }

        guard status != .error, conversionError == nil else {
            fail(.audioFormat("AVAudioConverter conversion failed (status \(status.rawValue)): \(conversionError?.localizedDescription ?? "unknown")"))
            return
        }
        guard outputBuffer.frameLength > 0 else { return } // legitimately nothing produced yet (priming) — not a failure

        continuation.yield(AnalyzerInput(buffer: outputBuffer))
    }

    private func fail(_ error: OsSpeechError) {
        guard !stopped else { return }
        stopped = true
        onFatalError(error)
    }
}
