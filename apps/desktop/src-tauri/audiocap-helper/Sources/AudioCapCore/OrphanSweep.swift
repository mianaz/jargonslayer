import CoreAudio
import Foundation

// S9.2 (docs/design-explorations/s9-app-audio-tap-blueprint.md, slice
// S9.2) — the `--sweep-orphans` CLI mode's own implementation: startup
// best-effort cleanup for aggregate devices this helper created in a
// PREVIOUS run that never got torn down (risk register item 4 —
// SIGKILL is uncatchable, so ShutdownSignal's stdin-EOF/SIGTERM path is
// the primary defense and this sweep is the backstop). Ownership-
// validated by an EXACT UID PREFIX check (isOwnedAggregateUID below) —
// mirrors main.swift's own aggregate UID construction
// ("com.bioinfospace.jargonslayer.audiocap." + a fresh UUID per session
// — ProcessTapCapture.createAggregateDevice's caller). Never touches
// any device whose UID doesn't match that exact prefix.
public enum OrphanSweep {
    /// The exact prefix every aggregate device THIS helper ever creates
    /// carries (main.swift's own `aggregateUID` construction) — kept
    /// here as the single source of truth for the ownership check, so
    /// device creation and this sweep can never drift apart.
    public static let ownedAggregateUIDPrefix = "com.bioinfospace.jargonslayer.audiocap."

    /// Pure prefix check — no CoreAudio, fully unit-testable (see
    /// OrphanSweepTests.swift). Exact-prefix, not a fuzzy/substring
    /// match: a UID that merely CONTAINS the prefix elsewhere, or
    /// extends it without the trailing ".", must never match — see this
    /// file's own tests for the exact negative cases this guards.
    public static func isOwnedAggregateUID(_ uid: String) -> Bool {
        uid.hasPrefix(ownedAggregateUIDPrefix)
    }

    /// Enumerates every AudioObjectID currently registered with the
    /// HAL, destroys exactly those that are BOTH an aggregate device
    /// (kAudioDevicePropertyTransportType ==
    /// kAudioDeviceTransportTypeAggregate) AND whose UID passes
    /// isOwnedAggregateUID above, and returns how many were destroyed.
    /// Best-effort throughout: a failure reading one device's transport
    /// type/UID, or destroying one matched device, is skipped (never
    /// thrown) so one bad device can't abort the sweep for every other
    /// orphan — this runs unattended at startup, with no one to report
    /// a thrown error to anyway.
    @available(macOS 14.2, *)
    public static func sweep() -> Int {
        guard let deviceIDs = try? allDeviceIDs() else { return 0 }
        var destroyed = 0
        for deviceID in deviceIDs {
            guard isAggregateDevice(deviceID),
                  let uid = try? readDeviceUID(deviceID),
                  isOwnedAggregateUID(uid)
            else {
                continue
            }
            if AudioHardwareDestroyAggregateDevice(deviceID) == kAudioHardwareNoError {
                destroyed += 1
            }
        }
        return destroyed
    }

    // ---- private CoreAudio helpers ----

    /// kAudioHardwarePropertyDevices: "An array of the AudioObjectIDs
    /// that represent all the devices currently available to the
    /// system" (AudioHardware.h's own doc block), queried on
    /// kAudioObjectSystemObject/global scope — verified directly
    /// against this toolchain's real SDK header, same posture as
    /// ProcessTapCapture.swift's own API verification.
    private static func allDeviceIDs() throws -> [AudioObjectID] {
        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var dataSize: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(systemObject, &address, 0, nil, &dataSize)
        guard status == kAudioHardwareNoError else {
            throw AudioCapError.deviceStartFailed("kAudioHardwarePropertyDevices size query failed (status \(osStatusDescription(status)))")
        }
        let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
        guard count > 0 else { return [] }

        var deviceIDs = [AudioObjectID](repeating: AudioObjectID(kAudioObjectUnknown), count: count)
        status = deviceIDs.withUnsafeMutableBufferPointer { buffer -> OSStatus in
            AudioObjectGetPropertyData(systemObject, &address, 0, nil, &dataSize, buffer.baseAddress!)
        }
        guard status == kAudioHardwareNoError else {
            throw AudioCapError.deviceStartFailed("kAudioHardwarePropertyDevices data query failed (status \(osStatusDescription(status)))")
        }
        return deviceIDs
    }

    /// kAudioDevicePropertyTransportType: "A UInt32 whose value
    /// indicates how the AudioDevice is connected" — aggregate devices
    /// report kAudioDeviceTransportTypeAggregate ('grup').
    private static func isAggregateDevice(_ deviceID: AudioObjectID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var transportType: UInt32 = 0
        var dataSize = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &dataSize, &transportType)
        return status == kAudioHardwareNoError && transportType == kAudioDeviceTransportTypeAggregate
    }

    /// kAudioDevicePropertyDeviceUID: "A CFString that contains a
    /// persistent identifier for the AudioDevice... The caller is
    /// responsible for releasing the returned CFObject" — same "create
    /// rule" CFString ownership pattern as ProcessTapCapture.readTapUID
    /// (kAudioTapPropertyUID), reused verbatim here.
    private static func readDeviceUID(_ deviceID: AudioObjectID) throws -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uidRef: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &uidRef) { pointer -> OSStatus in
            AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, pointer)
        }
        guard status == kAudioHardwareNoError, let uidRef else {
            throw AudioCapError.deviceStartFailed(
                "failed to read kAudioDevicePropertyDeviceUID for device \(deviceID) (status \(osStatusDescription(status)))"
            )
        }
        return uidRef.takeRetainedValue() as String
    }
}
