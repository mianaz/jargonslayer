#ifndef JARGONSLAYER_AUDIOCAP_ATOMICS_H
#define JARGONSLAYER_AUDIOCAP_ATOMICS_H

#include <stdatomic.h>
#include <stdint.h>

// S9.1 (docs/design-explorations/s9-app-audio-tap-blueprint.md) — a
// minimal C11-atomics shim so AudioCapCore's SPSC ring buffer
// (Ring.swift) and the shutdown flag (ShutdownSignal.swift) can do
// genuinely lock-free cross-thread bookkeeping from the CoreAudio
// IOProc's realtime thread. RT-safety forbids locks in that callback
// (no allocation, no locks, no I/O, no logging — see ProcessTapCapture.
// swift's own header comment), which rules out anything NSLock/
// os_unfair_lock-based for the ring's head/tail/overflow counters.
//
// Swift's ClangImporter cannot call <stdatomic.h>'s own macros directly
// (atomic_load_explicit et al. are `_Generic` macros, not real linkable
// symbols), and this helper's technical floor (macOS 14.2, per the
// blueprint's D1) predates the Synchronization framework's Atomic<T>
// (macOS 15+) — so this tiny always-inline wrapper is the standard
// bridge used by e.g. apple/swift-atomics for the same pre-Synchronization
// gap: one real, callable C function per operation, each a thin
// pass-through to the actual __c11 atomic builtins.
//
// Pointers are passed/returned as OpaquePointer on the Swift side —
// verified against this toolchain (Swift 6.3.2 / Xcode 26.5 SDK): a
// `_Atomic(uint64_t) *` parameter does NOT import as
// UnsafeMutablePointer<UInt64> (ClangImporter treats the atomic-
// qualified pointee as opaque; passing a typed pointer there is a
// compile error). That's a feature here, not a workaround: callers
// never dereference the slot directly from Swift, so the memory is
// ONLY ever touched through these functions — i.e. only ever via real
// atomic instructions, never a stray non-atomic load/store.

static inline uint64_t jsac_atomic_load_u64(const _Atomic(uint64_t) *slot) {
    return atomic_load_explicit(slot, memory_order_acquire);
}

static inline void jsac_atomic_store_u64(_Atomic(uint64_t) *slot, uint64_t value) {
    atomic_store_explicit(slot, value, memory_order_release);
}

// Relaxed: used for the ring's free-running overflow counter and the
// shutdown-request flag, both read back on their own with no other
// memory access that needs to be ordered around them (the shutdown flag
// additionally doubles as a "claim exactly once" primitive — the caller
// treats "was it zero before my fetch-add" as equivalent to a
// compare-and-swap for that one purpose).
static inline uint64_t jsac_atomic_fetch_add_u64(_Atomic(uint64_t) *slot, uint64_t delta) {
    return atomic_fetch_add_explicit(slot, delta, memory_order_relaxed);
}

#endif
