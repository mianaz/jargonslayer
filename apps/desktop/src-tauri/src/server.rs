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
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::paths::resolve_app_paths;
use crate::uv::{emit_uv_log, ProcessResult};

/// Whisper model sizes sidecar/whisper_server.py's own `--model` argparse
/// choices accept (parse_args' `choices=[...]`) — kept in lock-step with
/// that list, not the full faster-whisper model zoo.
const ALLOWED_MODELS: [&str; 6] = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"];

pub fn validate_model(model: &str) -> Result<(), String> {
    if ALLOWED_MODELS.contains(&model) {
        Ok(())
    } else {
        Err(format!(
            "'{model}' is not a supported Whisper model (must be one of {ALLOWED_MODELS:?})"
        ))
    }
}

/// Holds the spawned whisper_server.py child, if any is currently running
/// under this app's management. A held child means "started by us, still
/// (as far as we last checked) alive" — start_server, stop_server, the
/// exit-monitor thread, and the app's own RunEvent::Exit handler (lib.rs)
/// are the only four places that ever touch this lock. start_server holds
/// it for its entire check-spawn-store sequence (see that fn's own
/// comment); the other three only ever take it briefly.
#[derive(Default)]
pub struct ServerState(pub Mutex<Option<Child>>);

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
pub async fn prewarm_model(app: tauri::AppHandle, model: String) -> Result<ProcessResult, String> {
    validate_model(&model)?;
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
    let args = vec![
        path_to_string(&paths.script_path),
        "--model".to_string(),
        model,
        "--download-only".to_string(),
    ];
    let extra_env = vec![("HF_HOME".to_string(), path_to_string(&paths.models_dir))];
    let venv_python = paths.venv_python.clone();
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
    let code = tauri::async_runtime::spawn_blocking(move || {
        run_venv_python_streaming(&app_for_blocking, &venv_python, &args, &extra_env, move |line| {
            // ADDS to the unconditional uv://log forwarding every line
            // already gets (run_venv_python_streaming calls emit_uv_log
            // itself, before this closure ever runs) — never replaces
            // it, so the wizard's 详细日志 pane keeps showing the raw
            // --download-only output exactly like every other
            // provisioning step.
            match classify_download_line(line) {
                DownloadLine::Progress { downloaded, total } => {
                    let _ = app_for_progress.emit("prewarm://progress", PrewarmProgressEvent { downloaded, total });
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

/// Runs `program args…` to completion with the given extra env vars,
/// streaming stdout/stderr lines to `uv://log` (reusing run_uv's event —
/// see uv::emit_uv_log) tagged "stdout"/"stderr", and additionally
/// invoking `on_stdout_line` with every RAW stdout line as it arrives —
/// ALONGSIDE the unconditional emit_uv_log call, never instead of it
/// (prewarm_model's own download-progress classification is the one
/// caller that needs this; a no-op closure costs nothing for any other
/// call shape). Blocking — callers on the async runtime must wrap this
/// in spawn_blocking (see prewarm_model above).
fn run_venv_python_streaming(
    app: &tauri::AppHandle,
    program: &std::path::Path,
    args: &[String],
    extra_env: &[(String, String)],
    on_stdout_line: impl Fn(&str) + Send + 'static,
) -> Result<Option<i32>, String> {
    let mut cmd = StdCommand::new(program);
    cmd.args(args)
        .envs(extra_env.iter().map(|(k, v)| (k.as_str(), v.as_str())));

    let app_out = app.clone();
    let app_err = app.clone();
    let (mut child, out_handle, err_handle) = spawn_streamed(
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

    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = out_handle.join();
    let _ = err_handle.join();
    Ok(status.code())
}

// ---- start_server / stop_server ----

#[tauri::command]
pub async fn start_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, ServerState>,
    model: String,
) -> Result<StartServerResult, String> {
    validate_model(&model)?;

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
    let mut guard = state.0.lock().map_err(poison_err)?;
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

    let mut cmd = StdCommand::new(&paths.venv_python);
    cmd.args([
        path_to_string(&paths.script_path),
        "--model".to_string(),
        model,
        "--port".to_string(),
        "8765".to_string(),
        "--http-port".to_string(),
        "8766".to_string(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
    ])
    .env("HF_HOME", &paths.models_dir);

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
    let mut guard = state.0.lock().map_err(poison_err)?;
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
    // match + early return (not `if let Ok(...) = state.0.lock() {}`) —
    // the latter trips a known borrowck quirk where the Err arm's
    // PoisonError<MutexGuard> temporary is computed to outlive `state`.
    let mut guard = match state.0.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if let Some(child) = guard.take() {
        drop(guard);
        kill_and_reap(child);
    }
}

const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Polls (never a blocking wait()) the held child until it exits or
/// stop_server()/the app's own exit handler empties the slot first. A
/// blocking child.wait() here would have to hold state.0's lock for the
/// server's entire lifetime, deadlocking stop_server's own attempt to
/// take() that same lock — try_wait() lets this thread release the lock
/// between polls instead.
fn spawn_exit_monitor(app: tauri::AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(EXIT_POLL_INTERVAL);
        let state = app.state::<ServerState>();
        let mut guard = match state.0.lock() {
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
}
