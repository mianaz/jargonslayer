import AudioToolbox
import CAudioCapAtomics

// S9.1 — the RT-safe hand-off point between the CoreAudio IOProc
// (realtime thread, single producer) and the writer thread (single
// consumer): "copy interleaved f32 samples into a PREALLOCATED
// power-of-two byte ring buffer (atomic head/tail, single-producer)...
// Overflow: drop + increment an atomic counter (never block)" (S9.1
// deliverable list). See CAudioCapAtomics.h for why the cross-thread
// counters are C11 atomics rather than a lock.
//
// NOTE ON "interleaved" in the RT push path: tryPush copies whatever
// byte layout the tap's AudioBufferList actually hands it (interleaved
// OR planar/non-interleaved — see ProcessTapCapture's own comment on
// what this helper has observed/documented for the tap format) —
// converting to interleaved happens on the WRITER thread (Interleave
// .swift), never in the IOProc, per this deliverable's own explicit
// instruction ("If the tap format isn't already interleaved f32,
// convert in the writer thread, not the IOProc").
public final class SPSCByteRing {
    public let capacity: Int
    private let mask: Int
    private let storage: UnsafeMutableRawPointer

    // Three cross-thread 8-byte C11 atomic counters — head, tail,
    // overflow, in that order — backing storage for the shim in
    // CAudioCapAtomics.h. ONLY ever touched through jsac_atomic_*
    // (never dereferenced directly from Swift); see that header's own
    // comment for why that's load-bearing, not just style.
    private let atomics: UnsafeMutableRawPointer
    private var headSlot: OpaquePointer { OpaquePointer(atomics) }
    private var tailSlot: OpaquePointer { OpaquePointer(atomics + 8) }
    private var overflowSlot: OpaquePointer { OpaquePointer(atomics + 16) }

    // Producer-private cache of the last value it published as `tail`.
    // Safe as plain (non-atomic) storage: AudioDeviceCreateIOProcIDWithBlock
    // guarantees the IOProc is invoked serially (CoreAudio never calls
    // one IOProc reentrantly/concurrently with itself), so exactly one
    // thread ever writes this — avoids an extra atomic load per push
    // purely for the producer's own bookkeeping.
    private var producerTail: UInt64 = 0
    // Consumer-private mirror of the same idea for `head` (the writer
    // thread is the only caller of `drain`).
    private var consumerHead: UInt64 = 0

    // Reusable non-RT scratch buffer `drain` copies a (possibly
    // wrapped-around) record's payload into before handing it to the
    // caller as one contiguous span — grown on demand, consumer-thread
    // only, never touched by tryPush.
    private var scratch: UnsafeMutableRawPointer
    private var scratchCapacity: Int

    /// `capacity` must be a power of two so ring-position math can use
    /// a bitmask instead of `%`.
    public init(capacity: Int) {
        precondition(capacity > 0 && (capacity & (capacity - 1)) == 0, "SPSCByteRing capacity must be a power of two")
        self.capacity = capacity
        self.mask = capacity - 1
        self.storage = UnsafeMutableRawPointer.allocate(byteCount: capacity, alignment: 8)
        self.atomics = UnsafeMutableRawPointer.allocate(byteCount: 24, alignment: 8)
        atomics.initializeMemory(as: UInt8.self, repeating: 0, count: 24)
        self.scratchCapacity = 16 * 1024
        self.scratch = UnsafeMutableRawPointer.allocate(byteCount: scratchCapacity, alignment: 8)
    }

    deinit {
        storage.deallocate()
        atomics.deallocate()
        scratch.deallocate()
    }

    /// Current value of the overflow counter (records dropped because
    /// they didn't fit) — polled by the writer thread for the periodic
    /// `stats` NDJSON record, never reset.
    public func overflowCount() -> UInt64 {
        jsac_atomic_load_u64(overflowSlot)
    }

    /// Bytes currently used (tail - head), for the writer thread's
    /// ringHighWater tracking. Reads both counters non-atomically-paired
    /// (a torn snapshot is possible but harmless here — this is a
    /// diagnostics-only approximation, never used for the actual
    /// drain/push protocol, which each independently load only the
    /// counter they need).
    public func approximateUsedBytes() -> Int {
        let tail = jsac_atomic_load_u64(tailSlot)
        let head = jsac_atomic_load_u64(headSlot)
        return Int(tail &- head)
    }

    /// REALTIME-SAFE producer path — called only from the CoreAudio
    /// IOProc. Writes `frameCount` + the concatenated bytes of every
    /// buffer in `buffers` as ONE atomically-published record: {frame
    /// Count u32}{byteLen u32}{payload}. Never blocks, allocates, or
    /// logs. If the record doesn't fit in the free space remaining, the
    /// WHOLE callback's audio is dropped and the overflow counter is
    /// incremented instead of a partial write — a partial write would
    /// corrupt framing for the consumer (see `drain`'s own invariant
    /// comment).
    @discardableResult
    public func tryPush(frameCount: UInt32, buffers: UnsafeMutableAudioBufferListPointer) -> Bool {
        var payloadBytes = 0
        for buffer in buffers where buffer.mData != nil {
            payloadBytes += Int(buffer.mDataByteSize)
        }
        let recordBytes = 8 + payloadBytes

        let head = jsac_atomic_load_u64(headSlot)
        let used = Int(producerTail &- head)
        let free = capacity - used
        guard recordBytes <= free, recordBytes <= capacity else {
            _ = jsac_atomic_fetch_add_u64(overflowSlot, 1)
            return false
        }

        var writePos = producerTail
        writePos = writeUInt32(frameCount, at: writePos)
        writePos = writeUInt32(UInt32(payloadBytes), at: writePos)
        for buffer in buffers where buffer.mData != nil {
            writePos = rawWrite(buffer.mData!, count: Int(buffer.mDataByteSize), at: writePos)
        }

        producerTail = writePos
        jsac_atomic_store_u64(tailSlot, writePos)
        return true
    }

    /// Non-realtime consumer path — called only from the writer thread.
    /// Drains every complete record currently available and invokes
    /// `onRecord` once per record with a span borrowed from an internal
    /// scratch buffer valid only for the duration of that one call.
    /// Publishes the new `head` once at the end of the drain (not per
    /// record) to keep atomic-store traffic down.
    ///
    /// INVARIANT this relies on: tryPush only ever advances `tail`
    /// AFTER writing a record's full bytes, so once `tail` (loaded once,
    /// up front, below) reflects a record, that record's bytes are
    /// already fully present — no "wait for more bytes" case exists for
    /// a syntactically complete record.
    public func drain(onRecord: (_ frameCount: UInt32, _ payload: UnsafeRawBufferPointer) -> Void) {
        let tail = jsac_atomic_load_u64(tailSlot)
        var readPos = consumerHead
        while tail &- readPos >= 8 {
            let frameCount = readUInt32(at: readPos)
            let byteLen = readUInt32(at: readPos &+ 4)
            let recordTotal = UInt64(8) &+ UInt64(byteLen)
            guard tail &- readPos >= recordTotal else {
                // Can't happen given the invariant above — defensive
                // only: stop here and retry next poll instead of
                // reading past what's actually been published.
                break
            }
            ensureScratchCapacity(Int(byteLen))
            rawRead(at: readPos &+ 8, count: Int(byteLen), into: scratch)
            onRecord(frameCount, UnsafeRawBufferPointer(start: scratch, count: Int(byteLen)))
            readPos = readPos &+ recordTotal
        }
        consumerHead = readPos
        jsac_atomic_store_u64(headSlot, readPos)
    }

    // ---- ring-position-aware raw memory helpers (private) ----

    private func rawWrite(_ source: UnsafeMutableRawPointer, count: Int, at pos: UInt64) -> UInt64 {
        guard count > 0 else { return pos }
        let start = Int(pos & UInt64(mask))
        let firstSpan = min(count, capacity - start)
        (storage + start).copyMemory(from: source, byteCount: firstSpan)
        let remaining = count - firstSpan
        if remaining > 0 {
            storage.copyMemory(from: source + firstSpan, byteCount: remaining)
        }
        return pos &+ UInt64(count)
    }

    private func writeUInt32(_ value: UInt32, at pos: UInt64) -> UInt64 {
        var v = value
        return withUnsafeMutableBytes(of: &v) { buf in
            rawWrite(buf.baseAddress!, count: 4, at: pos)
        }
    }

    private func rawRead(at pos: UInt64, count: Int, into destination: UnsafeMutableRawPointer) {
        guard count > 0 else { return }
        let start = Int(pos & UInt64(mask))
        let firstSpan = min(count, capacity - start)
        destination.copyMemory(from: storage + start, byteCount: firstSpan)
        let remaining = count - firstSpan
        if remaining > 0 {
            (destination + firstSpan).copyMemory(from: storage, byteCount: remaining)
        }
    }

    private func readUInt32(at pos: UInt64) -> UInt32 {
        var value: UInt32 = 0
        withUnsafeMutableBytes(of: &value) { buf in
            rawRead(at: pos, count: 4, into: buf.baseAddress!)
        }
        return value
    }

    private func ensureScratchCapacity(_ needed: Int) {
        guard needed > scratchCapacity else { return }
        scratch.deallocate()
        scratchCapacity = max(needed, scratchCapacity * 2)
        scratch = UnsafeMutableRawPointer.allocate(byteCount: scratchCapacity, alignment: 8)
    }
}
