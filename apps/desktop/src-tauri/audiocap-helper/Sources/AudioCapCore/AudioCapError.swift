// S9.1 (docs/design-explorations/s9-app-audio-tap-blueprint.md, slice
// S9.1 deliverable list) — the CLOSED set of typed error codes this
// helper ever emits on stderr as `{"type":"error","code":"...",
// "message":"..."}` (StatusEvents.emitError). Deliberately closed
// (exactly the six codes the blueprint spells out) rather than open-
// ended: S9.2's Rust side is expected to exhaustively match on `code`,
// and an ad hoc extra case here would silently break that the moment it
// showed up. CLI usage errors (missing/malformed --exclude-pid, unknown
// flags) are NOT part of this taxonomy — they happen before this
// helper's stderr protocol begins at all (no tap/aggregate/device state
// exists yet to describe), so main.swift reports those as a plain
// usage line + exit(2), the same way any other Unix CLI would.
public enum AudioCapError: Error {
    /// Below the technical floor (macOS 14.2 — AudioHardwareCreateProcessTap/
    /// CATapDescription's tap-creation entry points). Never actually
    /// reached once S9.2's Rust-side capabilities() gating exists (D2:
    /// "below floor we never spawn it"), but main.swift's own
    /// `#available` guard keeps this helper honest even if invoked
    /// directly.
    case unsupportedOS(String)
    /// kAudioHardwarePropertyTranslatePIDToProcessObject failed OR
    /// (see ProcessTapCapture.translateExcludePID's own comment)
    /// "succeeded" but returned kAudioObjectUnknown — the HAL's own
    /// documented way of saying the PID doesn't match any process
    /// object, which is just as much a failure for this helper's
    /// purposes (D3: translation failure must refuse to start, never
    /// silently capture without the exclusion).
    case pidTranslateFailed(String)
    /// AudioHardwareCreateProcessTap failed.
    case tapCreateFailed(String)
    /// AudioHardwareCreateAggregateDevice failed.
    case aggregateCreateFailed(String)
    /// AudioDeviceCreateIOProcIDWithBlock or AudioDeviceStart failed for
    /// a reason OTHER than kAudioDevicePermissionsError (see
    /// .permissionDenied) — e.g. a device/format/aggregate-composition
    /// problem.
    case deviceStartFailed(String)
    /// AudioDeviceStart returned kAudioDevicePermissionsError ('!hog') —
    /// the one OSStatus CoreAudio's own AudioHardwareBase.h documents as
    /// "the requested operation can't be completed because the process
    /// doesn't have permission" (verified against the real SDK header,
    /// not assumed). This is as far as the OSStatus alone lets this
    /// helper distinguish "TCC denied" from any other start failure —
    /// see ProcessTapCapture.start's own comment for the exact mapping.
    case permissionDenied(String)

    public var code: String {
        switch self {
        case .unsupportedOS: return "unsupported-os"
        case .pidTranslateFailed: return "pid-translate-failed"
        case .tapCreateFailed: return "tap-create-failed"
        case .aggregateCreateFailed: return "aggregate-create-failed"
        case .deviceStartFailed: return "device-start-failed"
        case .permissionDenied: return "permission-denied"
        }
    }

    public var message: String {
        switch self {
        case .unsupportedOS(let message),
             .pidTranslateFailed(let message),
             .tapCreateFailed(let message),
             .aggregateCreateFailed(let message),
             .deviceStartFailed(let message),
             .permissionDenied(let message):
            return message
        }
    }
}
