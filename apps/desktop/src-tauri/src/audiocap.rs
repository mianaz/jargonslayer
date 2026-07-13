// v0.4 S9.1 (docs/design-explorations/s9-app-audio-tap-blueprint.md,
// slice S9.1) — jargonslayer-audiocap: the CoreAudio process-tap
// helper, a second externalBin alongside uv (D2). This module is S9.1's
// own scope ONLY: the bare-file-name sidecar constant (mirrors uv.rs's
// UV_SIDECAR_PROGRAM) plus an env-gated spike rig that spawns the
// helper for a few seconds at app setup, so a PACKAGED build can be
// used to verify TCC attribution (D2's own spike gate: "responsible-
// process attribution depends on the spawn topology, so a terminal-
// launched helper proves nothing" — the packaged app itself has to do
// the spawning). No IPC commands here — that's S9.2's
// start_app_audio/stop_app_audio/capabilities() surface.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::audiocap_framing::{FramingReader, Record};
use crate::audiocap_pipeline::AudioPipeline;
use crate::uv::emit_uv_log;

/// The program name handed to `Shell::sidecar` — the FILE NAME of
/// tauri.conf.json's `bundle.externalBin` entry ("binaries/
/// jargonslayer-audiocap"), never the entry itself. Same verbatim-join
/// vs bundler-flatten trap as UV_SIDECAR_PROGRAM (uv.rs, that
/// constant's own doc comment): `Shell::sidecar` joins the given path
/// VERBATIM onto the running exe's own directory, while the bundler
/// FLATTENS every externalBin into that directory
/// (binaries/jargonslayer-audiocap-<triple> -> Contents/MacOS/
/// jargonslayer-audiocap in the macOS bundle, target/<profile>/
/// jargonslayer-audiocap in dev) — passing the whole config entry
/// "binaries/jargonslayer-audiocap" would resolve to Contents/MacOS/
/// binaries/jargonslayer-audiocap: ENOENT, exactly the v0.4.0 uv
/// hotfix's own bug shape. Pinned against the config by
/// sidecar_program_is_a_bare_file_name_matching_external_bin below
/// (mirrors uv.rs's identically-named test).
pub const AUDIOCAP_SIDECAR_PROGRAM: &str = "jargonslayer-audiocap";

/// Buffers raw stderr byte chunks (`set_raw_out(true)` — D5: "Raw mode
/// applies to stderr too => Rust reassembles NDJSON status records
/// across arbitrary chunk boundaries") into complete '\n'-terminated
/// lines, matching jargonslayer-audiocap's own stderr convention (one
/// JSON object + one '\n' per record — StatusEvents.swift). A line
/// arriving split across two-or-more raw chunks is exactly the case
/// this exists to handle; a plain per-chunk split on '\n' would
/// silently corrupt/drop a line straddling a chunk boundary.
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

/// S9.1's own go/no-go spike rig (blueprint D2's spike gate): spawns
/// jargonslayer-audiocap for a few seconds so a PACKAGED build's TCC
/// prompt attribution can be verified interactively with Miana against
/// a real Developer-ID build (D2: "against a packaged Developer-ID
/// build ... a terminal-launched helper proves nothing"). Inert (a
/// no-op) unless armed by ONE of:
///   - the `--spike-audiocap` argv flag — the PRIMARY gate: the
///     TCC-correct invocation is `open -a JargonSlayer.app --args
///     --spike-audiocap`, because a LaunchServices launch makes the app
///     its own TCC responsible process, whereas a binary launched
///     directly from a terminal can be attributed to the TERMINAL —
///     which would make the spike read false. `open` also drops
///     environment variables, hence an argv flag at all;
///   - JARGONSLAYER_SPIKE_AUDIOCAP=1 in the environment (dev/terminal
///     convenience only — see the attribution caveat above).
/// The packaged app itself has to be the one spawning the helper for
/// the spike to mean anything, so this hook lives at app setup, not
/// behind any UI affordance.
///
/// Excludes THIS APP's own pid (`std::process::id()`) per D3 — the
/// Tauri GUI app is "the only thing of ours that could ever render
/// audio," not the helper — with `--duration 5` so the spike auto-stops
/// rather than needing a manual kill. Every spike line is TEED three
/// ways: the uv://log event lane (uv::emit_uv_log), stderr (eprintln),
/// and append-only `<app_log_dir>/audiocap-spike.log` — the file is the
/// one Miana can actually read, since a provisioned machine never shows
/// the wizard's 详细日志 pane and an `open`-launched app has no
/// terminal. stdout (the framing v1 PCM stream) is never logged as
/// text; only its byte count is reported once the process exits.
pub fn maybe_spawn_spike(app: &tauri::AppHandle) {
    let env_armed = std::env::var("JARGONSLAYER_SPIKE_AUDIOCAP").ok().as_deref() == Some("1");
    let arg_armed = std::env::args().any(|a| a == "--spike-audiocap");
    if !env_armed && !arg_armed {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Best-effort file tee — see this fn's doc comment for why the
        // file is the spike's primary evidence channel. None (with a
        // stderr note) rather than an error if the log dir can't be
        // resolved/created: the spike should still run and emit to the
        // other two channels.
        let mut spike_file: Option<std::fs::File> = {
            use tauri::Manager;
            app.path()
                .app_log_dir()
                .ok()
                .and_then(|dir| {
                    std::fs::create_dir_all(&dir).ok()?;
                    std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(dir.join("audiocap-spike.log"))
                        .ok()
                })
        };
        if spike_file.is_none() {
            eprintln!("[audiocap-spike] could not open audiocap-spike.log — continuing with event lane + stderr only");
        }
        let mut tee = move |app: &tauri::AppHandle, stream: &'static str, line: String| {
            let message = format!("[audiocap-spike] {line}");
            eprintln!("{message}");
            if let Some(f) = spike_file.as_mut() {
                use std::io::Write;
                let _ = writeln!(f, "[{stream}] {message}");
            }
            emit_uv_log(app, stream, message);
        };

        let now_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let own_pid = std::process::id().to_string();
        tee(
            &app,
            "stdout",
            format!("--- spike run (unix {now_unix}) — spawning {AUDIOCAP_SIDECAR_PROGRAM} --exclude-pid {own_pid} --duration 5 ---"),
        );

        let command = match app.shell().sidecar(AUDIOCAP_SIDECAR_PROGRAM) {
            Ok(command) => command,
            Err(e) => {
                tee(&app, "stderr", format!("could not resolve sidecar: {e}"));
                return;
            }
        };
        let command = command
            .args(["--exclude-pid", &own_pid, "--duration", "5"])
            .set_raw_out(true);

        let (mut rx, _child) = match command.spawn() {
            Ok(pair) => pair,
            Err(e) => {
                tee(&app, "stderr", format!("failed to spawn: {e}"));
                return;
            }
        };

        let mut stderr_lines = LineReassembler::new();
        let mut stdout_bytes: u64 = 0;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    stdout_bytes += bytes.len() as u64;
                }
                CommandEvent::Stderr(bytes) => {
                    for line in stderr_lines.feed(&bytes) {
                        tee(&app, "stderr", line);
                    }
                }
                CommandEvent::Error(message) => {
                    tee(&app, "stderr", format!("error: {message}"));
                }
                CommandEvent::Terminated(payload) => {
                    tee(&app, "stdout", format!("exited (code {:?})", payload.code));
                }
                _ => {}
            }
        }
        if let Some(line) = stderr_lines.flush() {
            tee(&app, "stderr", line);
        }

        tee(&app, "stdout", format!("stdout bytes: {stdout_bytes}"));
    });
}

// ============================================================================
// S9.2 (docs/design-explorations/s9-app-audio-tap-blueprint.md, slice
// S9.2) — the real command surface: audiocap_capabilities() /
// start_app_audio() / stop_app_audio(), spawn+supervise+resample+batch,
// the audiocap://status side-channel, generation guard, and the
// startup orphan sweep. Everything above this banner is S9.1's own
// scope (unchanged). Pure logic (version gating, status-kind mapping,
// NDJSON line parsing, the AudiocapState single-flight/generation state
// machine) is kept free of tauri types so it's directly unit-testable;
// spawn_session_task is the one place that necessarily mixes the two
// (it drives the pure FramingReader/AudioPipeline with real
// CommandEvent/Channel/AppHandle plumbing) and is kept as thin as that
// mixing allows.
// ============================================================================

// ---- D1/D6: macOS version gating ----

/// NSProcessInfo.operatingSystemVersion (objc2-foundation 0.3.2, see
/// Cargo.toml's own comment for why this crate — already resolved
/// transitively — was made a direct dependency instead of shelling out
/// to `sw_vers` or hand-parsing SystemVersion.plist).
#[cfg(target_os = "macos")]
fn macos_version() -> (i64, i64) {
    use objc2_foundation::NSProcessInfo;
    let version = NSProcessInfo::processInfo().operatingSystemVersion();
    // NSOperatingSystemVersion's fields are NSInteger, which objc2
    // imports as `isize` (not `i64`) — cast explicitly rather than
    // widen the return type, so callers/tests keep working with a
    // plain, platform-independent i64 tuple.
    (version.majorVersion as i64, version.minorVersion as i64)
}

#[cfg(not(target_os = "macos"))]
fn macos_version() -> (i64, i64) {
    (0, 0)
}

/// D1/D6's product policy floor: macOS >= 14.4 — NOT the 14.2
/// TECHNICAL floor the Swift helper's own `#available` gates against
/// (D1's own distinction: 14.4 is a conservative product-policy choice,
/// not a hard API requirement). `major > 14` also covers Apple's
/// post-Sequoia version-number jump (macOS 26 == Tahoe, aligning the
/// marketing major version with iOS/etc — see the S9.1 outcome note's
/// own "verify on-device 14.x/15.x/26").
fn is_macos_version_supported((major, minor): (i64, i64)) -> bool {
    major > 14 || (major == 14 && minor >= 4)
}

pub const UNSUPPORTED_REASON: &str = "需要 macOS 14.4 或更高版本";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudiocapCapabilities {
    pub app_audio_supported: bool,
    pub reason: Option<String>,
}

fn capabilities_for(version: (i64, i64)) -> AudiocapCapabilities {
    if is_macos_version_supported(version) {
        AudiocapCapabilities {
            app_audio_supported: true,
            reason: None,
        }
    } else {
        AudiocapCapabilities {
            app_audio_supported: false,
            reason: Some(UNSUPPORTED_REASON.to_string()),
        }
    }
}

#[tauri::command]
pub fn audiocap_capabilities() -> AudiocapCapabilities {
    capabilities_for(macos_version())
}

// ---- open_privacy_settings (D6: permission-denied CTA) ----

/// Primary deep link (D6): opens Sequoia's 屏幕与系统音频录制 pane
/// directly. Undocumented/uncontracted (Apple ships no public API for
/// this) — `PRIVACY_SETTINGS_FALLBACK_URL` below is tried if opening
/// this one fails.
pub const PRIVACY_SETTINGS_SCREEN_CAPTURE_URL: &str =
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture";

/// Fallback (D6): the bare 隐私与安全性 pane, one level up from the deep
/// link above — tried only if THAT `open` invocation itself errors.
pub const PRIVACY_SETTINGS_FALLBACK_URL: &str =
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension";

/// SettingsDialog's 系统/App 音频 permission-denied CTA (S9.4, D6):
/// best-effort `open <url>` of the direct 屏幕与系统音频录制 deep link,
/// falling back to the bare 隐私与安全性 pane if that FIRST `open`
/// invocation itself errors (a failed spawn or a nonzero exit status —
/// `open` can't tell us whether the URL scheme actually resolved to a
/// real pane, only whether it handed the request to LaunchServices at
/// all). Both legs are best-effort/uncontracted (blueprint D6: "deep
/// links are uncontracted") and this never reports failure back to the
/// JS caller — SettingsDialog's own manual-path text (系统设置 → 隐私与
/// 安全性 → 屏幕与系统音频录制) stays visible beside the button regardless
/// of whether either `open` actually worked. No-op on non-macOS (the
/// `x-apple.systempreferences:` scheme and the `open` binary are both
/// macOS-only; the whole 系统/App 音频 feature is unreachable below the
/// macOS floor anyway — see `is_macos_version_supported`).
#[tauri::command]
pub fn open_privacy_settings() {
    if !try_open(PRIVACY_SETTINGS_SCREEN_CAPTURE_URL) {
        try_open(PRIVACY_SETTINGS_FALLBACK_URL);
    }
}

/// Spawns `open <url>`, status-checked — a failed spawn OR a nonzero
/// exit both count as "try the fallback" per `open_privacy_settings`'s
/// own doc comment. Never panics.
#[cfg(target_os = "macos")]
fn try_open(url: &str) -> bool {
    std::process::Command::new("open")
        .arg(url)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn try_open(_url: &str) -> bool {
    false
}

// ---- audiocap://status kind mapping (wire contract) ----

/// The CLOSED set of `audiocap://status` event kinds the wire contract
/// pins — mirrors AudioCapError's own "closed set" posture
/// (AudioCapError.swift's doc comment) one layer up: S9.3's JS side is
/// expected to exhaustively match on `kind`, so an ad hoc extra value
/// here would silently break that.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusKind {
    Starting,
    Capturing,
    ExcludePidInactive,
    PermissionDenied,
    Unsupported,
    DeviceChanged,
    Crashed,
    Ended,
}

impl StatusKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Capturing => "capturing",
            Self::ExcludePidInactive => "exclude-pid-inactive",
            Self::PermissionDenied => "permission-denied",
            Self::Unsupported => "unsupported",
            Self::DeviceChanged => "device-changed",
            Self::Crashed => "crashed",
            Self::Ended => "ended",
        }
    }
}

/// Maps a `type:"status"` record's `state` to a StatusKind for states
/// that are immediately actionable on their own. `"device-changed"` is
/// NOT emitted by jargonslayer-audiocap today (v1 has no hot device-
/// change detection — the blueprint's own "no hot re-tap in v1"
/// non-goal) but is kept as a forward-compatible mapping: StatusEvents
/// .emitNote's `state` is a free string, and this wire contract's own
/// typed-exit list already reserves the kind. Any other/unknown state
/// (e.g. a future note this contract doesn't yet know about) returns
/// `None` — still mirrored to the log lane by the caller, but never
/// emitted as a mistyped status event.
fn status_record_kind(state: &str) -> Option<StatusKind> {
    match state {
        "starting" => Some(StatusKind::Starting),
        "capturing" => Some(StatusKind::Capturing),
        "exclude-pid-inactive" => Some(StatusKind::ExcludePidInactive),
        "device-changed" => Some(StatusKind::DeviceChanged),
        _ => None,
    }
}

/// Maps a `type:"error"` record's `code` to a StatusKind — only the two
/// codes this wire contract has a dedicated kind for. AudioCapError's
/// other four codes (pid-translate-failed / tap-create-failed /
/// aggregate-create-failed / device-start-failed) have no kind of their
/// own here; they fall through to `exit_status_kind`'s "crashed"
/// default once the process actually exits non-zero.
fn error_record_kind(code: &str) -> Option<StatusKind> {
    match code {
        "permission-denied" => Some(StatusKind::PermissionDenied),
        "unsupported-os" => Some(StatusKind::Unsupported),
        _ => None,
    }
}

/// The wire contract's own literal rule: "clean EOS/exit-0 after stop
/// => ended; nonzero exit with a mapped error code => that kind;
/// nonzero without one => crashed." `final_kind` below layers one
/// refinement on top of this for the one case this literal rule reads
/// ambiguously for (an intentional stop that had to escalate to
/// SIGKILL); this function stays a direct, literal implementation of
/// the stated rule on its own so both are independently testable.
pub fn exit_status_kind(code: Option<i32>, last_error_code: Option<&str>) -> StatusKind {
    if code == Some(0) {
        return StatusKind::Ended;
    }
    last_error_code.and_then(error_record_kind).unwrap_or(StatusKind::Crashed)
}

/// `final_kind` = `exit_status_kind`, EXCEPT: if stop_app_audio (or
/// supersession) had already taken this session's child before it
/// exited, the outcome is reported as `Ended` unconditionally — even if
/// reaching that point required the grace-timeout SIGKILL fallback
/// (which reports as a signal kill, i.e. `code: None`, not a clean
/// `Some(0)`). A user-requested stop that took the hard path is still a
/// requested stop, not a crash, from the UI's point of view.
pub fn final_kind(code: Option<i32>, last_error_code: Option<&str>, stop_was_requested: bool) -> StatusKind {
    if stop_was_requested {
        return StatusKind::Ended;
    }
    exit_status_kind(code, last_error_code)
}

/// jargonslayer-audiocap's stderr NDJSON wire shape (StatusEvents.swift):
/// status records carry `state` (+ `sampleRate`/`channels` for the
/// starting/capturing lifecycle pair, or `message` for a freeform note
/// like exclude-pid-inactive/swept); error records carry `code` +
/// `message`; stats records carry the three ring/frame counters. All
/// four shapes collapse onto this one permissive struct; `parse_
/// audiocap_line` below is what actually distinguishes them.
#[derive(Debug, Deserialize)]
struct RawAudiocapLine {
    #[serde(rename = "type")]
    kind: String,
    state: Option<String>,
    message: Option<String>,
    code: Option<String>,
    #[serde(rename = "sampleRate")]
    sample_rate: Option<u32>,
    channels: Option<u16>,
    overflows: Option<u64>,
    #[serde(rename = "ringHighWater")]
    ring_high_water: Option<u64>,
    #[serde(rename = "framesOut")]
    frames_out: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
enum ParsedAudiocapLine {
    Status {
        state: String,
        sample_rate: Option<u32>,
        channels: Option<u16>,
        message: Option<String>,
    },
    Error {
        code: String,
        message: String,
    },
    Stats {
        overflows: u64,
        ring_high_water: u64,
        frames_out: u64,
    },
    /// Not valid JSON at all, valid JSON with an unrecognized/missing
    /// "type", or a known "type" missing the fields that shape
    /// requires — never a panic, always falls back here (mirrors
    /// server.rs's own classify_download_line/DownloadLine::Other
    /// posture for the same class of "line might be garbage" problem).
    Unrecognized,
}

/// Pure line classifier — no I/O, no process spawn. spawn_session_task
/// below is the only production caller, applying it to every reassembled
/// stderr line ALONGSIDE (never instead of) the unconditional log-lane
/// mirror every audiocap stderr line gets regardless of whether it
/// parses.
fn parse_audiocap_line(line: &str) -> ParsedAudiocapLine {
    let Ok(raw) = serde_json::from_str::<RawAudiocapLine>(line) else {
        return ParsedAudiocapLine::Unrecognized;
    };
    match raw.kind.as_str() {
        "status" => match raw.state {
            Some(state) => ParsedAudiocapLine::Status {
                state,
                sample_rate: raw.sample_rate,
                channels: raw.channels,
                message: raw.message,
            },
            None => ParsedAudiocapLine::Unrecognized,
        },
        "error" => match (raw.code, raw.message) {
            (Some(code), Some(message)) => ParsedAudiocapLine::Error { code, message },
            _ => ParsedAudiocapLine::Unrecognized,
        },
        "stats" => match (raw.overflows, raw.ring_high_water, raw.frames_out) {
            (Some(overflows), Some(ring_high_water), Some(frames_out)) => ParsedAudiocapLine::Stats {
                overflows,
                ring_high_water,
                frames_out,
            },
            _ => ParsedAudiocapLine::Unrecognized,
        },
        _ => ParsedAudiocapLine::Unrecognized,
    }
}

// ---- AudiocapState: single-flight + generation guard ----

/// Managed Tauri state (`.manage(AudiocapState::default())`, lib.rs).
/// `running` is the single-flight gate: `Some` means a session was
/// begun and hasn't yet fully finished (see `finish`); `generation` is
/// a monotonically-increasing session id bumped once per successful
/// `try_begin`, checked by `is_current` to suppress a stale/superseded
/// session's late Channel sends or status events (D5: "a late
/// chunk/status from a dying session must never reach a newer
/// session's channel/events"). Deliberately two separate primitives
/// (an AtomicU64 alongside the Mutex, not one generation field living
/// only inside the Mutex): `is_current` is called on every forwarded
/// audio batch and every status emission — a lock-free atomic load
/// keeps that hot path cheap, while `running`'s own mutex is only ever
/// touched at start/stop/finish (low frequency).
#[derive(Default)]
pub struct AudiocapState {
    generation: AtomicU64,
    running: Mutex<Option<RunningSession>>,
}

struct RunningSession {
    generation: u64,
    /// `Some` from `attach_child` (right after a successful spawn)
    /// until `take_child_for_stop` removes it — its presence/absence is
    /// also how `finish` tells a requested stop apart from a
    /// spontaneous exit (see that function's own doc comment).
    child: Option<CommandChild>,
}

#[derive(Debug, Clone, Copy)]
struct FinishOutcome {
    /// Whether `generation` was still the authoritative session when it
    /// finished. `final`/status emission must be suppressed whenever
    /// this is `false` — the generation guard itself.
    was_current: bool,
    /// Meaningless when `was_current` is false. Otherwise: whether
    /// `take_child_for_stop` had already run for this session (i.e.
    /// this was a requested stop, however it eventually exited) versus
    /// a spontaneous exit/crash — see `final_kind`.
    stop_was_requested: bool,
}

fn poison_err<T>(_: std::sync::PoisonError<T>) -> String {
    "audiocap state lock was poisoned by an earlier panic".to_string()
}

impl AudiocapState {
    /// Single-flight claim: `Err` if a session is already running,
    /// otherwise bumps the generation counter and reserves the running
    /// slot (with no child attached yet — see `attach_child`), returning
    /// the new generation.
    fn try_begin(&self) -> Result<u64, String> {
        let mut guard = self.running.lock().map_err(poison_err)?;
        if guard.is_some() {
            return Err("app audio capture is already running".to_string());
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *guard = Some(RunningSession { generation, child: None });
        Ok(generation)
    }

    /// Attaches the just-spawned CommandChild to `generation`'s slot —
    /// a no-op if that generation is no longer the occupant (defensive;
    /// shouldn't happen given single-flight, since nothing else can
    /// clear the slot before this session's own `finish`).
    fn attach_child(&self, generation: u64, child: CommandChild) {
        if let Ok(mut guard) = self.running.lock() {
            if let Some(session) = guard.as_mut() {
                if session.generation == generation {
                    session.child = Some(child);
                }
            }
        }
    }

    /// Cheap, lock-free — called on every forwarded audio batch and
    /// every status emission (see this struct's own doc comment for why
    /// that matters).
    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    /// Idempotent stop-request: `None` when nothing is running, or a
    /// stop was already requested for the current session (its child
    /// slot is already empty) — `stop_app_audio` maps either case to
    /// `Ok(())`. `Some((child, pid, generation))` otherwise, after
    /// taking the child (the caller is now responsible for dropping it
    /// to close its stdin — see stop_app_audio's own comment).
    fn take_child_for_stop(&self) -> Result<Option<(CommandChild, u32, u64)>, String> {
        let mut guard = self.running.lock().map_err(poison_err)?;
        Ok(guard.as_mut().and_then(|session| {
            session.child.take().map(|child| {
                let pid = child.pid();
                (child, pid, session.generation)
            })
        }))
    }

    /// Called once by a session's own task when it's fully done
    /// (drained, flushed, final status decided) — clears the running
    /// slot IFF it's still this generation's own (never clobbers a
    /// newer session that may have since begun).
    fn finish(&self, generation: u64) -> FinishOutcome {
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
    /// fallback is still needed (i.e. this generation hasn't `finish`ed
    /// on its own yet).
    fn still_running(&self, generation: u64) -> bool {
        self.running
            .lock()
            .map(|guard| matches!(&*guard, Some(session) if session.generation == generation))
            .unwrap_or(true) // poisoned -> assume still running: a spurious kill is harmless, a missed one is a real leak
    }
}

// ---- start_app_audio / stop_app_audio ----

#[tauri::command]
pub fn start_app_audio(
    app: tauri::AppHandle,
    state: tauri::State<'_, AudiocapState>,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<(), String> {
    // Runtime re-check (D6: "UI gating is not a boundary") — even if
    // the card was somehow shown/enabled below the floor, the spawn
    // itself is refused here too.
    if !is_macos_version_supported(macos_version()) {
        return Err(UNSUPPORTED_REASON.to_string());
    }

    let generation = state.try_begin()?;
    let own_pid = std::process::id().to_string();

    let spawn_result = app
        .shell()
        .sidecar(AUDIOCAP_SIDECAR_PROGRAM)
        .map_err(|e| format!("could not resolve the jargonslayer-audiocap sidecar: {e}"))
        .and_then(|command| {
            command
                .args(["--exclude-pid", &own_pid])
                .set_raw_out(true)
                .spawn()
                .map_err(|e| format!("failed to spawn jargonslayer-audiocap: {e}"))
        });

    match spawn_result {
        Ok((rx, child)) => {
            let pid = child.pid();
            state.attach_child(generation, child);
            spawn_session_task(app, channel, generation, pid, rx);
            Ok(())
        }
        Err(e) => {
            // Release the slot we optimistically claimed in try_begin —
            // reuses `finish` (the child is still None, so this is
            // exactly the same "nothing to stop" shape a fresh
            // AudiocapState starts in).
            state.finish(generation);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn stop_app_audio(app: tauri::AppHandle, state: tauri::State<'_, AudiocapState>) -> Result<(), String> {
    let Some((child, pid, generation)) = state.take_child_for_stop()? else {
        return Ok(()); // idempotent: nothing running, or a stop is already in flight
    };

    // Closes stdin — the ONLY way to reach it from here. CommandChild
    // (tauri-plugin-shell 2.3.5) exposes just write(&mut self) and
    // kill(self) (consumes the handle; SharedChild::kill's own doc:
    // "On Unix this sends SIGKILL") — no partial "close just stdin,
    // keep the handle" API — so dropping the WHOLE CommandChild is the
    // only way to close its stdin pipe, which is jargonslayer-
    // audiocap's own documented graceful-stop path (ShutdownSignal
    // .startStdinEOFMonitor, D5's "SIGTERM/stdin-EOF"). This does NOT
    // send SIGKILL.
    drop(child);

    // Grace-then-SIGKILL fallback (blueprint: "SIGTERM-then-SIGKILL
    // grace"). Dropping `child` above already consumed the only
    // CommandChild::kill() this session will ever have, so the fallback
    // reaches the process directly via its pid instead (force_kill_pid)
    // if it hasn't exited on its own by the time the watchdog wakes.
    spawn_stop_watchdog(app, generation, pid);
    Ok(())
}

const STOP_GRACE_PERIOD: Duration = Duration::from_secs(3);

fn spawn_stop_watchdog(app: tauri::AppHandle, generation: u64, pid: u32) {
    thread::spawn(move || {
        thread::sleep(STOP_GRACE_PERIOD);
        let state = app.state::<AudiocapState>();
        if state.still_running(generation) {
            emit_uv_log(
                &app,
                "stderr",
                format!("[audiocap] stop grace period elapsed — sending SIGKILL to pid {pid}"),
            );
            force_kill_pid(pid);
        }
    });
}

#[cfg(target_os = "macos")]
fn force_kill_pid(pid: u32) {
    // SAFETY: a plain libc::kill syscall wrapper with a pid_t/signal —
    // no aliasing/lifetime requirements beyond the FFI call itself.
    // Best-effort: ESRCH (no such process — the graceful stop already
    // won the race) is the overwhelmingly likely reason for a nonzero
    // return, same "nothing left to report a further failure to"
    // posture as ProcessTapCapture.teardown/server::kill_and_reap.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

#[cfg(not(target_os = "macos"))]
fn force_kill_pid(_pid: u32) {}

// ---- the session task: spawn+supervise+resample+batch+status ----

const DIAG_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudiocapStatusEvent {
    kind: &'static str,
    message: Option<String>,
}

/// Owns one session's entire lifetime: reads CommandEvents until
/// Terminated, feeds stdout through FramingReader -> AudioPipeline ->
/// the Channel (gated on both `capturing` and the generation guard),
/// reassembles+mirrors every stderr line to the log lane, maps
/// status/error records + the eventual exit to one `audiocap://status`
/// event, and clears its own AudiocapState slot when done. The tauri
/// glue (CommandEvent/Channel/AppHandle) stays as thin as the mixing
/// allows — all the actual decoding/resampling/batching/kind-mapping is
/// delegated to pure functions/structs tested on their own.
fn spawn_session_task(
    app: tauri::AppHandle,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    generation: u64,
    pid: u32,
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
) {
    tauri::async_runtime::spawn(async move {
        let mut stderr_lines = LineReassembler::new();
        let mut framing = FramingReader::new();
        let mut pipeline = AudioPipeline::new();
        // D5/wire contract: "First bytes flow only after the helper
        // reports capturing" — gates PCM forwarding even though, by
        // construction, jargonslayer-audiocap never actually writes a
        // chunk record before AudioDeviceStart succeeds (Writer.run is
        // only ever reached after the "capturing" status is emitted —
        // see main.swift's runCapture) — this is belt-and-suspenders
        // against relying on cross-stream (stdout vs stderr) ordering.
        let mut capturing = false;
        let mut last_error: Option<(String, String)> = None;
        let mut last_diag = Instant::now();

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => match framing.feed(&bytes) {
                    Ok(items) => {
                        if !pipeline.has_format() {
                            if let Some(header) = framing.header() {
                                if let Err(e) = pipeline.set_format(header.sample_rate, header.channels) {
                                    emit_uv_log(&app, "stderr", format!("[audiocap] failed to configure resampler: {e}"));
                                }
                            }
                        }
                        for item in items {
                            if item.gap_before > 0 {
                                match pipeline.process_gap(item.gap_before) {
                                    Ok(batches) => send_batches(&app, &channel, generation, &mut pipeline, batches),
                                    Err(e) => emit_uv_log(&app, "stderr", format!("[audiocap] gap-silence error: {e}")),
                                }
                            }
                            match item.record {
                                Record::Chunk { frame_count, payload, .. } => {
                                    if !capturing {
                                        continue;
                                    }
                                    match pipeline.process_chunk(frame_count, &payload) {
                                        Ok(batches) => send_batches(&app, &channel, generation, &mut pipeline, batches),
                                        Err(e) => emit_uv_log(&app, "stderr", format!("[audiocap] resample error: {e}")),
                                    }
                                }
                                Record::Eos { .. } => match pipeline.flush() {
                                    Ok(batches) => send_batches(&app, &channel, generation, &mut pipeline, batches),
                                    Err(e) => emit_uv_log(&app, "stderr", format!("[audiocap] flush error: {e}")),
                                },
                            }
                        }
                    }
                    Err(e) => {
                        // Unrecoverable: without a valid header/record
                        // framing we can no longer trust ANY byte
                        // boundary in the rest of the stream. Ends the
                        // session proactively (force_kill_pid — nothing
                        // else still holds this session's CommandChild
                        // to close its stdin gracefully instead).
                        emit_uv_log(&app, "stderr", format!("[audiocap] fatal framing error: {e} — stopping session"));
                        force_kill_pid(pid);
                        let outcome = app.state::<AudiocapState>().finish(generation);
                        if outcome.was_current {
                            emit_status(&app, generation, StatusKind::Crashed, Some(format!("malformed audio stream: {e}")));
                        }
                        return;
                    }
                },
                CommandEvent::Stderr(bytes) => {
                    for line in stderr_lines.feed(&bytes) {
                        // Mirrors EVERY stderr line (status/error/stats
                        // alike) to the log lane for diagnosability,
                        // regardless of whether it goes on to parse
                        // into a typed status event below.
                        emit_uv_log(&app, "stderr", format!("[audiocap] {line}"));
                        match parse_audiocap_line(&line) {
                            ParsedAudiocapLine::Status { state, sample_rate, channels, message } => {
                                if state == "capturing" {
                                    capturing = true;
                                }
                                if let Some(kind) = status_record_kind(&state) {
                                    let message = message.or_else(|| match (sample_rate, channels) {
                                        (Some(sr), Some(ch)) => Some(format!("{sr} Hz, {ch}ch")),
                                        _ => None,
                                    });
                                    emit_status(&app, generation, kind, message);
                                }
                            }
                            ParsedAudiocapLine::Error { code, message } => {
                                // Deferred, not emitted immediately — the
                                // wire contract ties error kinds to the
                                // process's eventual exit (see
                                // exit_status_kind), and
                                // jargonslayer-audiocap always follows an
                                // emitError with an exit anyway
                                // (main.swift's own catch blocks).
                                last_error = Some((code, message));
                            }
                            ParsedAudiocapLine::Stats { .. } | ParsedAudiocapLine::Unrecognized => {}
                        }
                    }
                }
                CommandEvent::Error(message) => {
                    emit_uv_log(&app, "stderr", format!("[audiocap] shell error: {message}"));
                }
                CommandEvent::Terminated(payload) => {
                    let outcome = app.state::<AudiocapState>().finish(generation);
                    if outcome.was_current {
                        let kind = final_kind(payload.code, last_error.as_ref().map(|(c, _)| c.as_str()), outcome.stop_was_requested);
                        let message = final_message(kind, payload.code, last_error.as_ref());
                        emit_status(&app, generation, kind, message);
                    }
                    return;
                }
                _ => {}
            }

            if last_diag.elapsed() >= DIAG_INTERVAL {
                emit_uv_log(&app, "stdout", pipeline.diagnostics_line(framing.seq_gaps()));
                last_diag = Instant::now();
            }
        }

        // rx closed without ever yielding Terminated — shouldn't happen
        // (tauri-plugin-shell's spawn() always sends Terminated/Error
        // before its sender drops; see process/mod.rs's own spawn()),
        // kept as a safety net so the running slot can never get stuck
        // open forever.
        if let Some(line) = stderr_lines.flush() {
            emit_uv_log(&app, "stderr", format!("[audiocap] {line}"));
        }
        let outcome = app.state::<AudiocapState>().finish(generation);
        if outcome.was_current {
            emit_status(
                &app,
                generation,
                StatusKind::Crashed,
                Some("helper process ended without a final status".to_string()),
            );
        }
    });
}

/// Sends every batch through the Channel, re-checking the generation
/// guard before EACH one (not just once per call) — a long-running
/// forward loop could otherwise straddle a supersession mid-batch.
fn send_batches(
    app: &tauri::AppHandle,
    channel: &tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    generation: u64,
    pipeline: &mut AudioPipeline,
    batches: Vec<Vec<u8>>,
) {
    for batch in batches {
        if !app.state::<AudiocapState>().is_current(generation) {
            return;
        }
        let len = batch.len() as u64;
        if channel.send(tauri::ipc::InvokeResponseBody::Raw(batch)).is_ok() {
            pipeline.note_bytes_sent(len);
        }
    }
}

fn emit_status(app: &tauri::AppHandle, generation: u64, kind: StatusKind, message: Option<String>) {
    if !app.state::<AudiocapState>().is_current(generation) {
        return;
    }
    let _ = app.emit(
        "audiocap://status",
        AudiocapStatusEvent {
            kind: kind.as_str(),
            message,
        },
    );
}

/// Human-readable `message` for the FINAL status event of a session
/// (Terminated/fatal-framing-error paths) — `None` for the lifecycle
/// states that need none (starting/capturing/ended already say enough
/// via `kind` alone).
fn final_message(kind: StatusKind, code: Option<i32>, last_error: Option<&(String, String)>) -> Option<String> {
    match kind {
        StatusKind::PermissionDenied | StatusKind::Unsupported => last_error.map(|(_, msg)| msg.clone()),
        StatusKind::Crashed => Some(match last_error {
            Some((code_str, msg)) => format!("{code_str}: {msg}"),
            None => format!("helper exited unexpectedly (code {code:?})"),
        }),
        StatusKind::Ended | StatusKind::Starting | StatusKind::Capturing | StatusKind::ExcludePidInactive | StatusKind::DeviceChanged => None,
    }
}

// ---- startup orphan sweep + app-exit cleanup ----

/// D2/S9.2's own startup backstop for aggregate-device leaks from an
/// earlier run that ended via an uncatchable SIGKILL (risk register
/// item 4 — stdin-EOF/SIGTERM are the primary defenses, both already
/// covered by jargonslayer-audiocap's own ShutdownSignal; this sweep
/// only ever matters for the signal neither of those can catch).
/// Fire-and-forget, log-lane only: never surfaced to the UI, never
/// blocks app setup. Runs only when the runtime macOS-version check
/// already says the feature is supported — a below-floor machine could
/// never have created one of these aggregate devices in the first
/// place.
pub fn sweep_orphans_best_effort(app: &tauri::AppHandle) {
    if !is_macos_version_supported(macos_version()) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let command = match app.shell().sidecar(AUDIOCAP_SIDECAR_PROGRAM) {
            Ok(command) => command,
            Err(e) => {
                emit_uv_log(&app, "stderr", format!("[audiocap] orphan sweep: could not resolve sidecar: {e}"));
                return;
            }
        };
        let (mut rx, _child) = match command.args(["--sweep-orphans"]).set_raw_out(true).spawn() {
            Ok(pair) => pair,
            Err(e) => {
                emit_uv_log(&app, "stderr", format!("[audiocap] orphan sweep: failed to spawn: {e}"));
                return;
            }
        };
        let mut stderr_lines = LineReassembler::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    for line in stderr_lines.feed(&bytes) {
                        emit_uv_log(&app, "stderr", format!("[audiocap] orphan sweep: {line}"));
                    }
                }
                CommandEvent::Error(message) => {
                    emit_uv_log(&app, "stderr", format!("[audiocap] orphan sweep error: {message}"));
                }
                CommandEvent::Terminated(payload) => {
                    emit_uv_log(&app, "stdout", format!("[audiocap] orphan sweep exited (code {:?})", payload.code));
                }
                _ => {}
            }
        }
        if let Some(line) = stderr_lines.flush() {
            emit_uv_log(&app, "stderr", format!("[audiocap] orphan sweep: {line}"));
        }
    });
}

/// Called from lib.rs's RunEvent::ExitRequested/Exit handler — mirrors
/// server::kill_held_child_on_exit's own posture (see that fn's doc
/// comment for the exact force-quit gap this can't catch either): a
/// best-effort, IMMEDIATE kill (no grace period — the app is exiting
/// now, there is nothing left to await it) so a graceful app quit never
/// leaves jargonslayer-audiocap (and the aggregate device/tap it holds)
/// running behind it. The startup orphan sweep is the backstop for the
/// force-quit case this can't catch.
pub fn kill_held_session_on_exit(app: &tauri::AppHandle) {
    let state = app.state::<AudiocapState>();
    let taken = match state.running.lock() {
        Ok(mut guard) => guard.take().and_then(|session| session.child),
        Err(_) => return,
    };
    if let Some(child) = taken {
        force_kill_pid(child.pid());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- AUDIOCAP_SIDECAR_PROGRAM vs tauri.conf.json (mirrors uv.rs's
    // identically-shaped/named test for UV_SIDECAR_PROGRAM) ----

    #[test]
    fn sidecar_program_is_a_bare_file_name_matching_external_bin() {
        assert_eq!(
            std::path::Path::new(AUDIOCAP_SIDECAR_PROGRAM).components().count(),
            1,
            "AUDIOCAP_SIDECAR_PROGRAM must be a bare file name, never a path"
        );

        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        let external_bins = conf["bundle"]["externalBin"].as_array().expect("bundle.externalBin is an array");
        assert!(
            external_bins
                .iter()
                .filter_map(|b| b.as_str())
                .any(|b| std::path::Path::new(b).file_name().is_some_and(|n| n == AUDIOCAP_SIDECAR_PROGRAM)),
            "no bundle.externalBin entry has file name '{AUDIOCAP_SIDECAR_PROGRAM}'"
        );
    }

    // ---- LineReassembler ----

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
        assert_eq!(r.feed(b"{\"type\":\"stat"), Vec::<String>::new(), "no complete line yet");
        assert_eq!(r.feed(b"us\"}\n"), vec!["{\"type\":\"status\"}".to_string()]);
    }

    #[test]
    fn feed_handles_a_line_split_across_three_chunks() {
        let mut r = LineReassembler::new();
        assert!(r.feed(b"ab").is_empty());
        assert!(r.feed(b"cd").is_empty());
        assert_eq!(r.feed(b"ef\n"), vec!["abcdef".to_string()]);
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

    #[test]
    fn consecutive_newlines_yield_an_empty_line_not_a_dropped_one() {
        let mut r = LineReassembler::new();
        let lines = r.feed(b"a\n\nb\n");
        assert_eq!(lines, vec!["a".to_string(), "".to_string(), "b".to_string()]);
    }

    // ================================================================
    // S9.2 tests — macOS version gating, status/error NDJSON parsing,
    // status-kind mapping, and the AudiocapState single-flight/
    // generation-guard state machine. No tauri types, no live tap, no
    // CoreAudio (per this slice's own test-list constraints).
    // ================================================================

    // ---- macOS version gating (D1/D6) ----

    #[test]
    fn version_below_14_4_is_unsupported() {
        assert!(!is_macos_version_supported((14, 0)));
        assert!(!is_macos_version_supported((14, 3)));
        assert!(!is_macos_version_supported((13, 9)));
    }

    #[test]
    fn version_14_4_and_above_within_major_14_is_supported() {
        assert!(is_macos_version_supported((14, 4)));
        assert!(is_macos_version_supported((14, 9)));
    }

    #[test]
    fn any_later_major_version_is_supported_regardless_of_minor() {
        // Covers Apple's post-Sequoia version jump (macOS 26 == Tahoe) —
        // a higher major always clears the floor even at minor 0.
        assert!(is_macos_version_supported((15, 0)));
        assert!(is_macos_version_supported((26, 0)));
    }

    #[test]
    fn capabilities_for_supported_version_has_no_reason() {
        let caps = capabilities_for((14, 4));
        assert!(caps.app_audio_supported);
        assert_eq!(caps.reason, None);
    }

    #[test]
    fn capabilities_for_unsupported_version_carries_the_zh_reason() {
        let caps = capabilities_for((14, 3));
        assert!(!caps.app_audio_supported);
        assert_eq!(caps.reason, Some(UNSUPPORTED_REASON.to_string()));
    }

    // ---- open_privacy_settings URL constants (S9.4, D6) — pure logic
    // only; try_open()/open_privacy_settings() themselves shell out to
    // the real `open` binary and are intentionally left untested here
    // (this task's own scope: "add a cargo test only if there's pure
    // logic to pin"). ----

    #[test]
    fn privacy_settings_urls_use_the_x_apple_systempreferences_scheme() {
        assert!(PRIVACY_SETTINGS_SCREEN_CAPTURE_URL.starts_with("x-apple.systempreferences:"));
        assert!(PRIVACY_SETTINGS_FALLBACK_URL.starts_with("x-apple.systempreferences:"));
    }

    #[test]
    fn primary_url_is_the_fallback_url_plus_the_screen_capture_query() {
        // Pins the two constants' relationship — the primary deep link
        // is the fallback pane's own URL with `?Privacy_ScreenCapture`
        // appended, not two independently-typo-able strings.
        assert_eq!(
            PRIVACY_SETTINGS_SCREEN_CAPTURE_URL,
            format!("{PRIVACY_SETTINGS_FALLBACK_URL}?Privacy_ScreenCapture")
        );
    }

    // ---- status/error NDJSON line parsing ----

    #[test]
    fn parses_a_starting_status_line() {
        let line = r#"{"type":"status","state":"starting","sampleRate":48000,"channels":2}"#;
        assert_eq!(
            parse_audiocap_line(line),
            ParsedAudiocapLine::Status {
                state: "starting".to_string(),
                sample_rate: Some(48_000),
                channels: Some(2),
                message: None,
            }
        );
    }

    #[test]
    fn parses_a_note_style_status_line_with_a_message_and_no_format_fields() {
        let line = r#"{"type":"status","state":"exclude-pid-inactive","message":"pid 123 has no CoreAudio process object"}"#;
        assert_eq!(
            parse_audiocap_line(line),
            ParsedAudiocapLine::Status {
                state: "exclude-pid-inactive".to_string(),
                sample_rate: None,
                channels: None,
                message: Some("pid 123 has no CoreAudio process object".to_string()),
            }
        );
    }

    #[test]
    fn parses_an_error_line() {
        let line = r#"{"type":"error","code":"permission-denied","message":"AudioDeviceStart denied"}"#;
        assert_eq!(
            parse_audiocap_line(line),
            ParsedAudiocapLine::Error {
                code: "permission-denied".to_string(),
                message: "AudioDeviceStart denied".to_string(),
            }
        );
    }

    #[test]
    fn parses_a_stats_line() {
        let line = r#"{"type":"stats","overflows":0,"ringHighWater":1024,"framesOut":48000}"#;
        assert_eq!(
            parse_audiocap_line(line),
            ParsedAudiocapLine::Stats {
                overflows: 0,
                ring_high_water: 1024,
                frames_out: 48_000
            }
        );
    }

    #[test]
    fn parses_the_sweep_orphans_status_line() {
        let line = r#"{"type":"status","state":"swept","message":"2 orphan(s)"}"#;
        assert_eq!(
            parse_audiocap_line(line),
            ParsedAudiocapLine::Status {
                state: "swept".to_string(),
                sample_rate: None,
                channels: None,
                message: Some("2 orphan(s)".to_string()),
            }
        );
    }

    #[test]
    fn garbage_and_malformed_lines_are_unrecognized_not_a_panic() {
        for line in [
            "",
            "not json",
            r#"{"type":"status"}"#,            // status with no state
            r#"{"type":"error","code":"x"}"#,  // error with no message
            r#"{"type":"something_else"}"#,
            r#"{"type":"stats","overflows":1}"#, // stats missing fields
        ] {
            assert_eq!(parse_audiocap_line(line), ParsedAudiocapLine::Unrecognized, "{line:?}");
        }
    }

    // ---- status kind mapping ----

    #[test]
    fn status_record_kind_maps_the_known_states() {
        assert_eq!(status_record_kind("starting"), Some(StatusKind::Starting));
        assert_eq!(status_record_kind("capturing"), Some(StatusKind::Capturing));
        assert_eq!(status_record_kind("exclude-pid-inactive"), Some(StatusKind::ExcludePidInactive));
        assert_eq!(status_record_kind("device-changed"), Some(StatusKind::DeviceChanged));
        assert_eq!(status_record_kind("swept"), None);
    }

    #[test]
    fn error_record_kind_maps_only_the_two_codes_the_wire_contract_has_a_kind_for() {
        assert_eq!(error_record_kind("permission-denied"), Some(StatusKind::PermissionDenied));
        assert_eq!(error_record_kind("unsupported-os"), Some(StatusKind::Unsupported));
        for code in ["pid-translate-failed", "tap-create-failed", "aggregate-create-failed", "device-start-failed"] {
            assert_eq!(error_record_kind(code), None, "{code} has no dedicated kind — falls through to crashed at exit");
        }
    }

    #[test]
    fn exit_status_kind_maps_clean_exit_to_ended() {
        assert_eq!(exit_status_kind(Some(0), None), StatusKind::Ended);
        assert_eq!(exit_status_kind(Some(0), Some("permission-denied")), StatusKind::Ended);
    }

    #[test]
    fn exit_status_kind_maps_a_nonzero_exit_with_a_mapped_error_to_that_kind() {
        assert_eq!(exit_status_kind(Some(1), Some("permission-denied")), StatusKind::PermissionDenied);
        assert_eq!(exit_status_kind(Some(1), Some("unsupported-os")), StatusKind::Unsupported);
    }

    #[test]
    fn exit_status_kind_maps_a_nonzero_exit_with_no_or_an_unmapped_error_to_crashed() {
        assert_eq!(exit_status_kind(Some(1), None), StatusKind::Crashed);
        assert_eq!(exit_status_kind(None, None), StatusKind::Crashed);
        assert_eq!(exit_status_kind(Some(1), Some("device-start-failed")), StatusKind::Crashed);
    }

    #[test]
    fn final_kind_reports_ended_for_any_requested_stop_even_a_forced_one() {
        // A stop that had to escalate to SIGKILL (code=None, killed by
        // signal) is still an ENDED session from the user's point of
        // view, not a crash — the refinement final_kind layers on top
        // of exit_status_kind's own literal exit-code table, applied
        // whenever stop_app_audio (or supersession) already took the
        // child before the process actually exited.
        assert_eq!(final_kind(None, None, true), StatusKind::Ended);
        assert_eq!(final_kind(Some(1), Some("device-start-failed"), true), StatusKind::Ended);
    }

    #[test]
    fn final_kind_falls_back_to_exit_status_kind_when_no_stop_was_requested() {
        assert_eq!(final_kind(Some(0), None, false), StatusKind::Ended);
        assert_eq!(final_kind(Some(1), Some("permission-denied"), false), StatusKind::PermissionDenied);
        assert_eq!(final_kind(Some(1), None, false), StatusKind::Crashed);
    }

    #[test]
    fn final_message_is_none_for_ended() {
        assert_eq!(final_message(StatusKind::Ended, Some(0), None), None);
    }

    #[test]
    fn final_message_uses_the_last_errors_message_for_permission_denied_and_unsupported() {
        let err = ("permission-denied".to_string(), "denied by TCC".to_string());
        assert_eq!(final_message(StatusKind::PermissionDenied, Some(1), Some(&err)), Some("denied by TCC".to_string()));
    }

    #[test]
    fn final_message_for_crashed_includes_the_unmapped_error_code_when_present() {
        let err = ("device-start-failed".to_string(), "boom".to_string());
        assert_eq!(
            final_message(StatusKind::Crashed, Some(1), Some(&err)),
            Some("device-start-failed: boom".to_string())
        );
    }

    #[test]
    fn final_message_for_crashed_falls_back_to_the_exit_code_when_no_error_was_ever_seen() {
        let message = final_message(StatusKind::Crashed, Some(137), None).unwrap();
        assert!(message.contains("137"), "{message}");
    }

    // ---- AudiocapState: single-flight, idempotent stop, generation guard ----

    #[test]
    fn try_begin_succeeds_when_nothing_is_running() {
        let state = AudiocapState::default();
        assert!(state.try_begin().is_ok());
    }

    #[test]
    fn try_begin_rejects_a_second_call_while_a_session_is_active() {
        let state = AudiocapState::default();
        let first = state.try_begin().unwrap();
        assert!(state.try_begin().is_err());
        // the rejected attempt must not have disturbed the first session
        assert!(state.is_current(first));
    }

    #[test]
    fn try_begin_after_finish_succeeds_and_bumps_the_generation() {
        let state = AudiocapState::default();
        let first = state.try_begin().unwrap();
        state.finish(first);
        let second = state.try_begin().unwrap();
        assert_ne!(first, second);
        assert!(state.try_begin().is_err(), "the second session is now occupying the slot");
    }

    #[test]
    fn is_current_becomes_false_once_a_newer_session_has_begun() {
        let state = AudiocapState::default();
        let first = state.try_begin().unwrap();
        assert!(state.is_current(first));
        state.finish(first);
        let second = state.try_begin().unwrap();
        assert!(!state.is_current(first), "a superseded generation must never read as current again");
        assert!(state.is_current(second));
    }

    #[test]
    fn stop_is_idempotent_when_nothing_is_running() {
        let state = AudiocapState::default();
        assert!(state.take_child_for_stop().unwrap().is_none());
        assert!(state.take_child_for_stop().unwrap().is_none());
    }

    #[test]
    fn stop_is_idempotent_when_a_session_is_running_but_its_child_was_never_attached() {
        // Simulates "stop called while spawn is still in flight" / "stop
        // called twice in a row" — neither has a real CommandChild to
        // hand back, and neither should error.
        let state = AudiocapState::default();
        state.try_begin().unwrap();
        assert!(state.take_child_for_stop().unwrap().is_none());
    }

    #[test]
    fn finish_clears_the_slot_and_treats_an_empty_child_slot_as_a_requested_stop() {
        let state = AudiocapState::default();
        let generation = state.try_begin().unwrap();
        // No attach_child call — mirrors exactly what take_child_for_stop
        // leaves behind after a real stop (child: None).
        let outcome = state.finish(generation);
        assert!(outcome.was_current);
        assert!(outcome.stop_was_requested);
        assert!(state.try_begin().is_ok(), "the slot must be free again");
    }

    #[test]
    fn finish_reports_not_current_for_a_superseded_generation() {
        let state = AudiocapState::default();
        let first = state.try_begin().unwrap();
        state.finish(first);
        state.try_begin().unwrap(); // a second session now occupies the slot

        let stale_outcome = state.finish(first);
        assert!(!stale_outcome.was_current, "finishing an already-cleared/superseded generation must be a no-op");
    }

    #[test]
    fn still_running_reflects_the_current_occupant_only() {
        let state = AudiocapState::default();
        let generation = state.try_begin().unwrap();
        assert!(state.still_running(generation));
        state.finish(generation);
        assert!(!state.still_running(generation));
    }
}
