import CoreAudio
import AudioToolbox
import Foundation

// S9.1 — the actual CoreAudio orchestration: PID -> AudioObjectID
// translation, tap creation, aggregate-device creation, IOProc
// creation/start. Every entry point here is @available(macOS 14.2, *)
// (D1's technical floor — AudioHardwareCreateProcessTap/CATapDescription's
// tap-creation entry points are documented 14.2+) — main.swift's own
// top-level `#available` guard is what makes calling into this type
// safe; see that file.
//
// API shapes below were verified directly against this toolchain's
// real SDK headers (Xcode 26.5 SDK, CoreAudio.framework's
// CATapDescription.h / AudioHardwareTapping.h / AudioHardware.h /
// AudioHardwareBase.h) and by actually typechecking/building small
// probes against them — not assumed from the blueprint's prose or
// AudioCap's own (different-language-surface, in-process) usage. Two
// notable deltas from a naive reading, both load-bearing:
//   - kAudioObjectSystemObject imports into Swift as Int32 (it's
//     declared `CF_ENUM(int)` in the header, NOT `CF_ENUM(AudioObjectID)`)
//     — needs an explicit AudioObjectID(...) cast. kAudioObjectUnknown,
//     by contrast, IS declared `CF_ENUM(AudioObjectID)` and needs none.
//   - kAudioHardwarePropertyTranslatePIDToProcessObject's own doc block
//     is explicit that a PID with no matching process is NOT reported
//     as a failing OSStatus — the call "succeeds" and hands back
//     kAudioObjectUnknown (0) as the translated AudioObjectID. See
//     translateExcludePID below: checking status alone would have let
//     an unmatched PID through as if it were a real exclusion target.
@available(macOS 14.2, *)
public enum ProcessTapCapture {
    /// D3: "Rust passes its own PID to the helper (--exclude-pid);
    /// helper translates via kAudioHardwarePropertyTranslatePIDToProcessObject
    /// and excludes the result; translation failure = typed error and
    /// refuse to start (never silently self-capture)." This is the
    /// FIRST CoreAudio call this helper ever makes — reached before any
    /// tap/aggregate/device object exists, so its failure path is pure
    /// (nothing to tear down yet).
    public static func translateExcludePID(_ pid: pid_t) throws -> AudioObjectID {
        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var mutablePID = pid
        var processObjectID = AudioObjectID(kAudioObjectUnknown)
        var dataSize = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = withUnsafeMutablePointer(to: &mutablePID) { pidPointer -> OSStatus in
            AudioObjectGetPropertyData(systemObject, &address, UInt32(MemoryLayout<pid_t>.size), pidPointer, &dataSize, &processObjectID)
        }
        // Both checks are required — see this file's own header comment.
        guard status == kAudioHardwareNoError, processObjectID != kAudioObjectUnknown else {
            throw AudioCapError.pidTranslateFailed(
                "kAudioHardwarePropertyTranslatePIDToProcessObject failed for pid \(pid) (status \(osStatusDescription(status)), processObjectID \(processObjectID))"
            )
        }
        return processObjectID
    }

    /// D3's tap shape: `CATapDescription(stereoGlobalTapButExcludeProcesses:)`
    /// — global tap excluding exactly the given (already-translated)
    /// process object, unmuted (the excluded app's own audio keeps
    /// playing normally — CATapUnmuted's own doc: "Audio is captured by
    /// the tap and also sent to the audio hardware"). `isPrivate = true`
    /// is a deliberate ADDITION beyond the S9.1 spec text (which only
    /// specifies init + mute behavior for the tap): the aggregate device
    /// built from this tap is already specified as private
    /// (kAudioAggregateDeviceIsPrivateKey), and leaving the TAP itself
    /// non-private would mean a live global system-audio tap stays
    /// enumerable/attachable system-wide for the tap's whole lifetime —
    /// inconsistent with a privacy-first product and an easy, low-risk
    /// default to set. Flagged here and in the PR report as a spec
    /// delta, not silently added.
    public static func createProcessTap(
        excluding processObjectID: AudioObjectID,
        name: String
    ) throws -> (tapID: AudioObjectID, tapUID: String, format: AudioStreamBasicDescription) {
        let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [processObjectID])
        tapDescription.name = name
        tapDescription.muteBehavior = .unmuted
        tapDescription.isPrivate = true

        var tapID = AudioObjectID(kAudioObjectUnknown)
        let status = AudioHardwareCreateProcessTap(tapDescription, &tapID)
        guard status == kAudioHardwareNoError, tapID != kAudioObjectUnknown else {
            throw AudioCapError.tapCreateFailed("AudioHardwareCreateProcessTap failed (status \(osStatusDescription(status)))")
        }

        let tapUID = try readTapUID(tapID)
        let format = try readTapFormat(tapID)
        return (tapID, tapUID, format)
    }

    /// D3/S9.1: private aggregate device (kAudioAggregateDeviceIsPrivateKey),
    /// UID "com.bioinfospace.jargonslayer.audiocap." + a fresh UUID per
    /// session, wrapping the one tap with drift compensation enabled
    /// (kAudioSubTapDriftCompensationKey) — the tap's OWN uid (read back
    /// from kAudioTapPropertyUID by createProcessTap above, never
    /// assumed equal to the CATapDescription's own .uuid) is what goes
    /// in kAudioSubTapUIDKey.
    public static func createAggregateDevice(uid: String, name: String, tapUID: String) throws -> AudioObjectID {
        let description: [String: Any] = [
            kAudioAggregateDeviceUIDKey: uid,
            kAudioAggregateDeviceNameKey: name,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapUIDKey: tapUID,
                    kAudioSubTapDriftCompensationKey: true,
                ]
            ],
        ]
        var aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
        let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggregateDeviceID)
        guard status == kAudioHardwareNoError, aggregateDeviceID != kAudioObjectUnknown else {
            throw AudioCapError.aggregateCreateFailed("AudioHardwareCreateAggregateDevice failed (status \(osStatusDescription(status)))")
        }
        return aggregateDeviceID
    }

    /// `inDispatchQueue: nil` -> per AudioDeviceCreateIOProcIDWithBlock's
    /// own header doc, the block is invoked DIRECTLY on CoreAudio's
    /// realtime IO thread rather than dispatched onto a queue first —
    /// the shape this helper's RT-safety design (Ring.swift) requires.
    /// A failure here is folded into device-start-failed (the S9.1
    /// error taxonomy has no dedicated "ioproc-create-failed" code, and
    /// creating the IOProc is conceptually part of "starting the
    /// device" — see this file's header comment on the closed error set).
    public static func createIOProc(
        aggregateDeviceID: AudioObjectID,
        block: @escaping AudioDeviceIOBlock
    ) throws -> AudioDeviceIOProcID {
        var ioProcID: AudioDeviceIOProcID?
        let status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateDeviceID, nil, block)
        guard status == kAudioHardwareNoError, let resolvedProcID = ioProcID else {
            throw AudioCapError.deviceStartFailed("AudioDeviceCreateIOProcIDWithBlock failed (status \(osStatusDescription(status)))")
        }
        return resolvedProcID
    }

    /// THIS is the call D1 documents as where the "System Audio
    /// Recording Only" TCC prompt actually fires (recording start on the
    /// tap-backed aggregate device) — everything before this point
    /// (tap/aggregate/IOProc creation) is not gated by that permission.
    ///
    /// Permission-vs-other-failure mapping (S9.1 deliverable list: "Distinguish
    /// permission-denied from other start failures as far as the
    /// OSStatus allows; document which codes map how"): CoreAudio's own
    /// AudioHardwareBase.h documents exactly one error constant for
    /// this — kAudioDevicePermissionsError ('!hog'), "The requested
    /// operation can't be completed because the process doesn't have
    /// permission." That single documented code is the full extent of
    /// what the OSStatus alone can distinguish; every other non-zero
    /// status maps to the generic .deviceStartFailed.
    public static func start(aggregateDeviceID: AudioObjectID, ioProcID: AudioDeviceIOProcID) throws {
        let status = AudioDeviceStart(aggregateDeviceID, ioProcID)
        guard status == kAudioHardwareNoError else {
            if status == kAudioDevicePermissionsError {
                throw AudioCapError.permissionDenied(
                    "AudioDeviceStart denied (status \(osStatusDescription(status)) = kAudioDevicePermissionsError) — 系统音频录制 permission not granted"
                )
            }
            throw AudioCapError.deviceStartFailed("AudioDeviceStart failed (status \(osStatusDescription(status)))")
        }
    }

    /// Best-effort, never throws. Split out from `teardown` below so
    /// main.swift can call it FIRST, on its own, before the writer's
    /// true final ring drain (Writer.drainRemaining's own comment) —
    /// AudioDeviceStop returning is CoreAudio's own guarantee that the
    /// IOProc won't fire again, which is exactly the guarantee that
    /// final drain needs to actually be final. `teardown` below also
    /// calls this (redundantly, if main.swift already has) purely so it
    /// remains safe to call on its own for a partial-setup failure path
    /// that never reached a successful start — a harmless no-op/error
    /// OSStatus on an already-stopped device, discarded the same as
    /// every other teardown return code.
    public static func stopDevice(aggregateDeviceID: AudioObjectID, ioProcID: AudioDeviceIOProcID) {
        _ = AudioDeviceStop(aggregateDeviceID, ioProcID)
    }

    /// Best-effort, never throws — mirrors server.rs's own
    /// kill_and_reap/kill_held_child_on_exit posture (Rust side) for the
    /// same reason: this runs during shutdown, where there is no longer
    /// anyone meaningful to report a further failure TO other than the
    /// stderr log. Exact order per the S9.1 deliverable list: stop ->
    /// destroy IOProc -> destroy aggregate -> destroy tap. Every
    /// parameter is optional so callers can pass exactly however far
    /// setup actually got (e.g. tap created but aggregate creation
    /// failed) without this function needing its own bespoke partial-
    /// state enum.
    public static func teardown(tapID: AudioObjectID?, aggregateDeviceID: AudioObjectID?, ioProcID: AudioDeviceIOProcID?) {
        if let aggregateDeviceID, let ioProcID {
            stopDevice(aggregateDeviceID: aggregateDeviceID, ioProcID: ioProcID)
            _ = AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
        }
        if let aggregateDeviceID {
            _ = AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
        }
        if let tapID {
            _ = AudioHardwareDestroyProcessTap(tapID)
        }
    }

    // ---- private helpers ----

    private static func readTapFormat(_ tapID: AudioObjectID) throws -> AudioStreamBasicDescription {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &asbd)
        guard status == kAudioHardwareNoError else {
            throw AudioCapError.tapCreateFailed("failed to read kAudioTapPropertyFormat (status \(osStatusDescription(status)))")
        }
        return asbd
    }

    /// kAudioTapPropertyFormat's own header doc: "A CFString that
    /// contains a persistent identifier for the Tap... The caller is
    /// responsible for releasing the returned CFObject" — a Core
    /// Foundation "create rule" return, which AudioObjectGetPropertyData's
    /// raw `void*` outData doesn't get bridged automatically the way a
    /// proper CF-typed API would. Reading it into an
    /// `Unmanaged<CFString>?` slot and consuming it with
    /// `takeRetainedValue()` is the correct match for that documented
    /// ownership contract (verified by round-tripping the same pattern
    /// against a manually-vended +1 CFString in a throwaway probe before
    /// wiring this in for real).
    private static func readTapUID(_ tapID: AudioObjectID) throws -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uidRef: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &uidRef) { pointer -> OSStatus in
            AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, pointer)
        }
        guard status == kAudioHardwareNoError, let uidRef else {
            throw AudioCapError.tapCreateFailed("failed to read kAudioTapPropertyUID (status \(osStatusDescription(status)))")
        }
        return uidRef.takeRetainedValue() as String
    }
}

/// OSStatus is a FourCC-or-numeric error code — printing both the raw
/// integer and (when it decodes to four printable ASCII bytes, as every
/// constant this file checks against does) the FourCC text makes stderr
/// error messages match what the SDK headers themselves document (e.g.
/// "'!hog'") instead of an opaque signed integer. A FourCC constant like
/// 'unop' is built (by the C compiler, in the SDK header) as
/// `('u'<<24)|('n'<<16)|('o'<<8)|'p'` — a plain arithmetic composition,
/// not a byte-order/memory-layout concept — so recovering the four
/// characters is four masked right-shifts of the raw VALUE, deliberately
/// NOT an `.bigEndian`/`.littleEndian` conversion (which would swap the
/// value's in-memory representation and recover the bytes reversed).
func osStatusDescription(_ status: OSStatus) -> String {
    let value = UInt32(bitPattern: status)
    let bytes = [
        UInt8(truncatingIfNeeded: value >> 24),
        UInt8(truncatingIfNeeded: value >> 16),
        UInt8(truncatingIfNeeded: value >> 8),
        UInt8(truncatingIfNeeded: value),
    ]
    if bytes.allSatisfy({ (0x20...0x7E).contains($0) }) {
        let fourCC = String(decoding: bytes, as: UTF8.self)
        return "\(status) ('\(fourCC)')"
    }
    return "\(status)"
}
