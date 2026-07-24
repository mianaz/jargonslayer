// S3 chunk 3 (blueprint §Chunk 3) — the long-lived whisper_server.py
// sidecar's lifecycle: prewarm (model download/load, its own decoupled
// step per architecture decision 4 — "load-before-bind" means the model
// loads BEFORE :8765/:8766 bind, so downloading during start_server would
// hide behind a server that never answers /health) and start/stop of the
// actual server process. Both prewarm_model and start_server spawn the
// SAME execution tool (architecture decision 3): the venv's own python,
// never a bare `python` off $PATH.
//
// S4 chunk 2 (docs/design-explorations/s4-model-wizard-blueprint.md,
// decision B's first-run one-shot path) — prewarm_model no longer runs a
// bare `-c "WhisperModel(...)"` script: it spawns whisper_server.py's own
// `--download-only` mode (chunk 1's run_download_only), which prints
// newline-delimited JSON progress lines to stdout
// ({"type":"download_progress","downloaded":N,"total":M}, throttled to
// ~500ms-or-whole-percent — see should_emit_download_progress) then a
// final download_done/download_error line, exit 0/1. classify_download_
// line below is the pure parser for those lines; every line — parsed or
// not — keeps flowing to uv://log exactly as before (run_venv_python_
// streaming's on_stdout_line callback ADDS the classification, it never
// replaces the log forwarding), so the wizard's 详细日志 pane is
// unaffected. A download_progress line additionally emits a
// prewarm://progress Tauri event; a download_error line is captured and,
// if the process then exits non-zero, becomes this command's own Err (a
// specific message) instead of the generic "exited with code N" a bare
// non-zero/null exit still falls back to when no such line was ever seen.
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::mlxcaps;
use crate::paths::{resolve_app_paths, AppPaths};
use crate::uv::{emit_uv_log, ProcessResult};

/// Whisper model sizes sidecar/whisper_server.py's own `--model` argparse
/// choices accept (parse_args' `choices=[...]`), plus S12a §C's own
/// Parakeet-v3 model id (`parakeet-tdt-0.6b-v3` — Q1: "a MODEL under
/// `whisper`, not a new engine kind") — kept in lock-step with that
/// list, not the full faster-whisper/parakeet-mlx model zoo.
const ALLOWED_MODELS: [&str; 7] = [
    "tiny",
    "base",
    "small",
    "medium",
    "large-v3",
    "large-v3-turbo",
    "parakeet-tdt-0.6b-v3",
];

pub fn validate_model(model: &str) -> Result<(), String> {
    if ALLOWED_MODELS.contains(&model) {
        Ok(())
    } else {
        Err(format!(
            "'{model}' is not a supported Whisper model (must be one of {ALLOWED_MODELS:?})"
        ))
    }
}

/// S12a §C R1 — `parakeet-*` model ids run under the separate, hash-
/// locked MLX venv; everything else (the faster-whisper family) runs
/// under the base venv. A simple prefix match rather than an exact
/// `ALLOWED_MODELS` lookup: there is currently exactly one parakeet
/// model id, but the prefix is what §C's own wire contract keys off
/// (`backend_for_model`, sidecar-side) — kept in the same shape here so
/// a future second parakeet size needs no Rust change.
fn is_parakeet_model(model: &str) -> bool {
    model.starts_with("parakeet-")
}

/// §C R1 — "`venv_for_model(model)` — base venv python for whisper-
/// family models, mlx venv python for `parakeet-*` — driving BOTH the
/// model-download/prewarm spawn and the server spawn." The one place
/// that decides which venv's python executes a given model; both
/// prewarm_model and start_server call this instead of hardcoding
/// `paths.venv_python`.
fn venv_for_model<'a>(paths: &'a AppPaths, model: &str) -> &'a Path {
    if is_parakeet_model(model) {
        &paths.mlx_venv_python
    } else {
        &paths.venv_python
    }
}

/// S12a §C Q6/§3.5 — the exact env additions every model-download/server
/// spawn gets, on top of whatever else that spawn already sets: HF_HOME
/// stays EXACTLY as today (the caller still sets it separately — this fn
/// deliberately does NOT touch it, so it can never introduce a second,
/// conflicting cache root); HF_TOKEN only when a non-EMPTY-AFTER-TRIM
/// token is configured (Settings.hfToken, threaded the same way
/// diarization's token already flows to the sidecar's own `--hf-token`/
/// `$HF_TOKEN` fallback, `whisper_server.py:2519-2520` — Q6);
/// HF_HUB_DISABLE_TELEMETRY=1 always (the "no new telemetry" invariant,
/// blueprint §1 non-goal e). Shared by prewarm_model (the first-run/
/// download spawn) and start_server (the long-lived sidecar spawn) so
/// the two spawns can never disagree on how a configured token reaches
/// HF's resolver.
///
/// F8 (S12a fix round, §D): trims the token and treats a whitespace-
/// only value as absent — the pre-fix `!token.is_empty()` check let
/// "   " through, setting `HF_TOKEN="   "`, which Python's own
/// `bool("   ")` reads as truthy (diar falsely armed even with no real
/// token configured). Trimming BEFORE setting the env var (not just
/// before the emptiness check) also keeps this Rust-side value in sync
/// with A4's own Python-side normalization for any direct/stale caller
/// that bypasses Rust entirely.
fn hf_extra_env(hf_token: &Option<String>) -> Vec<(String, String)> {
    let mut env = vec![("HF_HUB_DISABLE_TELEMETRY".to_string(), "1".to_string())];
    if let Some(token) = hf_token {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            env.push(("HF_TOKEN".to_string(), trimmed.to_string()));
        }
    }
    env
}

/// S13 hotfix (v0.4.4 field report: "huge python RAM usage even after
/// transcription finished" — see whisper_server.py's own "S13 hotfix"
/// module-section doc comment, above its `LazyWhisperModel`, for the
/// full field-bug/fix rationale) — the argv addition for that file's
/// own opt-in `--lazy-load` flag: present (a single `"--lazy-load"`
/// element) only when `lazy_load` is explicitly `Some(true)`; `None`
/// (every start_server caller before this hotfix, and performSwitchModel's
/// own direct call, which never threads this field at all — see
/// provisionRunner.ts's own RunnerDeps.readLazyLoad doc comment for why
/// that call stays eager unconditionally) or `Some(false)` both
/// produce an EMPTY Vec — the exact spawn argv this hotfix's own
/// "byte-identical when absent" requirement demands. A tiny pure fn
/// (mirrors hf_extra_env's own "extract as a pure, independently-unit-
/// testable helper" precedent immediately above) rather than inlining
/// the `if` at the call site, so this on/off argv shape is verified
/// directly (see this module's own #[cfg(test)] section) without
/// spawning a real process.
fn lazy_load_args(lazy_load: &Option<bool>) -> Vec<String> {
    if lazy_load.unwrap_or(false) {
        vec!["--lazy-load".to_string()]
    } else {
        Vec::new()
    }
}

/// §C F13/F14's "belt" — Rust `start_server` re-checks `mlx_capabilities`
/// before spawning a parakeet model (JS's own `provisionMachine`
/// marker-capability-check is the primary guard; this is defense in
/// depth against a stale/cross-machine-restored marker or preference
/// reaching `start_server` directly). Returns a distinctly-prefixed
/// error (never a bare `Err(reason)`) so a caller CAN pattern-match on
/// `MLX_UNSUPPORTED_ERROR_PREFIX` if it ever wants to, without this
/// command's error channel otherwise changing shape (still a plain
/// `Result<_, String>`, same as every other error this command already
/// returns).
const MLX_UNSUPPORTED_ERROR_PREFIX: &str = "mlx-unsupported: ";

fn check_mlx_capable_if_parakeet(model: &str) -> Result<(), String> {
    if !is_parakeet_model(model) {
        return Ok(());
    }
    let caps = mlxcaps::compute_mlx_capabilities();
    if caps.mlx_supported {
        return Ok(());
    }
    let reason = caps.reason.unwrap_or_else(|| "MLX unsupported on this machine".to_string());
    Err(format!("{MLX_UNSUPPORTED_ERROR_PREFIX}{reason}"))
}

/// Holds the spawned whisper_server.py child, if any is currently running
/// under this app's management. A held child means "started by us, still
/// (as far as we last checked) alive" — start_server, stop_server, the
/// exit-monitor thread, and the app's own RunEvent::Exit handler (lib.rs)
/// are the only four places that ever touch `server`. start_server holds
/// it for its entire check-spawn-store sequence (see that fn's own
/// comment); the other three only ever take it briefly.
///
/// Field-test issue 6 (cancellable first-run model downloads) — `prewarm`
/// is a SEPARATE slot for prewarm_model's own download child (a totally
/// different process from the long-lived sidecar `server` holds: one-shot
/// `--download-only`, not the persistent server). Registered by
/// run_venv_python_streaming right after spawn, polled (never a blocking
/// wait() while holding this lock — see EXIT_POLL_INTERVAL's own
/// spawn_exit_monitor precedent below) until it exits on its own, and
/// cleared by whichever side notices first: that same poll loop (natural
/// exit/crash) or cancel_prewarm (user-requested cancel — see that
/// command's own doc comment). Two independent Mutexes (not one Mutex
/// wrapping a small struct) so a start_server/stop_server call and a
/// concurrent prewarm poll/cancel never contend on the same lock at all.
#[derive(Default)]
pub struct ServerState {
    pub server: Mutex<Option<Child>>,
    pub prewarm: Mutex<Option<Child>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartServerResult {
    pub already_running: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerExitEvent {
    pub code: Option<i32>,
}

/// `prewarm://progress` event payload — emitted once per accepted
/// download_progress line (see classify_download_line and
/// should_emit_download_progress's own throttle in
/// sidecar/whisper_server.py). Field names are already camelCase
/// (single words), same as ServerExitEvent/StartServerResult above.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrewarmProgressEvent {
    pub downloaded: u64,
    pub total: u64,
    /// Field-test issue 6 — set (true) ONLY on the one terminal event
    /// prewarm_model emits when run_venv_python_streaming's own wait
    /// loop (below) observes cancel_prewarm having taken the child
    /// before it exited on its own; every ordinary download_progress-
    /// derived event carries `false`. A killed child's exit code is
    /// indistinguishable from a genuine crash (both are a bare
    /// None/null `ProcessResult.code`), so the JS side (bootstrap.ts)
    /// reads THIS field — not the exit code — to tell a deliberate
    /// cancel apart from a real failure.
    pub cancelled: bool,
}

fn poison_err<T>(_: std::sync::PoisonError<T>) -> String {
    "server state lock was poisoned by an earlier panic".to_string()
}

fn path_to_string(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

// ---- prewarm_model ----

/// The parsed shape of one stdout line from `whisper_server.py
/// --download-only` (sidecar/whisper_server.py's run_download_only/
/// should_emit_download_progress — newline-delimited JSON, throttled to
/// ~1 line/500ms-or-whole-percent-change). `Other` covers every line
/// that ISN'T one of the three known shapes: not valid JSON at all (a
/// Python traceback line, a blank line, ...), valid JSON with an
/// unrecognized/missing "type", or a truncated/partial JSON object (a
/// line split mid-write) — classify_download_line never panics on any
/// of these, it just falls back to Other. See classify_download_line's
/// own #[cfg(test)] cases below.
#[derive(Debug, Clone, PartialEq)]
enum DownloadLine {
    Progress { downloaded: u64, total: u64 },
    Done,
    Error { message: String },
    Other,
}

/// Wire shape, internally tagged on "type" — exactly what
/// run_download_only prints (`json.dumps({"type": "download_progress",
/// "downloaded": N, "total": M})`, etc.). Private/wire-only:
/// classify_download_line is the only thing that ever sees this,
/// converting to the richer DownloadLine enum above.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum RawDownloadLine {
    #[serde(rename = "download_progress")]
    Progress { downloaded: u64, total: u64 },
    #[serde(rename = "download_done")]
    Done,
    #[serde(rename = "download_error")]
    Error { message: String },
}

/// Pure line classifier — no I/O, no process spawn. Rust tests exercise
/// this directly (never a real whisper_server.py child — see this
/// module's own #[cfg(test)] block); prewarm_model below is the only
/// caller in production, applying it to every stdout line ALONGSIDE
/// (never instead of) the unconditional uv://log forwarding every
/// prewarm_model line has always gotten (see run_venv_python_streaming).
fn classify_download_line(line: &str) -> DownloadLine {
    match serde_json::from_str::<RawDownloadLine>(line) {
        Ok(RawDownloadLine::Progress { downloaded, total }) => DownloadLine::Progress { downloaded, total },
        Ok(RawDownloadLine::Done) => DownloadLine::Done,
        Ok(RawDownloadLine::Error { message }) => DownloadLine::Error { message },
        Err(_) => DownloadLine::Other,
    }
}

#[tauri::command]
pub async fn prewarm_model(
    app: tauri::AppHandle,
    model: String,
    hf_token: Option<String>,
) -> Result<ProcessResult, String> {
    validate_model(&model)?;
    // F5b (S12a fix round, §D): the same INSTALL-time capability belt
    // start_server already has (F13/F14) — reuse check_mlx_capable_if_
    // parakeet verbatim so a compromised/buggy caller can't kick off a
    // multi-GB parakeet download on an unsupported platform just because
    // it called prewarm_model instead of start_server. A no-op for every
    // non-parakeet model (see that fn's own doc comment + its existing
    // tests for the pass-through/rejection coverage this reuse rides on).
    check_mlx_capable_if_parakeet(&model)?;
    let paths = resolve_app_paths(&app)?;

    std::fs::create_dir_all(&paths.models_dir)
        .map_err(|e| format!("failed to create {}: {e}", paths.models_dir.display()))?;

    // Decision B (s4-model-wizard-blueprint.md) — first-run is a Rust
    // one-shot spawn of whisper_server.py's own --download-only mode
    // (chunk 1's run_download_only), not a bare `-c "WhisperModel(...)"`
    // script: the sidecar module already owns the real download logic
    // (disk precheck, resumable snapshot_download, progress accounting
    // via download_model_snapshot) and is the SAME helper the :8766
    // model-switch job (chunk 1's JobManager.start_download_job) reuses
    // — "one shared helper, only invocation + progress transport
    // differ." Bonus (per the blueprint): no longer instantiates+
    // discards a CT2 model, pure download.
    // §C R1 — resolved BEFORE `model` moves into `args` below: the base
    // venv for whisper-family models, the separate mlx venv for
    // `parakeet-*` (see venv_for_model's own doc comment).
    let venv_python = venv_for_model(&paths, &model).to_path_buf();
    let args = vec![
        path_to_string(&paths.script_path),
        "--model".to_string(),
        model,
        "--download-only".to_string(),
    ];
    // HF_HOME unchanged (existing) + Q6's HF_TOKEN-when-configured/
    // HF_HUB_DISABLE_TELEMETRY=1-always additions (hf_extra_env's own
    // doc comment).
    let mut extra_env = vec![("HF_HOME".to_string(), path_to_string(&paths.models_dir))];
    extra_env.extend(hf_extra_env(&hf_token));
    let app_for_blocking = app.clone();

    // Captures the download_error line's message (if any) seen on
    // stdout while the child runs, read back once spawn_blocking below
    // settles. A Mutex, not a plain Cell: the per-line classification
    // runs on spawn_streamed's own stdout reader thread (see
    // run_venv_python_streaming) — a DIFFERENT thread than the one that
    // reads it back here.
    let download_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let download_error_for_lines = download_error.clone();
    let app_for_progress = app.clone();

    // Blocking model download/load lives on its own std::process::Child
    // wait() — spawn_blocking so this async command's own await never
    // ties up the async runtime for however long the (possibly multi-GB,
    // first-run) download takes; see architecture decision 4 / risk
    // register item 6 (load-before-bind).
    let (code, cancelled) = tauri::async_runtime::spawn_blocking(move || {
        run_venv_python_streaming(&app_for_blocking, &venv_python, &args, &extra_env, move |line| {
            // ADDS to the unconditional uv://log forwarding every line
            // already gets (run_venv_python_streaming calls emit_uv_log
            // itself, before this closure ever runs) — never replaces
            // it, so the wizard's 详细日志 pane keeps showing the raw
            // --download-only output exactly like every other
            // provisioning step.
            match classify_download_line(line) {
                DownloadLine::Progress { downloaded, total } => {
                    let _ = app_for_progress.emit(
                        "prewarm://progress",
                        PrewarmProgressEvent { downloaded, total, cancelled: false },
                    );
                }
                DownloadLine::Error { message } => {
                    if let Ok(mut guard) = download_error_for_lines.lock() {
                        *guard = Some(message);
                    }
                }
                DownloadLine::Done | DownloadLine::Other => {}
            }
        })
    })
    .await
    .map_err(|e| format!("prewarm task panicked: {e}"))??;

    // Field-test issue 6 (cancellable first-run model downloads) —
    // cancel_prewarm's own kill (see that command's own doc comment):
    // reported via a terminal prewarm://progress `cancelled: true`
    // marker rather than falling into the download_error-line Err path
    // below, so the JS side (bootstrap.ts) can tell "the user cancelled
    // this" apart from a genuine crash — a bare null/None exit code
    // alone can't distinguish the two (see PrewarmProgressEvent's own
    // doc comment). `code` itself is whatever run_venv_python_streaming's
    // own poll loop last observed (usually None, since a killed child is
    // rarely reaped with a clean exit code) — irrelevant here, since the
    // cancelled marker is the authoritative signal, not this Ok's code.
    if cancelled {
        let _ = app.emit(
            "prewarm://progress",
            PrewarmProgressEvent { downloaded: 0, total: 0, cancelled: true },
        );
        return Ok(ProcessResult { code });
    }

    // A download_error line -> this command's own Err carrying that
    // specific message (e.g. a disk-full/offline zh error raised by
    // download_model_snapshot), rather than the generic "exited with
    // code N" processResultToEvent (provisionRunner.ts) would otherwise
    // synthesize from a bare non-zero ProcessResult. A non-zero/null
    // exit with NO download_error line ever seen (a crash outside
    // run_download_only's own try/except, a killed process, ...) keeps
    // today's generic path unchanged.
    if code != Some(0) {
        let message = download_error.lock().map_err(poison_err)?.clone();
        if let Some(message) = message {
            return Err(message);
        }
    }

    Ok(ProcessResult { code })
}

/// One poll iteration's outcome against the shared ServerState.prewarm
/// slot — see run_venv_python_streaming's own wait loop below, the only
/// caller. Factored out purely for direct testability: std::process::
/// Child can't be faked (it isn't a trait, unlike this codebase's usual
/// "shape-only" spawn tests — see build_import_preflight_command's own
/// doc comment, uv.rs), so this module's own #[cfg(test)] section
/// exercises it against REAL short-lived child processes instead — the
/// one deliberate exception to that convention.
#[derive(Debug, PartialEq, Eq)]
enum PollOutcome {
    StillRunning,
    Exited(Option<i32>),
    /// The slot was already empty — cancel_prewarm's own take() (see
    /// that command's own doc comment) won the race and is killing/
    /// reaping the child on its own thread; nothing left here to poll.
    Cancelled,
}

fn poll_prewarm_slot(guard: &mut Option<Child>) -> PollOutcome {
    match guard.as_mut() {
        None => PollOutcome::Cancelled,
        Some(child) => match child.try_wait() {
            Ok(None) => PollOutcome::StillRunning,
            Ok(Some(status)) => {
                *guard = None;
                PollOutcome::Exited(status.code())
            }
            Err(_) => {
                // Vanishingly rare (see std::process::Child::try_wait's
                // own docs) and unrelated to cancellation — treated like
                // an ordinary crash-with-unknown-exit-code, same as
                // spawn_exit_monitor's identical Err(_) branch below.
                //
                // F5 (review-round fix, Sol LOW #18): previously just
                // cleared the slot here, dropping the Child (still
                // possibly alive — try_wait's own Err says nothing about
                // whether the process actually exited) without ever
                // killing it. `guard.take()` + a best-effort kill_and_reap
                // mirrors every OTHER slot-clearing path in this module
                // (stop_server/cancel_prewarm_impl's own take-then-kill
                // shape) instead of silently leaking the process. NOT the
                // mutex-poison case: a poisoned ServerState.prewarm lock
                // fails at this fn's only caller's own `.lock()` call,
                // before poll_prewarm_slot is ever reached — this branch
                // is purely a try_wait() OS-level failure.
                if let Some(child) = guard.take() {
                    kill_and_reap(child);
                }
                PollOutcome::Exited(None)
            }
        },
    }
}

/// Registers `child` as the new ServerState.prewarm slot occupant,
/// first taking + kill_and_reap-ing whatever child (if any) was
/// ALREADY there. Returns whether a stale child was found (so the
/// caller — run_venv_python_streaming, the only one, which DOES hold a
/// real tauri::AppHandle — can log it).
///
/// F1 (review-round fix, Sol HIGH #2): a second prewarm reaching
/// registration while an EARLIER prewarm's child is still in the slot
/// (reachable: a backgrounded download's own poll loop gets superseded
/// by reprovision/requestProvisionCheck WITHOUT ever cancelling Rust,
/// then beginProvision spawns again) must not silently overwrite it via
/// a bare `*guard = Some(child)` — that orphans the first, possibly
/// multi-GB, child (never killed, never reaped) AND cross-wires the two
/// poll loops: the orphaned loop can observe the slot as emptied-then-
/// refilled and read that back as PollOutcome::Cancelled (see that enum
/// above), a false cancel marker contaminating the NEW drive it has
/// nothing to do with. Taking the stale child, dropping the lock, THEN
/// kill_and_reap-ing it — never holding the lock across the kill —
/// mirrors cancel_prewarm_impl's own take-then-kill shape exactly, so
/// slot ownership stays exclusive regardless of what the JS side does.
///
/// Split out of run_venv_python_streaming purely for testability
/// (mirrors cancel_prewarm/cancel_prewarm_impl's own #[tauri::command]-
/// wrapper split immediately below): takes `&ServerState` directly
/// rather than requiring a live tauri::AppHandle, so this module's own
/// #[cfg(test)] section can drive two sequential registrations against
/// REAL short-lived child processes without any tauri app-context
/// scaffolding (this crate's tests never construct a tauri::AppHandle —
/// see poll_prewarm_slot's own doc comment for why Child itself already
/// forces an exception to the usual shape-only convention here).
fn register_prewarm_child(state: &ServerState, child: Child) -> Result<bool, String> {
    let stale_child = {
        let mut guard = state.prewarm.lock().map_err(poison_err)?;
        guard.take()
    };
    let had_stale_child = stale_child.is_some();
    if let Some(stale_child) = stale_child {
        kill_and_reap(stale_child);
    }
    let mut guard = state.prewarm.lock().map_err(poison_err)?;
    *guard = Some(child);
    Ok(had_stale_child)
}

/// Runs `program args…` to completion with the given extra env vars,
/// streaming stdout/stderr lines to `uv://log` (reusing run_uv's event —
/// see uv::emit_uv_log) tagged "stdout"/"stderr", and additionally
/// invoking `on_stdout_line` with every RAW stdout line as it arrives —
/// ALONGSIDE the unconditional emit_uv_log call, never instead of it
/// (prewarm_model's own download-progress classification is the one
/// caller that needs this; a no-op closure costs nothing for any other
/// call shape). Blocking — callers on the async runtime must wrap this
/// in spawn_blocking (see prewarm_model above).
///
/// Field-test issue 6 (cancellable first-run model downloads): the
/// spawned child is registered in `app`'s own ServerState.prewarm slot
/// immediately after spawn (via register_prewarm_child, which also
/// closes the F1 second-prewarm race — see that fn's own doc comment —
/// so cancel_prewarm can kill it — see that command's own doc comment)
/// and then POLLED (never a blocking child.wait()) to completion — a
/// blocking wait would have to hold state.prewarm's lock for the
/// entire download, deadlocking cancel_prewarm's own attempt to take()
/// it. Mirrors spawn_exit_
/// monitor's identical try_wait()-between-sleeps shape (EXIT_POLL_
/// INTERVAL) for the long-lived server child further below. Returns
/// (exit_code, cancelled) — see PollOutcome/poll_prewarm_slot above;
/// `cancelled` is what lets prewarm_model tell a deliberate cancel apart
/// from a genuine crash (both otherwise look like a bare None exit code).
fn run_venv_python_streaming(
    app: &tauri::AppHandle,
    program: &std::path::Path,
    args: &[String],
    extra_env: &[(String, String)],
    on_stdout_line: impl Fn(&str) + Send + 'static,
) -> Result<(Option<i32>, bool), String> {
    let mut cmd = StdCommand::new(program);
    cmd.args(args)
        .envs(extra_env.iter().map(|(k, v)| (k.as_str(), v.as_str())));

    let app_out = app.clone();
    let app_err = app.clone();
    let (child, out_handle, err_handle) = spawn_streamed(
        cmd,
        move |line| {
            emit_uv_log(&app_out, "stdout", line);
            on_stdout_line(line);
        },
        move |line| emit_uv_log(&app_err, "stderr", line),
    )
    .map_err(|e| {
        // Emitted as a uv://log line too — a spawn failure produces zero
        // subprocess output, and this stream is the wizard 详细日志
        // pane's only feed (same rationale as run_uv's own two failure
        // paths, uv.rs).
        let message = format!("failed to spawn {}: {e}", program.display());
        emit_uv_log(app, "stderr", message.clone());
        message
    })?;

    let state = app.state::<ServerState>();
    // F1 (review-round fix, Sol HIGH #2): see register_prewarm_child's
    // own doc comment for the second-prewarm race this closes — the log
    // line lives here (not in that fn) purely because this call site is
    // the one holding a real tauri::AppHandle to emit it through.
    if register_prewarm_child(&state, child)? {
        emit_uv_log(
            app,
            "stderr",
            "prewarm: a previous prewarm child was still registered — killed it before starting this one",
        );
    }

    let (code, cancelled) = loop {
        let outcome = {
            let mut guard = state.prewarm.lock().map_err(poison_err)?;
            poll_prewarm_slot(&mut guard)
        };
        match outcome {
            PollOutcome::StillRunning => thread::sleep(EXIT_POLL_INTERVAL),
            PollOutcome::Exited(code) => break (code, false),
            PollOutcome::Cancelled => break (None, true),
        }
    };

    let _ = out_handle.join();
    let _ = err_handle.join();
    Ok((code, cancelled))
}

// ---- start_server / stop_server ----

#[tauri::command]
pub async fn start_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, ServerState>,
    model: String,
    hf_token: Option<String>,
    lazy_load: Option<bool>,
) -> Result<StartServerResult, String> {
    validate_model(&model)?;
    // §C F13/F14 belt: re-check mlx capabilities before ever spawning a
    // parakeet model (see check_mlx_capable_if_parakeet's own doc
    // comment) — a no-op for every non-parakeet model.
    check_mlx_capable_if_parakeet(&model)?;

    // Hold ONE lock across the entire check-spawn-store sequence below —
    // this is the fix for a double-spawn race the earlier "check, drop,
    // spawn, re-lock" shape had: two concurrent start_server calls could
    // both pass an is-it-running check taken before spawning, both spawn
    // whisper_server.py racing for ports 8765/8766, and a "kill whichever
    // call re-locked second" step at the end killed whichever call
    // happened to re-acquire the lock second — NOT whichever process
    // actually lost the port-bind race — so the port-holding child could
    // be the one killed while the address-in-use child (which then exits
    // on its own) was kept, leaving no server running even though both
    // invokes returned success.
    //
    // Holding the lock this long is safe/cheap because everything below
    // is synchronous std code with no `.await` in it: spawn_streamed's
    // cmd.spawn() is a quick fork/exec, and the only other lock holder
    // (spawn_exit_monitor's thread) only contends for this same mutex
    // once every EXIT_POLL_INTERVAL. If this section ever grows an
    // `.await` while `guard` is still alive, it will fail to compile — a
    // std MutexGuard held across an await point makes this async fn's
    // future non-Send, which tauri rejects for an async #[tauri::command]
    // — so the compiler enforces this invariant, not just this comment.
    let mut guard = state.server.lock().map_err(poison_err)?;
    if guard.is_some() {
        return Ok(StartServerResult {
            already_running: true,
        });
    }

    let paths = resolve_app_paths(&app)?;
    let log_dir = paths
        .log_path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", paths.log_path.display()))?;
    std::fs::create_dir_all(log_dir)
        .map_err(|e| format!("failed to create {}: {e}", log_dir.display()))?;

    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log_path)
        .map_err(|e| format!("failed to open {}: {e}", paths.log_path.display()))?;
    let log_file = Arc::new(Mutex::new(log_file));

    // §C R1 — resolved BEFORE `model` moves into `cmd.args` below: the
    // base venv for whisper-family models, the separate mlx venv for
    // `parakeet-*` (see venv_for_model's own doc comment).
    let venv_python = venv_for_model(&paths, &model).to_path_buf();
    let mut args = vec![
        path_to_string(&paths.script_path),
        "--model".to_string(),
        model,
        "--port".to_string(),
        "8765".to_string(),
        "--http-port".to_string(),
        "8766".to_string(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
    ];
    // S13 hotfix — see lazy_load_args's own doc comment. A no-op
    // (empty extend) for every pre-hotfix caller and for
    // performSwitchModel's own restart call (which never passes this
    // field at all): byte-identical argv to before this hotfix.
    args.extend(lazy_load_args(&lazy_load));

    let mut cmd = StdCommand::new(&venv_python);
    cmd.args(&args)
        .env("HF_HOME", &paths.models_dir)
        // Q6/§3.5 — HF_TOKEN-when-configured + HF_HUB_DISABLE_TELEMETRY=1-
        // always, same additions prewarm_model's own spawn gets (hf_extra_env's
        // own doc comment).
        .envs(hf_extra_env(&hf_token));

    let log_out = log_file.clone();
    let log_err = log_file.clone();
    let (child, _out_handle, _err_handle) = spawn_streamed(
        cmd,
        move |line| append_log_line(&log_out, "stdout", line),
        move |line| append_log_line(&log_err, "stderr", line),
    )
    .map_err(|e| format!("failed to spawn whisper_server.py: {e}"))?;

    // No second is-it-running check needed here: `guard` has been held,
    // uninterrupted, since before the first (and only) check above, so no
    // other start_server call could have stored a child in the meantime.
    *guard = Some(child);
    drop(guard);

    spawn_exit_monitor(app);

    Ok(StartServerResult {
        already_running: false,
    })
}

#[tauri::command]
pub fn stop_server(state: tauri::State<'_, ServerState>) -> Result<(), String> {
    let mut guard = state.server.lock().map_err(poison_err)?;
    if let Some(child) = guard.take() {
        drop(guard);
        kill_and_reap(child);
    }
    Ok(())
}

/// Field-test issue 6 (cancellable first-run model downloads) — the
/// wizard's own 「取消下载」 button and the task tray's cancel affordance
/// on a backgrounded prewarm row both call this. Mirrors stop_server's
/// exact take-then-kill_and_reap shape above, just targeting
/// ServerState.prewarm instead of .server — a plain kill is fine here
/// too (see kill_and_reap's own doc comment): partial download files
/// stay on disk and hf_hub resumes them on the next attempt. No-op
/// (Ok(())) when nothing is currently downloading — `guard.take()`
/// already gives that for free, same as stop_server's own no-op-when-
/// nothing-running contract.
///
/// Split into a thin #[tauri::command] wrapper + cancel_prewarm_impl
/// purely for testability: tauri::State<'_, T> has no public
/// constructor outside real command dispatch, so this module's own
/// #[cfg(test)] section calls cancel_prewarm_impl directly against a
/// bare ServerState instead.
#[tauri::command]
pub fn cancel_prewarm(state: tauri::State<'_, ServerState>) -> Result<(), String> {
    cancel_prewarm_impl(&state)
}

fn cancel_prewarm_impl(state: &ServerState) -> Result<(), String> {
    let mut guard = state.prewarm.lock().map_err(poison_err)?;
    if let Some(child) = guard.take() {
        drop(guard);
        kill_and_reap(child);
    }
    Ok(())
}

/// std::process::Child::kill() sends SIGKILL on Unix (TerminateProcess on
/// Windows) — there is no portable graceful-SIGTERM-then-grace-period on
/// stable std without pulling in an extra dependency (e.g. `nix`) purely
/// for this one call. Accepted as-is per the blueprint's own "std::process
/// ::Child::kill is SIGKILL — acceptable, note it" — flagged again in this
/// chunk's PR report as a deliberate deviation, not an oversight.
fn kill_and_reap(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Called from lib.rs's RunEvent::ExitRequested/Exit handler — best-
/// effort cleanup so a graceful app quit never leaves an orphaned
/// whisper_server.py behind. Force-quit is the one case this can't catch;
/// the blueprint's own accepted-for-v1 answer for that is self-heal via
/// adoption on next launch (risk register item 4), not attempted here.
///
/// ACCEPTED GAP (adversarial-review finding, kept as a documented
/// decision, not an oversight): "adoption on next launch" is a TS-side
/// concept (provisionMachine.ts's CHECKING -> HEALTHY probe path) — when
/// it fires, this app never spawned the process it just started treating
/// as its server, so there is no std::process::Child to put in
/// ServerState for it. An adopted process is therefore never HELD: this
/// function finds an empty slot and does nothing for it on a later
/// graceful quit, and spawn_exit_monitor (only ever started from a fresh
/// start_server spawn) never runs for it either, so no server://exit
/// fires if it dies either. Net effect: a whisper_server.py orphaned by a
/// force-quit and then adopted on the next launch survives every
/// SUBSEQUENT graceful quit too, until it's killed manually or the OS
/// reclaims it — v1 accepts this; real ownership of an adopted process
/// (e.g. a pidfile this app can re-attach a kill to) is v1.5 material.
pub fn kill_held_child_on_exit(app: &tauri::AppHandle) {
    let state = app.state::<ServerState>();
    // match + early return (not `if let Ok(...) = state.server.lock() {}`)
    // — the latter trips a known borrowck quirk where the Err arm's
    // PoisonError<MutexGuard> temporary is computed to outlive `state`.
    let mut guard = match state.server.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if let Some(child) = guard.take() {
        drop(guard);
        kill_and_reap(child);
    }

    // Field-test issue 6 — an in-flight first-run download is a SEPARATE
    // child (ServerState.prewarm, not .server) and gets the exact same
    // best-effort graceful-quit cleanup, or a `uv`/whisper_server.py
    // --download-only process would otherwise survive the app quitting
    // out from under it.
    let mut prewarm_guard = match state.prewarm.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if let Some(child) = prewarm_guard.take() {
        drop(prewarm_guard);
        kill_and_reap(child);
    }
}

const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Polls (never a blocking wait()) the held child until it exits or
/// stop_server()/the app's own exit handler empties the slot first. A
/// blocking child.wait() here would have to hold state.server's lock for
/// the server's entire lifetime, deadlocking stop_server's own attempt to
/// take() that same lock — try_wait() lets this thread release the lock
/// between polls instead.
fn spawn_exit_monitor(app: tauri::AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(EXIT_POLL_INTERVAL);
        let state = app.state::<ServerState>();
        let mut guard = match state.server.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        let Some(child) = guard.as_mut() else {
            // stop_server()/RunEvent::Exit already took it — this exit
            // (if any) was intentional, nothing to report.
            return;
        };
        match child.try_wait() {
            Ok(None) => continue,
            Ok(Some(status)) => {
                *guard = None;
                drop(guard);
                let _ = app.emit(
                    "server://exit",
                    ServerExitEvent {
                        code: status.code(),
                    },
                );
                return;
            }
            Err(_) => return,
        }
    });
}

// ---- shared std::process streaming helper ----

/// Spawns `cmd` with piped stdout/stderr and forwards each line (split on
/// \n, same "one line per callback" contract as tauri-plugin-shell's own
/// CommandEvent::Stdout/Stderr) to the given per-stream callback from two
/// dedicated reader threads. Returns the still-running Child (NOT waited
/// on) plus both reader threads' JoinHandles — callers decide how/whether
/// to wait (prewarm waits inline; start_server hands the Child to
/// ServerState and lets spawn_exit_monitor poll it instead).
fn spawn_streamed(
    mut cmd: StdCommand,
    on_stdout_line: impl Fn(&str) + Send + 'static,
    on_stderr_line: impl Fn(&str) + Send + 'static,
) -> std::io::Result<(Child, thread::JoinHandle<()>, thread::JoinHandle<()>)> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("stdout was configured as piped");
    let stderr = child.stderr.take().expect("stderr was configured as piped");

    let out_handle = thread::spawn(move || stream_lines(stdout, on_stdout_line));
    let err_handle = thread::spawn(move || stream_lines(stderr, on_stderr_line));

    Ok((child, out_handle, err_handle))
}

fn stream_lines<R: std::io::Read>(reader: R, on_line: impl Fn(&str)) {
    for line in BufReader::new(reader).lines() {
        match line {
            Ok(text) => on_line(&text),
            Err(_) => break,
        }
    }
}

fn append_log_line(file: &Arc<Mutex<std::fs::File>>, stream: &str, line: &str) {
    if let Ok(mut f) = file.lock() {
        let _ = writeln!(f, "[{stream}] {line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fake_paths() -> AppPaths {
        AppPaths {
            app_data: PathBuf::from("/fake/AppData"),
            python_install_dir: PathBuf::from("/fake/AppData/python"),
            uv_cache_dir: PathBuf::from("/fake/AppData/uv-cache"),
            venv_dir: PathBuf::from("/fake/AppData/venv"),
            venv_python: PathBuf::from("/fake/AppData/venv/bin/python"),
            models_dir: PathBuf::from("/fake/AppData/models"),
            script_path: PathBuf::from("/fake/Resources/sidecar/whisper_server.py"),
            requirements_path: PathBuf::from("/fake/Resources/sidecar/requirements-sidecar.txt"),
            diar_requirements_path: PathBuf::from("/fake/Resources/sidecar/requirements-diar.txt"),
            log_path: PathBuf::from("/fake/Logs/whisper_server.log"),
            marker_path: PathBuf::from("/fake/AppData/.provisioned.json"),
            mlx_venv_dir: PathBuf::from("/fake/AppData/mlx-venv"),
            mlx_venv_python: PathBuf::from("/fake/AppData/mlx-venv/bin/python"),
            mlx_requirements_lock_path: PathBuf::from("/fake/Resources/sidecar/requirements-mlx.lock"),
        }
    }

    #[test]
    fn accepts_every_whisper_server_model_choice() {
        for model in ALLOWED_MODELS {
            assert!(validate_model(model).is_ok());
        }
    }

    #[test]
    fn rejects_an_unsupported_model() {
        for model in ["large-v2", "large", "turbo", "gpt-4", ""] {
            assert!(validate_model(model).is_err(), "{model} should be rejected");
        }
    }

    // ---- S12a §C R1: is_parakeet_model / venv_for_model ----

    #[test]
    fn is_parakeet_model_matches_only_the_parakeet_prefix() {
        assert!(is_parakeet_model("parakeet-tdt-0.6b-v3"));
        assert!(is_parakeet_model("parakeet-some-future-size"));
        for model in ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo", ""] {
            assert!(!is_parakeet_model(model), "{model} should not be treated as parakeet");
        }
    }

    #[test]
    fn venv_for_model_uses_the_base_venv_for_every_whisper_family_model() {
        let paths = fake_paths();
        for model in ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"] {
            assert_eq!(venv_for_model(&paths, model), paths.venv_python.as_path());
        }
    }

    #[test]
    fn venv_for_model_uses_the_separate_mlx_venv_for_the_parakeet_model() {
        let paths = fake_paths();
        assert_eq!(
            venv_for_model(&paths, "parakeet-tdt-0.6b-v3"),
            paths.mlx_venv_python.as_path()
        );
    }

    // ---- S12a §C Q6/§3.5: hf_extra_env ----

    #[test]
    fn hf_extra_env_always_disables_telemetry_and_omits_hf_token_when_unset() {
        let env = hf_extra_env(&None);
        assert_eq!(env, vec![("HF_HUB_DISABLE_TELEMETRY".to_string(), "1".to_string())]);
    }

    #[test]
    fn hf_extra_env_omits_hf_token_when_the_configured_token_is_empty() {
        let env = hf_extra_env(&Some(String::new()));
        assert_eq!(env, vec![("HF_HUB_DISABLE_TELEMETRY".to_string(), "1".to_string())]);
    }

    #[test]
    fn hf_extra_env_adds_hf_token_when_a_non_empty_token_is_configured() {
        let env = hf_extra_env(&Some("secret-token".to_string()));
        assert!(env.contains(&("HF_HUB_DISABLE_TELEMETRY".to_string(), "1".to_string())));
        assert!(env.contains(&("HF_TOKEN".to_string(), "secret-token".to_string())));
        assert_eq!(env.len(), 2);
    }

    #[test]
    fn hf_extra_env_omits_hf_token_when_the_configured_token_is_whitespace_only() {
        // F8 (S12a fix round, §D) — red on the pre-fix code: a plain
        // `!token.is_empty()` check treats "   " as non-empty and sets
        // HF_TOKEN="   ", which Python's own `bool("   ")` truthiness
        // reads as configured (diar falsely armed) even though there is
        // no real token — the exact JS/Rust semantics divergence F8
        // names.
        let env = hf_extra_env(&Some("   ".to_string()));
        assert_eq!(env, vec![("HF_HUB_DISABLE_TELEMETRY".to_string(), "1".to_string())]);
    }

    #[test]
    fn hf_extra_env_trims_surrounding_whitespace_off_a_configured_token() {
        let env = hf_extra_env(&Some("  secret-token  ".to_string()));
        assert!(env.contains(&("HF_TOKEN".to_string(), "secret-token".to_string())));
        assert!(!env.iter().any(|(_, v)| v.contains(' ')));
    }

    #[test]
    fn hf_extra_env_never_sets_hf_home_itself() {
        // Q6's own scope trim ("keep HF_HOME exactly as today ... do NOT
        // introduce a second conflicting cache root"): this fn must never
        // emit its own HF_HOME entry — callers set that separately.
        let env = hf_extra_env(&Some("tok".to_string()));
        assert!(!env.iter().any(|(k, _)| k == "HF_HOME"));
    }

    // ---- S13 hotfix: lazy_load_args ----

    #[test]
    fn lazy_load_args_is_empty_when_absent() {
        // None — every pre-hotfix caller, and performSwitchModel's own
        // restart call, which never threads this field at all.
        assert_eq!(lazy_load_args(&None), Vec::<String>::new());
    }

    #[test]
    fn lazy_load_args_is_empty_when_explicitly_false() {
        assert_eq!(lazy_load_args(&Some(false)), Vec::<String>::new());
    }

    #[test]
    fn lazy_load_args_adds_the_flag_when_explicitly_true() {
        assert_eq!(lazy_load_args(&Some(true)), vec!["--lazy-load".to_string()]);
    }

    // ---- S12a §C F13/F14: check_mlx_capable_if_parakeet ----

    #[test]
    fn check_mlx_capable_if_parakeet_is_a_noop_for_every_non_parakeet_model() {
        for model in ALLOWED_MODELS.iter().filter(|m| !is_parakeet_model(m)) {
            assert!(check_mlx_capable_if_parakeet(model).is_ok());
        }
    }

    #[test]
    fn check_mlx_capable_if_parakeet_matches_live_mlx_capabilities_for_the_parakeet_model() {
        // Environment-independent by construction: asserts consistency
        // with mlxcaps::compute_mlx_capabilities()'s own live result on
        // whatever machine runs this test, rather than assuming this
        // machine's own arch/OS.
        let caps = mlxcaps::compute_mlx_capabilities();
        let result = check_mlx_capable_if_parakeet("parakeet-tdt-0.6b-v3");
        assert_eq!(result.is_ok(), caps.mlx_supported);
        if let Err(message) = result {
            assert!(message.starts_with(MLX_UNSUPPORTED_ERROR_PREFIX));
        }
    }

    // ---- classify_download_line (S4 chunk 2's --download-only line
    // parser) — pure, no process ever spawned. ----

    #[test]
    fn classifies_a_download_progress_line() {
        let line = r#"{"type":"download_progress","downloaded":1048576,"total":3145728}"#;
        assert_eq!(
            classify_download_line(line),
            DownloadLine::Progress {
                downloaded: 1_048_576,
                total: 3_145_728
            }
        );
    }

    #[test]
    fn classifies_a_download_done_line() {
        assert_eq!(classify_download_line(r#"{"type":"download_done"}"#), DownloadLine::Done);
    }

    #[test]
    fn classifies_a_download_error_line() {
        let line = r#"{"type":"download_error","message":"磁盘空间不足"}"#;
        assert_eq!(
            classify_download_line(line),
            DownloadLine::Error {
                message: "磁盘空间不足".to_string()
            }
        );
    }

    #[test]
    fn classifies_garbage_text_as_other() {
        for line in [
            "",
            "not json at all",
            "Downloading... 45%",
            "Traceback (most recent call last):",
            "null",
            "42",
        ] {
            assert_eq!(
                classify_download_line(line),
                DownloadLine::Other,
                "{line:?} should classify as Other"
            );
        }
    }

    #[test]
    fn classifies_partial_or_truncated_json_as_other() {
        // A line split mid-write (e.g. the reader thread observed a
        // not-yet-flushed prefix) must never panic or be misread as a
        // different known shape — falls back to Other exactly like
        // garbage text.
        for line in [
            r#"{"type":"download_progress","downloaded":123"#,
            r#"{"type":"download_progress""#,
            r#"{"type": "download_"#,
            "{",
        ] {
            assert_eq!(
                classify_download_line(line),
                DownloadLine::Other,
                "{line:?} should classify as Other"
            );
        }
    }

    #[test]
    fn classifies_valid_json_with_an_unrecognized_type_as_other() {
        assert_eq!(
            classify_download_line(r#"{"type":"something_else","x":1}"#),
            DownloadLine::Other
        );
    }

    #[test]
    fn classifies_valid_json_missing_the_type_field_as_other() {
        assert_eq!(classify_download_line(r#"{"downloaded":1,"total":2}"#), DownloadLine::Other);
    }

    // ---- field-test issue 6 (cancellable model downloads): PollOutcome
    // / poll_prewarm_slot + cancel_prewarm_impl — the one place in this
    // module's own test suite that spawns REAL child processes rather
    // than staying shape-only (see poll_prewarm_slot's own doc comment
    // for why: std::process::Child can't be faked, unlike this
    // codebase's usual convention — see build_import_preflight_command's
    // own doc comment, uv.rs). Uses `sleep`/`true` (plain Unix
    // utilities, always present on this app's macOS target) rather than
    // a real whisper_server.py. ----

    #[test]
    fn poll_prewarm_slot_reports_cancelled_when_the_slot_is_already_empty() {
        let mut guard: Option<Child> = None;
        assert_eq!(poll_prewarm_slot(&mut guard), PollOutcome::Cancelled);
    }

    #[test]
    fn poll_prewarm_slot_reports_still_running_for_a_live_child_and_leaves_it_registered() {
        let child = StdCommand::new("sleep").arg("5").spawn().expect("failed to spawn sleep");
        let mut guard = Some(child);

        assert_eq!(poll_prewarm_slot(&mut guard), PollOutcome::StillRunning);
        assert!(guard.is_some(), "a still-running child must stay registered for the next poll");

        // Cleanup — don't leave a real 5s sleep orphaned for the rest of
        // this test binary's run.
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    #[test]
    fn poll_prewarm_slot_reports_exited_and_clears_the_slot_once_the_child_finishes() {
        let child = StdCommand::new("true").spawn().expect("failed to spawn true");
        let mut guard = Some(child);

        // `true` exits ~instantly but isn't guaranteed reaped by the
        // very first try_wait() — short retry loop, same shape a real
        // poll would use, rather than assuming exact OS timing.
        let mut outcome = PollOutcome::StillRunning;
        for _ in 0..100 {
            outcome = poll_prewarm_slot(&mut guard);
            if outcome != PollOutcome::StillRunning {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }

        assert_eq!(outcome, PollOutcome::Exited(Some(0)));
        assert!(guard.is_none(), "an exited child must be cleared from the slot");
    }

    // ---- F1 (review-round fix, Sol HIGH #2): register_prewarm_child —
    // two sequential registrations must not orphan the first child or
    // cross-wire the two poll loops (see that fn's own doc comment). ----

    #[test]
    fn register_prewarm_child_kills_the_stale_child_on_a_second_registration_and_reports_it() {
        let state = ServerState::default();

        let first_child = StdCommand::new("sleep").arg("5").spawn().expect("failed to spawn sleep");
        let first_pid = first_child.id();
        let had_stale_first =
            register_prewarm_child(&state, first_child).expect("first registration should succeed");
        assert!(!had_stale_first, "the first-ever registration has nothing stale to report");

        // Sanity: the first child is genuinely alive and registered
        // before the second registration supersedes it.
        {
            let mut guard = state.prewarm.lock().unwrap();
            assert_eq!(poll_prewarm_slot(&mut guard), PollOutcome::StillRunning);
        }

        let second_child = StdCommand::new("true").spawn().expect("failed to spawn true");
        let had_stale_second =
            register_prewarm_child(&state, second_child).expect("second registration should succeed");
        assert!(
            had_stale_second,
            "the second registration must report that a stale (first) child was superseded"
        );

        // The stale first child must actually be dead — SIGKILL'd and
        // reaped via kill_and_reap, not merely dropped from the slot.
        // `kill -0 <pid>` fails once a pid no longer exists (stderr
        // suppressed — the expected "No such process" line is the
        // assertion, not a real problem to surface in test output).
        let kill_probe = StdCommand::new("kill")
            .arg("-0")
            .arg(first_pid.to_string())
            .stderr(Stdio::null())
            .status();
        assert!(
            matches!(kill_probe, Ok(status) if !status.success()),
            "the stale first child must actually be killed, not just dropped from the slot"
        );

        // The second child now owns the slot and polls normally to
        // completion — no false Cancelled contamination from the first
        // child's own supersession (see PollOutcome::Cancelled's own
        // doc comment for the exact false-marker this fix avoids).
        let mut outcome = PollOutcome::StillRunning;
        for _ in 0..100 {
            let mut guard = state.prewarm.lock().unwrap();
            outcome = poll_prewarm_slot(&mut guard);
            drop(guard);
            if outcome != PollOutcome::StillRunning {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(outcome, PollOutcome::Exited(Some(0)));
    }

    #[test]
    fn cancel_prewarm_impl_kills_a_registered_child_and_clears_the_slot() {
        let state = ServerState::default();
        let child = StdCommand::new("sleep").arg("5").spawn().expect("failed to spawn sleep");
        *state.prewarm.lock().unwrap() = Some(child);

        assert!(cancel_prewarm_impl(&state).is_ok());
        assert!(state.prewarm.lock().unwrap().is_none());
    }

    #[test]
    fn cancel_prewarm_impl_is_a_noop_when_nothing_is_in_flight() {
        let state = ServerState::default();
        assert!(cancel_prewarm_impl(&state).is_ok());
        assert!(state.prewarm.lock().unwrap().is_none());
    }

    #[test]
    fn cancel_prewarm_impl_never_touches_the_unrelated_server_slot() {
        // ServerState.server and .prewarm are independent Mutexes (see
        // that struct's own doc comment) — cancelling a download must
        // never disturb an already-running long-lived sidecar.
        let state = ServerState::default();
        let server_child = StdCommand::new("sleep").arg("5").spawn().expect("failed to spawn sleep");
        *state.server.lock().unwrap() = Some(server_child);
        let prewarm_child = StdCommand::new("sleep").arg("5").spawn().expect("failed to spawn sleep");
        *state.prewarm.lock().unwrap() = Some(prewarm_child);

        assert!(cancel_prewarm_impl(&state).is_ok());

        assert!(state.prewarm.lock().unwrap().is_none());
        assert!(state.server.lock().unwrap().is_some(), "the server slot must be untouched");

        // Cleanup.
        let leftover = state.server.lock().unwrap().take();
        if let Some(mut child) = leftover {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
