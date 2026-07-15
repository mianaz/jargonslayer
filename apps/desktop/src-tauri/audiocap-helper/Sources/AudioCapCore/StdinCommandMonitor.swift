import CAudioCapAtomics
import Foundation
#if canImport(Darwin)
import Darwin
#endif

// S11 (§2.3/§A1) — transcribe mode's stdin protocol: line-oriented,
// UTF-8, `\n`-terminated `pause`/`resume` commands, EOF (zero-length
// read) = shutdown (unchanged dead-man semantic). §A1 (lead
// adjudication): this is the ONLY stdin reader in transcribe mode —
// two threads reading the same stdin would race and split lines
// unpredictably — so `ShutdownSignal.startStdinEOFMonitor()` is NOT
// called there (main.swift's own comment at that call site); EOF
// handling lives HERE instead, via the `onEOF` callback main.swift wires
// to the shared shutdown flag (ShutdownSignal is Must-NOT-TOUCH for
// this worker, so this takes a plain closure rather than depending on
// that type directly — see main.swift for the concrete wiring).
//
// Pause state is a cross-thread flag the SAME way SPSCByteRing/
// ShutdownSignal are: one C11-atomics slot (CAudioCapAtomics.h's own
// header comment on why — Swift can't call <stdatomic.h> macros
// directly, and this predates the Synchronization framework) rather
// than a lock, since `isPaused()` is polled from the producer thread
// (TranscribeConsumer.pollOnce, every ~4ms) while `pause`/`resume`
// lines are applied from THIS type's own stdin-reading thread.
public final class StdinCommandMonitor {
    /// The two meaningful commands (§2.3) plus an explicit `.unknown`
    /// case (rather than silently dropping at classification time) so
    /// `classify(_:)` stays a total, directly-assertable pure function;
    /// `apply` below is what actually implements "any other line is
    /// ignored".
    enum Command: Equatable {
        case pause
        case resume
        case unknown(String)
    }

    private let input: FileHandle
    private let onEOF: () -> Void

    // One 8-byte C11-atomic slot: 0 = running, nonzero = paused.
    private let atomics: UnsafeMutableRawPointer
    private var pausedSlot: OpaquePointer { OpaquePointer(atomics) }

    private var thread: Thread?
    // Reassembles `\n`-terminated lines across arbitrary read-chunk
    // boundaries (a single `availableData` read is NOT guaranteed to
    // land exactly on a line boundary) — the same hazard Rust's own
    // LineReassembler exists for, one layer down the pipeline, just on
    // the READING side of a pipe instead of the writing side.
    private var buffer = Data()

    /// `input` is injectable (default `.standardInput`, mirrors Writer's
    /// own injectable `output: FileHandle = .standardOutput`) purely so
    /// tests can drive `readOnce()` against a real `Pipe()` instead of
    /// the process's real stdin — see StdinCommandMonitorTests.swift.
    public init(input: FileHandle = .standardInput, onEOF: @escaping () -> Void) {
        self.input = input
        self.onEOF = onEOF
        atomics = UnsafeMutableRawPointer.allocate(byteCount: 8, alignment: 8)
        atomics.initializeMemory(as: UInt8.self, repeating: 0, count: 8)
    }

    deinit {
        atomics.deallocate()
    }

    public func isPaused() -> Bool {
        jsac_atomic_load_u64(pausedSlot) != 0
    }

    /// Starts the dedicated background thread — mirrors
    /// ShutdownSignal.startStdinEOFMonitor's own thread shape (blocks on
    /// `availableData` until EOF) but additionally parses+applies
    /// `pause`/`resume` lines as they arrive, via `readOnce()` below.
    public func start() {
        let thread = Thread { [weak self] in
            while let self, self.readOnce() {}
        }
        thread.name = "jargonslayer-audiocap.stdin-command-monitor"
        thread.start()
        self.thread = thread
    }

    // ---- internals (package-visible for direct testing — no thread,
    // no polling/waiting needed: tests drive these synchronously against
    // a real Pipe(), same posture as WriterTests' own Pipe()-based
    // write-failure tests) ----

    /// One blocking read + dispatch cycle. Returns `false` exactly once
    /// (having already invoked `onEOF`) on the zero-length EOF read;
    /// `true` otherwise (including for a read that turned out to be
    /// entirely a partial line with nothing to dispatch yet). Factored
    /// out of `start()`'s `Thread {}` closure so tests can call it
    /// directly against an injected `Pipe()` — a read with data already
    /// buffered (or already closed) returns immediately, so no real
    /// blocking/waiting ever happens in a test.
    @discardableResult
    func readOnce() -> Bool {
        let data = input.availableData
        guard !data.isEmpty else {
            onEOF()
            return false
        }
        feed(data)
        return true
    }

    /// Appends `chunk` to the reassembly buffer and dispatches every
    /// complete `\n`-terminated line found (via `apply`), leaving any
    /// trailing partial line buffered for the next call.
    func feed(_ chunk: Data) {
        buffer.append(chunk)
        while let newlineIndex = buffer.firstIndex(of: 0x0A) {
            let lineBytes = buffer[buffer.startIndex..<newlineIndex]
            apply(Self.classify(String(decoding: lineBytes, as: UTF8.self)))
            buffer.removeSubrange(buffer.startIndex...newlineIndex)
        }
    }

    private func apply(_ command: Command) {
        switch command {
        case .pause:
            jsac_atomic_store_u64(pausedSlot, 1)
        case .resume:
            jsac_atomic_store_u64(pausedSlot, 0)
        case .unknown:
            break // §2.3: "Any other line = ignored"
        }
    }

    /// Pure line classification (§2.3) — `line` has already had its
    /// trailing `\n` stripped by `feed` above; no whitespace tolerance
    /// (the wire contract specifies the exact bytes `pause\n`/`resume\n`,
    /// nothing fuzzier).
    static func classify(_ line: String) -> Command {
        switch line {
        case "pause": return .pause
        case "resume": return .resume
        default: return .unknown(line)
        }
    }
}
