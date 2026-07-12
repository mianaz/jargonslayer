// S3 chunk 3 (blueprint §Chunk 3) — run_uv: the ONLY way this app talks to
// the uv sidecar (architecture decision 2 — Rust owns all process
// spawning; TS only ever builds {args,env} and invoke()s, see apps/web/
// src/lib/desktop/uvCommands.ts, chunk 4). HARDENING: args[0] and every
// env key are validated against small allowlists before anything is
// spawned (validate_uv_args/validate_uv_env below) — `args`/`env` arrive
// as a caller-supplied Vec/HashMap from the JS side over IPC, and a
// buggy/compromised TS caller must not be able to smuggle an arbitrary uv
// subcommand (`cache clean`, `self update`, ...) or an arbitrary env var
// into a process that runs with the app's own filesystem permissions.
use std::collections::HashMap;

use serde::Serialize;
use tauri::Emitter;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// uv subcommands the app is ever allowed to run — deliberately NOT the
/// full uv CLI surface (no `cache`, `self`, `tool`, `run`, ...).
const ALLOWED_UV_SUBCOMMANDS: [&str; 3] = ["python", "venv", "pip"];

/// Env var keys the app is ever allowed to forward into a spawned uv (or
/// venv-python — see server.rs's prewarm_model, which reuses this same
/// allowlist) process: the exact set uvEnv() in apps/web/src/lib/desktop/
/// uvCommands.ts builds (UV_PYTHON_INSTALL_DIR/UV_CACHE_DIR/
/// UV_PYTHON_PREFERENCE/UV_NO_MODIFY_PATH) plus HF_HOME.
fn is_allowed_env_key(key: &str) -> bool {
    key.starts_with("UV_") || key == "HF_HOME"
}

pub fn validate_uv_args(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some(sub) if ALLOWED_UV_SUBCOMMANDS.contains(&sub) => Ok(()),
        Some(other) => Err(format!(
            "run_uv: '{other}' is not an allowed uv subcommand (must be one of {ALLOWED_UV_SUBCOMMANDS:?})"
        )),
        None => Err("run_uv: args must not be empty (need a subcommand)".to_string()),
    }
}

pub fn validate_uv_env(env: &HashMap<String, String>) -> Result<(), String> {
    if let Some(key) = env.keys().find(|k| !is_allowed_env_key(k)) {
        return Err(format!(
            "run_uv: env var '{key}' is not on the allowlist (must be UV_* or HF_HOME)"
        ));
    }
    Ok(())
}

/// Shared "a subprocess ran to completion" result shape — reused by
/// prewarm_model (server.rs), which also just runs one venv-python
/// subprocess to completion and needs the same {code} shape run_uv
/// resolves with.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessResult {
    pub code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UvLogEvent {
    pub stream: &'static str,
    pub line: String,
}

/// Emits one `uv://log` line — reused by prewarm_model (server.rs) per
/// the blueprint's "streams combined output as uv://log too (reuse the
/// event)" instruction, so the wizard UI (chunk 6) only ever needs one
/// listener for both uv provisioning steps and the model-prewarm step.
pub fn emit_uv_log(app: &tauri::AppHandle, stream: &'static str, line: impl Into<String>) {
    let _ = app.emit(
        "uv://log",
        UvLogEvent {
            stream,
            line: line.into(),
        },
    );
}

#[tauri::command]
pub async fn run_uv(
    app: tauri::AppHandle,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<ProcessResult, String> {
    validate_uv_args(&args)?;
    validate_uv_env(&env)?;

    // `app.shell().sidecar("binaries/uv")` — matches capabilities/
    // default.json's shell:allow-spawn `"name": "binaries/uv"` entry and
    // tauri.conf.json's `bundle.externalBin: ["binaries/uv"]` (chunk 2)
    // exactly; the bundler strips the target-triple suffix at build time,
    // so the sidecar name at runtime is never triple-qualified.
    let command = app
        .shell()
        .sidecar("binaries/uv")
        .map_err(|e| format!("could not resolve the uv sidecar: {e}"))?
        .args(&args)
        .envs(env);

    let (mut rx, _child) = command
        .spawn()
        .map_err(|e| format!("failed to spawn uv {args:?}: {e}"))?;

    let mut code = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                emit_uv_log(&app, "stdout", String::from_utf8_lossy(&bytes).into_owned());
            }
            CommandEvent::Stderr(bytes) => {
                emit_uv_log(&app, "stderr", String::from_utf8_lossy(&bytes).into_owned());
            }
            CommandEvent::Error(message) => emit_uv_log(&app, "stderr", message),
            CommandEvent::Terminated(payload) => code = payload.code,
            _ => {}
        }
    }

    Ok(ProcessResult { code })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_each_allowed_subcommand() {
        for sub in ALLOWED_UV_SUBCOMMANDS {
            assert!(validate_uv_args(&[sub.to_string()]).is_ok());
            assert!(validate_uv_args(&[sub.to_string(), "--extra".to_string()]).is_ok());
        }
    }

    #[test]
    fn rejects_an_empty_args_list() {
        assert!(validate_uv_args(&[]).is_err());
    }

    #[test]
    fn rejects_a_disallowed_subcommand() {
        for sub in ["cache", "self", "tool", "run", "--version"] {
            assert!(
                validate_uv_args(&[sub.to_string()]).is_err(),
                "{sub} should be rejected"
            );
        }
    }

    #[test]
    fn accepts_the_blueprint_uv_env_vars_plus_hf_home() {
        let env = HashMap::from([
            ("UV_PYTHON_INSTALL_DIR".to_string(), "/x".to_string()),
            ("UV_CACHE_DIR".to_string(), "/y".to_string()),
            (
                "UV_PYTHON_PREFERENCE".to_string(),
                "only-managed".to_string(),
            ),
            ("UV_NO_MODIFY_PATH".to_string(), "1".to_string()),
            ("HF_HOME".to_string(), "/z".to_string()),
        ]);
        assert!(validate_uv_env(&env).is_ok());
    }

    #[test]
    fn rejects_an_env_var_outside_the_allowlist() {
        for key in [
            "PATH",
            "HOME",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "HF_TOKEN",
        ] {
            let env = HashMap::from([(key.to_string(), "x".to_string())]);
            assert!(validate_uv_env(&env).is_err(), "{key} should be rejected");
        }
    }

    #[test]
    fn empty_env_is_fine() {
        assert!(validate_uv_env(&HashMap::new()).is_ok());
    }
}
