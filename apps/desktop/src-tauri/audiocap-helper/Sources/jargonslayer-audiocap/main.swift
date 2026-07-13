import AudioCapCore
import AudioToolbox
import CoreAudio
import Foundation
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

// S9.2 — the CLI's two mutually-exclusive modes: live capture (the
// original S9.1 shape, requires --exclude-pid) and --sweep-orphans (the
// startup best-effort aggregate-device cleanup, OrphanSweep.swift —
// takes no other arguments at all, needs no pid).
enum CLIMode {
    case capture(CLIArguments)
    case sweepOrphans
}

func parseArguments(_ arguments: [String]) -> CLIMode? {
    if arguments.count == 2, arguments[1] == "--sweep-orphans" {
        return .sweepOrphans
    }

    var excludePID: pid_t?
    var durationSeconds: Double?
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
        default:
            return nil
        }
    }
    guard let excludePID else { return nil }
    return .capture(CLIArguments(excludePID: excludePID, durationSeconds: durationSeconds))
}

func printUsageAndExit() -> Never {
    let usage = "usage: jargonslayer-audiocap --exclude-pid <pid> [--duration <seconds>] | jargonslayer-audiocap --sweep-orphans\n"
    FileHandle.standardError.write(Data(usage.utf8))
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
        FileHandle.standardOutput.write(Data(Framing.encodeStreamHeader(sampleRate: sampleRate, channels: channels)))
        StatusEvents.emitStatus(state: "starting", sampleRate: sampleRate, channels: channels)

        try ProcessTapCapture.start(aggregateDeviceID: resolvedAggregateDeviceID, ioProcID: resolvedIOProcID)
        StatusEvents.emitStatus(state: "capturing", sampleRate: sampleRate, channels: channels)

        let durationDeadline = durationSeconds.map { Date().addingTimeInterval($0) }
        let writer = Writer(ring: ring, sampleRate: sampleRate, channels: channels, isNonInterleaved: isNonInterleaved)
        writer.run {
            shutdown.isRequested() || (durationDeadline.map { Date() >= $0 } ?? false)
        }

        // Teardown order per the S9.1 deliverable list: stop -> destroy
        // IOProc -> destroy aggregate -> destroy tap -> write EOS -> exit 0.
        // stopDevice is called BEFORE the writer's true final drain
        // (Writer.drainRemaining/stopDevice's own doc comments) —
        // AudioDeviceStop returning is what actually guarantees the
        // IOProc can't push any more audio into the ring, which is what
        // makes that drain the real last one rather than a racy one.
        ProcessTapCapture.stopDevice(aggregateDeviceID: resolvedAggregateDeviceID, ioProcID: resolvedIOProcID)
        writer.drainRemaining()
        ProcessTapCapture.teardown(tapID: tapID, aggregateDeviceID: aggregateDeviceID, ioProcID: ioProcID)
        writer.emitFinalStats()
        writer.writeEOS()
        exit(0)
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

// D1's technical floor. Reached before ANY CoreAudio call — this file
// never spawns a tap-related object below this guard. See
// AudioCapError.unsupportedOS's own doc comment for why S9.2's Rust
// side (capabilities() gating) is the primary defense and this is
// belt-and-suspenders for direct/manual invocation. Applies uniformly
// to BOTH CLI modes (capture and --sweep-orphans) even though
// OrphanSweep's own CoreAudio calls don't strictly need 14.2+ — see
// that file's own doc comment for why the gate is kept anyway.
//
// `if #available ... else` (not `guard #available ... else { exit }`):
// verified empirically that top-level code in a script-mode file like
// this one does NOT carry a `guard`'s availability narrowing forward to
// later top-level statements the way it would inside a function body —
// the compiler still flagged the runCapture call below as unguarded
// with the `guard` form. Wrapping the call itself in `if #available`
// sidesteps that quirk entirely.
if #available(macOS 14.2, *) {
    switch cliMode {
    case .capture(let cliArguments):
        runCapture(excludePID: cliArguments.excludePID, durationSeconds: cliArguments.durationSeconds)
    case .sweepOrphans:
        runSweepOrphans()
    }
} else {
    StatusEvents.emitError(.unsupportedOS("jargonslayer-audiocap requires macOS 14.2+ (CoreAudio process taps: AudioHardwareCreateProcessTap / CATapDescription's tap-creation entry points)"))
    exit(1)
}
