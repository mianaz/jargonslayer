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
            try await ensureAssetInstalled(transcriber: transcriber)

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

            let options = SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .processLifetime)
            let analyzer = SpeechAnalyzer(
                inputSequence: stream,
                modules: [transcriber],
                options: options,
                analysisContext: analysisContext,
                volatileRangeChangedHandler: nil
            )

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
            let resultsTask = Task {
                await Self.consumeResults(transcriber: transcriber, shutdown: shutdown)
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

            // MUST happen before the true final ring drain below (see
            // this protocol requirement's own doc comment) — the
            // producer thread has already fully stopped (the semaphore
            // above only signals AFTER `consumer.run` itself returns),
            // so there is no concurrent `pollOnce()` caller left by the
            // time `stopTap()` runs.
            stopTap()

            // ---- teardown (§2.7's own trio, transcribe analog):
            // continuation.finish() -> finalizeAndFinishThroughEndOfInput
            // (~0.1s measured) -> drain remaining finals -> final ring
            // drain -> stats -> finished/error. ----
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
            consumer.drainRemaining()
            consumer.emitFinalStats()
            await SpeechModels.endRetention() // best-effort (§Q12), guarded

            if let fatal = fatalBox.value {
                TranscriptEvents.emitError(fatal)
                return .failure
            }
            switch stopReasonBox.value {
            case .requested:
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
        } catch let error as OsSpeechError {
            TranscriptEvents.emitError(error)
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
            try await ensureAssetInstalled(transcriber: transcriber)
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
    private func ensureAssetInstalled(transcriber: SpeechTranscriber) async throws {
        TranscriptEvents.emitAssetChecking()
        let status = await AssetInventory.status(forModules: [transcriber])
        guard status != .installed else {
            TranscriptEvents.emitAssetInstalled()
            return
        }
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
            throw OsSpeechError.assetUnavailable("AssetInventory.assetInstallationRequest(supporting:) returned nil for a non-installed module")
        }

        // Progress polling via fractionCompleted (spike: totalUnitCount
        // is misleading/0-1 — poll fractionCompleted instead), on the
        // SAME poll-driven posture as every other periodic mechanism in
        // this helper rather than a one-off KVO observer.
        let progress = request.progress
        let progressTask = Task {
            var lastEmitted = -1.0
            while !Task.isCancelled {
                let fraction = progress.fractionCompleted
                if fraction - lastEmitted >= 0.01 {
                    TranscriptEvents.emitAssetDownloading(progress: fraction)
                    lastEmitted = fraction
                }
                try? await Task.sleep(nanoseconds: 200_000_000) // 200ms
            }
        }
        defer { progressTask.cancel() }

        do {
            try await request.downloadAndInstall()
        } catch {
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
    private static func consumeResults(transcriber: SpeechTranscriber, shutdown: ShutdownSignal) async {
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
            TranscriptEvents.emitError(.from(error, context: "transcriber.results"))
            shutdown.requestShutdownFromWriteFailure()
        }
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
