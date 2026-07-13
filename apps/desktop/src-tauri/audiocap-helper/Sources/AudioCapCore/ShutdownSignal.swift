import Dispatch
import Foundation
#if canImport(Darwin)
import Darwin
#endif
import CAudioCapAtomics

// S9.1 — unifies the three ways this helper's writer loop learns it
// should stop: SIGTERM, SIGINT, and stdin-EOF (risk register item 4's
// dead-man switch: "parent death => EOF is the dead-man switch, SIGTERM
// preferred"), behind one atomic flag the writer loop polls.
//
// DispatchSourceSignal (not a raw POSIX `signal()` handler doing real
// work) is used deliberately: its event handler runs as a normal
// libdispatch queue callback, NOT actual async-signal-handler context,
// so ordinary Swift work there (setting a flag via a real function
// call) needs no async-signal-safety audit — `signal(sig, SIG_IGN)` is
// still required first, to suppress the default terminate-immediately
// action before the dispatch source gets a chance to observe the
// signal. Verified empirically (a throwaway probe that installs this
// exact pattern, sends itself SIGTERM, and confirms the handler runs
// and the process does NOT die from the default action) before wiring
// this in for real.
public final class ShutdownSignal {
    // Reuses the same C11-atomics shim as SPSCByteRing for one
    // load/fetch-add slot — this flag is never touched from the actual
    // RT IOProc thread, so a lock would be equally correct here, but
    // reusing the existing primitive avoids a second synchronization
    // mechanism for what both ultimately are: a cross-thread counter.
    private let atomics: UnsafeMutableRawPointer
    private var requestedSlot: OpaquePointer { OpaquePointer(atomics) }

    private var signalSources: [DispatchSourceSignal] = []
    private var stdinMonitorThread: Thread?

    public init() {
        atomics = UnsafeMutableRawPointer.allocate(byteCount: 8, alignment: 8)
        atomics.initializeMemory(as: UInt8.self, repeating: 0, count: 8)
    }

    deinit {
        atomics.deallocate()
    }

    public func isRequested() -> Bool {
        jsac_atomic_load_u64(requestedSlot) != 0
    }

    private func requestShutdown() {
        _ = jsac_atomic_fetch_add_u64(requestedSlot, 1)
    }

    /// F12 (adversarial-review fix round) — a failed stdout write
    /// (Writer's own `onWriteFailure` callback, wired from main.swift)
    /// is functionally the SAME "the parent is gone" signal stdin-EOF
    /// already covers, just observed from the opposite direction
    /// (writing TO the parent instead of reading FROM it): reuses the
    /// exact same atomic flag/`isRequested()` mechanism rather than
    /// inventing a parallel one, so `run(shouldStop:)`'s existing
    /// `shutdown.isRequested()` check picks it up on its very next poll
    /// with no other plumbing required.
    public func requestShutdownFromWriteFailure() {
        requestShutdown()
    }

    /// Must run before any blocking CoreAudio call, so SIGTERM/SIGINT
    /// are never handled by the process-default action (immediate
    /// death, skipping this helper's own teardown of the tap/aggregate/
    /// IOProc it may have already created).
    public func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
            source.setEventHandler { [weak self] in
                self?.requestShutdown()
            }
            source.resume()
            signalSources.append(source)
        }
    }

    /// Dead-man switch (risk register item 4): blocks reading stdin on
    /// its own thread until EOF — the parent process (and therefore its
    /// end of this pipe) went away, INCLUDING on an uncatchable SIGKILL,
    /// which the SIGTERM/SIGINT handlers above can never observe.
    /// tauri-plugin-shell's `Command::new` (verified against 2.3.5's own
    /// source — see uv.rs's UV_SIDECAR_PROGRAM comment for the same
    /// crate/version) unconditionally pipes a sidecar's stdin, so this
    /// pipe is real for every spawn topology this helper is ever used
    /// under. This helper takes no input on stdin, so any non-empty read
    /// is treated as stray/ignorable, never itself a shutdown signal —
    /// only a genuine zero-length read (EOF) is.
    public func startStdinEOFMonitor() {
        let thread = Thread { [weak self] in
            while true {
                let data = FileHandle.standardInput.availableData
                if data.isEmpty {
                    self?.requestShutdown()
                    return
                }
            }
        }
        thread.name = "jargonslayer-audiocap.stdin-eof-monitor"
        thread.start()
        stdinMonitorThread = thread
    }
}
