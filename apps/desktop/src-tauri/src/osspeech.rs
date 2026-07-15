// v0.4.3 S11 (docs/design-explorations/s11-osspeech-blueprint.md) — the
// zero-install macOS 26+ "SpeechAnalyzer" transcribe lane's Rust
// supervisor. Worker B's own scope ONLY: this module supervises a SECOND
// jargonslayer-audiocap invocation mode (`--transcribe`/`--probe-osspeech`/
// `--preinstall-osspeech`, all new — Worker A's scope) that never writes
// PCM to stdout at all (§0: "no PCM ever leaves the process, and no
// stdout wire is used") — everything (transcripts, asset/locale
// lifecycle, errors) rides the existing stderr NDJSON lane as new
// `type`s (§2.2), parsed here and re-emitted on two NEW, parallel event
// lanes (`osspeech://transcript`/`osspeech://status`, §2.5) — never the
// closed `audiocap://status` set audiocap.rs owns.
//
// audiocap.rs is this slice's PATTERN SOURCE, not a dependency: its
// state-machine shape (single-flight + generation guard), spawn/stop/
// watchdog plumbing, stderr line-reassembly, and always-on session log
// are all mirrored here as INDEPENDENT copies (audiocap.rs itself is
// off-limits to edit — see this crate's own lib.rs for the one thing it
// DOES export, `AUDIOCAP_SIDECAR_PROGRAM`, reused verbatim below rather
// than duplicated, since the whole point of that constant is "one sidecar
// binary, don't typo the name twice"). Everything else this module needs
// from audiocap.rs (`macos_version`, `LineReassembler`, the log-file-open
// helper, `force_kill_pid`, `STOP_GRACE_PERIOD`, the state machine itself)
// is a PRIVATE copy — see each one's own doc comment for why.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::audiocap::AUDIOCAP_SIDECAR_PROGRAM;
use crate::uv::emit_uv_log;

// ---- LineReassembler: private copy (audiocap.rs's own struct isn't pub,
// and that file is off-limits to edit — see this module's header). Byte-
// for-byte the same reassembly rule audiocap.rs's own copy documents:
// jargonslayer-audiocap's stderr convention is one JSON object + one '\n'
// per record regardless of which CLI mode emitted it, and a raw chunk
// boundary can land in the middle of a line exactly the same way here as
// it can on the capture path. ----

/// Buffers raw stderr byte chunks into complete '\n'-terminated lines —
/// see audiocap.rs's own `LineReassembler` (this module's pattern source)
/// for the full rationale; this is an independent copy, not a re-export.
struct LineReassembler {
    pending: Vec<u8>,
}

impl LineReassembler {
    fn new() -> Self {
        Self { pending: Vec::new() }
    }

    /// Returns every complete line newly available after appending
    /// `chunk` (oldest first, '\n' stripped); any trailing partial line
    /// stays buffered for a later `feed`/`flush` call.
    fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = self.pending.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = self.pending.drain(..pos).collect();
            self.pending.remove(0); // drop the '\n' itself, now at index 0
            lines.push(String::from_utf8_lossy(&line_bytes).into_owned());
        }
        lines
    }

    /// Returns whatever's left buffered (a line that never got a
    /// trailing '\n' before the stream ended, if any) and clears it —
    /// call once after the process's stderr stream is done.
    fn flush(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let line_bytes = std::mem::take(&mut self.pending);
        Some(String::from_utf8_lossy(&line_bytes).into_owned())
    }
}

/// Mirrors audiocap.rs's own (private) `open_log_file_in_app_log_dir`:
/// resolve `<app_log_dir>`, create it if needed, open `file_name` inside
/// it in append mode. `None` — never surfaced as an error — whenever the
/// dir can't be resolved/created or the open itself fails; every caller
/// already degrades to "no file tee" rather than failing the session over
/// a log file it couldn't open.
fn open_log_file_in_app_log_dir(app: &tauri::AppHandle, file_name: &str) -> Option<std::fs::File> {
    let dir = app.path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::OpenOptions::new().create(true).append(true).open(dir.join(file_name)).ok()
}

// ---- D1/D6-style macOS version gating (Q1/Q4/Q8: the transcribe lane is
// macOS 26+ only — the version after 15/Tahoe's own naming jump). Private
// copy of audiocap.rs's own `macos_version` (not pub there either). ----

#[cfg(target_os = "macos")]
fn macos_version() -> (i64, i64) {
    use objc2_foundation::NSProcessInfo;
    let version = NSProcessInfo::processInfo().operatingSystemVersion();
    (version.majorVersion as i64, version.minorVersion as i64)
}

#[cfg(not(target_os = "macos"))]
fn macos_version() -> (i64, i64) {
    (0, 0)
}

/// Blueprint §1 Q1/Q8: SpeechAnalyzer's transcribe lane is gated on
/// `major >= 26`, unlike audiocap's own 14.4 product floor — a whole
/// major version higher, so minor is irrelevant either way (mirrors
/// audiocap's own `is_macos_version_supported`'s "major jump" handling,
/// simpler here since there's no in-major minor threshold to also check).
fn is_macos_26_or_later((major, _minor): (i64, i64)) -> bool {
    major >= 26
}

/// Used for BOTH `OsSpeechCapabilities.reason` (the pre-flight capability
/// check) and the runtime re-check `Err` in `start_os_speech`/
/// `preinstall_os_speech` (D6's "UI gating is not a boundary" posture,
/// same as audiocap's own `UNSUPPORTED_REASON`).
pub const UNSUPPORTED_REASON: &str = "需要 macOS 26 或更高版本";

// ---- os_speech_capabilities: macOS-gate short-circuit + a process-once
// probe memo (Q4: "the probe spawns a process; StatusLine dropdown +
// Settings + wizard all probe, so Rust-side memoization avoids repeat
// spawns"). ----

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsSpeechCapabilities {
    pub supported: bool,
    pub reason: Option<String>,
    pub locales: Vec<String>,
    pub installed_locales: Vec<String>,
}

fn unsupported_capabilities(reason: impl Into<String>) -> OsSpeechCapabilities {
    OsSpeechCapabilities {
        supported: false,
        reason: Some(reason.into()),
        locales: Vec::new(),
        installed_locales: Vec::new(),
    }
}

/// DEVIATION from §2.4's pinned pseudocode return type (bare
/// `OsSpeechCapabilities`): tauri 2.11.5 enforces (a compile error, not
/// just a lint) that an ASYNC command taking a reference-shaped parameter
/// — `tauri::State<'_, OsSpeechState>`, needed here for the process-once
/// probe memo — must return a `Result`. This never actually constructs an
/// `Err` in practice (`run_probe`/`unsupported_capabilities` already fold
/// every failure into a valid `supported:false` value), so JS's own
/// observable contract is unchanged: `invoke()` always resolves with an
/// `OsSpeechCapabilities`, never rejects.
#[tauri::command]
pub async fn os_speech_capabilities(app: tauri::AppHandle, state: tauri::State<'_, OsSpeechState>) -> Result<OsSpeechCapabilities, String> {
    // Below the floor: never spawns the helper at all (mirrors
    // audiocap_capabilities' own cheap, always-recomputed check) — no
    // memo entry is ever stored for this branch, since there's nothing
    // to memoize (no spawn happened).
    if !is_macos_26_or_later(macos_version()) {
        return Ok(unsupported_capabilities(UNSUPPORTED_REASON));
    }
    if let Some(cached) = state.cached_probe() {
        return Ok(cached);
    }
    let result = run_probe(&app).await;
    // Q4: "ONE helper spawn per app run" — cache unconditionally,
    // success or synthesized-failure alike, so a later call never
    // re-spawns within the same app run even after a transient failure.
    state.store_probe(result.clone());
    Ok(result)
}

/// Spawns `--probe-osspeech`, drains its stderr for the single
/// `{"type":"osspeech-probe",...}` line (§2.2), and folds any
/// resolve/spawn/parse failure into a `supported:false` result — never
/// itself an `Err`; see `os_speech_capabilities`'s own doc comment for
/// why ITS return type still had to grow a `Result` wrapper anyway.
async fn run_probe(app: &tauri::AppHandle) -> OsSpeechCapabilities {
    let command = match app.shell().sidecar(AUDIOCAP_SIDECAR_PROGRAM) {
        Ok(command) => command,
        Err(e) => return unsupported_capabilities(format!("could not resolve the jargonslayer-audiocap sidecar: {e}")),
    };
    // No `.set_raw_out(true)`: this mode never writes to stdout at all
    // (§0), so the plugin's default line-buffered ("cooked") stdout/
    // stderr reading is fine — `LineReassembler` below is still applied
    // regardless, belt-and-suspenders against relying on that.
    let (mut rx, _child) = match command.args(["--probe-osspeech"]).spawn() {
        Ok(pair) => pair,
        Err(e) => return unsupported_capabilities(format!("failed to spawn jargonslayer-audiocap --probe-osspeech: {e}")),
    };

    let mut stderr_lines = LineReassembler::new();
    let mut result: Option<OsSpeechCapabilities> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => {
                for line in stderr_lines.feed(&bytes) {
                    emit_uv_log(app, "stderr", format!("[osspeech-probe] {line}"));
                    if let ParsedOsSpeechLine::Probe { supported, locales, installed } = parse_osspeech_line(&line) {
                        result = Some(OsSpeechCapabilities {
                            supported,
                            reason: None,
                            locales,
                            installed_locales: installed,
                        });
                    }
                }
            }
            CommandEvent::Error(message) => {
                emit_uv_log(app, "stderr", format!("[osspeech-probe] shell error: {message}"));
            }
            _ => {}
        }
    }
    if let Some(line) = stderr_lines.flush() {
        emit_uv_log(app, "stderr", format!("[osspeech-probe] {line}"));
    }
    result.unwrap_or_else(|| unsupported_capabilities("osspeech probe produced no result"))
}

// ---- osspeech://status kind mapping (wire contract, §2.5) ----

/// The CLOSED 13-kind set §2.5 pins — same "closed set" posture as
/// audiocap's own `StatusKind` (that enum's own doc comment), one lane
/// over: JS is expected to exhaustively match on `kind`, so an ad hoc
/// extra value here would silently break that.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OsSpeechStatusKind {
    Starting,
    Capturing,
    AssetChecking,
    AssetDownloading,
    AssetInstalled,
    AssetFailed,
    LocaleResolved,
    PermissionDenied,
    Unsupported,
    UnsupportedLocale,
    DeviceChanged,
    Crashed,
    Ended,
}

impl OsSpeechStatusKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Capturing => "capturing",
            Self::AssetChecking => "asset-checking",
            Self::AssetDownloading => "asset-downloading",
            Self::AssetInstalled => "asset-installed",
            Self::AssetFailed => "asset-failed",
            Self::LocaleResolved => "locale-resolved",
            Self::PermissionDenied => "permission-denied",
            Self::Unsupported => "unsupported",
            Self::UnsupportedLocale => "unsupported-locale",
            Self::DeviceChanged => "device-changed",
            Self::Crashed => "crashed",
            Self::Ended => "ended",
        }
    }
}

/// Maps a `type:"status"` record's `state` — immediate emission (unlike
/// `error_record_kind` below, never deferred to exit). `"finished"` (the
/// clean-stop sentinel, §2.2) deliberately returns `None` here: it's
/// internal bookkeeping for `finished_seen` (this module's `eos_seen`
/// analog), never a kind surfaced to JS on its own — the eventual ended/
/// crashed kind is decided at exit time (`final_kind`). Any other/unknown
/// state (e.g. the reused `exclude-pid-inactive` note, §A5) is still
/// mirrored to the log lane by the caller, but never emitted as a
/// mistyped status event.
fn status_record_kind(state: &str) -> Option<OsSpeechStatusKind> {
    match state {
        "starting" => Some(OsSpeechStatusKind::Starting),
        "capturing" => Some(OsSpeechStatusKind::Capturing),
        _ => None,
    }
}

/// Maps a `type:"asset"` record's `state` (§2.2) — immediate emission,
/// same posture as `status_record_kind`.
fn asset_record_kind(state: &str) -> Option<OsSpeechStatusKind> {
    match state {
        "checking" => Some(OsSpeechStatusKind::AssetChecking),
        "downloading" => Some(OsSpeechStatusKind::AssetDownloading),
        "installed" => Some(OsSpeechStatusKind::AssetInstalled),
        "failed" => Some(OsSpeechStatusKind::AssetFailed),
        _ => None,
    }
}

/// Maps a `type:"error"` record's `code` — DEFERRED, not emitted
/// immediately, mirroring audiocap's own `error_record_kind`/`ParsedAudiocapLine
/// ::Error` handling verbatim: the wire contract ties error kinds to the
/// process's eventual exit, and jargonslayer-audiocap always follows an
/// emitError with an exit anyway. Covers BOTH the three tap-level
/// `AudioCapError` codes reused unchanged on this path (permission-denied/
/// unsupported-os/device-changed, §2.2's own "reused unchanged" list) and
/// three of the new `OsSpeechError` codes that map to a dedicated kind
/// (unsupported-locale directly; asset-download-failed and
/// asset-unavailable — R5: the latter covers noModel/cannotAllocate/
/// …Allocated-style asset codes, i.e. the asset exists but can't actually
/// be used, as distinct from a network failure — both as a fallback for
/// the rare case the earlier immediate `asset:"failed"` event was somehow
/// never seen; see `asset_record_kind`, the normal/immediate path for that
/// same user-facing signal). `engine-failure`/`audio-format` have no kind
/// of their own (same "falls through to Crashed at exit" posture
/// audiocap's own unmapped codes get).
fn error_record_kind(code: &str) -> Option<OsSpeechStatusKind> {
    match code {
        "permission-denied" => Some(OsSpeechStatusKind::PermissionDenied),
        "unsupported-os" => Some(OsSpeechStatusKind::Unsupported),
        "device-changed" => Some(OsSpeechStatusKind::DeviceChanged),
        "unsupported-locale" => Some(OsSpeechStatusKind::UnsupportedLocale),
        "asset-download-failed" => Some(OsSpeechStatusKind::AssetFailed),
        "asset-unavailable" => Some(OsSpeechStatusKind::AssetFailed),
        _ => None,
    }
}

/// Mirrors audiocap's own `exit_status_kind` literally, substituting this
/// module's own `finished_seen` (the `{"type":"status","state":"finished"}`
/// sentinel, §2.2) for `eos_seen`: "clean finished-sentinel/exit-0 =>
/// ended; nonzero exit with a mapped error code => that kind; nonzero
/// without one => crashed." A clean exit-0 that never saw the finished
/// sentinel is a truncated session, never reported Ended (same F8
/// rationale audiocap's own doc comment gives for its `eos_seen`).
fn exit_status_kind(code: Option<i32>, last_error_code: Option<&str>, finished_seen: bool) -> OsSpeechStatusKind {
    if code == Some(0) {
        return if finished_seen { OsSpeechStatusKind::Ended } else { OsSpeechStatusKind::Crashed };
    }
    last_error_code.and_then(error_record_kind).unwrap_or(OsSpeechStatusKind::Crashed)
}

/// Mirrors audiocap's own `final_kind`: `exit_status_kind`, except a
/// requested stop (stdin-EOF closed by `stop_os_speech`/supersession,
/// however it eventually exited — even via the grace-timeout SIGKILL
/// fallback) is unconditionally reported `Ended`, never crashed.
fn final_kind(code: Option<i32>, last_error_code: Option<&str>, stop_was_requested: bool, finished_seen: bool) -> OsSpeechStatusKind {
    if stop_was_requested {
        return OsSpeechStatusKind::Ended;
    }
    exit_status_kind(code, last_error_code, finished_seen)
}

/// Human-readable `message` for the FINAL status event of a session/
/// preinstall (mirrors audiocap's own `final_message`) — `None` for the
/// lifecycle states that need none (their own immediate emission, if any,
/// already said enough via `kind` alone).
fn final_message(kind: OsSpeechStatusKind, code: Option<i32>, last_error: Option<&(String, String)>) -> Option<String> {
    match kind {
        OsSpeechStatusKind::PermissionDenied
        | OsSpeechStatusKind::Unsupported
        | OsSpeechStatusKind::DeviceChanged
        | OsSpeechStatusKind::UnsupportedLocale
        | OsSpeechStatusKind::AssetFailed => last_error.map(|(_, msg)| msg.clone()),
        OsSpeechStatusKind::Crashed => Some(match last_error {
            Some((code_str, msg)) => format!("{code_str}: {msg}"),
            None => format!("helper exited unexpectedly (code {code:?})"),
        }),
        OsSpeechStatusKind::Ended
        | OsSpeechStatusKind::Starting
        | OsSpeechStatusKind::Capturing
        | OsSpeechStatusKind::AssetChecking
        | OsSpeechStatusKind::AssetDownloading
        | OsSpeechStatusKind::AssetInstalled
        | OsSpeechStatusKind::LocaleResolved => None,
    }
}

/// The preinstall lane's OWN terminal-status decision (R7) — narrower
/// than the session lane's `final_kind`/`exit_status_kind`, which this
/// deliberately does NOT delegate to: preinstall has no tap, no explicit
/// stop command, and (crucially) an already-successful `asset:"installed"`
/// event has already settled the JS task row on its own, so a clean
/// finish needs NO further signal at all — `None` here means "emit
/// nothing" (mirrors the preempted case's own suppression, one level
/// up). Any OTHER outcome is, from the JS preinstall tracker's point of
/// view, simply "the model failed to install": always `AssetFailed`,
/// NEVER `Crashed`/`Ended` — an extra "ended" from this lane is exactly
/// what codex's HIGH false-latch scenario rode on. R2's `source` tag
/// already protects the SESSION engine from a stray event on this lane,
/// but the preinstall tracker itself still listens for asset-kind events
/// from EITHER source (preempt handoff continuity), so this closes the
/// semantic hole at the source instead of relying on `source` alone.
fn preinstall_terminal_kind(code: Option<i32>, finished_seen: bool) -> Option<OsSpeechStatusKind> {
    if finished_seen && code == Some(0) {
        None
    } else {
        Some(OsSpeechStatusKind::AssetFailed)
    }
}

// ---- NDJSON parsing (§2.2) ----

/// jargonslayer-audiocap's new stderr NDJSON shapes for the transcribe/
/// probe/preinstall modes — all eight `type`s collapse onto this one
/// permissive struct (mirrors audiocap.rs's own `RawAudiocapLine`);
/// `parse_osspeech_line` below is what actually distinguishes them.
#[derive(Debug, Deserialize)]
struct RawOsSpeechLine {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "final")]
    final_: Option<bool>,
    seq: Option<u64>,
    #[serde(rename = "startMs")]
    start_ms: Option<u64>,
    #[serde(rename = "endMs")]
    end_ms: Option<u64>,
    text: Option<String>,
    state: Option<String>,
    progress: Option<f64>,
    message: Option<String>,
    requested: Option<String>,
    resolved: Option<String>,
    supported: Option<bool>,
    locales: Option<Vec<String>>,
    installed: Option<Vec<String>>,
    code: Option<String>,
    #[serde(rename = "sampleRate")]
    sample_rate: Option<u32>,
    channels: Option<u16>,
    overflows: Option<u64>,
    #[serde(rename = "ringHighWater")]
    ring_high_water: Option<u64>,
    #[serde(rename = "framesOut")]
    frames_out: Option<u64>,
    #[serde(rename = "droppedFrames")]
    dropped_frames: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
enum ParsedOsSpeechLine {
    Transcript {
        final_: bool,
        seq: u64,
        start_ms: u64,
        end_ms: u64,
        text: String,
    },
    Asset {
        state: String,
        progress: Option<f64>,
        message: Option<String>,
    },
    Locale {
        requested: String,
        /// R6: Swift deliberately OMITS this field when `supported:false`
        /// (there's no resolved locale to report) — required only
        /// in-practice when `supported` is `true`, so this must stay
        /// `Option`, never a bare `String`, or the whole record wrongly
        /// degrades to `Unrecognized` on the unsupported-locale path.
        resolved: Option<String>,
        supported: bool,
    },
    Probe {
        supported: bool,
        locales: Vec<String>,
        installed: Vec<String>,
    },
    Status {
        state: String,
        sample_rate: Option<u32>,
        channels: Option<u16>,
    },
    Error {
        code: String,
        message: String,
    },
    /// Forwarded to the log lane only (no status event) — same posture
    /// as audiocap's own `ParsedAudiocapLine::Stats`. No fields: nothing
    /// downstream of this parse ever needs the actual counters, only the
    /// raw line (already mirrored unconditionally — see the session
    /// task) — this variant exists purely so a well-formed stats line is
    /// never misclassified as `Unrecognized`.
    Stats,
    /// Not valid JSON, valid JSON with an unrecognized/missing "type", or
    /// a known "type" missing the fields that shape requires — never a
    /// panic, always falls back here (mirrors audiocap's own posture for
    /// the same class of "line might be garbage" problem).
    Unrecognized,
}

/// Pure line classifier — no I/O, no process spawn. Mirrors audiocap's
/// own `parse_audiocap_line`: a permissive raw parse, then a strict
/// per-`type` check that every field that shape requires actually showed
/// up (else `Unrecognized`, never a default/guess).
fn parse_osspeech_line(line: &str) -> ParsedOsSpeechLine {
    let Ok(raw) = serde_json::from_str::<RawOsSpeechLine>(line) else {
        return ParsedOsSpeechLine::Unrecognized;
    };
    match raw.kind.as_str() {
        "transcript" => match (raw.final_, raw.seq, raw.start_ms, raw.end_ms, raw.text) {
            (Some(final_), Some(seq), Some(start_ms), Some(end_ms), Some(text)) => ParsedOsSpeechLine::Transcript {
                final_,
                seq,
                start_ms,
                end_ms,
                text,
            },
            _ => ParsedOsSpeechLine::Unrecognized,
        },
        "asset" => match raw.state {
            Some(state) => ParsedOsSpeechLine::Asset {
                state,
                progress: raw.progress,
                message: raw.message,
            },
            None => ParsedOsSpeechLine::Unrecognized,
        },
        // R6: `resolved` is NOT required here (only `requested`/
        // `supported` are) — Swift omits it when `supported:false`.
        "locale" => match (raw.requested, raw.supported) {
            (Some(requested), Some(supported)) => ParsedOsSpeechLine::Locale {
                requested,
                resolved: raw.resolved,
                supported,
            },
            _ => ParsedOsSpeechLine::Unrecognized,
        },
        "osspeech-probe" => match (raw.supported, raw.locales, raw.installed) {
            (Some(supported), Some(locales), Some(installed)) => ParsedOsSpeechLine::Probe { supported, locales, installed },
            _ => ParsedOsSpeechLine::Unrecognized,
        },
        "status" => match raw.state {
            Some(state) => ParsedOsSpeechLine::Status {
                state,
                sample_rate: raw.sample_rate,
                channels: raw.channels,
            },
            None => ParsedOsSpeechLine::Unrecognized,
        },
        "error" => match (raw.code, raw.message) {
            (Some(code), Some(message)) => ParsedOsSpeechLine::Error { code, message },
            _ => ParsedOsSpeechLine::Unrecognized,
        },
        "stats" => match (raw.overflows, raw.ring_high_water, raw.frames_out, raw.dropped_frames) {
            (Some(_), Some(_), Some(_), Some(_)) => ParsedOsSpeechLine::Stats,
            _ => ParsedOsSpeechLine::Unrecognized,
        },
        _ => ParsedOsSpeechLine::Unrecognized,
    }
}

// ---- OsSpeechState: single-flight + generation guard (clone of
// AudiocapState's shape, §3 Worker B) ----

/// Managed Tauri state (`.manage(OsSpeechState::default())`, lib.rs).
/// `running`/`generation`/`paused` are a direct clone of `AudiocapState`'s
/// own shape/semantics (see that struct's own doc comment) for the
/// transcribe session. `preinstall` is this module's own addition — a
/// SEPARATE single-flight slot (never the `running` one) so
/// `pause_os_speech`/`resume_os_speech`/`stop_os_speech` can never
/// accidentally reach into a running preinstall's child (they only ever
/// touch `running`) — see `try_begin_preinstall`'s own doc comment for
/// how the two slots are still kept mutually exclusive. `probe_memo` is
/// `os_speech_capabilities`'s own process-once cache (Q4).
#[derive(Default)]
pub struct OsSpeechState {
    generation: AtomicU64,
    running: Mutex<Option<RunningSession>>,
    /// Q3: "Pause gates in the HELPER (PCM never reaches Rust)" — unlike
    /// `AudiocapState::paused` (which the audiocap session task polls
    /// every loop iteration to gate a LOCAL pipeline), this flag is pure
    /// externally-observable bookkeeping: the actual pause/resume
    /// happens via `write_stdin_command` writing directly to the
    /// helper's stdin. Still reset unconditionally by every `try_begin`
    /// (a leftover pause from a finished session must never leak into
    /// the next one, same as audiocap).
    paused: AtomicBool,
    preinstall: Mutex<Option<PreinstallSlot>>,
    /// R3 (ABA fix): a monotonic counter, mirroring `generation` one layer
    /// down — every `try_begin_preinstall` claim mints a fresh `attempt`
    /// id (see `PreinstallSlot`'s own doc comment for why the slot itself
    /// carries it too).
    preinstall_attempt: AtomicU64,
    /// Records WHICH preinstall attempt (if any) was preempted by a
    /// session start — R3 replaces what used to be a bare
    /// `AtomicBool` specifically to close an ABA race: a belated
    /// Terminated from an attempt preempted long ago must never
    /// mistake itself for "not preempted" just because a LATER attempt
    /// has since begun (which a shared, un-keyed bool couldn't tell
    /// apart). Consumed exactly once, attempt-conditionally, by the
    /// preinstall task's Terminated arm — see `preempt_preinstall`/
    /// `take_preinstall_preempted`'s own doc comments. Deliberately
    /// NEVER reset by `try_begin_preinstall` (unlike the old bool, which
    /// was — see that fn's own doc comment for why that reset is gone):
    /// a leaked-but-unconsumed record can only ever match its own unique
    /// attempt id, never a different (in particular, a later) one, so
    /// there is no correctness reason left to clear it early, and doing
    /// so would reopen exactly the race this field exists to close.
    preempted_attempt: Mutex<Option<u64>>,
    probe_memo: Mutex<Option<OsSpeechCapabilities>>,
}

struct RunningSession {
    generation: u64,
    /// `Some` from `attach_child` until `take_child_for_stop` removes it
    /// — mirrors `AudiocapState::RunningSession.child` exactly (see that
    /// struct's own doc comment for the F1 cancel-during-spawn race this
    /// enables detecting).
    child: Option<CommandChild>,
    cancel_requested: bool,
}

/// Single-flight slot for an in-flight `preinstall_os_speech` call —
/// deliberately its OWN two-phase shape (`Spawning` before the sidecar
/// spawn resolves, `Attached` once its `CommandChild` is known), mirroring
/// `RunningSession`'s own Starting/Running split, but with no
/// `cancel_requested` field: v1 ships no explicit preinstall-cancel
/// command. The one way a preinstall ends early is `preempt_preinstall`
/// (a session start taking over — the F1-analogous race THAT introduces
/// is handled by `attach_preinstall_child`'s Err branch plus the
/// `preempted_attempt` record). Each variant carries its own `attempt` id
/// (R3, ABA fix — mirrors `RunningSession::generation` one layer down):
/// without it, a delayed `attach_preinstall_child`/`finish_preinstall`
/// call from attempt N could act on a slot that, by the time it actually
/// runs, has become attempt N+1's own occupancy — `attempt()` below is
/// what every attempt-conditional check compares against.
enum PreinstallSlot {
    Spawning { attempt: u64 },
    Attached { attempt: u64, child: CommandChild },
}

impl PreinstallSlot {
    fn attempt(&self) -> u64 {
        match self {
            Self::Spawning { attempt } | Self::Attached { attempt, .. } => *attempt,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct FinishOutcome {
    was_current: bool,
    stop_was_requested: bool,
}

fn poison_err<T>(_: std::sync::PoisonError<T>) -> String {
    "osspeech state lock was poisoned by an earlier panic".to_string()
}

/// A running transcribe session and an in-flight preinstall are never
/// concurrent — both post asset-lifecycle events to the SAME
/// `osspeech://status` lane (§2.5). `source` (R2) now tags WHICH lane
/// emitted a given event, but that's a JS-side disambiguation signal, not
/// a reason on its own to let two independent helper processes (two
/// CoreAudio taps / asset-installer sessions) run at once — v1 still
/// keeps them single-flighted against each other regardless. The two
/// directions resolve differently (lead adjudication on the §A2 wording,
/// 2026-07-14):
/// - preinstall over a running session → REJECTED (this message);
/// - session start over an in-flight preinstall → the preinstall is
///   PREEMPTED (`preempt_preinstall`), because rejecting would break the
///   wizard's own happy path: choose 系统识别 → background preinstall
///   fires → the user immediately starts a meeting. The session helper's
///   own asset-ensure step resumes the download from the OS asset cache,
///   and its asset events continue the same single-wire progression.
///
/// `try_begin`/`try_begin_preinstall` still both acquire `running`'s lock
/// FIRST (see each fn's own comment) — a deliberate, consistent
/// lock-ordering choice, not an accident: acquiring the two Mutexes in a
/// different order in the two functions would be a classic deadlock risk.
const PREINSTALL_BUSY_MESSAGE: &str = "busy: session or preinstall in progress";

impl OsSpeechState {
    /// Single-flight claim for a transcribe session. The preinstall-slot
    /// rejection below is a LAST-RESORT guard: `start_os_speech` calls
    /// `preempt_preinstall` first, so by the time this runs the slot is
    /// normally empty — it only still fires if a concurrent
    /// `preinstall_os_speech` re-claimed the slot in the tiny window
    /// between the preempt and this call (accept-as-is: user-driven
    /// double-click-scale race, and rejecting the START is the safe
    /// side). Holds `running`'s lock across the `preinstall` check (not
    /// just its own) so a concurrent `try_begin_preinstall` (which
    /// acquires the SAME lock first) can never interleave with this
    /// function's own check-then-write.
    fn try_begin(&self) -> Result<u64, String> {
        let mut guard = self.running.lock().map_err(poison_err)?;
        if guard.is_some() {
            return Err("a transcribe session is already running".to_string());
        }
        if self.preinstall.lock().map(|g| g.is_some()).unwrap_or(true) {
            return Err(PREINSTALL_BUSY_MESSAGE.to_string());
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *guard = Some(RunningSession {
            generation,
            child: None,
            cancel_requested: false,
        });
        self.paused.store(false, Ordering::SeqCst);
        Ok(generation)
    }

    fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Backs `pause_os_speech`/`resume_os_speech`: idempotent, a no-op
    /// whenever nothing is actually running — mirrors `AudiocapState::
    /// set_paused` exactly (see that fn's own doc comment for why the
    /// small "session ends right after this check" race is harmless).
    fn set_paused(&self, paused: bool) {
        if self.running.lock().map(|guard| guard.is_some()).unwrap_or(false) {
            self.paused.store(paused, Ordering::SeqCst);
        }
    }

    /// Writes a stdin command line (`pause\n`/`resume\n`, §2.3) to the
    /// current session's child, if one is attached — a silent no-op when
    /// idle (nothing running yet, or the spawn is still in its own
    /// Starting window with no `CommandChild` attached) so `pause_os_
    /// speech`/`resume_os_speech` can stay `Ok(())`-always-when-idle per
    /// their own pinned contract (§2.4).
    fn write_stdin_command(&self, bytes: &[u8]) -> Result<(), String> {
        let mut guard = self.running.lock().map_err(poison_err)?;
        if let Some(session) = guard.as_mut() {
            if let Some(child) = session.child.as_mut() {
                child.write(bytes).map_err(|e| format!("failed to write to jargonslayer-audiocap stdin: {e}"))?;
            }
        }
        Ok(())
    }

    /// F1 (audiocap.rs's own fix, replicated here): the pure, `CommandChild`
    /// -free predicate behind `attach_child`'s decision, split out so it's
    /// unit-testable without ever constructing a real `CommandChild` (see
    /// `should_attach_child` below).
    fn is_attachable(session: &RunningSession, generation: u64) -> bool {
        session.generation == generation && !session.cancel_requested
    }

    #[cfg(test)]
    fn should_attach_child(&self, generation: u64) -> bool {
        self.running
            .lock()
            .map(|guard| guard.as_ref().is_some_and(|session| Self::is_attachable(session, generation)))
            .unwrap_or(false)
    }

    /// Attaches the just-spawned `CommandChild` to `generation`'s slot —
    /// `Err(child)` (handing the same child straight back, unstored)
    /// whenever `is_attachable` says no: F1's own race (a stop already
    /// landed for this generation while the spawn was still in flight) or
    /// the defensive "generation no longer the slot's occupant at all"
    /// case. Either way `start_os_speech` is expected to tear the
    /// returned child down immediately, exactly like `AudiocapState::
    /// attach_child`'s own caller.
    fn attach_child(&self, generation: u64, child: CommandChild) -> Result<(), CommandChild> {
        let Ok(mut guard) = self.running.lock() else {
            return Err(child);
        };
        match guard.as_mut() {
            Some(session) if Self::is_attachable(session, generation) => {
                session.child = Some(child);
                Ok(())
            }
            _ => Err(child),
        }
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    /// Idempotent stop-request — mirrors `AudiocapState::take_child_for_stop`
    /// exactly, including the F1 `cancel_requested` marking for a stop
    /// landing during the Starting window.
    fn take_child_for_stop(&self) -> Result<Option<(CommandChild, u32, u64)>, String> {
        let mut guard = self.running.lock().map_err(poison_err)?;
        Ok(guard.as_mut().and_then(|session| match session.child.take() {
            Some(child) => {
                let pid = child.pid();
                Some((child, pid, session.generation))
            }
            None => {
                session.cancel_requested = true;
                None
            }
        }))
    }

    /// Called once by a session's own task when it's fully done — clears
    /// the running slot IFF it's still this generation's own. Named
    /// distinctly from audiocap's own `finish` (this module also has a
    /// `finish_preinstall`, a different concept living in a different
    /// slot — see `PreinstallSlot`'s own doc comment for why they're kept
    /// separate).
    fn finish_session(&self, generation: u64) -> FinishOutcome {
        let Ok(mut guard) = self.running.lock() else {
            return FinishOutcome {
                was_current: false,
                stop_was_requested: true,
            };
        };
        match guard.as_ref() {
            Some(session) if session.generation == generation => {
                let stop_was_requested = session.child.is_none();
                *guard = None;
                FinishOutcome {
                    was_current: true,
                    stop_was_requested,
                }
            }
            _ => FinishOutcome {
                was_current: false,
                stop_was_requested: true,
            },
        }
    }

    /// Used by the stop-grace watchdog to decide whether the SIGKILL
    /// fallback is still needed.
    fn still_running(&self, generation: u64) -> bool {
        self.running
            .lock()
            .map(|guard| matches!(&*guard, Some(session) if session.generation == generation))
            .unwrap_or(true) // poisoned -> assume still running: a spurious kill is harmless, a missed one is a real leak
    }

    fn cached_probe(&self) -> Option<OsSpeechCapabilities> {
        self.probe_memo.lock().ok().and_then(|guard| guard.clone())
    }

    fn store_probe(&self, caps: OsSpeechCapabilities) {
        if let Ok(mut guard) = self.probe_memo.lock() {
            *guard = Some(caps);
        }
    }

    /// Single-flight claim for `preinstall_os_speech` — see this struct's
    /// own doc comment for the full mutual-exclusion rationale (against
    /// BOTH a running transcribe session and another in-flight
    /// preinstall). Holds `running`'s lock across the `preinstall` check-
    /// and-write (not just a read) for the same reason `try_begin` does:
    /// consistent lock ordering (`running` always acquired first) is what
    /// makes the two functions race-free against each other. Returns the
    /// freshly-minted `attempt` id (R3) the caller threads through
    /// `attach_preinstall_child`/`spawn_preinstall_task` so every later
    /// attempt-conditional check can tell its own slot/preemption record
    /// apart from a since-superseded one.
    fn try_begin_preinstall(&self) -> Result<u64, String> {
        let session_guard = self.running.lock().map_err(poison_err)?;
        if session_guard.is_some() {
            return Err(PREINSTALL_BUSY_MESSAGE.to_string());
        }
        let mut preinstall_guard = self.preinstall.lock().map_err(poison_err)?;
        if preinstall_guard.is_some() {
            return Err(PREINSTALL_BUSY_MESSAGE.to_string());
        }
        let attempt = self.preinstall_attempt.fetch_add(1, Ordering::SeqCst) + 1;
        *preinstall_guard = Some(PreinstallSlot::Spawning { attempt });
        Ok(attempt)
    }

    /// A session start taking over an in-flight preinstall (see
    /// `PREINSTALL_BUSY_MESSAGE`'s doc comment for the product rationale).
    /// Clears the slot, records the preempted attempt's own id in
    /// `preempted_attempt` (R3) so the preinstall task's Terminated arm
    /// suppresses its terminal status emission — that emission is NOT
    /// generation-gated, and (post-R7) a failure emits `asset-failed`,
    /// which the JS preinstall tracker accepts from either source, so
    /// letting a STALE attempt's failure through unsuppressed could
    /// corrupt a DIFFERENT, still-live attempt's task row. Returns the
    /// preempted `CommandChild` (if the spawn had already attached one)
    /// for the caller to tear down; a still-`Spawning` preinstall needs no
    /// teardown here because `attach_preinstall_child` finds the slot's
    /// attempt mismatched (or altogether missing) and hands the child
    /// straight back for dropping.
    fn preempt_preinstall(&self) -> Option<CommandChild> {
        let Ok(mut guard) = self.preinstall.lock() else {
            return None;
        };
        match guard.take() {
            None => None,
            Some(PreinstallSlot::Spawning { attempt }) => {
                self.record_preempted_attempt(attempt);
                None
            }
            Some(PreinstallSlot::Attached { attempt, child }) => {
                self.record_preempted_attempt(attempt);
                Some(child)
            }
        }
    }

    fn record_preempted_attempt(&self, attempt: u64) {
        if let Ok(mut guard) = self.preempted_attempt.lock() {
            *guard = Some(attempt);
        }
    }

    /// Attempt-conditional (R3): consumes (and returns `true` for) a
    /// preempt recorded against EXACTLY this attempt id, leaving a
    /// differently-scoped record (belonging to some other attempt — in
    /// particular a LATER one that began in the meantime) untouched. A
    /// belated call for an attempt that was never actually preempted —
    /// including one whose own preempt record has since been overwritten
    /// by a later attempt's own preemption — correctly reports `false`
    /// rather than accidentally consuming a record that isn't its own.
    /// Called once, by the preinstall task at Terminated, with its own
    /// attempt id (captured at spawn time — see `spawn_preinstall_task`).
    fn take_preinstall_preempted(&self, attempt: u64) -> bool {
        let Ok(mut guard) = self.preempted_attempt.lock() else {
            return false;
        };
        if *guard == Some(attempt) {
            *guard = None;
            true
        } else {
            false
        }
    }

    /// Attaches the just-spawned preinstall `CommandChild` to ITS OWN
    /// attempt id's slot. The `Err(child)` branch IS reachable: not only
    /// when `preempt_preinstall` cleared the slot outright (a session
    /// start racing this spawn window — the original F1-analogous race
    /// this guarded from the start), but now (R3) ALSO when the slot has
    /// since been reclaimed by a DIFFERENT, later preinstall attempt —
    /// without the attempt check this attach would otherwise splice
    /// attempt N's child into attempt N+1's `Spawning` slot. Either way
    /// the caller is expected to tear the returned child down immediately.
    fn attach_preinstall_child(&self, attempt: u64, child: CommandChild) -> Result<(), CommandChild> {
        let Ok(mut guard) = self.preinstall.lock() else {
            return Err(child);
        };
        match guard.as_ref() {
            Some(PreinstallSlot::Spawning { attempt: slot_attempt }) if *slot_attempt == attempt => {
                *guard = Some(PreinstallSlot::Attached { attempt, child });
                Ok(())
            }
            _ => Err(child),
        }
    }

    /// Clears the preinstall slot IFF it's still THIS attempt's own
    /// occupant (R3: attempt-conditional, mirrors `finish_session`'s own
    /// generation check one layer up) — a belated call from a
    /// since-preempted attempt can therefore never clear a NEWER attempt's
    /// own live slot (the "stale-P1-clears-P2" scenario this fix makes
    /// impossible).
    fn finish_preinstall(&self, attempt: u64) {
        if let Ok(mut guard) = self.preinstall.lock() {
            if guard.as_ref().is_some_and(|slot| slot.attempt() == attempt) {
                *guard = None;
            }
        }
    }
}

// ---- start_os_speech / stop_os_speech ----

#[tauri::command]
pub fn start_os_speech(
    app: tauri::AppHandle,
    state: tauri::State<'_, OsSpeechState>,
    locale: String,
    contextual_json: Option<String>,
) -> Result<(), String> {
    // Runtime re-check (D6: "UI gating is not a boundary") — even if the
    // option was somehow shown/enabled below the floor, the spawn itself
    // is refused here too.
    if !is_macos_26_or_later(macos_version()) {
        return Err(UNSUPPORTED_REASON.to_string());
    }

    // A session start preempts an in-flight preinstall rather than being
    // rejected by it (see PREINSTALL_BUSY_MESSAGE's doc comment — the
    // wizard's happy path fires a background preinstall right before the
    // user's first meeting). A downloader holds no audio and needs no
    // grace period: SIGKILL immediately; the OS asset manager resumes the
    // download inside this session's own asset-ensure step.
    if let Some(child) = state.preempt_preinstall() {
        let pid = child.pid();
        drop(child);
        force_kill_pid(pid);
    }

    let generation = state.try_begin()?;
    let own_pid = std::process::id().to_string();

    // §2.1/A5: `--exclude-pid` is required in transcribe mode too (same
    // self-exclusion semantics as capture).
    let mut args = vec!["--transcribe".to_string(), "--exclude-pid".to_string(), own_pid, "--locale".to_string(), locale];
    if let Some(json) = contextual_json {
        args.push("--contextual-json".to_string());
        args.push(json);
    }

    let spawn_result = app
        .shell()
        .sidecar(AUDIOCAP_SIDECAR_PROGRAM)
        .map_err(|e| format!("could not resolve the jargonslayer-audiocap sidecar: {e}"))
        .and_then(|command| {
            // No `.set_raw_out(true)`: no stdout wire in this mode (§0) —
            // see `run_probe`'s own comment for why that's safe together
            // with still running stderr through `LineReassembler` anyway.
            command.args(args).spawn().map_err(|e| format!("failed to spawn jargonslayer-audiocap: {e}"))
        });

    match spawn_result {
        Ok((rx, child)) => {
            let pid = child.pid();
            if let Err(child) = state.attach_child(generation, child) {
                // F1 (mirrors audiocap's start_app_audio exactly): a stop
                // already landed for this generation while the spawn was
                // still in flight — tear this child down right now
                // instead of letting it become a live, un-stoppable
                // session.
                drop(child);
                spawn_stop_watchdog(app.clone(), generation, pid);
            }
            spawn_os_speech_session_task(app, generation, rx);
            Ok(())
        }
        Err(e) => {
            // Release the slot optimistically claimed in try_begin.
            state.finish_session(generation);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn stop_os_speech(app: tauri::AppHandle, state: tauri::State<'_, OsSpeechState>) -> Result<(), String> {
    let Some((child, pid, generation)) = state.take_child_for_stop()? else {
        return Ok(()); // idempotent: nothing running, or a stop is already in flight
    };
    // Closes stdin — jargonslayer-audiocap's StdinCommandMonitor sees EOF
    // and shuts down gracefully (§2.3/§A1). Does NOT send SIGKILL.
    drop(child);
    spawn_stop_watchdog(app, generation, pid);
    Ok(())
}

// ---- pause_os_speech / resume_os_speech ----

/// PINNED CONTRACT: the JS worker wires engine.pause() to exactly this
/// command name. Idempotent; a no-op `Ok(())` when nothing is running.
/// Unlike `AudiocapState`'s own pause (a Rust-side gate on a local
/// pipeline), the actual pause effect lives entirely in the helper — this
/// just relays `pause\n` over stdin (§2.3) and mirrors the flag locally
/// for observability (`OsSpeechState::paused`'s own doc comment).
#[tauri::command]
pub fn pause_os_speech(state: tauri::State<'_, OsSpeechState>) -> Result<(), String> {
    state.write_stdin_command(b"pause\n")?;
    state.set_paused(true);
    Ok(())
}

/// PINNED CONTRACT: the JS worker wires engine.resume() to exactly this
/// command name. See `pause_os_speech`'s own doc comment.
#[tauri::command]
pub fn resume_os_speech(state: tauri::State<'_, OsSpeechState>) -> Result<(), String> {
    state.write_stdin_command(b"resume\n")?;
    state.set_paused(false);
    Ok(())
}

// ---- preinstall_os_speech (§A2: a real 6th command, single-flighted) ----

#[tauri::command]
pub fn preinstall_os_speech(app: tauri::AppHandle, state: tauri::State<'_, OsSpeechState>, locale: String) -> Result<(), String> {
    if !is_macos_26_or_later(macos_version()) {
        return Err(UNSUPPORTED_REASON.to_string());
    }
    let attempt = state.try_begin_preinstall()?;

    let spawn_result = app
        .shell()
        .sidecar(AUDIOCAP_SIDECAR_PROGRAM)
        .map_err(|e| format!("could not resolve the jargonslayer-audiocap sidecar: {e}"))
        .and_then(|command| {
            command
                .args(["--preinstall-osspeech", "--locale", &locale])
                .spawn()
                .map_err(|e| format!("failed to spawn jargonslayer-audiocap: {e}"))
        });

    match spawn_result {
        Ok((rx, child)) => {
            if let Err(child) = state.attach_preinstall_child(attempt, child) {
                // R4: reachable (see attach_preinstall_child's own doc
                // comment) — a session start preempted this attempt (or
                // a later attempt has since reclaimed the slot, R3)
                // while this spawn was still resolving. Unlike a
                // transcribe session's child, the preinstall helper has
                // NO stdin monitor, so dropping the child alone would
                // NOT make it exit — it would keep downloading as an
                // untracked orphan, its events still flowing. Same
                // posture as `start_os_speech`'s own preempt path: a
                // downloader holds no audio and needs no grace period,
                // so SIGKILL it immediately rather than leaking it.
                // Layering note: even if this orphan lingered, its
                // events now carry source:"preinstall" (R2), so the
                // session engine (which ignores anything but
                // source:"session") is protected regardless — this kill
                // is about not leaking the OS process/download, not
                // about wire-level safety, which R2 already covers.
                let pid = child.pid();
                drop(child);
                force_kill_pid(pid);
            }
            spawn_preinstall_task(app, attempt, rx);
            Ok(())
        }
        Err(e) => {
            state.finish_preinstall(attempt);
            Err(e)
        }
    }
}

// Cross-language invariant (mirrors audiocap.rs's own identical comment):
// the JS OsSpeechEngine's own stop path waits up to ~4s
// (STOP_ENDED_TIMEOUT_MS) for a matching "ended" osspeech://status event
// before giving up. This 3s grace period MUST stay strictly shorter than
// that JS timeout — it's what guarantees Rust has cleared OsSpeechState's
// single-flight slot and emitted the final status BEFORE JS times out.
const STOP_GRACE_PERIOD: Duration = Duration::from_secs(3);

fn spawn_stop_watchdog(app: tauri::AppHandle, generation: u64, pid: u32) {
    thread::spawn(move || {
        thread::sleep(STOP_GRACE_PERIOD);
        let state = app.state::<OsSpeechState>();
        if state.still_running(generation) {
            emit_uv_log(&app, "stderr", format!("[osspeech] stop grace period elapsed — sending SIGKILL to pid {pid}"));
            force_kill_pid(pid);
        }
    });
}

#[cfg(target_os = "macos")]
fn force_kill_pid(pid: u32) {
    // SAFETY: a plain libc::kill syscall wrapper with a pid_t/signal — no
    // aliasing/lifetime requirements beyond the FFI call itself.
    // Best-effort: ESRCH (no such process — the graceful stop already won
    // the race) is the overwhelmingly likely reason for a nonzero return.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

#[cfg(not(target_os = "macos"))]
fn force_kill_pid(_pid: u32) {}

// ---- event payload structs (§2.5) + emit helpers ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OsSpeechTranscriptEvent {
    #[serde(rename = "final")]
    final_: bool,
    seq: u64,
    start_ms: u64,
    end_ms: u64,
    text: String,
}

/// §2.5 R2 — PINNED CROSS-LANE CONTRACT: every `osspeech://status` payload
/// carries a `source` provenance tag distinguishing the two independent
/// Rust tasks that can both emit on this one shared, app-global event lane
/// (risk register item 8's "app.emit is app-global" concern, one layer up
/// from the existing generation guard, which only protects the session
/// lane against ITS OWN stale generations — it says nothing about the
/// preinstall lane's events also landing on the exact same wire). The JS
/// `OsSpeechEngine` ignores any event whose `source` isn't `"session"`;
/// the JS preinstall tracker accepts asset-lifecycle events from EITHER
/// source, since a session start can preempt an in-flight preinstall
/// mid-download (`preempt_preinstall`) and then continue driving the SAME
/// task row under its own `"session"` source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OsSpeechEventSource {
    Session,
    Preinstall,
}

impl OsSpeechEventSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Preinstall => "preinstall",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OsSpeechStatusEvent {
    kind: &'static str,
    /// Placeholder at construction time — see `tagged`'s own doc comment
    /// for why that's safe: every event this module ever builds passes
    /// through it (via `emit_os_speech_status`) before reaching the wire.
    source: &'static str,
    message: Option<String>,
    progress: Option<f64>,
    resolved_locale: Option<String>,
    supported_locales: Option<Vec<String>>,
}

impl OsSpeechStatusEvent {
    fn kind_only(kind: OsSpeechStatusKind) -> Self {
        Self {
            kind: kind.as_str(),
            source: OsSpeechEventSource::Session.as_str(), // placeholder — see `tagged`
            message: None,
            progress: None,
            resolved_locale: None,
            supported_locales: None,
        }
    }

    fn with_message(kind: OsSpeechStatusKind, message: impl Into<String>) -> Self {
        Self {
            message: Some(message.into()),
            ..Self::kind_only(kind)
        }
    }

    /// The ONLY place `source` is ever set to a value that matters —
    /// `emit_os_speech_status` calls this immediately before every single
    /// emission (§2.5 R2), so every event that reaches JS is correctly
    /// tagged regardless of which of this module's many construction call
    /// sites built it, with no risk of a call site forgetting to set it.
    fn tagged(mut self, source: OsSpeechEventSource) -> Self {
        self.source = source.as_str();
        self
    }
}

/// The sole choke point this module ever emits `osspeech://status` from —
/// see `OsSpeechStatusEvent::tagged`'s own doc comment for why that makes
/// `source` unforgeable-wrong on the actual wire.
fn emit_os_speech_status(app: &tauri::AppHandle, source: OsSpeechEventSource, event: OsSpeechStatusEvent) {
    let _ = app.emit("osspeech://status", event.tagged(source));
}

/// Same generation-guard posture as audiocap's own `emit_status`: a late
/// event from a superseded session's own task must never reach a newer
/// session's listeners (risk register item 8). Only ever called from the
/// session task, so `source` is always `Session` here.
fn emit_status_for_session(app: &tauri::AppHandle, generation: u64, event: OsSpeechStatusEvent) {
    if !app.state::<OsSpeechState>().is_current(generation) {
        return;
    }
    emit_os_speech_status(app, OsSpeechEventSource::Session, event);
}

fn emit_transcript_for_session(app: &tauri::AppHandle, generation: u64, event: OsSpeechTranscriptEvent) {
    if !app.state::<OsSpeechState>().is_current(generation) {
        return;
    }
    let _ = app.emit("osspeech://transcript", event);
}

// ---- durable session log (mirrors audiocap.rs's own SessionLog
// approach, minus the batch/byte counters — there is no PCM channel to
// track batches/bytes for on this path at all) ----

const OSSPEECH_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

fn open_osspeech_log_file(app: &tauri::AppHandle) -> Option<std::fs::File> {
    if let Ok(dir) = app.path().app_log_dir() {
        let path = dir.join("osspeech.log");
        if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > OSSPEECH_LOG_MAX_BYTES {
            let _ = std::fs::write(&path, []); // best-effort truncate-to-empty
        }
    }
    open_log_file_in_app_log_dir(app, "osspeech.log")
}

/// `<app_log_dir>/osspeech.log` — every stderr line gets appended here
/// (unconditionally — see the session/preinstall tasks below), alongside
/// the ephemeral `uv://log` mirror every line also gets. For every record
/// EXCEPT a transcript, that's the raw NDJSON line verbatim. A transcript
/// record carries live meeting content in its `text` field (§2.2) — this
/// would otherwise be the first local, durable log in the app to contain
/// meeting content, violating the app's own no-transcript-in-diagnostics
/// posture (`diag/log.ts`/`diag/report.ts`/`bootstrap.ts`) — so transcript
/// lines are logged as a METADATA-ONLY line instead (see `log_line_for`):
/// the `text` itself is NEVER written to this file or mirrored to
/// `uv://log`.
struct OsSpeechSessionLog {
    file: Option<std::fs::File>,
}

impl OsSpeechSessionLog {
    fn open(app: &tauri::AppHandle) -> Self {
        Self { file: open_osspeech_log_file(app) }
    }

    /// Appends one timestamped line — a silent no-op if the file
    /// couldn't be opened, and a write failure permanently disables
    /// further appends for the rest of this session (mirrors audiocap's
    /// own `SessionLog::append` exactly): an io error writing this log
    /// must never fail — or even slow down — the actual session it only
    /// ever describes.
    fn append(&mut self, line: &str) {
        let Some(file) = self.file.as_mut() else { return };
        let now_unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        use std::io::Write;
        if writeln!(file, "[unix {now_unix}] {line}").is_err() {
            self.file = None;
        }
    }
}

/// Decides what actually gets written to the two log lanes (`uv://log` +
/// `OsSpeechSessionLog`) for one already-parsed stderr line — the single
/// choke point both the session task and the preinstall task route
/// through (R1 fix): a `Transcript` record NEVER contributes its `text`
/// (live meeting content) to either lane, only a metadata line; every
/// other record — including `Unrecognized` garbage — is logged verbatim,
/// unchanged from before this fix.
fn log_line_for<'a>(raw_line: &'a str, parsed: &ParsedOsSpeechLine) -> std::borrow::Cow<'a, str> {
    match parsed {
        ParsedOsSpeechLine::Transcript { final_, seq, start_ms, end_ms, text } => {
            std::borrow::Cow::Owned(format!("transcript final={final_} seq={seq} startMs={start_ms} endMs={end_ms} len={}", text.len()))
        }
        _ => std::borrow::Cow::Borrowed(raw_line),
    }
}

// ---- the transcribe session task ----

/// Owns one transcribe session's entire lifetime: reads CommandEvents,
/// reassembles+mirrors every stderr line to both log lanes, maps
/// transcript/asset/locale/status/error records to the two event lanes
/// (§2.5, gated on `is_current`), and clears `OsSpeechState`'s running
/// slot when done. No stdout/framing/pipeline/Channel handling at all —
/// unlike audiocap's own `spawn_session_task`, this mode never writes PCM
/// to stdout (§0), so there is nothing on that side of the child to read.
fn spawn_os_speech_session_task(app: tauri::AppHandle, generation: u64, mut rx: tauri::async_runtime::Receiver<CommandEvent>) {
    tauri::async_runtime::spawn(async move {
        let mut stderr_lines = LineReassembler::new();
        let mut last_error: Option<(String, String)> = None;
        let mut finished_seen = false;
        let mut session_log = OsSpeechSessionLog::open(&app);
        session_log.append(&format!("session start generation={generation}"));

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    for line in stderr_lines.feed(&bytes) {
                        let parsed = parse_osspeech_line(&line);
                        let log_line = log_line_for(&line, &parsed);
                        emit_uv_log(&app, "stderr", format!("[osspeech] {log_line}"));
                        session_log.append(&log_line);
                        match parsed {
                            ParsedOsSpeechLine::Transcript { final_, seq, start_ms, end_ms, text } => {
                                if app.state::<OsSpeechState>().is_paused() {
                                    // Shouldn't normally happen (the
                                    // helper stops advancing analyzer
                                    // input while paused, Q3) — a
                                    // defensive diagnostic in case the
                                    // helper's own pause hasn't taken
                                    // effect yet.
                                    session_log.append(&format!("note: transcript arrived while paused (seq={seq})"));
                                }
                                emit_transcript_for_session(
                                    &app,
                                    generation,
                                    OsSpeechTranscriptEvent {
                                        final_,
                                        seq,
                                        start_ms,
                                        end_ms,
                                        text,
                                    },
                                );
                            }
                            ParsedOsSpeechLine::Asset { state, progress, message } => {
                                if let Some(kind) = asset_record_kind(&state) {
                                    let event = match (progress, message) {
                                        (Some(progress), _) => OsSpeechStatusEvent { progress: Some(progress), ..OsSpeechStatusEvent::kind_only(kind) },
                                        (None, Some(message)) => OsSpeechStatusEvent::with_message(kind, message),
                                        (None, None) => OsSpeechStatusEvent::kind_only(kind),
                                    };
                                    emit_status_for_session(&app, generation, event);
                                }
                            }
                            ParsedOsSpeechLine::Locale { requested: _, resolved, supported } => {
                                // §Q4: unsupported is signaled by a
                                // SEPARATE, deferred `error:unsupported-
                                // locale` record — no direct emission
                                // from the locale record itself in that
                                // case (see error_record_kind's own doc
                                // comment). R6: `resolved` is `Option`
                                // (Swift omits it when `supported:false`),
                                // so this also defensively requires it to
                                // actually be present before emitting —
                                // `supported:true` with no `resolved` is
                                // malformed and simply logged, not emitted.
                                if let (true, Some(resolved)) = (supported, resolved) {
                                    let event = OsSpeechStatusEvent {
                                        resolved_locale: Some(resolved),
                                        ..OsSpeechStatusEvent::kind_only(OsSpeechStatusKind::LocaleResolved)
                                    };
                                    emit_status_for_session(&app, generation, event);
                                }
                            }
                            ParsedOsSpeechLine::Status { state, sample_rate, channels } => {
                                if state == "finished" {
                                    finished_seen = true;
                                }
                                if let Some(kind) = status_record_kind(&state) {
                                    let event = match (sample_rate, channels) {
                                        (Some(sr), Some(ch)) => OsSpeechStatusEvent::with_message(kind, format!("{sr} Hz, {ch}ch")),
                                        _ => OsSpeechStatusEvent::kind_only(kind),
                                    };
                                    emit_status_for_session(&app, generation, event);
                                }
                            }
                            ParsedOsSpeechLine::Error { code, message } => {
                                last_error = Some((code, message));
                            }
                            ParsedOsSpeechLine::Probe { .. } | ParsedOsSpeechLine::Stats | ParsedOsSpeechLine::Unrecognized => {}
                        }
                    }
                }
                CommandEvent::Error(message) => {
                    emit_uv_log(&app, "stderr", format!("[osspeech] shell error: {message}"));
                }
                CommandEvent::Terminated(payload) => {
                    let outcome = app.state::<OsSpeechState>().finish_session(generation);
                    let kind = final_kind(payload.code, last_error.as_ref().map(|(c, _)| c.as_str()), outcome.stop_was_requested, finished_seen);
                    session_log.append(&format!(
                        "session end kind={} exit_code={:?} finished_seen={} was_current={}",
                        kind.as_str(),
                        payload.code,
                        finished_seen,
                        outcome.was_current
                    ));
                    if outcome.was_current {
                        let message = final_message(kind, payload.code, last_error.as_ref());
                        // Best-effort attach of the already-cached probe's
                        // own locale list, if warm — see error_record_kind
                        // /this module's own header note: not a pinned
                        // wire source, just a plausible one given the
                        // field is optional.
                        let supported_locales = if kind == OsSpeechStatusKind::UnsupportedLocale {
                            app.state::<OsSpeechState>().cached_probe().map(|c| c.locales)
                        } else {
                            None
                        };
                        emit_os_speech_status(
                            &app,
                            OsSpeechEventSource::Session,
                            OsSpeechStatusEvent {
                                message,
                                supported_locales,
                                ..OsSpeechStatusEvent::kind_only(kind)
                            },
                        );
                    }
                    return;
                }
                _ => {}
            }
        }

        // rx closed without ever yielding Terminated — shouldn't happen
        // (see audiocap's own identical safety net), kept so the running
        // slot can never get stuck open forever.
        if let Some(line) = stderr_lines.flush() {
            emit_uv_log(&app, "stderr", format!("[osspeech] {line}"));
        }
        let outcome = app.state::<OsSpeechState>().finish_session(generation);
        session_log.append(&format!(
            "session end kind={} exit_code=None finished_seen={} was_current={} reason=rx_closed_without_terminated",
            OsSpeechStatusKind::Crashed.as_str(),
            finished_seen,
            outcome.was_current
        ));
        if outcome.was_current {
            emit_os_speech_status(
                &app,
                OsSpeechEventSource::Session,
                OsSpeechStatusEvent::with_message(OsSpeechStatusKind::Crashed, "helper process ended without a final status"),
            );
        }
    });
}

// ---- the preinstall task ----

/// Owns one `preinstall_os_speech` call's entire lifetime — same
/// stderr-reassembly/log/parse pipeline as the transcribe session task,
/// but: no event-lane generation gating (preinstall is single-flighted
/// with no possibility of a "stale/superseded" instance the way a
/// transcribe session can be), no transcript emission, and
/// `finish_preinstall`/`take_preinstall_preempted` instead of
/// `finish_session` at the end — both attempt-conditional (R3), keyed on
/// `attempt` (this call's own id, minted by `try_begin_preinstall` and
/// threaded in here as a plain param — not a generation, since this task
/// has no event-lane listeners to guard, only its OWN state-bookkeeping
/// calls to scope against a since-superseded attempt).
fn spawn_preinstall_task(app: tauri::AppHandle, attempt: u64, mut rx: tauri::async_runtime::Receiver<CommandEvent>) {
    tauri::async_runtime::spawn(async move {
        let mut stderr_lines = LineReassembler::new();
        let mut last_error: Option<(String, String)> = None;
        let mut finished_seen = false;
        let mut session_log = OsSpeechSessionLog::open(&app);
        session_log.append("preinstall start");

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    for line in stderr_lines.feed(&bytes) {
                        // The preinstall lane shouldn't ever see a
                        // transcript record (§0: no transcribe happens
                        // during a preinstall) — routed through the same
                        // `log_line_for` choke point as the session task
                        // anyway, defensively, so that invariant isn't
                        // load-bearing for the no-transcript-in-
                        // diagnostics posture (R1).
                        let parsed = parse_osspeech_line(&line);
                        let log_line = log_line_for(&line, &parsed);
                        emit_uv_log(&app, "stderr", format!("[osspeech-preinstall] {log_line}"));
                        session_log.append(&log_line);
                        match parsed {
                            ParsedOsSpeechLine::Asset { state, progress, message } => {
                                if let Some(kind) = asset_record_kind(&state) {
                                    let event = match (progress, message) {
                                        (Some(progress), _) => OsSpeechStatusEvent { progress: Some(progress), ..OsSpeechStatusEvent::kind_only(kind) },
                                        (None, Some(message)) => OsSpeechStatusEvent::with_message(kind, message),
                                        (None, None) => OsSpeechStatusEvent::kind_only(kind),
                                    };
                                    emit_os_speech_status(&app, OsSpeechEventSource::Preinstall, event);
                                }
                            }
                            ParsedOsSpeechLine::Locale { requested: _, resolved, supported } => {
                                // R6: see the session task's own copy of
                                // this same guard for why `resolved` needs
                                // its own `Some(..)` check here too.
                                if let (true, Some(resolved)) = (supported, resolved) {
                                    let event = OsSpeechStatusEvent {
                                        resolved_locale: Some(resolved),
                                        ..OsSpeechStatusEvent::kind_only(OsSpeechStatusKind::LocaleResolved)
                                    };
                                    emit_os_speech_status(&app, OsSpeechEventSource::Preinstall, event);
                                }
                            }
                            ParsedOsSpeechLine::Status { state, .. } => {
                                if state == "finished" {
                                    finished_seen = true;
                                }
                            }
                            ParsedOsSpeechLine::Error { code, message } => {
                                last_error = Some((code, message));
                            }
                            ParsedOsSpeechLine::Transcript { .. } | ParsedOsSpeechLine::Probe { .. } | ParsedOsSpeechLine::Stats | ParsedOsSpeechLine::Unrecognized => {}
                        }
                    }
                }
                CommandEvent::Error(message) => {
                    emit_uv_log(&app, "stderr", format!("[osspeech-preinstall] shell error: {message}"));
                }
                CommandEvent::Terminated(payload) => {
                    let state = app.state::<OsSpeechState>();
                    // Both attempt-conditional (R3): a belated Terminated
                    // from an attempt preempted long ago can never (a)
                    // mistake itself for not-preempted just because a
                    // later attempt has since begun (`take_preinstall_
                    // preempted` only matches ITS OWN attempt id), nor (b)
                    // clear that later attempt's own live slot
                    // (`finish_preinstall` only clears a slot still
                    // holding this same `attempt`).
                    let preempted = state.take_preinstall_preempted(attempt);
                    state.finish_preinstall(attempt);
                    if preempted {
                        // Preempted by a session start: emit NOTHING. This
                        // task's terminal emission is not generation-gated
                        // and `crashed` is in the JS terminal-latch set —
                        // letting it through would latch the new session
                        // at birth. The session's own asset events
                        // continue the same single-wire progression, so
                        // the JS task row survives the handoff seamlessly.
                        session_log.append(&format!(
                            "preinstall end preempted-by-session exit_code={:?} — terminal status suppressed",
                            payload.code
                        ));
                        return;
                    }
                    // R7: the preinstall lane's own, narrower terminal
                    // decision — see `preinstall_terminal_kind`'s own doc
                    // comment. `None` (a clean finish) emits nothing at
                    // all; the JS task row was already settled by the
                    // earlier `asset:"installed"` event.
                    match preinstall_terminal_kind(payload.code, finished_seen) {
                        None => {
                            session_log.append(&format!(
                                "preinstall end: finished cleanly, exit_code={:?} — no terminal status emitted (asset-installed already settled the task row)",
                                payload.code
                            ));
                        }
                        Some(kind) => {
                            session_log.append(&format!("preinstall end kind={} exit_code={:?} finished_seen={}", kind.as_str(), payload.code, finished_seen));
                            let message = final_message(kind, payload.code, last_error.as_ref());
                            emit_os_speech_status(&app, OsSpeechEventSource::Preinstall, OsSpeechStatusEvent { message, ..OsSpeechStatusEvent::kind_only(kind) });
                        }
                    }
                    return;
                }
                _ => {}
            }
        }

        if let Some(line) = stderr_lines.flush() {
            emit_uv_log(&app, "stderr", format!("[osspeech-preinstall] {line}"));
        }
        app.state::<OsSpeechState>().finish_preinstall(attempt);
        session_log.append("preinstall end: rx closed without a final status");
        // R7: same posture as the Terminated arm above — this lane never
        // reports crashed/ended, only asset-failed (see
        // `preinstall_terminal_kind`'s own doc comment).
        emit_os_speech_status(
            &app,
            OsSpeechEventSource::Preinstall,
            OsSpeechStatusEvent::with_message(OsSpeechStatusKind::AssetFailed, "helper process ended without a final status"),
        );
    });
}

// ---- app-exit cleanup ----

/// Called from lib.rs's RunEvent::ExitRequested/Exit handler, right next
/// to `audiocap::kill_held_session_on_exit` — same best-effort,
/// no-grace-period posture (see that function's own doc comment for the
/// force-quit gap this can't catch either). Covers BOTH a live transcribe
/// session's child AND a live preinstall's child — both are real,
/// separately-spawned helper processes that would otherwise survive a
/// graceful app quit.
pub fn kill_held_session_on_exit(app: &tauri::AppHandle) {
    let state = app.state::<OsSpeechState>();
    if let Ok(mut guard) = state.running.lock() {
        if let Some(child) = guard.take().and_then(|session| session.child) {
            force_kill_pid(child.pid());
        }
    }
    if let Ok(mut guard) = state.preinstall.lock() {
        if let Some(PreinstallSlot::Attached { child, .. }) = guard.take() {
            force_kill_pid(child.pid());
        }
    }; // semicolon: this is the fn's tail expression otherwise, which
       // extends the MutexGuard-holding temporary's drop scope to the
       // end of the function — outliving `state` itself (E0597).
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- LineReassembler (copy of audiocap.rs's own tests) ----

    #[test]
    fn feed_returns_complete_lines_from_a_single_chunk() {
        let mut r = LineReassembler::new();
        let lines = r.feed(b"{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(lines, vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]);
        assert_eq!(r.flush(), None, "nothing should remain buffered");
    }

    #[test]
    fn feed_buffers_a_line_split_across_two_chunks() {
        let mut r = LineReassembler::new();
        assert_eq!(r.feed(b"{\"type\":\"transc"), Vec::<String>::new(), "no complete line yet");
        assert_eq!(r.feed(b"ript\"}\n"), vec!["{\"type\":\"transcript\"}".to_string()]);
    }

    #[test]
    fn feed_keeps_a_trailing_partial_line_buffered_and_returns_completed_ones() {
        let mut r = LineReassembler::new();
        let lines = r.feed(b"one\ntwo\nthree-partial");
        assert_eq!(lines, vec!["one".to_string(), "two".to_string()]);
        assert_eq!(r.flush(), Some("three-partial".to_string()));
    }

    #[test]
    fn flush_returns_none_when_nothing_is_buffered() {
        let mut r = LineReassembler::new();
        assert_eq!(r.flush(), None);
    }

    #[test]
    fn flush_clears_the_buffer_so_a_second_flush_returns_none() {
        let mut r = LineReassembler::new();
        r.feed(b"no newline yet");
        assert_eq!(r.flush(), Some("no newline yet".to_string()));
        assert_eq!(r.flush(), None);
    }

    #[test]
    fn empty_chunk_yields_no_lines() {
        let mut r = LineReassembler::new();
        assert!(r.feed(b"").is_empty());
    }

    // ---- macOS version gating ----

    #[test]
    fn version_below_26_is_unsupported() {
        assert!(!is_macos_26_or_later((14, 4)));
        assert!(!is_macos_26_or_later((15, 9)));
        assert!(!is_macos_26_or_later((25, 9)));
    }

    #[test]
    fn version_26_and_above_is_supported_regardless_of_minor() {
        assert!(is_macos_26_or_later((26, 0)));
        assert!(is_macos_26_or_later((27, 0)));
    }

    // ---- NDJSON parsing (§2.2) ----

    #[test]
    fn parses_an_interim_transcript_line() {
        let line = r#"{"type":"transcript","final":false,"seq":12,"startMs":3200,"endMs":4100,"text":"jargon slayer"}"#;
        assert_eq!(
            parse_osspeech_line(line),
            ParsedOsSpeechLine::Transcript {
                final_: false,
                seq: 12,
                start_ms: 3200,
                end_ms: 4100,
                text: "jargon slayer".to_string(),
            }
        );
    }

    #[test]
    fn parses_a_final_transcript_line() {
        let line = r#"{"type":"transcript","final":true,"seq":13,"startMs":0,"endMs":4920,"text":"Jargon slayer is a tool."}"#;
        assert_eq!(
            parse_osspeech_line(line),
            ParsedOsSpeechLine::Transcript {
                final_: true,
                seq: 13,
                start_ms: 0,
                end_ms: 4920,
                text: "Jargon slayer is a tool.".to_string(),
            }
        );
    }

    #[test]
    fn parses_asset_lifecycle_lines() {
        assert_eq!(
            parse_osspeech_line(r#"{"type":"asset","state":"checking"}"#),
            ParsedOsSpeechLine::Asset { state: "checking".to_string(), progress: None, message: None }
        );
        assert_eq!(
            parse_osspeech_line(r#"{"type":"asset","state":"downloading","progress":0.42}"#),
            ParsedOsSpeechLine::Asset { state: "downloading".to_string(), progress: Some(0.42), message: None }
        );
        assert_eq!(
            parse_osspeech_line(r#"{"type":"asset","state":"installed"}"#),
            ParsedOsSpeechLine::Asset { state: "installed".to_string(), progress: None, message: None }
        );
        assert_eq!(
            parse_osspeech_line(r#"{"type":"asset","state":"failed","message":"network unreachable"}"#),
            ParsedOsSpeechLine::Asset {
                state: "failed".to_string(),
                progress: None,
                message: Some("network unreachable".to_string()),
            }
        );
    }

    #[test]
    fn parses_a_locale_line() {
        let line = r#"{"type":"locale","requested":"zh-Hans","resolved":"zh_CN","supported":true}"#;
        assert_eq!(
            parse_osspeech_line(line),
            ParsedOsSpeechLine::Locale {
                requested: "zh-Hans".to_string(),
                resolved: Some("zh_CN".to_string()),
                supported: true,
            }
        );
    }

    #[test]
    fn parses_an_unsupported_locale_line_with_no_resolved_field_r6() {
        // R6 golden case: Swift deliberately omits `resolved` when
        // `supported:false` — this must NOT degrade to `Unrecognized`.
        let line = r#"{"type":"locale","requested":"xx-YY","supported":false}"#;
        assert_eq!(
            parse_osspeech_line(line),
            ParsedOsSpeechLine::Locale {
                requested: "xx-YY".to_string(),
                resolved: None,
                supported: false,
            }
        );
    }

    #[test]
    fn parses_a_probe_line() {
        let line = r#"{"type":"osspeech-probe","supported":true,"locales":["zh_CN","zh_TW","en_US"],"installed":["en_US"]}"#;
        assert_eq!(
            parse_osspeech_line(line),
            ParsedOsSpeechLine::Probe {
                supported: true,
                locales: vec!["zh_CN".to_string(), "zh_TW".to_string(), "en_US".to_string()],
                installed: vec!["en_US".to_string()],
            }
        );
    }

    #[test]
    fn parses_the_finished_sentinel_status_line() {
        let line = r#"{"type":"status","state":"finished"}"#;
        assert_eq!(
            parse_osspeech_line(line),
            ParsedOsSpeechLine::Status {
                state: "finished".to_string(),
                sample_rate: None,
                channels: None,
            }
        );
        // The sentinel itself has no dedicated kind (it's internal
        // finished_seen bookkeeping, never a status event on its own).
        assert_eq!(status_record_kind("finished"), None);
    }

    #[test]
    fn parses_the_reused_starting_and_capturing_status_lines() {
        let line = r#"{"type":"status","state":"starting","sampleRate":48000,"channels":2}"#;
        assert_eq!(
            parse_osspeech_line(line),
            ParsedOsSpeechLine::Status {
                state: "starting".to_string(),
                sample_rate: Some(48_000),
                channels: Some(2),
            }
        );
        assert_eq!(status_record_kind("starting"), Some(OsSpeechStatusKind::Starting));
        assert_eq!(status_record_kind("capturing"), Some(OsSpeechStatusKind::Capturing));
    }

    #[test]
    fn parses_error_lines_for_both_reused_and_new_codes() {
        for code in [
            "permission-denied",
            "device-changed",
            "unsupported-os",
            "asset-download-failed",
            "unsupported-locale",
            "engine-failure",
            "audio-format",
            "asset-unavailable",
        ] {
            let line = format!(r#"{{"type":"error","code":"{code}","message":"boom"}}"#);
            assert_eq!(
                parse_osspeech_line(&line),
                ParsedOsSpeechLine::Error {
                    code: code.to_string(),
                    message: "boom".to_string(),
                }
            );
        }
    }

    #[test]
    fn parses_a_stats_line() {
        let line = r#"{"type":"stats","overflows":0,"ringHighWater":1024,"framesOut":48000,"droppedFrames":0}"#;
        assert_eq!(parse_osspeech_line(line), ParsedOsSpeechLine::Stats);
    }

    #[test]
    fn a_stats_line_missing_a_field_is_unrecognized_not_defaulted() {
        let line = r#"{"type":"stats","overflows":0,"ringHighWater":1024,"framesOut":48000}"#;
        assert_eq!(parse_osspeech_line(line), ParsedOsSpeechLine::Unrecognized);
    }

    // ---- R1: transcript text must never reach either log lane ----

    #[test]
    fn log_line_for_redacts_a_transcript_lines_text_to_metadata_only() {
        let raw = r#"{"type":"transcript","final":true,"seq":13,"startMs":0,"endMs":4920,"text":"Jargon slayer is a tool."}"#;
        let parsed = parse_osspeech_line(raw);
        let logged = log_line_for(raw, &parsed);
        assert_eq!(logged, "transcript final=true seq=13 startMs=0 endMs=4920 len=24");
        assert!(!logged.contains("Jargon"), "the meeting content itself must never appear in a logged line: {logged}");
        assert!(!logged.contains("text"), "not even the field name should leak: {logged}");
    }

    #[test]
    fn log_line_for_redacts_an_interim_transcript_too() {
        let raw = r#"{"type":"transcript","final":false,"seq":12,"startMs":3200,"endMs":4100,"text":"jargon slayer"}"#;
        let parsed = parse_osspeech_line(raw);
        let logged = log_line_for(raw, &parsed);
        assert_eq!(logged, "transcript final=false seq=12 startMs=3200 endMs=4100 len=13");
        assert!(!logged.contains("jargon"), "{logged}");
    }

    #[test]
    fn log_line_for_passes_every_non_transcript_record_through_verbatim() {
        for raw in [
            r#"{"type":"asset","state":"downloading","progress":0.42}"#,
            r#"{"type":"locale","requested":"zh-Hans","resolved":"zh_CN","supported":true}"#,
            r#"{"type":"osspeech-probe","supported":true,"locales":["zh_CN"],"installed":[]}"#,
            r#"{"type":"status","state":"capturing","sampleRate":48000,"channels":2}"#,
            r#"{"type":"error","code":"engine-failure","message":"boom"}"#,
            r#"{"type":"stats","overflows":0,"ringHighWater":1024,"framesOut":48000,"droppedFrames":0}"#,
            "not json",
            "",
        ] {
            let parsed = parse_osspeech_line(raw);
            assert_eq!(log_line_for(raw, &parsed), raw, "non-transcript records must be logged verbatim, unchanged");
        }
    }

    #[test]
    fn garbage_and_malformed_lines_are_unrecognized_not_a_panic() {
        for line in [
            "",
            "not json",
            r#"{"type":"transcript"}"#,          // missing every required field
            r#"{"type":"asset"}"#,               // missing state
            r#"{"type":"locale","requested":"x"}"#, // missing supported (R6: resolved alone is never required)
            r#"{"type":"osspeech-probe"}"#,      // missing every required field
            r#"{"type":"status"}"#,              // missing state
            r#"{"type":"error","code":"x"}"#,    // missing message
            r#"{"type":"something_else"}"#,
        ] {
            assert_eq!(parse_osspeech_line(line), ParsedOsSpeechLine::Unrecognized, "{line:?}");
        }
    }

    // ---- kind mapping ----

    #[test]
    fn asset_record_kind_maps_the_four_states() {
        assert_eq!(asset_record_kind("checking"), Some(OsSpeechStatusKind::AssetChecking));
        assert_eq!(asset_record_kind("downloading"), Some(OsSpeechStatusKind::AssetDownloading));
        assert_eq!(asset_record_kind("installed"), Some(OsSpeechStatusKind::AssetInstalled));
        assert_eq!(asset_record_kind("failed"), Some(OsSpeechStatusKind::AssetFailed));
        assert_eq!(asset_record_kind("bogus"), None);
    }

    #[test]
    fn error_record_kind_maps_the_reused_tap_level_codes() {
        assert_eq!(error_record_kind("permission-denied"), Some(OsSpeechStatusKind::PermissionDenied));
        assert_eq!(error_record_kind("unsupported-os"), Some(OsSpeechStatusKind::Unsupported));
        assert_eq!(error_record_kind("device-changed"), Some(OsSpeechStatusKind::DeviceChanged));
    }

    #[test]
    fn error_record_kind_maps_the_new_osspeech_codes() {
        assert_eq!(error_record_kind("unsupported-locale"), Some(OsSpeechStatusKind::UnsupportedLocale));
        assert_eq!(error_record_kind("asset-download-failed"), Some(OsSpeechStatusKind::AssetFailed));
        for code in ["engine-failure", "audio-format"] {
            assert_eq!(error_record_kind(code), None, "{code} has no dedicated kind — falls through to crashed at exit");
        }
    }

    #[test]
    fn error_record_kind_maps_asset_unavailable_to_asset_failed() {
        // R5: previously unmapped -> fell through to Crashed at exit,
        // so JS showed a generic unexpected-exit message instead of the
        // retryable asset-failure copy for what's really a
        // noModel/cannotAllocate/…Allocated-style asset problem.
        assert_eq!(error_record_kind("asset-unavailable"), Some(OsSpeechStatusKind::AssetFailed));
    }

    #[test]
    fn exit_status_kind_maps_clean_exit_to_ended_only_when_finished_was_seen() {
        assert_eq!(exit_status_kind(Some(0), None, true), OsSpeechStatusKind::Ended);
        assert_eq!(exit_status_kind(Some(0), None, false), OsSpeechStatusKind::Crashed);
    }

    #[test]
    fn exit_status_kind_maps_a_nonzero_exit_with_a_mapped_error_to_that_kind() {
        assert_eq!(exit_status_kind(Some(1), Some("unsupported-locale"), false), OsSpeechStatusKind::UnsupportedLocale);
        assert_eq!(exit_status_kind(Some(1), Some("permission-denied"), false), OsSpeechStatusKind::PermissionDenied);
        // eos-analog is irrelevant once code != Some(0) — true here
        // specifically to demonstrate a nonzero exit is never "upgraded"
        // to Ended just because the sentinel happened to be seen.
        assert_eq!(exit_status_kind(Some(1), Some("device-changed"), true), OsSpeechStatusKind::DeviceChanged);
    }

    #[test]
    fn exit_status_kind_maps_a_nonzero_exit_with_no_or_an_unmapped_error_to_crashed() {
        assert_eq!(exit_status_kind(Some(1), None, false), OsSpeechStatusKind::Crashed);
        assert_eq!(exit_status_kind(None, None, false), OsSpeechStatusKind::Crashed);
        assert_eq!(exit_status_kind(Some(1), Some("engine-failure"), false), OsSpeechStatusKind::Crashed);
    }

    #[test]
    fn final_kind_reports_ended_for_any_requested_stop_even_a_forced_one() {
        assert_eq!(final_kind(None, None, true, false), OsSpeechStatusKind::Ended);
        assert_eq!(final_kind(Some(1), Some("engine-failure"), true, false), OsSpeechStatusKind::Ended);
    }

    #[test]
    fn final_kind_falls_back_to_exit_status_kind_when_no_stop_was_requested() {
        assert_eq!(final_kind(Some(0), None, false, true), OsSpeechStatusKind::Ended);
        assert_eq!(final_kind(Some(1), Some("unsupported-locale"), false, false), OsSpeechStatusKind::UnsupportedLocale);
        assert_eq!(final_kind(Some(1), None, false, false), OsSpeechStatusKind::Crashed);
    }

    #[test]
    fn final_kind_falls_back_to_crashed_for_a_spontaneous_clean_exit_that_never_saw_finished() {
        assert_eq!(final_kind(Some(0), None, false, false), OsSpeechStatusKind::Crashed);
    }

    #[test]
    fn final_message_uses_the_last_errors_message_for_the_deferred_kinds() {
        let err = ("unsupported-locale".to_string(), "zh-Yue".to_string());
        assert_eq!(final_message(OsSpeechStatusKind::UnsupportedLocale, Some(1), Some(&err)), Some("zh-Yue".to_string()));
        let err = ("asset-download-failed".to_string(), "network unreachable".to_string());
        assert_eq!(final_message(OsSpeechStatusKind::AssetFailed, Some(1), Some(&err)), Some("network unreachable".to_string()));
    }

    #[test]
    fn final_message_for_crashed_falls_back_to_the_exit_code_when_no_error_was_ever_seen() {
        let message = final_message(OsSpeechStatusKind::Crashed, Some(137), None).unwrap();
        assert!(message.contains("137"), "{message}");
    }

    #[test]
    fn final_message_is_none_for_ended() {
        assert_eq!(final_message(OsSpeechStatusKind::Ended, Some(0), None), None);
    }

    // ---- R7: the preinstall lane's own (narrower) terminal decision ----

    #[test]
    fn preinstall_terminal_kind_emits_nothing_on_a_clean_finish() {
        assert_eq!(preinstall_terminal_kind(Some(0), true), None, "asset-installed already settled the task row");
    }

    #[test]
    fn preinstall_terminal_kind_is_asset_failed_for_a_clean_exit_that_never_saw_finished() {
        assert_eq!(preinstall_terminal_kind(Some(0), false), Some(OsSpeechStatusKind::AssetFailed));
    }

    #[test]
    fn preinstall_terminal_kind_is_asset_failed_for_finished_seen_with_a_nonzero_exit() {
        // finished_seen alone is not enough if the exit code says otherwise.
        assert_eq!(preinstall_terminal_kind(Some(1), true), Some(OsSpeechStatusKind::AssetFailed));
    }

    #[test]
    fn preinstall_terminal_kind_is_asset_failed_for_any_other_nonzero_or_missing_exit() {
        assert_eq!(preinstall_terminal_kind(Some(1), false), Some(OsSpeechStatusKind::AssetFailed));
        assert_eq!(preinstall_terminal_kind(Some(137), false), Some(OsSpeechStatusKind::AssetFailed));
        assert_eq!(preinstall_terminal_kind(None, false), Some(OsSpeechStatusKind::AssetFailed));
    }

    #[test]
    fn preinstall_terminal_kind_never_produces_crashed_or_ended() {
        // R7: an extra "ended"/"crashed" from the preinstall lane is
        // what codex's HIGH false-latch scenario rode on — this lane
        // must only ever emit nothing or asset-failed.
        for (code, finished_seen) in [(Some(0), true), (Some(0), false), (Some(1), true), (Some(1), false), (None, false), (Some(137), false)] {
            let kind = preinstall_terminal_kind(code, finished_seen);
            assert!(
                kind.is_none() || kind == Some(OsSpeechStatusKind::AssetFailed),
                "code={code:?} finished_seen={finished_seen} produced {kind:?}"
            );
        }
    }

    // ---- R2: source provenance tag on osspeech://status ----

    #[test]
    fn tagged_sets_source_to_session() {
        let event = OsSpeechStatusEvent::kind_only(OsSpeechStatusKind::Capturing).tagged(OsSpeechEventSource::Session);
        assert_eq!(event.source, "session");
    }

    #[test]
    fn tagged_sets_source_to_preinstall() {
        let event = OsSpeechStatusEvent::kind_only(OsSpeechStatusKind::AssetDownloading).tagged(OsSpeechEventSource::Preinstall);
        assert_eq!(event.source, "preinstall");
    }

    #[test]
    fn tagged_overrides_whatever_source_the_constructor_left_in_place() {
        // kind_only/with_message always leave SOME value in `source` (a
        // struct-update base must be a complete instance) — `tagged` must
        // still win regardless of what that placeholder was.
        let event = OsSpeechStatusEvent::with_message(OsSpeechStatusKind::AssetFailed, "network unreachable").tagged(OsSpeechEventSource::Preinstall);
        assert_eq!(event.source, "preinstall");
        assert_eq!(event.message, Some("network unreachable".to_string()));
    }

    #[test]
    fn os_speech_event_source_as_str_matches_the_pinned_wire_values() {
        assert_eq!(OsSpeechEventSource::Session.as_str(), "session");
        assert_eq!(OsSpeechEventSource::Preinstall.as_str(), "preinstall");
    }

    // ---- OsSpeechState: single-flight, generation guard, pause ----

    #[test]
    fn try_begin_succeeds_when_nothing_is_running() {
        let state = OsSpeechState::default();
        assert!(state.try_begin().is_ok());
    }

    #[test]
    fn try_begin_rejects_a_second_call_while_a_session_is_active() {
        let state = OsSpeechState::default();
        let first = state.try_begin().unwrap();
        assert!(state.try_begin().is_err());
        assert!(state.is_current(first));
    }

    #[test]
    fn is_current_becomes_false_once_a_newer_session_has_begun() {
        let state = OsSpeechState::default();
        let first = state.try_begin().unwrap();
        state.finish_session(first);
        let second = state.try_begin().unwrap();
        assert!(!state.is_current(first), "a superseded generation must never read as current again");
        assert!(state.is_current(second));
    }

    #[test]
    fn stop_is_idempotent_when_nothing_is_running() {
        let state = OsSpeechState::default();
        assert!(state.take_child_for_stop().unwrap().is_none());
        assert!(state.take_child_for_stop().unwrap().is_none());
    }

    #[test]
    fn finish_session_treats_an_empty_child_slot_as_a_requested_stop() {
        let state = OsSpeechState::default();
        let generation = state.try_begin().unwrap();
        let outcome = state.finish_session(generation);
        assert!(outcome.was_current);
        assert!(outcome.stop_was_requested);
        assert!(state.try_begin().is_ok(), "the slot must be free again");
    }

    #[test]
    fn finish_session_reports_not_current_for_a_superseded_generation() {
        let state = OsSpeechState::default();
        let first = state.try_begin().unwrap();
        state.finish_session(first);
        state.try_begin().unwrap();
        let stale_outcome = state.finish_session(first);
        assert!(!stale_outcome.was_current);
    }

    #[test]
    fn still_running_reflects_the_current_occupant_only() {
        let state = OsSpeechState::default();
        let generation = state.try_begin().unwrap();
        assert!(state.still_running(generation));
        state.finish_session(generation);
        assert!(!state.still_running(generation));
    }

    #[test]
    fn f1_stop_during_the_starting_window_blocks_a_later_attach() {
        let state = OsSpeechState::default();
        let generation = state.try_begin().unwrap();
        assert!(state.take_child_for_stop().unwrap().is_none(), "idempotent success even though nothing has actually stopped yet");
        assert!(
            !state.should_attach_child(generation),
            "F1: a stop recorded during Starting must block a later attach_child"
        );
        let outcome = state.finish_session(generation);
        assert!(outcome.was_current);
        assert!(outcome.stop_was_requested, "F1: a cancel during Starting must still finish as a requested stop, never a crash");
    }

    #[test]
    fn set_paused_only_takes_effect_while_a_session_is_running() {
        let state = OsSpeechState::default();
        state.set_paused(true); // nothing running — no-op
        assert!(!state.is_paused());
        state.try_begin().unwrap();
        state.set_paused(true);
        assert!(state.is_paused());
    }

    #[test]
    fn try_begin_always_resets_paused_to_false_for_a_fresh_session() {
        let state = OsSpeechState::default();
        let first = state.try_begin().unwrap();
        state.set_paused(true);
        assert!(state.is_paused());
        state.finish_session(first);
        state.try_begin().unwrap();
        assert!(!state.is_paused(), "a leftover pause from a finished session must never leak into the next one");
    }

    // ---- preinstall single-flight (§A2) ----

    #[test]
    fn preinstall_is_rejected_while_a_transcribe_session_is_running() {
        let state = OsSpeechState::default();
        state.try_begin().unwrap();
        assert!(state.try_begin_preinstall().is_err());
    }

    #[test]
    fn preinstall_is_rejected_while_another_preinstall_is_already_in_flight() {
        let state = OsSpeechState::default();
        state.try_begin_preinstall().unwrap();
        assert!(state.try_begin_preinstall().is_err());
    }

    #[test]
    fn preinstall_succeeds_again_after_the_previous_one_finished() {
        let state = OsSpeechState::default();
        let attempt = state.try_begin_preinstall().unwrap();
        state.finish_preinstall(attempt);
        assert!(state.try_begin_preinstall().is_ok());
    }

    #[test]
    fn try_begin_still_rejects_if_a_preinstall_slot_is_occupied_last_resort_guard() {
        // Normally unreachable: start_os_speech preempts first. This is
        // the guard for a concurrent re-claim in the preempt→try_begin
        // window (see try_begin's own doc comment).
        let state = OsSpeechState::default();
        state.try_begin_preinstall().unwrap();
        assert!(state.try_begin().is_err());
    }

    #[test]
    fn a_transcribe_session_succeeds_once_the_preinstall_finished() {
        let state = OsSpeechState::default();
        let attempt = state.try_begin_preinstall().unwrap();
        state.finish_preinstall(attempt);
        assert!(state.try_begin().is_ok());
    }

    #[test]
    fn try_begin_preinstall_mints_a_fresh_monotonic_attempt_id_each_time() {
        // R3: `PreinstallSlot`/`preempted_attempt` are keyed on this id.
        let state = OsSpeechState::default();
        let first = state.try_begin_preinstall().unwrap();
        state.finish_preinstall(first);
        let second = state.try_begin_preinstall().unwrap();
        assert_ne!(first, second, "each preinstall attempt must get its own id");
    }

    #[test]
    fn preinstall_slot_attempt_reflects_whichever_attempt_currently_holds_it() {
        let state = OsSpeechState::default();
        let p1 = state.try_begin_preinstall().unwrap();
        assert_eq!(state.preinstall.lock().unwrap().as_ref().map(PreinstallSlot::attempt), Some(p1));
        let _ = state.preempt_preinstall();
        let p2 = state.try_begin_preinstall().unwrap();
        let slot_attempt = state.preinstall.lock().unwrap().as_ref().map(PreinstallSlot::attempt);
        assert_eq!(slot_attempt, Some(p2));
        assert_ne!(slot_attempt, Some(p1), "the slot must never still read as p1's once p2 occupies it");
    }

    // ---- session-start preempts an in-flight preinstall (lead §A2 amendment) ----

    #[test]
    fn preempt_on_an_idle_state_is_a_noop_and_sets_no_flag() {
        let state = OsSpeechState::default();
        assert!(state.preempt_preinstall().is_none());
        // No attempt was ever claimed — 0 is never a real attempt id
        // (the counter is 1-indexed), so it must never spuriously match.
        assert!(!state.take_preinstall_preempted(0));
    }

    #[test]
    fn preempt_during_the_spawning_window_clears_the_slot_and_marks_preempted() {
        let state = OsSpeechState::default();
        let attempt = state.try_begin_preinstall().unwrap();
        // Still Spawning (no child attached): nothing to hand back, but
        // the slot must clear and the flag must arm.
        assert!(state.preempt_preinstall().is_none());
        assert!(state.try_begin().is_ok(), "session start must proceed after the preempt");
        assert!(state.take_preinstall_preempted(attempt), "the preinstall task must see preempted=true at Terminated");
        assert!(!state.take_preinstall_preempted(attempt), "consumed exactly once");
    }

    #[test]
    fn a_stale_preempt_record_never_matches_a_different_later_attempt() {
        // R3: `try_begin_preinstall` deliberately no longer resets
        // `preempted_attempt` (see that field's own doc comment) — a
        // fresh attempt's own id simply never numerically matches an
        // older, different attempt's still-unconsumed record, so it
        // reads as "not preempted" with no explicit reset required.
        let state = OsSpeechState::default();
        let first = state.try_begin_preinstall().unwrap();
        let _ = state.preempt_preinstall(); // records `first` as preempted; spawn-failure path never spawns a task to consume it
        let second = state.try_begin_preinstall().unwrap();
        assert_ne!(first, second);
        assert!(!state.take_preinstall_preempted(second), "attempt 2 must never inherit attempt 1's stale preempt record");
    }

    #[test]
    fn a_preempted_attempts_late_terminated_neither_clears_nor_confuses_a_newer_attempts_state() {
        // The exact ABA scenario R3 closes: P1 is preempted, then P2
        // begins BEFORE P1's own (belated) Terminated has been
        // processed. P1's late handling must correctly see its own
        // preemption, and must not clear P2's live slot nor report P2
        // as preempted.
        let state = OsSpeechState::default();
        let p1 = state.try_begin_preinstall().unwrap();
        assert!(state.preempt_preinstall().is_none(), "P1 still Spawning — nothing to hand back");

        // P2 begins — the slot preempt_preinstall cleared is free again.
        let p2 = state.try_begin_preinstall().unwrap();
        assert_ne!(p1, p2);

        // P1's belated Terminated handling runs now, well after P2 has
        // already claimed the slot.
        assert!(state.take_preinstall_preempted(p1), "P1 must still correctly see its OWN preemption");
        state.finish_preinstall(p1); // P1's own attempt-conditional cleanup call

        // None of P1's belated activity above may have touched P2.
        assert!(!state.take_preinstall_preempted(p2), "P2 was never preempted");
        assert!(
            state.preinstall.lock().map(|g| g.is_some()).unwrap_or(false),
            "P1's belated finish_preinstall must not clear P2's still-live slot"
        );
    }

    #[test]
    fn attach_preinstall_child_reports_unattachable_after_a_preempt() {
        let state = OsSpeechState::default();
        state.try_begin_preinstall().unwrap();
        let _ = state.preempt_preinstall();
        // Can't construct a real CommandChild in tests (same limitation
        // audiocap's own tests note) — assert the slot state that forces
        // attach_preinstall_child's Err branch instead.
        let slot_is_empty = state.preinstall.lock().map(|g| g.is_none()).unwrap_or(false);
        assert!(slot_is_empty, "a preempted slot must be empty so a late attach hands the child back for teardown");
    }

    // ---- probe memo (§Q4: process-once per app run) ----

    #[test]
    fn probe_memo_is_empty_by_default() {
        let state = OsSpeechState::default();
        assert!(state.cached_probe().is_none());
    }

    #[test]
    fn probe_memo_returns_the_cached_value_so_a_second_lookup_never_needs_to_respawn() {
        let state = OsSpeechState::default();
        let caps = OsSpeechCapabilities {
            supported: true,
            reason: None,
            locales: vec!["en_US".to_string()],
            installed_locales: vec![],
        };
        assert!(state.cached_probe().is_none(), "nothing cached yet — a real caller would spawn the probe here");
        state.store_probe(caps.clone());
        // A second lookup now short-circuits on the memo alone — no
        // process spawn / AppHandle needed to observe this, which is
        // exactly the seam `os_speech_capabilities` itself checks first.
        assert_eq!(state.cached_probe(), Some(caps));
    }

    #[test]
    fn probe_memo_caches_a_synthesized_failure_result_too() {
        // Q4: "spawn helper --probe-osspeech ONCE per app run" — even a
        // failed probe is cached, so a later call never retries within
        // the same app run.
        let state = OsSpeechState::default();
        state.store_probe(unsupported_capabilities("boom"));
        assert_eq!(state.cached_probe(), Some(unsupported_capabilities("boom")));
    }
}
