import AudioCapCore
import AudioToolbox
import CoreAudio
import Foundation
import Speech
import Translation
#if canImport(Darwin)
import Darwin
#endif

// S9.1 (docs/design-explorations/s9-app-audio-tap-blueprint.md) —
// jargonslayer-audiocap: the CLI entry point. Argument parsing + the
// macOS-version gate live here (see AudioCapError's own doc comment for
// why CLI-usage errors are NOT part of the typed NDJSON error
// taxonomy); the CoreAudio orchestration itself is AudioCapCore
// .ProcessTapCapture, gated `@available(macOS 14.2, *)` — runCapture
// below is this file's one entry into that gated surface, reached only
// once `#available` has already confirmed it's safe.
//
// NOTE on ordering: every declaration in this file (constants,
// functions) is placed BEFORE the actual top-level executable
// statements at the bottom. This isn't just style — a top-level `let`
// in a script-mode file like this one is only actually INITIALIZED when
// program execution reaches its textual position; a function called
// earlier in the file that reads a not-yet-reached top-level `let`
// silently sees its zero-initialized storage, not the intended value
// (confirmed with a throwaway probe before writing this file for real).
// Keeping all declarations first and the sequential "go" statements
// last sidesteps the whole hazard.

/// Sizes the SPSC ring for roughly 2.7s of stereo float32 audio at
/// 48kHz (1 MiB / (48000 * 2 * 4) ≈ 2.73s) — enough headroom to absorb
/// scheduling jitter between the realtime IOProc and the ~4ms-polling
/// writer thread, plus transient stdout backpressure, well beyond
/// either in practice.
let ringCapacityBytes = 1 << 20

struct CLIArguments {
    let excludePID: pid_t
    let durationSeconds: Double?
}

/// S11 (§2.1) — `--transcribe`'s own argument bundle: `--exclude-pid` is
/// required here too (§A5: "same self-exclusion semantics... as
/// capture"), plus the BCP-47 `--locale`; `--duration`/`--contextual-json`
/// are optional (the former mirrors capture's own optional `--duration`,
/// same meaning: self-stop after N seconds, used for testing).
/// Dual-capture mic producer — `source` is ALWAYS resolved by the time
/// this struct exists (parseArguments defaults a bare `--transcribe`,
/// with no `--source` at all, to `.system` — see that function's own
/// comment), so this is a plain non-optional `TranscribeSource`, never
/// the raw optional string `--source`/`--target` share with translate
/// mode below.
struct TranscribeArguments {
    let excludePID: pid_t
    let locale: String
    let durationSeconds: Double?
    let contextualJSON: String?
    let source: TranscribeSource
}

/// v0.6 (Apple on-device translate lane) — `--probe-translate`'s and
/// `--translate`'s shared argument bundle: just the BCP-47 source/target
/// pair, nothing else (no `--exclude-pid`/`--locale`/`--duration` — this
/// mode has no CoreAudio tap and no SpeechAnalyzer locale to resolve).
struct TranslateArguments {
    let source: String
    let target: String
}

// S9.2 — the CLI's two mutually-exclusive modes: live capture (the
// original S9.1 shape, requires --exclude-pid) and --sweep-orphans (the
// startup best-effort aggregate-device cleanup, OrphanSweep.swift —
// takes no other arguments at all, needs no pid).
// S11 (§2.1) adds three more, all macOS-26-gated independently at the
// entry-point dispatch below (see this file's own comment there):
// `--transcribe` (the new SpeechAnalyzer lane), `--probe-osspeech`
// (one-shot capability probe, no other arguments — same "whole argv"
// shape as --sweep-orphans), and `--preinstall-osspeech` (background
// asset warm-up, `--locale` only).
// v0.6 adds two more, same macOS-26-gated-independently-at-dispatch
// posture: `--probe-translate` (one-shot Translation-framework
// capability probe for a source/target pair) and `--translate` (the
// long-lived, stay-warm Translation session — mirrors `--transcribe`'s
// own "spawn once, keep running" lifecycle, not `--probe-translate`'s
// one-shot shape).
enum CLIMode {
    case capture(CLIArguments)
    case sweepOrphans
    case transcribe(TranscribeArguments)
    case probeOsSpeech
    case preinstallOsSpeech(locale: String)
    case probeTranslate(TranslateArguments)
    case translate(TranslateArguments)
}

func parseArguments(_ arguments: [String]) -> CLIMode? {
    if arguments.count == 2, arguments[1] == "--sweep-orphans" {
        return .sweepOrphans
    }
    if arguments.count == 2, arguments[1] == "--probe-osspeech" {
        return .probeOsSpeech
    }

    var excludePID: pid_t?
    var durationSeconds: Double?
    var locale: String?
    var contextualJSON: String?
    var source: String?
    var target: String?
    var wantsTranscribe = false
    var wantsPreinstall = false
    var wantsProbeTranslate = false
    var wantsTranslate = false
    var index = 1
    while index < arguments.count {
        switch arguments[index] {
        case "--exclude-pid":
            guard index + 1 < arguments.count, let value = Int32(arguments[index + 1]) else { return nil }
            excludePID = pid_t(value)
            index += 2
        case "--duration":
            guard index + 1 < arguments.count, let value = Double(arguments[index + 1]), value > 0 else { return nil }
            durationSeconds = value
            index += 2
        case "--transcribe":
            wantsTranscribe = true
            index += 1
        case "--preinstall-osspeech":
            wantsPreinstall = true
            index += 1
        case "--probe-translate":
            wantsProbeTranslate = true
            index += 1
        case "--translate":
            wantsTranslate = true
            index += 1
        case "--locale":
            guard index + 1 < arguments.count else { return nil }
            locale = arguments[index + 1]
            index += 2
        case "--contextual-json":
            guard index + 1 < arguments.count else { return nil }
            contextualJSON = arguments[index + 1]
            index += 2
        case "--source":
            guard index + 1 < arguments.count else { return nil }
            source = arguments[index + 1]
            index += 2
        case "--target":
            guard index + 1 < arguments.count else { return nil }
            target = arguments[index + 1]
            index += 2
        default:
            return nil
        }
    }

    // v0.6 — --probe-translate/--translate checked before --transcribe/
    // --preinstall-osspeech below so neither can ever fall through into
    // the plain-capture guard at the bottom: both require --source/
    // --target and reject every capture/transcribe-only flag.
    //
    // Dual-capture mic producer — `--source` is now DUAL-PURPOSE: a
    // BCP-47 tag for --probe-translate/--translate (unchanged, above),
    // but mic|system|dual for --transcribe (below). Both branches parse
    // the exact same `source: String?` captured by the shared `case
    // "--source":` arm above (the switch can only match that literal
    // flag text once) — never ambiguous in practice, since
    // wantsProbeTranslate/wantsTranslate/wantsTranscribe are already
    // mutually exclusive here (each guard above rejects the others).
    if wantsProbeTranslate {
        guard !wantsTranslate, !wantsTranscribe, !wantsPreinstall,
            let source, let target,
            excludePID == nil, durationSeconds == nil, locale == nil, contextualJSON == nil
        else { return nil }
        return .probeTranslate(TranslateArguments(source: source, target: target))
    }
    if wantsTranslate {
        guard !wantsTranscribe, !wantsPreinstall,
            let source, let target,
            excludePID == nil, durationSeconds == nil, locale == nil, contextualJSON == nil
        else { return nil }
        return .translate(TranslateArguments(source: source, target: target))
    }
    if wantsTranscribe {
        // §A5: --exclude-pid required in transcribe mode too.
        guard !wantsPreinstall, let excludePID, let locale else { return nil }
        // Absent --source defaults to .system (backward compatible —
        // today's Rust caller passes no flag at all); present-but-unknown
        // is a validation error, same "return nil -> usage + exit(2)"
        // idiom every other malformed flag in this function already uses.
        let transcribeSource: TranscribeSource
        if let source {
            guard let resolved = TranscribeSource(rawValue: source) else { return nil }
            transcribeSource = resolved
        } else {
            transcribeSource = .system
        }
        return .transcribe(TranscribeArguments(excludePID: excludePID, locale: locale, durationSeconds: durationSeconds, contextualJSON: contextualJSON, source: transcribeSource))
    }
    if wantsPreinstall {
        guard let locale, excludePID == nil, durationSeconds == nil, contextualJSON == nil else { return nil }
        return .preinstallOsSpeech(locale: locale)
    }
    guard let excludePID, locale == nil, contextualJSON == nil else { return nil }
    return .capture(CLIArguments(excludePID: excludePID, durationSeconds: durationSeconds))
}

func printUsageAndExit() -> Never {
    let usage = """
    usage: jargonslayer-audiocap --exclude-pid <pid> [--duration <seconds>] \
    | jargonslayer-audiocap --sweep-orphans \
    | jargonslayer-audiocap --transcribe --exclude-pid <pid> --locale <bcp47> [--duration <seconds>] [--contextual-json <jsonArray>] [--source mic|system|dual] \
    | jargonslayer-audiocap --probe-osspeech \
    | jargonslayer-audiocap --preinstall-osspeech --locale <bcp47> \
    | jargonslayer-audiocap --probe-translate --source <bcp47> --target <bcp47> \
    | jargonslayer-audiocap --translate --source <bcp47> --target <bcp47>\n
    """
    // F12 follow-up (lead): throwing write, same NSException class as
    // Writer/StatusEvents — a closed stderr must not crash even here.
    try? FileHandle.standardError.write(contentsOf: Data(usage.utf8))
    exit(2)
}

/// `--sweep-orphans` mode's own entry point — no ring/tap/writer thread,
/// no signal handling, just a one-shot enumerate+destroy+report+exit.
/// Gated the same `@available` way as `runCapture` (see this file's own
/// entry-point comment) purely for uniform CLI behavior below the
/// floor; OrphanSweep's own CoreAudio calls don't actually require
/// 14.2+ (see that file's own doc comment).
@available(macOS 14.2, *)
func runSweepOrphans() -> Never {
    let destroyed = OrphanSweep.sweep()
    StatusEvents.emitNote(state: "swept", message: "\(destroyed) orphan(s)")
    exit(0)
}

@available(macOS 14.2, *)
func runCapture(excludePID: pid_t, durationSeconds: Double?) -> Never {
    let shutdown = ShutdownSignal()
    shutdown.installSignalHandlers()
    shutdown.startStdinEOFMonitor()

    var tapID: AudioObjectID?
    var aggregateDeviceID: AudioObjectID?
    var ioProcID: AudioDeviceIOProcID?

    func teardownAndExit(code: Int32) -> Never {
        ProcessTapCapture.teardown(tapID: tapID, aggregateDeviceID: aggregateDeviceID, ioProcID: ioProcID)
        exit(code)
    }

    do {
        // A NONEXISTENT pid and an alive-but-never-audio-active pid are
        // indistinguishable at the HAL (both answer noErr +
        // kAudioObjectUnknown — translateExcludePID's doc comment), so
        // liveness is checked here via POSIX first: kill(pid, 0) == 0
        // means alive-and-ours (the parent app always is); -1/EPERM
        // means alive-but-not-ours; -1/ESRCH means the pid doesn't
        // exist at all — a caller bug, kept as the hard typed error it
        // always was (and the no-CoreAudio-touched negative-test path:
        // `--exclude-pid 99999999`).
        guard kill(excludePID, 0) == 0 || errno == EPERM else {
            throw AudioCapError.pidTranslateFailed("pid \(excludePID) does not exist (kill(pid, 0) -> ESRCH)")
        }

        let processObjectID = try ProcessTapCapture.translateExcludePID(excludePID)
        if processObjectID == nil {
            // Blueprint D3 as amended (2026-07-13 spike finding): the
            // exclude PID has no HAL process object — it has never
            // played/captured audio, so it cannot be tapped either;
            // proceed with an empty exclusion list, but say so loudly.
            StatusEvents.emitNote(
                state: "exclude-pid-inactive",
                message: "pid \(excludePID) has no CoreAudio process object (never audio-active) — nothing to exclude; proceeding with a global tap and an empty exclusion list"
            )
        }

        let created = try ProcessTapCapture.createProcessTap(excluding: processObjectID, name: "JargonSlayer System Audio Tap")
        tapID = created.tapID
        let format = created.format

        guard TapFormatDescription.isFloat32(format) else {
            throw AudioCapError.tapCreateFailed(
                "tap format is not Float32 (formatID \(format.mFormatID), flags \(format.mFormatFlags), bitsPerChannel \(format.mBitsPerChannel)) — jargonslayer-audiocap only knows how to forward Float32 tap output"
            )
        }
        let isNonInterleaved = TapFormatDescription.isNonInterleaved(format)
        let channels = UInt16(TapFormatDescription.channelCount(format))
        let sampleRate = UInt32(format.mSampleRate)

        let aggregateUID = "com.bioinfospace.jargonslayer.audiocap." + UUID().uuidString
        let resolvedAggregateDeviceID = try ProcessTapCapture.createAggregateDevice(
            uid: aggregateUID,
            name: "JargonSlayer Audio Capture",
            tapUID: created.tapUID
        )
        aggregateDeviceID = resolvedAggregateDeviceID

        let ring = SPSCByteRing(capacity: ringCapacityBytes)
        let ioBlock: AudioDeviceIOBlock = { _, inInputData, _, _, _ in
            // REALTIME THREAD — no allocation, no locks, no I/O, no
            // logging, no Swift runtime traps below this line. UnsafeMutable
            // AudioBufferListPointer is a non-allocating pointer wrapper
            // over the AudioBufferList CoreAudio already handed us; tryPush
            // only ever memcpys into the preallocated ring and does an
            // atomic store to publish — see Ring.swift.
            let bufferList = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
            var frameCount: UInt32 = 0
            if let first = bufferList.first, first.mDataByteSize > 0 {
                let bytesPerChannelFrame = isNonInterleaved ? 4 : Int(channels) * 4
                frameCount = bytesPerChannelFrame > 0 ? UInt32(Int(first.mDataByteSize) / bytesPerChannelFrame) : 0
            }
            ring.tryPush(frameCount: frameCount, buffers: bufferList)
        }
        let resolvedIOProcID = try ProcessTapCapture.createIOProc(aggregateDeviceID: resolvedAggregateDeviceID, block: ioBlock)
        ioProcID = resolvedIOProcID

        // Stream header + "starting" status: both emitted once the real
        // tap format is known but BEFORE AudioDeviceStart — the call D1
        // documents as where the TCC prompt actually fires.
        //
        // F12 follow-up (lead): this write sits AFTER tap/aggregate/
        // IOProc creation — the one place the raising FileHandle.write
        // could crash past teardown and leak them. A failed header
        // write means the parent is already gone; throw so the normal
        // catch -> teardownAndExit path runs (the error record's own
        // write is itself failure-safe by then — StatusEvents post-F12).
        do {
            try FileHandle.standardOutput.write(contentsOf: Data(Framing.encodeStreamHeader(sampleRate: sampleRate, channels: channels)))
        } catch {
            throw AudioCapError.deviceStartFailed("stdout closed before the stream header could be written (parent process gone) — tearing down")
        }
        StatusEvents.emitStatus(state: "starting", sampleRate: sampleRate, channels: channels)

        try ProcessTapCapture.start(aggregateDeviceID: resolvedAggregateDeviceID, ioProcID: resolvedIOProcID)
        StatusEvents.emitStatus(state: "capturing", sampleRate: sampleRate, channels: channels)

        let durationDeadline = durationSeconds.map { Date().addingTimeInterval($0) }
        // F12 (adversarial-review fix round): a failed stdout write
        // (closed parent pipe — EPIPE) is wired to the SAME shutdown
        // mechanism SIGTERM/SIGINT/stdin-EOF already use, so `run`'s own
        // `shouldStop` check below picks it up and this reaches the
        // normal graceful teardown path instead of crashing.
        let writer = Writer(
            ring: ring, sampleRate: sampleRate, channels: channels, isNonInterleaved: isNonInterleaved,
            onWriteFailure: shutdown.requestShutdownFromWriteFailure
        )
        let stopReason = writer.run {
            shutdown.isRequested() || (durationDeadline.map { Date() >= $0 } ?? false)
        }

        // Teardown order per the S9.1 deliverable list: stop -> destroy
        // IOProc -> destroy aggregate -> destroy tap -> (write EOS ->
        // exit 0, ONLY for a requested stop — see below). stopDevice is
        // called BEFORE the writer's true final drain
        // (Writer.drainRemaining/stopDevice's own doc comments) —
        // AudioDeviceStop returning is what actually guarantees the
        // IOProc can't push any more audio into the ring, which is what
        // makes that drain the real last one rather than a racy one.
        // Unchanged for BOTH stop reasons — F6: "run full teardown"
        // applies just as much to a starvation-triggered stop as a
        // requested one.
        ProcessTapCapture.stopDevice(aggregateDeviceID: resolvedAggregateDeviceID, ioProcID: resolvedIOProcID)
        writer.drainRemaining()
        ProcessTapCapture.teardown(tapID: tapID, aggregateDeviceID: aggregateDeviceID, ioProcID: ioProcID)
        writer.emitFinalStats()

        switch stopReason {
        case .requested:
            writer.writeEOS()
            exit(0)
        case .starved:
            // F6: no EOS — an EOS record claims a clean, complete
            // stream, and a starvation-truncated one is deliberately
            // not represented as one (mirrors the catch blocks below,
            // which also never write EOS on an error exit). Rust maps
            // this typed code to StatusKind::DeviceChanged via the
            // SAME deferred "last error code wins at exit" path
            // permission-denied/unsupported-os already use — see
            // audiocap.rs's error_record_kind.
            StatusEvents.emitError(.deviceChanged("音频设备停止供给（设备切换或系统休眠）— 请重新开始转录"))
            exit(1)
        }
    } catch let error as AudioCapError {
        StatusEvents.emitError(error)
        teardownAndExit(code: 1)
    } catch {
        StatusEvents.emitError(.deviceStartFailed("unexpected error: \(error)"))
        teardownAndExit(code: 1)
    }
}

// S11 (§2.1/§Q4) — `--probe-osspeech`: one shot, no CoreAudio, no tap.
// `SpeechTranscriber.isAvailable` is a plain sync Bool (spike-verified);
// `supportedLocales`/`installedLocales` are async, only queried when
// available at all — the same "top-level Task + DispatchSemaphore to
// park the process" bridge runTranscribe uses below, just for a single
// quick async readout rather than a whole session.
@available(macOS 26.0, *)
func runProbe() -> Never {
    let semaphore = DispatchSemaphore(value: 0)
    var supported = false
    var locales: [String] = []
    var installed: [String] = []
    Task {
        supported = SpeechTranscriber.isAvailable
        if supported {
            locales = await SpeechTranscriber.supportedLocales.map(\.identifier)
            installed = await SpeechTranscriber.installedLocales.map(\.identifier)
        }
        semaphore.signal()
    }
    semaphore.wait()
    TranscriptEvents.emitProbe(supported: supported, locales: locales, installed: installed)
    exit(0)
}

// S11 (§A2/§2.1) — `--preinstall-osspeech`: locale resolve + asset
// ensure only, via the SAME AnalyzerSeam `run`/`preinstall` a real
// transcribe session uses for its own asset step (SpeechAnalyzerSession
// .swift) — no tap, no ring, no analyzer.
@available(macOS 26.0, *)
func runPreinstall(locale: String) -> Never {
    let semaphore = DispatchSemaphore(value: 0)
    var outcome = SpeechSessionOutcome.failure
    Task {
        outcome = await SpeechAnalyzerSession().preinstall(locale: locale)
        semaphore.signal()
    }
    semaphore.wait()
    exit(outcome == .success ? 0 : 1)
}

// v0.6 — DEVIATION from the "same Task+DispatchSemaphore bridge every
// other async-CLI entry point in this file uses" instruction, found
// EMPIRICALLY, not guessed at: that exact bridge (a plain
// `DispatchSemaphore.wait()` blocking the calling thread while a `Task`
// runs the real `await`) is what runProbe/runPreinstall/runTranscribe
// all already use successfully for Speech.framework — but reproduced
// live, it DEADLOCKS for Translation.framework's `LanguageAvailability
// .status(from:to:)`/`TranslationSession.translations(from:)` instead
// (confirmed with a throwaway standalone `swiftc`-compiled repro OUTSIDE
// this package too, ruling out anything SwiftPM-specific). Near-certain
// cause: Translation.framework, designed first for SwiftUI's
// `.translationTask` modifier, delivers its async result via a hop that
// needs the calling thread's RUN LOOP actually pumped (an XPC reply,
// most likely) — a bare semaphore-blocked thread never services that.
// Spinning `RunLoop.current` while polling a completion flag — instead
// of blocking outright — keeps whatever Translation.framework needs the
// run loop for able to run, and resolved the deadlock in the same
// standalone repro before this fix was ever applied here. Scoped to
// ONLY the two Translation-framework call sites below
// (runProbeTranslate/handleTranslateRequestLine) — every other async
// bridge in this file is unchanged.
/// MEDIUM-3 fix (v0.6 round-2 review): a lock-protected box for
/// `runOnMainRunLoop`'s own result, same `@unchecked Sendable` + NSLock
/// shape as SpeechAnalyzerSession.swift's own `ResultsErrorBox`/
/// `StopReasonBox`/`FatalErrorBox`/`DownloadOutcomeBox` (this file's own
/// established pattern for "a value written once from an escaping Task
/// closure, read from elsewhere with no other synchronization"), just
/// generic over `T` since this one's shared by two different result
/// types (`LanguageAvailability.Status` in `runProbeTranslate`,
/// `TranslationOutcome` in `handleTranslateRequestLine`). Fixes a real
/// data race (c): the OLD code's bare `var result: T?`, captured by the
/// escaping `Task` below and polled from the `while` loop with no
/// synchronization at all, since `body()`'s own internal `await` can
/// resume the Task off the main thread while the `while` loop reads
/// `result` synchronously ON the main thread.
@available(macOS 26.0, *)
private final class RunLoopPumpBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: T?
    func record(_ value: T) {
        lock.lock(); defer { lock.unlock() }
        if stored == nil { stored = value }
    }
    var value: T? {
        lock.lock(); defer { lock.unlock() }
        return stored
    }
}

/// Bounded now (MEDIUM-3 fix, v0.6 round-2 review) — the old version was
/// a bare `while result == nil { RunLoop.current.run(...) }` with two
/// real problems on top of the data race `RunLoopPumpBox` above closes:
/// (a) `RunLoop.run(mode:before:)` returns IMMEDIATELY, without actually
/// waiting, whenever this mode has no input source attached to it yet —
/// so a `body()` that hasn't resumed could busy-spin this loop at 100%
/// of a core instead of idling (the `Thread.sleep` below caps that); (b)
/// there was no DEADLINE at all — if `body()` never resumes (a cold
/// `LanguageAvailability`/`TranslationSession` call that never completes
/// its own XPC round trip), this call never returned, and since it
/// always runs on the MAIN thread, that permanently stopped
/// `--translate`'s own stdin read loop too (`runTranslate` below),
/// leaving the child alive-but-deaf forever — a hung request took the
/// whole warm session down with it, not just itself. Returns `nil` on
/// timeout instead of hanging forever; both call sites below emit their
/// own `{"kind":"error"}` record and continue (`runProbeTranslate` exits
/// non-zero since it has no loop to keep alive; `handleTranslateRequestLine`
/// simply returns, so `runTranslate`'s stdin loop keeps reading the NEXT
/// request line). Default kept safely under Rust's own systranslate.rs
/// `TRANSLATE_TIMEOUT` (10s) so this process's own clean error record
/// reaches Rust before Rust's hard `child.kill()` would.
@available(macOS 26.0, *)
func runOnMainRunLoop<T>(timeout: TimeInterval = 8.0, _ body: @escaping () async -> T) -> T? {
    let box = RunLoopPumpBox<T>()
    Task {
        box.record(await body())
    }
    let deadline = Date().addingTimeInterval(timeout)
    while box.value == nil {
        if Date() >= deadline { return nil }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
        // See (a) above — RunLoop.run(mode:before:) can return instantly
        // with nothing to wait on; this keeps a not-yet-resumed body()
        // from busy-spinning a full core in the meantime.
        Thread.sleep(forTimeInterval: 0.005)
    }
    return box.value
}

// v0.6 (Apple on-device translate lane) — `--probe-translate`: one shot,
// no CoreAudio, no tap, same shape as `--probe-osspeech`'s own runProbe
// above. `LanguageAvailability.status(from:to:)` is async (spike-
// verified) — bridged via `runOnMainRunLoop` above (NOT the semaphore
// bridge every other mode uses — see that function's own doc comment
// for why).
@available(macOS 26.0, *)
func runProbeTranslate(source: String, target: String) -> Never {
    let outcome = runOnMainRunLoop {
        await LanguageAvailability().status(
            from: Locale.Language(identifier: source),
            to: Locale.Language(identifier: target)
        )
    }
    // MEDIUM-3 fix: runOnMainRunLoop now returns nil on its own bounded
    // timeout instead of hanging forever — a one-shot mode like this one
    // has no stdin loop to keep alive either way, so timing out here
    // just means reporting a clean error and exiting non-zero (Rust's
    // own system_translate_probe also has its own timeout now, as a
    // second, independent backstop — see that command's own doc comment).
    guard let status = outcome else {
        TranslateEvents.emitError(id: nil, code: "timeout", message: "timed out waiting for LanguageAvailability().status(...)")
        exit(1)
    }
    // osSupported is unconditionally true here: this function only ever
    // runs once the dispatch switch below has already confirmed macOS
    // 26+ via `#available` — the `osSupported:false` wire value is the
    // OTHER branch of that switch's own fallback, reached without ever
    // calling into Translation.framework at all.
    TranslateEvents.emitProbe(osSupported: true, status: translateStatusWireValue(status))
    exit(0)
}

/// `LanguageAvailability.Status` -> the probe wire contract's own three
/// string values (spike-verified case list: `.installed`/`.supported`/
/// `.unsupported`; NOT `@frozen`, so `@unknown default` folds any future
/// case back to "unsupported" rather than crashing — same defensive
/// posture this file already takes toward other closed-set OS enums,
/// e.g. TranscriptEvents' own `statusLabel`-shaped switches).
@available(macOS 26.0, *)
func translateStatusWireValue(_ status: LanguageAvailability.Status) -> String {
    switch status {
    case .installed: return "installed"
    case .supported: return "supported"
    case .unsupported: return "unsupported"
    @unknown default: return "unsupported"
    }
}

// v0.6 — `--translate`: long-lived, mirrors `--transcribe`'s own
// stay-warm lifecycle (T1: "NOT per-batch spawn — the session must stay
// warm"). Session construction itself is a plain, non-throwing,
// non-async convenience init (spike-verified:
// `TranslationSession(installedSource:target:)` constructs successfully
// for ANY pair, even an uninstalled one) — no async bridge needed for
// THAT step, unlike every other entry point in this file. Only the
// per-request `translations(from:)` call is async+throwing, so ONE
// `runOnMainRunLoop` call runs per incoming stdin request line
// (handleTranslateRequestLine below, NOT the semaphore bridge — see
// that function's own doc comment for why), not once for the whole
// process — the session itself stays warm across every request. The
// read loop itself reuses StdinCommandMonitor's own line-reassembly ALGORITHM
// (buffer + split on 0x0A) inline rather than that type itself: this
// mode's stdin lines are structured translate requests, not
// StdinCommandMonitor's own hardcoded pause/resume vocabulary, and (per
// §A1's "the ONLY stdin reader" rule one mode over) there is no second
// thread here to race against — one blocking read loop on the main
// thread is enough since --translate has no realtime audio producer to
// keep servicing concurrently.
@available(macOS 26.0, *)
func runTranslate(source: String, target: String) -> Never {
    let session = TranslationSession(
        installedSource: Locale.Language(identifier: source),
        target: Locale.Language(identifier: target)
    )
    TranslateEvents.emitReady()

    let input = FileHandle.standardInput
    var buffer = Data()
    while true {
        let chunk = input.availableData
        if chunk.isEmpty {
            break // EOF — the parent closed stdin; exit cleanly below.
        }
        buffer.append(chunk)
        while let newlineIndex = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer[buffer.startIndex..<newlineIndex]
            buffer.removeSubrange(buffer.startIndex...newlineIndex)
            handleTranslateRequestLine(String(decoding: lineData, as: UTF8.self), session: session)
        }
    }
    exit(0)
}

/// The `--translate` mode's own stdin wire shape (T1) — a private
/// Decodable pair, decode-only (main.swift never encodes this shape;
/// TranslateEvents.TranslationOut is the encode-only analog for the
/// OUTGOING `result` side).
private struct TranslateRequestLine: Decodable {
    let id: String
    let segments: [Segment]

    struct Segment: Decodable {
        let id: String
        let text: String
    }
}

/// One incoming `{"id":...,"segments":[{"id":...,"text":...}]}` line. A
/// line that isn't valid JSON in that exact shape is reported back as a
/// `kind:"error"` with no `id` (there's no request id to correlate
/// against — it was never decoded far enough to learn one) and the read
/// loop simply continues — malformed input is never a reason to tear
/// down an otherwise-healthy warm session.
@available(macOS 26.0, *)
func handleTranslateRequestLine(_ line: String, session: TranslationSession) {
    guard let data = line.data(using: .utf8),
        let request = try? JSONDecoder().decode(TranslateRequestLine.self, from: data)
    else {
        TranslateEvents.emitError(id: nil, code: "failed", message: "malformed translate request line")
        return
    }

    let requests = request.segments.map { segment in
        TranslationSession.Request(sourceText: segment.text, clientIdentifier: segment.id)
    }

    // `TranslationOutcome` carries the batch result (or a typed failure)
    // out of the `runOnMainRunLoop` closure below — a local type rather
    // than a top-level one since nothing outside this function needs it.
    enum TranslationOutcome {
        case ok([TranslationSession.Response])
        case notInstalled
        case failed(String)
    }
    let pumpResult = runOnMainRunLoop { () -> TranslationOutcome in
        do {
            return .ok(try await session.translations(from: requests))
        } catch TranslationError.notInstalled {
            // Spike-verified: matched via TranslationError's own `~=`
            // pattern operator (no Equatable conformance), not `==`.
            return .notInstalled
        } catch {
            return .failed("\(error)")
        }
    }
    // MEDIUM-3 fix: runOnMainRunLoop now returns nil on its own bounded
    // timeout instead of hanging forever (which — since it always runs
    // on the main thread — used to also permanently stop THIS loop's own
    // caller, runTranslate's stdin read loop below, wedging the whole
    // warm session over one stuck request). On timeout, report a clean
    // per-request error and `return` (not `exit`) — runTranslate's own
    // `while true` loop keeps reading the NEXT stdin line right after.
    guard let outcome = pumpResult else {
        TranslateEvents.emitError(id: request.id, code: "timeout", message: "timed out waiting for session.translations(from:)")
        return
    }

    let responses: [TranslationSession.Response]
    switch outcome {
    case .ok(let value):
        responses = value
    case .notInstalled:
        TranslateEvents.emitError(id: request.id, code: "not-installed", message: "translation language pack not installed")
        return
    case .failed(let message):
        TranslateEvents.emitError(id: request.id, code: "failed", message: message)
        return
    }

    // Re-correlate by clientIdentifier (== segment id) rather than
    // trusting `responses`' own array order to already match
    // `request.segments`' order — the wire contract requires order
    // preserved against the ORIGINAL segments regardless of what the
    // framework's own batch-return order turns out to be. A duplicate
    // key (a caller-sent duplicate segment id) keeps the FIRST response
    // seen for it rather than trapping — `Dictionary(uniqueKeysWithValues:)`
    // would crash this long-lived process over one malformed request.
    var textByID: [String: String] = [:]
    for response in responses {
        guard let id = response.clientIdentifier, textByID[id] == nil else { continue }
        textByID[id] = response.targetText
    }
    let translations = request.segments.map { segment in
        TranslateEvents.TranslationOut(id: segment.id, text: textByID[segment.id] ?? segment.text)
    }
    TranslateEvents.emitResult(id: request.id, translations: translations)
}

// Dual-capture mic producer — `--transcribe`'s own `--source` dispatcher:
// forks to one of three bodies below by audio producer. `runTranscribeSystem`
// is the pre-existing S11 body, renamed but otherwise BYTE-IDENTICAL
// (source=system, the default, is "unchanged behavior" per this slice's
// own spec) — see that function's own header comment for the full
// CoreAudio-setup rationale, not repeated on the other two.
@available(macOS 26.0, *)
func runTranscribe(excludePID: pid_t, locale: String, durationSeconds: Double?, contextualJSON: String?, source: TranscribeSource) -> Never {
    switch source {
    case .system:
        runTranscribeSystem(excludePID: excludePID, locale: locale, durationSeconds: durationSeconds, contextualJSON: contextualJSON)
    case .mic:
        runTranscribeMic(locale: locale, durationSeconds: durationSeconds, contextualJSON: contextualJSON)
    case .dual:
        runTranscribeDual(excludePID: excludePID, locale: locale, durationSeconds: durationSeconds, contextualJSON: contextualJSON)
    }
}

// S11 (§0/§Q1) — `--transcribe --source system` (the default): reuses
// the EXACT same CoreAudio setup as runCapture above (translate/create
// tap/create aggregate/create IOProc — byte-identical calls into
// AudioCapCore, see each step's own comment in runCapture for the full
// rationale, not repeated here) up through the ring/ioBlock, then hands
// off to `AnalyzerSeam` for everything Speech-related (locale/asset/
// analyzer/results/finalize). Two deliberate deltas from runCapture: (1)
// no stdout Framing stream header/chunks/EOS at all — blueprint §0: "no
// PCM ever leaves the process, and no stdout wire is used"; (2)
// `ShutdownSignal.startStdinEOFMonitor()` is NOT called — §A1:
// `StdinCommandMonitor` is the ONLY stdin reader in transcribe mode (two
// threads reading the same stdin would race and split lines
// unpredictably); EOF handling lives in StdinCommandMonitor's own
// `onEOF` callback instead, wired to the SAME shared shutdown flag via
// `requestShutdownFromWriteFailure` (reused purely for its mechanical
// effect — see that method's own doc comment on why a write failure and
// a stdin EOF are the same "the parent is gone" signal, just observed
// from opposite directions).
@available(macOS 26.0, *)
func runTranscribeSystem(excludePID: pid_t, locale: String, durationSeconds: Double?, contextualJSON: String?) -> Never {
    let shutdown = ShutdownSignal()
    shutdown.installSignalHandlers()
    let stdinMonitor = StdinCommandMonitor(onEOF: shutdown.requestShutdownFromWriteFailure)
    stdinMonitor.start()

    var tapID: AudioObjectID?
    var aggregateDeviceID: AudioObjectID?
    var ioProcID: AudioDeviceIOProcID?

    func teardownAndExit(code: Int32) -> Never {
        ProcessTapCapture.teardown(tapID: tapID, aggregateDeviceID: aggregateDeviceID, ioProcID: ioProcID)
        exit(code)
    }

    do {
        // Same self-exclusion precheck as capture (§A5): a nonexistent
        // pid is a caller bug (hard typed error); alive-but-not-ours
        // (EPERM) is fine — see runCapture's own comment on this exact
        // check for the full rationale.
        guard kill(excludePID, 0) == 0 || errno == EPERM else {
            throw AudioCapError.pidTranslateFailed("pid \(excludePID) does not exist (kill(pid, 0) -> ESRCH)")
        }

        let processObjectID = try ProcessTapCapture.translateExcludePID(excludePID)
        if processObjectID == nil {
            // §A5/D3 amendment: HAL-absent exclude PID -> empty exclusion
            // + note, identical semantics to runCapture's own handling.
            StatusEvents.emitNote(
                state: "exclude-pid-inactive",
                message: "pid \(excludePID) has no CoreAudio process object (never audio-active) — nothing to exclude; proceeding with a global tap and an empty exclusion list"
            )
        }

        let created = try ProcessTapCapture.createProcessTap(excluding: processObjectID, name: "JargonSlayer System Audio Tap (Transcribe)")
        tapID = created.tapID
        let format = created.format

        guard TapFormatDescription.isFloat32(format) else {
            throw AudioCapError.tapCreateFailed(
                "tap format is not Float32 (formatID \(format.mFormatID), flags \(format.mFormatFlags), bitsPerChannel \(format.mBitsPerChannel)) — jargonslayer-audiocap only knows how to forward Float32 tap output"
            )
        }
        let isNonInterleaved = TapFormatDescription.isNonInterleaved(format)
        let channels = UInt16(TapFormatDescription.channelCount(format))
        let sampleRate = UInt32(format.mSampleRate)

        let aggregateUID = "com.bioinfospace.jargonslayer.audiocap.osspeech." + UUID().uuidString
        let resolvedAggregateDeviceID = try ProcessTapCapture.createAggregateDevice(
            uid: aggregateUID,
            name: "JargonSlayer System Audio Transcribe",
            tapUID: created.tapUID
        )
        aggregateDeviceID = resolvedAggregateDeviceID

        let ring = SPSCByteRing(capacity: ringCapacityBytes)
        let ioBlock: AudioDeviceIOBlock = { _, inInputData, _, _, _ in
            // REALTIME THREAD — identical contract to runCapture's own
            // ioBlock (never touches Speech/AVFoundation, just
            // ring.tryPush — see that closure's own comment).
            let bufferList = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
            var frameCount: UInt32 = 0
            if let first = bufferList.first, first.mDataByteSize > 0 {
                let bytesPerChannelFrame = isNonInterleaved ? 4 : Int(channels) * 4
                frameCount = bytesPerChannelFrame > 0 ? UInt32(Int(first.mDataByteSize) / bytesPerChannelFrame) : 0
            }
            ring.tryPush(frameCount: frameCount, buffers: bufferList)
        }
        let resolvedIOProcID = try ProcessTapCapture.createIOProc(aggregateDeviceID: resolvedAggregateDeviceID, block: ioBlock)
        ioProcID = resolvedIOProcID

        // No stdout stream header (unlike runCapture) — transcribe mode
        // never opens the Framing/stdout wire at all (blueprint §0).
        // "starting" is still emitted, reused unchanged (§2.2), as soon
        // as the tap's real format is known — same placement/semantics
        // as runCapture's own "starting" emission.
        StatusEvents.emitStatus(state: "starting", sampleRate: sampleRate, channels: channels)

        let semaphore = DispatchSemaphore(value: 0)
        var outcome = SpeechSessionOutcome.failure
        Task {
            outcome = await SpeechAnalyzerSession().run(
                locale: locale,
                contextualJSON: contextualJSON,
                durationSeconds: durationSeconds,
                ring: ring,
                channels: channels,
                isNonInterleaved: isNonInterleaved,
                sampleRate: sampleRate,
                shutdown: shutdown,
                isPaused: stdinMonitor.isPaused,
                startTap: {
                    try ProcessTapCapture.start(aggregateDeviceID: resolvedAggregateDeviceID, ioProcID: resolvedIOProcID)
                },
                stopTap: {
                    ProcessTapCapture.stopDevice(aggregateDeviceID: resolvedAggregateDeviceID, ioProcID: resolvedIOProcID)
                }
            )
            semaphore.signal()
        }
        semaphore.wait()

        // AnalyzerSeam.run already called `stopTap` (== stopDevice) at
        // the correct point in its own teardown sequence (see that
        // protocol requirement's own doc comment) — this final
        // `teardown` call's own redundant stopDevice is the same
        // harmless no-op ProcessTapCapture.teardown's doc comment
        // already documents, unconditionally regardless of how far the
        // session got (mirrors runCapture's own catch-all teardown).
        ProcessTapCapture.teardown(tapID: tapID, aggregateDeviceID: aggregateDeviceID, ioProcID: ioProcID)
        exit(outcome == .success ? 0 : 1)
    } catch let error as AudioCapError {
        StatusEvents.emitError(error)
        teardownAndExit(code: 1)
    } catch {
        StatusEvents.emitError(.deviceStartFailed("unexpected error: \(error)"))
        teardownAndExit(code: 1)
    }
}

// Dual-capture mic producer — `--transcribe --source mic`: same session
// structure as runTranscribeSystem immediately above (shutdown/stdin
// lifecycle, "starting"/"capturing"/"finished" status reused unchanged
// at the SAME emission sites — §2.2's own state machine, never forked),
// but the ring is fed by MicCapture instead of a CoreAudio tap: no
// CATapDescription/aggregate/IOProc at all, so `excludePID` (meaningful
// only for excluding a process from a system-audio TAP) plays no role
// here and this function simply never asks for one. `channel` is left
// at `run`'s own default (`nil`) — a single-source run, mic alone, is
// exactly as unambiguous as system alone (this slice's own "single-
// source runs stay byte-identical to today's protocol" requirement).
@available(macOS 26.0, *)
func runTranscribeMic(locale: String, durationSeconds: Double?, contextualJSON: String?) -> Never {
    let shutdown = ShutdownSignal()
    shutdown.installSignalHandlers()
    let stdinMonitor = StdinCommandMonitor(onEOF: shutdown.requestShutdownFromWriteFailure)
    stdinMonitor.start()

    let ring = SPSCByteRing(capacity: ringCapacityBytes)
    let micCapture = MicCapture(ring: ring)

    func teardownAndExit(code: Int32) -> Never {
        // MicCapture.stop()'s own doc comment: safe to call even if
        // setup()/start() never got far enough to need it (engine.stop()
        // on a never-started engine, removeTap on a bus with no tap
        // installed, are both documented no-ops).
        micCapture.stop()
        exit(code)
    }

    do {
        let sampleRate = try micCapture.setup()
        let channels: UInt16 = 1 // MicCapture always extracts channel 0 only — see its own header comment.

        // No stdout stream header (transcribe mode never opens the
        // Framing/stdout wire — see runTranscribeSystem's own comment).
        // "starting" reused unchanged (§2.2) at the same placement
        // semantics: emitted once the mic's real format is known, same
        // as runTranscribeSystem's own "starting" emission once the
        // tap's format is known.
        StatusEvents.emitStatus(state: "starting", sampleRate: sampleRate, channels: channels)

        let semaphore = DispatchSemaphore(value: 0)
        var outcome = SpeechSessionOutcome.failure
        Task {
            outcome = await SpeechAnalyzerSession().run(
                locale: locale,
                contextualJSON: contextualJSON,
                durationSeconds: durationSeconds,
                ring: ring,
                channels: channels,
                isNonInterleaved: false, // mono — never planar (see MicCapture.extractChannelZeroAndPush)
                sampleRate: sampleRate,
                shutdown: shutdown,
                isPaused: stdinMonitor.isPaused,
                startTap: { try micCapture.start() },
                stopTap: { micCapture.stop() }
            )
            semaphore.signal()
        }
        semaphore.wait()

        // AnalyzerSeam.run already called stopTap (== micCapture.stop())
        // at the correct point in its own teardown — mirrors
        // runTranscribeSystem's own identically-reasoned redundant call
        // just above: a second micCapture.stop() here is a harmless
        // no-op, and also covers the case where `run` threw before ever
        // calling `startTap` at all (e.g. during asset install).
        micCapture.stop()
        exit(outcome == .success ? 0 : 1)
    } catch let error as AudioCapError {
        StatusEvents.emitError(error)
        teardownAndExit(code: 1)
    } catch {
        StatusEvents.emitError(.deviceStartFailed("unexpected error: \(error)"))
        teardownAndExit(code: 1)
    }
}

// Dual-capture mic producer — `--transcribe --source dual`: the tap
// (system audio, session A) and MicCapture (session B) setups below are
// each byte-identical to their single-source counterparts immediately
// above (see those functions' own comments for the full rationale of
// each individual step, not repeated here) — this function's only real
// job is running BOTH `SpeechAnalyzerSession.run` calls concurrently
// (`async let`, mirroring the aec-spike's own proven `runDualAnalyzer`
// shape) against ONE shared `ShutdownSignal`/`StdinCommandMonitor`, and
// making sure the process-level "starting"/"capturing" status is
// emitted exactly ONCE — from the tap/"system" side, exactly as it is
// today — never doubled by session B's own internal "capturing" emission
// (`emitProcessStatus: false` on that one call; see AnalyzerSeam.run's
// own doc comment). Exit code 0 only if BOTH sessions succeed.
@available(macOS 26.0, *)
func runTranscribeDual(excludePID: pid_t, locale: String, durationSeconds: Double?, contextualJSON: String?) -> Never {
    let shutdown = ShutdownSignal()
    shutdown.installSignalHandlers()
    let stdinMonitor = StdinCommandMonitor(onEOF: shutdown.requestShutdownFromWriteFailure)
    stdinMonitor.start()

    var tapID: AudioObjectID?
    var aggregateDeviceID: AudioObjectID?
    var ioProcID: AudioDeviceIOProcID?
    let ringMic = SPSCByteRing(capacity: ringCapacityBytes)
    let micCapture = MicCapture(ring: ringMic)

    func teardownAndExit(code: Int32) -> Never {
        ProcessTapCapture.teardown(tapID: tapID, aggregateDeviceID: aggregateDeviceID, ioProcID: ioProcID)
        micCapture.stop()
        exit(code)
    }

    do {
        // ---- tap/system side setup (session A) — see runTranscribeSystem's own comments for the full rationale of each step ----
        guard kill(excludePID, 0) == 0 || errno == EPERM else {
            throw AudioCapError.pidTranslateFailed("pid \(excludePID) does not exist (kill(pid, 0) -> ESRCH)")
        }

        let processObjectID = try ProcessTapCapture.translateExcludePID(excludePID)
        if processObjectID == nil {
            StatusEvents.emitNote(
                state: "exclude-pid-inactive",
                message: "pid \(excludePID) has no CoreAudio process object (never audio-active) — nothing to exclude; proceeding with a global tap and an empty exclusion list"
            )
        }

        let created = try ProcessTapCapture.createProcessTap(excluding: processObjectID, name: "JargonSlayer System Audio Tap (Transcribe Dual)")
        tapID = created.tapID
        let format = created.format

        guard TapFormatDescription.isFloat32(format) else {
            throw AudioCapError.tapCreateFailed(
                "tap format is not Float32 (formatID \(format.mFormatID), flags \(format.mFormatFlags), bitsPerChannel \(format.mBitsPerChannel)) — jargonslayer-audiocap only knows how to forward Float32 tap output"
            )
        }
        let isNonInterleaved = TapFormatDescription.isNonInterleaved(format)
        let tapChannels = UInt16(TapFormatDescription.channelCount(format))
        let tapSampleRate = UInt32(format.mSampleRate)

        let aggregateUID = "com.bioinfospace.jargonslayer.audiocap.osspeech.dual." + UUID().uuidString
        let resolvedAggregateDeviceID = try ProcessTapCapture.createAggregateDevice(
            uid: aggregateUID,
            name: "JargonSlayer System Audio Transcribe (Dual)",
            tapUID: created.tapUID
        )
        aggregateDeviceID = resolvedAggregateDeviceID

        let ringTap = SPSCByteRing(capacity: ringCapacityBytes)
        let ioBlock: AudioDeviceIOBlock = { _, inInputData, _, _, _ in
            // REALTIME THREAD — identical contract to runTranscribeSystem's own ioBlock.
            let bufferList = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
            var frameCount: UInt32 = 0
            if let first = bufferList.first, first.mDataByteSize > 0 {
                let bytesPerChannelFrame = isNonInterleaved ? 4 : Int(tapChannels) * 4
                frameCount = bytesPerChannelFrame > 0 ? UInt32(Int(first.mDataByteSize) / bytesPerChannelFrame) : 0
            }
            ringTap.tryPush(frameCount: frameCount, buffers: bufferList)
        }
        let resolvedIOProcID = try ProcessTapCapture.createIOProc(aggregateDeviceID: resolvedAggregateDeviceID, block: ioBlock)
        ioProcID = resolvedIOProcID

        // ---- mic side setup (session B) ----
        let micSampleRate = try micCapture.setup()

        // "starting"/"capturing": emitted ONCE for the process, from the
        // tap side only (this function's own header comment) — session
        // B's own `run` call below passes `emitProcessStatus: false` so
        // its internal "capturing" emission is suppressed; "starting" is
        // simply never called a second time here either.
        StatusEvents.emitStatus(state: "starting", sampleRate: tapSampleRate, channels: tapChannels)

        let semaphore = DispatchSemaphore(value: 0)
        var outcomeA = SpeechSessionOutcome.failure
        var outcomeB = SpeechSessionOutcome.failure
        Task {
            // durationSeconds is force-nil for BOTH dual sessions — the
            // 2026-08-02 spike observed the duration cutoff hanging
            // `run` ≥90s when it lands mid-utterance
            // (dual-capture-2026-08.md §spike 6). Dual's only lifecycle
            // is the shared ShutdownSignal (stdin EOF / signals).
            async let sessionA = SpeechAnalyzerSession().run(
                locale: locale,
                contextualJSON: contextualJSON,
                durationSeconds: nil,
                ring: ringTap,
                channels: tapChannels,
                isNonInterleaved: isNonInterleaved,
                sampleRate: tapSampleRate,
                shutdown: shutdown,
                isPaused: stdinMonitor.isPaused,
                startTap: {
                    try ProcessTapCapture.start(aggregateDeviceID: resolvedAggregateDeviceID, ioProcID: resolvedIOProcID)
                },
                stopTap: {
                    ProcessTapCapture.stopDevice(aggregateDeviceID: resolvedAggregateDeviceID, ioProcID: resolvedIOProcID)
                },
                channel: "system"
            )
            async let sessionB = SpeechAnalyzerSession().run(
                locale: locale,
                contextualJSON: contextualJSON,
                durationSeconds: nil,
                ring: ringMic,
                channels: 1,
                isNonInterleaved: false,
                sampleRate: micSampleRate,
                shutdown: shutdown,
                isPaused: stdinMonitor.isPaused,
                startTap: { try micCapture.start() },
                stopTap: { micCapture.stop() },
                channel: "mic",
                emitProcessStatus: false
            )
            (outcomeA, outcomeB) = await (sessionA, sessionB)
            semaphore.signal()
        }
        semaphore.wait()

        // Both AnalyzerSeam.run calls already called their own stopTap —
        // these two are the same harmless, unconditional redundant calls
        // runTranscribeSystem/runTranscribeMic each make one file above.
        ProcessTapCapture.teardown(tapID: tapID, aggregateDeviceID: aggregateDeviceID, ioProcID: ioProcID)
        micCapture.stop()
        // Dual mode's own exit-code contract (this function's own header
        // comment): 0 only if BOTH sessions succeeded.
        exit(outcomeA == .success && outcomeB == .success ? 0 : 1)
    } catch let error as AudioCapError {
        StatusEvents.emitError(error)
        teardownAndExit(code: 1)
    } catch {
        StatusEvents.emitError(.deviceStartFailed("unexpected error: \(error)"))
        teardownAndExit(code: 1)
    }
}

// ---- entry point (everything above is declarations only) ----

// Ignore SIGPIPE up front: if the parent (Rust) side closes its end of
// our stdout/stderr pipes (e.g. it died) while a write is in flight, the
// default SIGPIPE action would kill this process immediately, bypassing
// the graceful teardown sequence in runCapture — the stdin-EOF monitor
// (started from runCapture) is the intended way this helper notices
// "the parent is gone" and shuts down cleanly instead.
signal(SIGPIPE, SIG_IGN)

guard let cliMode = parseArguments(CommandLine.arguments) else {
    printUsageAndExit()
}

// D1's technical floor (capture/sweep) / S11's own higher floor
// (transcribe/probe/preinstall — SpeechAnalyzer needs macOS 26, strictly
// above 14.2). Reached before ANY CoreAudio OR Speech call — this file
// never spawns a tap-related object, nor touches Speech.framework,
// below the relevant guard. See AudioCapError.unsupportedOS's own doc
// comment for why S9.2's Rust side (capabilities() gating) is the
// primary defense and this is belt-and-suspenders for direct/manual
// invocation.
//
// Each CLIMode case gets its OWN independent `if #available` (§2.1:
// "the three new modes each wrap their body in if #available(macOS
// 26.0,*)") rather than one shared outer gate: capture/sweepOrphans'
// OWN behavior on an unsupported OS is completely unchanged from before
// this slice (same message, same exit(1)) — the two are simply no
// longer expressed as one shared `if/else` now that CLIMode has grown
// three more cases with a DIFFERENT floor. Critically, `--probe-osspeech`
// must NOT be caught by the 14.2 message at all (§2.1: "on <26,
// supported:false without spawning Speech" — that has to work even on
// an OS below 14.2, reporting the PROBE's own unsupported shape, not a
// CoreAudio-flavored error it never asked about).
//
// `if #available ... else` (not `guard #available ... else { exit }`):
// verified empirically that top-level code in a script-mode file like
// this one does NOT carry a `guard`'s availability narrowing forward to
// later top-level statements the way it would inside a function body —
// the compiler still flagged the runCapture call below as unguarded
// with the `guard` form. Wrapping each call itself in `if #available`
// sidesteps that quirk entirely.
switch cliMode {
case .capture(let cliArguments):
    if #available(macOS 14.2, *) {
        runCapture(excludePID: cliArguments.excludePID, durationSeconds: cliArguments.durationSeconds)
    } else {
        StatusEvents.emitError(.unsupportedOS("jargonslayer-audiocap requires macOS 14.2+ (CoreAudio process taps: AudioHardwareCreateProcessTap / CATapDescription's tap-creation entry points)"))
        exit(1)
    }
case .sweepOrphans:
    if #available(macOS 14.2, *) {
        runSweepOrphans()
    } else {
        StatusEvents.emitError(.unsupportedOS("jargonslayer-audiocap requires macOS 14.2+ (CoreAudio process taps: AudioHardwareCreateProcessTap / CATapDescription's tap-creation entry points)"))
        exit(1)
    }
case .transcribe(let transcribeArguments):
    if #available(macOS 26.0, *) {
        runTranscribe(
            excludePID: transcribeArguments.excludePID,
            locale: transcribeArguments.locale,
            durationSeconds: transcribeArguments.durationSeconds,
            contextualJSON: transcribeArguments.contextualJSON,
            source: transcribeArguments.source
        )
    } else {
        StatusEvents.emitError(.unsupportedOS("jargonslayer-audiocap --transcribe requires macOS 26.0+ (Speech framework SpeechAnalyzer)"))
        exit(1)
    }
case .probeOsSpeech:
    if #available(macOS 26.0, *) {
        runProbe()
    } else {
        TranscriptEvents.emitProbe(supported: false, locales: [], installed: [])
        exit(0)
    }
case .preinstallOsSpeech(let locale):
    if #available(macOS 26.0, *) {
        runPreinstall(locale: locale)
    } else {
        StatusEvents.emitError(.unsupportedOS("jargonslayer-audiocap --preinstall-osspeech requires macOS 26.0+ (Speech framework SpeechAnalyzer)"))
        exit(1)
    }
case .probeTranslate(let translateArguments):
    if #available(macOS 26.0, *) {
        runProbeTranslate(source: translateArguments.source, target: translateArguments.target)
    } else {
        // v0.6's own in-band <26 shape (T1's own pinned contract) —
        // NOT the shared AudioCapError.unsupportedOS path: unlike
        // --transcribe/--preinstall-osspeech above, --probe-translate
        // must keep succeeding (exit 0) with an honest
        // "osSupported:false" reading even below the floor, exactly
        // mirroring --probe-osspeech's own <26 branch immediately above.
        TranslateEvents.emitProbe(osSupported: false, status: "unsupported")
        exit(0)
    }
case .translate(let translateArguments):
    if #available(macOS 26.0, *) {
        runTranslate(source: translateArguments.source, target: translateArguments.target)
    } else {
        StatusEvents.emitError(.unsupportedOS("jargonslayer-audiocap --translate requires macOS 26.0+ (Translation framework)"))
        exit(1)
    }
}
