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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// Shared boilerplate behind BOTH the spike rig's own `audiocap-spike
/// .log` tee below and `SessionLog`'s `audiocap.log` (S9 live-failure
/// investigation, further down): resolve `<app_log_dir>`, create it if
/// needed, and open `file_name` inside it in append mode. `None` —
/// never surfaced as an `Err` to any caller — whenever the dir can't be
/// resolved/created or the open itself fails; every caller already
/// degrades to "no file tee" rather than failing whatever it's
/// actually doing (the spike run, or a real capture session) over a
/// log file it couldn't open.
fn open_log_file_in_app_log_dir(app: &tauri::AppHandle, file_name: &str) -> Option<std::fs::File> {
    let dir = app.path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::OpenOptions::new().create(true).append(true).open(dir.join(file_name)).ok()
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
///
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
        let mut spike_file: Option<std::fs::File> = open_log_file_in_app_log_dir(&app, "audiocap-spike.log");
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
/// still NOT emitted as a STATUS record by jargonslayer-audiocap (F6,
/// adversarial-review fix round: the helper's own IO-starvation dead-man
/// switch emits it as a typed `type:"error"` record instead —
/// `error_record_kind` below — the same deferred-to-exit shape
/// permission-denied/unsupported-os already use) but this mapping is
/// kept as a forward-compatible reservation regardless: StatusEvents
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

/// Maps a `type:"error"` record's `code` to a StatusKind — only the
/// three codes this wire contract has a dedicated kind for (the third,
/// F6's `device-changed`, is jargonslayer-audiocap's own IO-starvation
/// dead-man switch — Writer.StopReason.starved/AudioCapError
/// .deviceChanged). AudioCapError's other four codes (pid-translate-
/// failed / tap-create-failed / aggregate-create-failed / device-start-
/// failed) have no kind of their own here; they fall through to
/// `exit_status_kind`'s "crashed" default once the process actually
/// exits non-zero.
fn error_record_kind(code: &str) -> Option<StatusKind> {
    match code {
        "permission-denied" => Some(StatusKind::PermissionDenied),
        "unsupported-os" => Some(StatusKind::Unsupported),
        "device-changed" => Some(StatusKind::DeviceChanged),
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
///
/// F8 (adversarial-review fix round): `eos_seen` — did
/// FramingReader ever actually observe a terminal EOS record on stdout
/// for this session — is now load-bearing for the `code == Some(0)`
/// branch, not just the exit code alone: this rule's own words already
/// said "clean EOS/exit-0", but the exit code used to be trusted on its
/// own. A clean exit-0 that never produced an EOS record is a truncated
/// stream (the helper died/was reaped some other way without ever
/// finishing its own normal teardown-then-writeEOS-then-exit(0)
/// sequence) and is now reported as `Crashed`, never `Ended`. Only
/// matters for the `code == Some(0)` branch — irrelevant to every
/// nonzero-exit outcome below it.
pub fn exit_status_kind(code: Option<i32>, last_error_code: Option<&str>, eos_seen: bool) -> StatusKind {
    if code == Some(0) {
        return if eos_seen { StatusKind::Ended } else { StatusKind::Crashed };
    }
    last_error_code.and_then(error_record_kind).unwrap_or(StatusKind::Crashed)
}

/// `final_kind` = `exit_status_kind`, EXCEPT: if stop_app_audio (or
/// supersession) had already taken this session's child before it
/// exited, the outcome is reported as `Ended` unconditionally — even if
/// reaching that point required the grace-timeout SIGKILL fallback
/// (which reports as a signal kill, i.e. `code: None`, not a clean
/// `Some(0)`) and even if THAT meant EOS was never written either (a
/// forced kill has no obligation to have reached its own normal
/// teardown sequence). A user-requested stop that took the hard path is
/// still a requested stop, not a crash, from the UI's point of view —
/// this short-circuit is deliberately unconditional on `eos_seen`,
/// unlike `exit_status_kind`'s own `code == Some(0)` branch.
pub fn final_kind(code: Option<i32>, last_error_code: Option<&str>, stop_was_requested: bool, eos_seen: bool) -> StatusKind {
    if stop_was_requested {
        return StatusKind::Ended;
    }
    exit_status_kind(code, last_error_code, eos_seen)
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
    /// F5 (adversarial-review fix round) — StatusEvents.StatsRecord's
    /// own new field: cumulative audio frames dropped across every ring
    /// overflow (distinct from `overflows`' rejected-callback count).
    #[serde(rename = "droppedFrames")]
    dropped_frames: Option<u64>,
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
        /// F5: see RawAudiocapLine.dropped_frames's own doc comment.
        dropped_frames: u64,
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
        "stats" => match (raw.overflows, raw.ring_high_water, raw.frames_out, raw.dropped_frames) {
            (Some(overflows), Some(ring_high_water), Some(frames_out), Some(dropped_frames)) => ParsedAudiocapLine::Stats {
                overflows,
                ring_high_water,
                frames_out,
                dropped_frames,
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
    /// F4 (soft pause, adversarial-review fix round) — PINNED CONTRACT:
    /// the JS worker wires engine.pause()/resume() to the
    /// `pause_app_audio`/`resume_app_audio` commands below, which just
    /// flip this. Lock-free like `generation` (mirrors `is_current`'s
    /// own "cheap enough for a hot path" reasoning — `spawn_session_task`
    /// checks it on every event it processes). Reset to `false` by every
    /// `try_begin` so a leftover pause from a finished session can never
    /// leak into the next one.
    paused: AtomicBool,
}

struct RunningSession {
    generation: u64,
    /// `Some` from `attach_child` (right after a successful spawn)
    /// until `take_child_for_stop` removes it — its presence/absence is
    /// also how `finish` tells a requested stop apart from a
    /// spontaneous exit (see that function's own doc comment).
    child: Option<CommandChild>,
    /// F1 fix (adversarial-review fix round): set by
    /// `take_child_for_stop` when it runs during the window between
    /// `try_begin` and `attach_child` — the sidecar spawn is still in
    /// flight, so there's no `CommandChild` yet to take/drop. Before
    /// this flag existed, a stop landing in exactly that window read as
    /// a no-op ("nothing to stop", child was already `None`) and was
    /// silently lost: `attach_child` later installed the just-spawned
    /// helper completely unconditionally, leaving a live, un-stoppable
    /// capture running behind a UI that already believed it had
    /// stopped. `is_attachable`/`attach_child` below now consult this
    /// instead of attaching blindly.
    cancel_requested: bool,
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
        *guard = Some(RunningSession { generation, child: None, cancel_requested: false });
        // F4: a fresh session always starts unpaused, regardless of
        // whatever the previous (now fully finished) session's own
        // pause state was left at.
        self.paused.store(false, Ordering::SeqCst);
        Ok(generation)
    }

    /// F4: cheap, lock-free — called on every event `spawn_session_task`
    /// processes (same "hot enough to matter" posture as `is_current`).
    fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// F4 — backs `pause_app_audio`/`resume_app_audio`: idempotent, and
    /// a no-op whenever nothing is actually running (both commands'
    /// own "no-op Ok when no session" contract) — harmless either way,
    /// since `try_begin` always resets this flag for the NEXT session
    /// regardless of whatever a stray call left it at. Unlike F1's own
    /// race, a session ending in the small window between this
    /// function's own read of `running` and its `paused` store below is
    /// truly inert, not a correctness bug: nothing is left reading a
    /// flag from a session that's already gone, and the value plays no
    /// part in whether/how a NEW session ever starts (see `try_begin`'s
    /// own unconditional reset) — so this doesn't need the same
    /// single-lock-acquisition treatment `attach_child` needed.
    fn set_paused(&self, paused: bool) {
        if self.running.lock().map(|guard| guard.is_some()).unwrap_or(false) {
            self.paused.store(paused, Ordering::SeqCst);
        }
    }

    /// F1: pure, `CommandChild`-free predicate behind `attach_child`'s
    /// own decision — split out specifically so this decision is
    /// unit-testable. `tauri_plugin_shell::process::CommandChild` has no
    /// constructor reachable outside an actual process spawn (its only
    /// constructor lives inside that crate's own private `spawn()`), so
    /// `attach_child` itself never can be unit-tested directly; this
    /// function is the actual seam the F1 fix's tests exercise. Shared
    /// by both `should_attach_child` (the test-facing query) and
    /// `attach_child` (the real mutator) so there is exactly one place
    /// this condition is spelled out.
    fn is_attachable(session: &RunningSession, generation: u64) -> bool {
        session.generation == generation && !session.cancel_requested
    }

    /// Read-only mirror of the check `attach_child` itself makes, kept
    /// separately callable so F1's actual decision logic — "does a
    /// cancellation already on record for this generation block the
    /// attach?" — has a seam unit tests can exercise without ever
    /// constructing a real `CommandChild`. Not used by any production
    /// caller; `attach_child` re-derives the same answer itself, under
    /// the SAME lock acquisition it uses to also perform the attach (a
    /// separate peek-then-act here would reopen a smaller version of
    /// F1's own race). `#[cfg(test)]`-only: production code never calls
    /// this (see this fn's own doc comment), so a non-test build has no
    /// caller for it at all.
    #[cfg(test)]
    fn should_attach_child(&self, generation: u64) -> bool {
        self.running
            .lock()
            .map(|guard| guard.as_ref().is_some_and(|session| Self::is_attachable(session, generation)))
            .unwrap_or(false)
    }

    /// Attaches the just-spawned CommandChild to `generation`'s slot —
    /// `Ok(())` on the normal path (the session becomes the Running
    /// occupant of its own slot). `Err(child)` hands the SAME child
    /// straight back, unstored, whenever `is_attachable` says no: either
    /// F1's own race (a stop already landed for this generation while
    /// the spawn was still in flight) or the defensive/shouldn't-happen
    /// case of `generation` no longer being the slot's occupant at all
    /// (nothing else can clear/replace the slot before this session's
    /// own `finish` — unchanged from before this fix). Either way the
    /// caller (`start_app_audio`) is expected to tear the returned child
    /// down immediately — drop for stdin-EOF plus the grace/SIGKILL
    /// watchdog, exactly like `stop_app_audio`'s own
    /// post-`take_child_for_stop` path.
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

    /// Cheap, lock-free — called on every forwarded audio batch and
    /// every status emission (see this struct's own doc comment for why
    /// that matters).
    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    /// Idempotent stop-request: `None` when nothing is running, a stop
    /// was already requested for the current session (its child slot is
    /// already empty), OR — F1 — the session is still in its `Starting`
    /// window (spawn in flight, no `CommandChild` attached yet): all
    /// three record `cancel_requested = true` before returning, so a
    /// LATER `attach_child` call (see that function's own doc comment)
    /// knows to refuse the attach rather than silently starting a
    /// session the caller already believes it stopped.
    /// `stop_app_audio` maps every `None` case to `Ok(())`.
    /// `Some((child, pid, generation))` otherwise, after taking the
    /// child (the caller is now responsible for dropping it to close
    /// its stdin — see stop_app_audio's own comment).
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

    /// F13 (adversarial-review fix round) — true if ANY session
    /// (Starting, Running, or already-Stopping) currently occupies the
    /// slot, regardless of generation. Backs `sweep_orphans_best_effort`'s
    /// own startup-race guard: that sweep's enumerate+destroy pass has no
    /// way to tell "an old orphan from a previous run" apart from "the
    /// aggregate device a session just created" — both carry the exact
    /// same UID prefix (OrphanSweep.ownedAggregateUIDPrefix, Swift side)
    /// — so it must never run while a session might already be live.
    fn any_session_active(&self) -> bool {
        self.running.lock().map(|guard| guard.is_some()).unwrap_or(true) // poisoned -> assume active: skipping a legitimate sweep is harmless, destroying a live session's aggregate device is not
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
            if let Err(child) = state.attach_child(generation, child) {
                // F1: a stop already landed for this generation while
                // the spawn was still in flight (see attach_child/
                // should_attach_child's own doc comments for the exact
                // race) — tear this child down right now instead of
                // letting it become a live, un-stoppable session. Same
                // teardown stop_app_audio's own post-take_child_for_stop
                // path uses: drop closes stdin (jargonslayer-audiocap's
                // own dead-man switch), the grace/SIGKILL watchdog
                // covers whatever that doesn't. finish() — reached once
                // spawn_session_task (started below) sees this child's
                // own Terminated event — reports the outcome as "ended",
                // never "crashed": session.child never having been
                // attached reads identically to a normal requested stop.
                drop(child);
                spawn_stop_watchdog(app.clone(), generation, pid);
            }
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

// ---- pause_app_audio / resume_app_audio (F4, adversarial-review fix
// round) ----

/// PINNED CONTRACT: the JS worker wires engine.pause() to exactly this
/// command name. Idempotent; a no-op `Ok(())` when nothing is running
/// (AudiocapState::set_paused's own doc comment). The actual pause
/// behavior — flushing the current partial batch through the Channel,
/// then dropping all further decoded PCM at the pipeline's own input —
/// happens inside spawn_session_task, the only place that has access to
/// the running session's Channel/AudioPipeline (both live only as that
/// task's own local variables); this command can only flip the shared
/// flag it reads on its next loop iteration. See AudioPipeline::pause's
/// own doc comment for the full semantics.
#[tauri::command]
pub fn pause_app_audio(state: tauri::State<'_, AudiocapState>) -> Result<(), String> {
    state.set_paused(true);
    Ok(())
}

/// PINNED CONTRACT: the JS worker wires engine.resume() to exactly this
/// command name. See `pause_app_audio`/`AudioPipeline::resume`'s own doc
/// comments for the full semantics (notably: resets the resampler to
/// avoid a discontinuity artifact at the resume boundary).
#[tauri::command]
pub fn resume_app_audio(state: tauri::State<'_, AudiocapState>) -> Result<(), String> {
    state.set_paused(false);
    Ok(())
}

// Cross-language invariant (adversarial-review fix round): the JS
// AppAudioEngine's own stop path waits up to ~4s for a matching "ended"
// audiocap://status event before giving up on the drain handshake (the
// JS worker owns that side and is adding the mirror comment there). This
// 3s grace period MUST stay strictly shorter than JS's own wait: it's
// what guarantees Rust has cleared AudiocapState's single-flight slot
// (`finish`, reached once the child actually exits — gracefully or via
// this watchdog's own SIGKILL fallback) and emitted the final status
// BEFORE JS times out — if the two ever crossed (grace >= JS timeout),
// a slow-to-die helper could leave JS waiting past its own deadline for
// an event Rust hasn't sent yet.
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

// ---- S9 live-failure investigation: always-on session log ----
//
// The spike rig above has always kept its own append-only
// `audiocap-spike.log` for exactly one reason: a provisioned machine
// never shows the wizard's 详细日志 pane, so a live/ephemeral event (like
// `emit_uv_log`'s own `uv://log`, which every stderr line ALSO still
// reaches unconditionally below — unchanged) is not something anyone
// can actually read back after the fact. NORMAL (non-spike) sessions
// had no equivalent — this generalizes that same "durable, readable-
// without-the-app-open" file tee to every real capture session,
// `<app_log_dir>/audiocap.log`, WITHOUT changing the spike rig's own
// behavior (`open_log_file_in_app_log_dir` above is the shared part).

/// ~2 MiB size guard (task's own "trivial" example) — checked once, at
/// session-open, so a long-lived install's `audiocap.log` can never
/// grow unbounded across MANY sessions (a single session's own lines
/// never approach this on their own). Best-effort/swallowed exactly
/// like `open_log_file_in_app_log_dir` itself — a failed truncate just
/// means the file opens (and keeps growing) as it would have without
/// the guard, which is still strictly better than failing the session
/// over it.
const AUDIOCAP_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

fn open_normal_session_log_file(app: &tauri::AppHandle) -> Option<std::fs::File> {
    if let Ok(dir) = app.path().app_log_dir() {
        let path = dir.join("audiocap.log");
        if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > AUDIOCAP_LOG_MAX_BYTES {
            let _ = std::fs::write(&path, []); // best-effort truncate-to-empty
        }
    }
    open_log_file_in_app_log_dir(app, "audiocap.log")
}

/// Pure cadence rule behind `SessionLog::note_batch_sent` below:
/// `Some(line)` exactly for the FIRST batch ever sent this session (its
/// own byte length only — no running total is meaningful yet) and
/// every 64th batch after that (cumulative batches+bytes so far);
/// `None` on every other call, so a caller incrementing once per batch
/// and always consulting this never double-logs. `batch_number` is
/// 1-based — the count AFTER the batch this call is describing (i.e.
/// what `note_batch_sent` already incremented to).
fn batch_forwarding_log_line(batch_number: u64, this_batch_bytes: u64, cumulative_bytes: u64) -> Option<String> {
    if batch_number == 1 {
        Some(format!("channel-forwarding first batch: bytes={this_batch_bytes}"))
    } else if batch_number != 0 && batch_number.is_multiple_of(64) {
        // `batch_number != 0` guard: batch_number is documented 1-based
        // (never actually 0 from `note_batch_sent`'s own always-
        // increment-first call), but 0 is also mathematically a
        // multiple of 64 — without this guard this function would
        // silently treat a hypothetical 0 as its own milestone too,
        // contradicting that contract.
        Some(format!("channel-forwarding progress: batches={batch_number} bytes={cumulative_bytes}"))
    } else {
        None
    }
}

/// Always-on (non-spike) session log — `<app_log_dir>/audiocap.log`.
/// One `spawn_session_task` call opens exactly one `SessionLog`
/// (`SessionLog::open`, at the top of that task) and owns it for the
/// session's whole lifetime; every method below is a plain, synchronous
/// append — see `append`'s own doc comment for the error-swallowing
/// contract that keeps this lane out of the byte-hot loop's error path.
/// NEVER logs PCM payload bytes/content — only byte LENGTHS/COUNTS, the
/// same posture the wire's own `stats` counters already take.
struct SessionLog {
    file: Option<std::fs::File>,
    batches_sent: u64,
    bytes_sent: u64,
}

impl SessionLog {
    fn open(app: &tauri::AppHandle) -> Self {
        Self {
            file: open_normal_session_log_file(app),
            batches_sent: 0,
            bytes_sent: 0,
        }
    }

    /// Appends one timestamped line — `None` `file` (couldn't be
    /// opened) is a silent no-op, and a write failure PERMANENTLY
    /// disables further appends for the rest of this session (rather
    /// than retrying a possibly-wedged fd on every subsequent line):
    /// either way, an io error writing this log must never fail — or
    /// even slow down — the actual capture session it only ever
    /// describes.
    fn append(&mut self, line: &str) {
        let Some(file) = self.file.as_mut() else { return };
        let now_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        use std::io::Write;
        if writeln!(file, "[unix {now_unix}] {line}").is_err() {
            self.file = None;
        }
    }

    /// `send_batches`' own per-successfully-sent-batch hook — advances
    /// the running totals and appends a line per
    /// `batch_forwarding_log_line`'s own cadence (batch 1 alone, then
    /// every 64th, cumulative both times).
    fn note_batch_sent(&mut self, byte_len: u64) {
        self.batches_sent += 1;
        self.bytes_sent += byte_len;
        if let Some(line) = batch_forwarding_log_line(self.batches_sent, byte_len, self.bytes_sent) {
            self.append(&line);
        }
    }

    /// Session-end totals — called once by EVERY one of
    /// `spawn_session_task`'s own termination points, regardless of
    /// where `batches_sent` last landed relative to the 64-cadence, so
    /// the log always shows the true final count even for a session
    /// that ended between milestones (including zero batches ever
    /// sent — e.g. a permission-denied session that never reached
    /// "capturing").
    fn note_session_end_totals(&mut self) {
        self.append(&format!("channel-forwarding session total: batches={} bytes={}", self.batches_sent, self.bytes_sent));
    }
}

/// Owns one session's entire lifetime: reads CommandEvents until
/// Terminated, feeds stdout through FramingReader -> AudioPipeline ->
/// the Channel (gated on both `capturing` and the generation guard),
/// reassembles+mirrors every stderr line to the log lane, maps
/// status/error records + the eventual exit to one `audiocap://status`
/// event, and clears its own AudiocapState slot when done. Also owns
/// this session's own `SessionLog` (S9 live-failure investigation) —
/// the durable `<app_log_dir>/audiocap.log` companion to the ephemeral
/// `uv://log` lane above, covering session start, every parsed status/
/// error record, channel-forwarding batch/byte milestones, and the
/// final exit/kind resolution — see SessionLog's own doc comment. The
/// tauri glue (CommandEvent/Channel/AppHandle) stays as thin as the
/// mixing allows — all the actual decoding/resampling/batching/kind-
/// mapping is delegated to pure functions/structs tested on their own.
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
        // F4 — local mirror of AudiocapState's own (shared, generation-
        // wide) paused flag, edge-detected once per loop iteration so
        // pipeline.pause()/resume() each run EXACTLY once per actual
        // transition (resume()'s resampler rebuild in particular must
        // not fire on every single event while already resumed).
        let mut paused = false;
        // S9 live-failure investigation — one `SessionLog` per session,
        // opened once here and threaded through the rest of this task;
        // see its own doc comment for what it logs (and, just as
        // deliberately, what it never does: PCM payload content).
        let mut session_log = SessionLog::open(&app);
        session_log.append(&format!("session start generation={generation}"));

        while let Some(event) = rx.recv().await {
            // Checked on every event this task sees (not just Stdout) —
            // jargonslayer-audiocap's writer flushes to stdout at least
            // every ~20-50ms while capturing (Writer.swift's own
            // targetChunkBytes/maxFlushLatency), so a pause/resume
            // request is observed and acted on well within that same
            // window regardless of which event happens to arrive next.
            let now_paused = app.state::<AudiocapState>().is_paused();
            if now_paused && !paused {
                let batches = pipeline.pause();
                send_batches(&app, &channel, generation, &mut pipeline, &mut session_log, batches);
                paused = true;
            } else if !now_paused && paused {
                if let Err(e) = pipeline.resume() {
                    emit_uv_log(&app, "stderr", format!("[audiocap] failed to reset resampler on resume: {e}"));
                }
                paused = false;
            }

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
                                    Ok(batches) => send_batches(&app, &channel, generation, &mut pipeline, &mut session_log, batches),
                                    Err(e) => emit_uv_log(&app, "stderr", format!("[audiocap] gap-silence error: {e}")),
                                }
                            }
                            match item.record {
                                Record::Chunk { frame_count, payload, .. } => {
                                    if !capturing {
                                        continue;
                                    }
                                    match pipeline.process_chunk(frame_count, &payload) {
                                        Ok(batches) => send_batches(&app, &channel, generation, &mut pipeline, &mut session_log, batches),
                                        Err(e) => emit_uv_log(&app, "stderr", format!("[audiocap] resample error: {e}")),
                                    }
                                }
                                Record::Eos { .. } => match pipeline.flush() {
                                    Ok(batches) => send_batches(&app, &channel, generation, &mut pipeline, &mut session_log, batches),
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
                        session_log.append(&format!(
                            "session end kind={} exit_code=None eos_seen={} was_current={} reason=fatal_framing_error",
                            StatusKind::Crashed.as_str(),
                            framing.eos_seen(),
                            outcome.was_current
                        ));
                        session_log.note_session_end_totals();
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
                                // S9 live-failure investigation: tee the
                                // exact raw NDJSON line (state/message/
                                // sampleRate/channels all fall straight
                                // out of it, whichever this record
                                // actually carries — no need to
                                // hand-reassemble a summary here).
                                session_log.append(&format!("status {line}"));
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
                                session_log.append(&format!("error {line}"));
                                // Deferred, not emitted immediately — the
                                // wire contract ties error kinds to the
                                // process's eventual exit (see
                                // exit_status_kind), and
                                // jargonslayer-audiocap always follows an
                                // emitError with an exit anyway
                                // (main.swift's own catch blocks).
                                last_error = Some((code, message));
                            }
                            ParsedAudiocapLine::Stats { .. } => {
                                // S9 live-failure investigation: stats
                                // records carry peak/windowPeak — the
                                // amplitude evidence that separates a
                                // silent-tap failure from a plumbing
                                // one — so they're teed like status/
                                // error. ~1 line / 5s; audiocap.log's
                                // 2MB session-open truncation bounds it.
                                session_log.append(&format!("stats {line}"));
                            }
                            ParsedAudiocapLine::Unrecognized => {}
                        }
                    }
                }
                CommandEvent::Error(message) => {
                    emit_uv_log(&app, "stderr", format!("[audiocap] shell error: {message}"));
                }
                CommandEvent::Terminated(payload) => {
                    let outcome = app.state::<AudiocapState>().finish(generation);
                    // F8: framing.eos_seen() reflects whether a terminal
                    // EOS record was ever actually parsed from stdout —
                    // see final_kind/exit_status_kind's own doc comments
                    // for why this now matters even for a clean exit-0.
                    // Computed (and logged) regardless of `was_current`
                    // — pure/side-effect-free either way — but only
                    // EMITTED as an audiocap://status event when this
                    // session is still the authoritative one, unchanged
                    // from before.
                    let kind = final_kind(
                        payload.code,
                        last_error.as_ref().map(|(c, _)| c.as_str()),
                        outcome.stop_was_requested,
                        framing.eos_seen(),
                    );
                    session_log.append(&format!(
                        "session end kind={} exit_code={:?} eos_seen={} was_current={}",
                        kind.as_str(),
                        payload.code,
                        framing.eos_seen(),
                        outcome.was_current
                    ));
                    session_log.note_session_end_totals();
                    if outcome.was_current {
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
        session_log.append(&format!(
            "session end kind={} exit_code=None eos_seen={} was_current={} reason=rx_closed_without_terminated",
            StatusKind::Crashed.as_str(),
            framing.eos_seen(),
            outcome.was_current
        ));
        session_log.note_session_end_totals();
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
    session_log: &mut SessionLog,
    batches: Vec<Vec<u8>>,
) {
    for batch in batches {
        if !app.state::<AudiocapState>().is_current(generation) {
            return;
        }
        let len = batch.len() as u64;
        if channel.send(tauri::ipc::InvokeResponseBody::Raw(batch)).is_ok() {
            pipeline.note_bytes_sent(len);
            // S9 live-failure investigation: only counts SUCCESSFULLY
            // sent batches — mirrors pipeline.note_bytes_sent's own
            // gating on the exact same `channel.send(...).is_ok()`
            // check, immediately above.
            session_log.note_batch_sent(len);
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
        // F6: DeviceChanged joins this arm (not the no-message one
        // below) — its only source is a deferred `type:"error"` record
        // (error_record_kind), same shape as the two it's now grouped
        // with, and its message is the one actionable thing the user
        // actually needs to see.
        StatusKind::PermissionDenied | StatusKind::Unsupported | StatusKind::DeviceChanged => last_error.map(|(_, msg)| msg.clone()),
        StatusKind::Crashed => Some(match last_error {
            Some((code_str, msg)) => format!("{code_str}: {msg}"),
            None => format!("helper exited unexpectedly (code {code:?})"),
        }),
        StatusKind::Ended | StatusKind::Starting | StatusKind::Capturing | StatusKind::ExcludePidInactive => None,
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
///
/// F13 (adversarial-review fix round): also skips entirely — logged,
/// never silent — if AudiocapState already shows a live/reserved
/// session at the moment this is called. lib.rs calls this from
/// `.setup()`, strictly before the webview/JS layer could ever have
/// reached `start_app_audio` (Tauri commands aren't dispatchable until
/// setup returns and the app finishes initializing), so
/// `any_session_active()` can't actually be true here in practice
/// today — this closes the race defensively anyway, against a FUTURE
/// change to that ordering (e.g. a dev/spike hook, or a refactor that
/// calls this from somewhere less strictly "before a start is
/// possible"). The sweep's own enumerate+destroy pass (OrphanSweep.swift)
/// has no way to distinguish an old orphan from a session's own
/// just-created aggregate device — both carry the exact same UID prefix
/// — so it must never run concurrently with a session that might be
/// creating or already holding one.
pub fn sweep_orphans_best_effort(app: &tauri::AppHandle) {
    if !is_macos_version_supported(macos_version()) {
        return;
    }
    if app.state::<AudiocapState>().any_session_active() {
        emit_uv_log(
            app,
            "stderr",
            "[audiocap] orphan sweep: skipped — a session is already active (startup race guard)".to_string(),
        );
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
        let line = r#"{"type":"stats","overflows":0,"ringHighWater":1024,"framesOut":48000,"droppedFrames":0}"#;
        assert_eq!(
            parse_audiocap_line(line),
            ParsedAudiocapLine::Stats {
                overflows: 0,
                ring_high_water: 1024,
                frames_out: 48_000,
                dropped_frames: 0,
            }
        );
    }

    #[test]
    fn parses_a_stats_line_with_a_nonzero_dropped_frames_count() {
        // F5 (adversarial-review fix round): distinct from `overflows`
        // (rejected-callback count) — this is the actual audio frame
        // count SPSCByteRing.droppedFrameCount() reports.
        let line = r#"{"type":"stats","overflows":2,"ringHighWater":2048,"framesOut":96000,"droppedFrames":37}"#;
        assert_eq!(
            parse_audiocap_line(line),
            ParsedAudiocapLine::Stats {
                overflows: 2,
                ring_high_water: 2048,
                frames_out: 96_000,
                dropped_frames: 37,
            }
        );
    }

    #[test]
    fn a_stats_line_missing_dropped_frames_is_unrecognized_not_defaulted() {
        // Same closed-wire-contract posture as the other three stats
        // fields (see garbage_and_malformed_lines_are_unrecognized_not_a_panic's
        // own "stats missing fields" case) — Rust and Swift are built
        // and shipped together, so a stats line missing a field this
        // parser expects means something is actually wrong, not a
        // version skew to silently paper over with a 0 default.
        let line = r#"{"type":"stats","overflows":0,"ringHighWater":1024,"framesOut":48000}"#;
        assert_eq!(parse_audiocap_line(line), ParsedAudiocapLine::Unrecognized);
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
    fn error_record_kind_maps_only_the_three_codes_the_wire_contract_has_a_kind_for() {
        assert_eq!(error_record_kind("permission-denied"), Some(StatusKind::PermissionDenied));
        assert_eq!(error_record_kind("unsupported-os"), Some(StatusKind::Unsupported));
        // F6 (adversarial-review fix round): jargonslayer-audiocap's own
        // IO-starvation dead-man switch (Writer.StopReason.starved)
        // emits this as a typed `type:"error"` record (AudioCapError
        // .deviceChanged), same deferred-to-exit shape as the two above.
        assert_eq!(error_record_kind("device-changed"), Some(StatusKind::DeviceChanged));
        for code in ["pid-translate-failed", "tap-create-failed", "aggregate-create-failed", "device-start-failed"] {
            assert_eq!(error_record_kind(code), None, "{code} has no dedicated kind — falls through to crashed at exit");
        }
    }

    #[test]
    fn exit_status_kind_maps_clean_exit_to_ended_when_eos_was_seen() {
        assert_eq!(exit_status_kind(Some(0), None, true), StatusKind::Ended);
        assert_eq!(exit_status_kind(Some(0), Some("permission-denied"), true), StatusKind::Ended);
    }

    #[test]
    fn exit_status_kind_maps_clean_exit_without_eos_to_crashed() {
        // F8 (adversarial-review fix round): a clean exit-0 that never
        // produced a terminal EOS record is a truncated stream, not a
        // normal end — the wire contract's own literal rule was always
        // "clean EOS/exit-0", not exit-0 alone.
        assert_eq!(exit_status_kind(Some(0), None, false), StatusKind::Crashed);
    }

    #[test]
    fn exit_status_kind_maps_a_nonzero_exit_with_a_mapped_error_to_that_kind() {
        // eos_seen is irrelevant once code != Some(0) — picked false
        // here specifically to demonstrate that (a nonzero exit is never
        // "upgraded" to Ended just because EOS happened to be seen).
        assert_eq!(exit_status_kind(Some(1), Some("permission-denied"), false), StatusKind::PermissionDenied);
        assert_eq!(exit_status_kind(Some(1), Some("unsupported-os"), false), StatusKind::Unsupported);
    }

    #[test]
    fn exit_status_kind_maps_a_nonzero_exit_with_no_or_an_unmapped_error_to_crashed() {
        assert_eq!(exit_status_kind(Some(1), None, false), StatusKind::Crashed);
        assert_eq!(exit_status_kind(None, None, false), StatusKind::Crashed);
        assert_eq!(exit_status_kind(Some(1), Some("device-start-failed"), false), StatusKind::Crashed);
    }

    #[test]
    fn final_kind_reports_ended_for_any_requested_stop_even_a_forced_one() {
        // A stop that had to escalate to SIGKILL (code=None, killed by
        // signal) is still an ENDED session from the user's point of
        // view, not a crash — the refinement final_kind layers on top
        // of exit_status_kind's own literal exit-code table, applied
        // whenever stop_app_audio (or supersession) already took the
        // child before the process actually exited. eos_seen=false in
        // both cases here — F8: a forced kill has no obligation to have
        // reached its own normal EOS-writing teardown either, and this
        // short-circuit must stay unconditional on that.
        assert_eq!(final_kind(None, None, true, false), StatusKind::Ended);
        assert_eq!(final_kind(Some(1), Some("device-start-failed"), true, false), StatusKind::Ended);
    }

    #[test]
    fn final_kind_falls_back_to_exit_status_kind_when_no_stop_was_requested() {
        assert_eq!(final_kind(Some(0), None, false, true), StatusKind::Ended);
        assert_eq!(final_kind(Some(1), Some("permission-denied"), false, false), StatusKind::PermissionDenied);
        assert_eq!(final_kind(Some(1), None, false, false), StatusKind::Crashed);
    }

    #[test]
    fn final_kind_falls_back_to_crashed_for_a_spontaneous_clean_exit_that_never_saw_eos() {
        // F8: NOT a requested stop, exit code 0, but EOS never arrived —
        // a truncated stream must never read as a normal Ended session
        // just because the process happened to exit 0.
        assert_eq!(final_kind(Some(0), None, false, false), StatusKind::Crashed);
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
    fn final_message_uses_the_last_errors_message_for_device_changed_too() {
        // F6: the actionable Chinese message (main.swift's own
        // AudioCapError.deviceChanged literal) must reach the FINAL
        // status event, not just the (also-emitted, via
        // error_record_kind's own deferred-to-exit design) intermediate
        // one — a message-less duplicate at exit would blank out the
        // one piece of text that actually tells the user what to do.
        let err = ("device-changed".to_string(), "音频设备停止供给（设备切换或系统休眠）— 请重新开始转录".to_string());
        assert_eq!(
            final_message(StatusKind::DeviceChanged, Some(1), Some(&err)),
            Some("音频设备停止供给（设备切换或系统休眠）— 请重新开始转录".to_string())
        );
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

    // ---- F13 (adversarial-review fix round): orphan-sweep-vs-live-
    // session race guard ----

    #[test]
    fn any_session_active_is_false_when_nothing_is_running() {
        let state = AudiocapState::default();
        assert!(!state.any_session_active());
    }

    #[test]
    fn any_session_active_is_true_once_try_begin_has_reserved_the_slot() {
        // "Active" starts at try_begin (Starting), not attach_child
        // (Running) — sweep_orphans_best_effort's own race is exactly
        // about the window BEFORE a child (and its aggregate device)
        // ever attaches.
        let state = AudiocapState::default();
        state.try_begin().unwrap();
        assert!(state.any_session_active());
    }

    #[test]
    fn any_session_active_is_false_again_after_finish() {
        let state = AudiocapState::default();
        let generation = state.try_begin().unwrap();
        state.finish(generation);
        assert!(!state.any_session_active());
    }

    // ---- F1: stop lost during the spawn window (adversarial-review
    // fix round) — `attach_child` cannot be unit-tested directly
    // (CommandChild has no test-reachable constructor), so these pin
    // `is_attachable`/`should_attach_child`, the pure decision that
    // fully determines what `attach_child` does with a real one. ----

    #[test]
    fn should_attach_child_is_true_when_no_stop_was_requested_during_starting() {
        let state = AudiocapState::default();
        let generation = state.try_begin().unwrap();
        assert!(state.should_attach_child(generation));
    }

    #[test]
    fn should_attach_child_is_false_when_nothing_is_reserved() {
        let state = AudiocapState::default();
        assert!(!state.should_attach_child(1));
    }

    #[test]
    fn should_attach_child_is_false_for_a_generation_that_is_no_longer_the_occupant() {
        let state = AudiocapState::default();
        let first = state.try_begin().unwrap();
        state.finish(first);
        state.try_begin().unwrap(); // a second session now occupies the slot
        assert!(!state.should_attach_child(first));
    }

    #[test]
    fn f1_stop_during_the_starting_window_blocks_a_later_attach() {
        // The exact race F1 fixes: try_begin (Starting, no child yet) ->
        // stop lands before the spawn's CommandChild could ever be
        // attached. Pre-fix, take_child_for_stop just returns None
        // (idempotent "nothing to do") and leaves NOTHING behind that a
        // later attach_child could ever consult — the just-spawned child
        // would be attached and left running, unstoppable. This is RED
        // against the version of `is_attachable` that only checks
        // `generation` (mirrors the pre-fix `attach_child`, which
        // attached unconditionally once the generation matched).
        let state = AudiocapState::default();
        let generation = state.try_begin().unwrap();
        assert!(
            state.take_child_for_stop().unwrap().is_none(),
            "stop reports idempotent success even though nothing has actually stopped yet"
        );
        assert!(
            !state.should_attach_child(generation),
            "F1: a stop recorded during Starting must block a later attach_child — \
             never silently start a session the caller was already told had stopped"
        );
    }

    #[test]
    fn f1_finish_after_a_cancel_during_starting_reports_a_requested_stop_never_a_crash() {
        // Closes the loop with exit_status_kind/final_kind's own tests
        // above: once should_attach_child has refused the attach (this
        // test's sibling above), the session must still resolve as a
        // normal, requested "ended" outcome when its (torn-down) child
        // eventually reports Terminated — never "crashed", and never a
        // session AudiocapState still thinks is running.
        let state = AudiocapState::default();
        let generation = state.try_begin().unwrap();
        assert!(state.take_child_for_stop().unwrap().is_none());
        assert!(!state.should_attach_child(generation));

        let outcome = state.finish(generation);
        assert!(outcome.was_current);
        assert!(
            outcome.stop_was_requested,
            "F1: a cancellation recorded during Starting must still finish as a requested stop"
        );
        assert_eq!(
            // eos_seen=false: this generation's child was torn down
            // before it ever attached — EOS was never a possibility —
            // and F8's own final_kind contract keeps stop_was_requested
            // unconditional on eos_seen for exactly this reason.
            final_kind(None, None, outcome.stop_was_requested, false),
            StatusKind::Ended,
            "F1: the end-to-end outcome must be Ended, never a phantom running/crashed session"
        );
    }

    // ---- S9 live-failure investigation: always-on session log — pure
    // parts only. `SessionLog` itself needs a real `tauri::AppHandle` to
    // resolve `app_log_dir()`, so it isn't unit-testable directly (same
    // posture as the rest of this file's tauri-coupled glue); this pins
    // the one piece of it that IS pure. ----

    #[test]
    fn batch_forwarding_log_line_fires_for_the_first_batch_with_its_own_byte_length_only() {
        assert_eq!(
            batch_forwarding_log_line(1, 4096, 4096),
            Some("channel-forwarding first batch: bytes=4096".to_string())
        );
    }

    #[test]
    fn batch_forwarding_log_line_fires_every_64th_batch_with_cumulative_totals() {
        assert_eq!(
            batch_forwarding_log_line(64, 4096, 64 * 4096),
            Some("channel-forwarding progress: batches=64 bytes=262144".to_string())
        );
        assert_eq!(
            batch_forwarding_log_line(128, 4096, 128 * 4096),
            Some("channel-forwarding progress: batches=128 bytes=524288".to_string())
        );
    }

    #[test]
    fn batch_forwarding_log_line_is_none_for_every_non_milestone_batch() {
        assert_eq!(batch_forwarding_log_line(2, 100, 200), None);
        assert_eq!(batch_forwarding_log_line(63, 100, 6300), None);
        assert_eq!(batch_forwarding_log_line(65, 100, 6500), None);
        assert_eq!(
            batch_forwarding_log_line(0, 100, 0),
            None,
            "batch_number is documented 1-based — 0 % 64 == 0 must not falsely match"
        );
    }

    #[test]
    fn batch_forwarding_log_line_never_double_logs_batch_one_as_also_a_64th_milestone() {
        // batch_number == 1 takes the FIRST branch only, never both —
        // trivially true for u64 (1 % 64 != 0) but pinned explicitly
        // since SessionLog::note_batch_sent relies on "at most one line
        // per batch".
        assert!(batch_forwarding_log_line(1, 10, 10).unwrap().starts_with("channel-forwarding first batch"));
    }
}
