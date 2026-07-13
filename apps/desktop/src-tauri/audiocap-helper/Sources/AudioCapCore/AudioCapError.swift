// S9.1 (docs/design-explorations/s9-app-audio-tap-blueprint.md, slice
// S9.1 deliverable list) — the CLOSED set of typed error codes this
// helper ever emits on stderr as `{"type":"error","code":"...",
// "message":"..."}` (StatusEvents.emitError). Deliberately closed
// (exactly the seven codes the blueprint spells out, six from S9.1 plus
// F6's own deviceChanged below) rather than open-ended: S9.2's Rust side
// is expected to exhaustively match on `code`, and an ad hoc extra case
// here would silently break that the moment it showed up. CLI usage
// errors (missing/malformed --exclude-pid, unknown flags) are NOT part
// of this taxonomy — they happen before this helper's stderr protocol
// begins at all (no tap/aggregate/device state exists yet to describe),
// so main.swift reports those as a plain usage line + exit(2), the same
// way any other Unix CLI would.
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
    /// F6 (adversarial-review fix round) — the writer thread's own
    /// IO-starvation dead-man switch (Writer.StopReason.starved): no new
    /// frames arrived from the ring for ~3s while capturing was already
    /// underway (device switched, system slept, HAL wedged — the IOProc
    /// fires on the device clock even for silent audio, so starvation is
    /// never explained by legitimate silence). Unlike every other case
    /// here, this is detected from POLLING inside Writer.run, not
    /// thrown from a single failing CoreAudio call — main.swift emits it
    /// directly (StatusEvents.emitError) once `run` returns `.starved`,
    /// rather than via a `throw`/`catch let error as AudioCapError`.
    case deviceChanged(String)

    public var code: String {
        switch self {
        case .unsupportedOS: return "unsupported-os"
        case .pidTranslateFailed: return "pid-translate-failed"
        case .tapCreateFailed: return "tap-create-failed"
        case .aggregateCreateFailed: return "aggregate-create-failed"
        case .deviceStartFailed: return "device-start-failed"
        case .permissionDenied: return "permission-denied"
        case .deviceChanged: return "device-changed"
        }
    }

    public var message: String {
        switch self {
        case .unsupportedOS(let message),
             .pidTranslateFailed(let message),
             .tapCreateFailed(let message),
             .aggregateCreateFailed(let message),
             .deviceStartFailed(let message),
             .permissionDenied(let message),
             .deviceChanged(let message):
            return message
        }
    }
}
