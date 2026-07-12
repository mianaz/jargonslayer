// S3 chunk 3 (blueprint §Chunk 3) — run_uv: the ONLY way this app talks to
// the uv sidecar (architecture decision 2 — Rust owns all process
// spawning; TS only ever builds {args,env} and invoke()s, see apps/web/
// src/lib/desktop/uvCommands.ts, chunk 4). HARDENING: `args`/`env` arrive
// as a caller-supplied Vec/HashMap from the JS side over IPC, and a
// buggy/compromised TS caller must not be able to smuggle an arbitrary uv
// subcommand (`cache clean`, `self update`, ...), an arbitrary flag on an
// otherwise-allowed subcommand (`pip install --target /anywhere ...`), or
// an arbitrary env var into a process that runs with the app's own
// filesystem permissions. validate_uv_args/validate_uv_env below therefore
// validate the FULL shape of args/env — exact arg counts and literal
// positions, not just args[0] — against the three exact call shapes
// uvCommands.ts's builders ever produce, and every path-valued
// operand/env value is further required to resolve (lexically — see
// is_under's own comment) under a root this app actually owns (the
// app-data dir, or for the bundled requirements file, the app's resource
// dir).
use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::paths::resolve_app_paths;

/// uv subcommands the app is ever allowed to run — deliberately NOT the
/// full uv CLI surface (no `cache`, `self`, `tool`, `run`, ...). Used only
/// to give an unrecognized-subcommand error a clearer message than the
/// generic "doesn't match any allowed shape" one below — the real
/// enforcement is validate_uv_args' per-shape match, not this list alone.
const ALLOWED_UV_SUBCOMMANDS: [&str; 3] = ["python", "venv", "pip"];

/// The two filesystem roots validate_uv_args/validate_uv_env check
/// path-valued operands/env values against. Deliberately just these two
/// paths (not the full `paths::AppPaths`) — a small, easily-faked struct
/// keeps the validators' unit tests independent of paths.rs's full
/// app-data layout (see this module's tests: `UvRoots` is built directly
/// from fake paths, no `tauri::AppHandle` needed). `run_uv` builds the
/// real one fresh every call from `resolve_app_paths` + `app.path()
/// .resource_dir()`.
pub struct UvRoots<'a> {
    pub app_data: &'a Path,
    pub resource_dir: &'a Path,
}

/// Lexically strips `.`/`..` components from an absolute path WITHOUT
/// touching the filesystem — deliberately NOT `fs::canonicalize`, which
/// requires the path to already exist; venvDir/venvPython routinely
/// don't yet (provisioning calls `uv venv <venvDir>` precisely to CREATE
/// that directory the first time, on a machine where the pinned Python
/// isn't installed yet either). A `..` that would pop past the root is
/// rejected outright (`None`) rather than silently clamped: for an
/// operand that's supposed to already be absolute, an unresolvable
/// leading `..` can only be a malformed or adversarial escape attempt.
/// Windows drive/UNC prefixes are kept as the first "segment" (not
/// discarded like RootDir) so two paths on different drives never
/// lexically collide into the same cleaned form.
fn lexically_clean_absolute(path: &Path) -> Option<Vec<std::ffi::OsString>> {
    use std::path::Component;
    let mut out: Vec<std::ffi::OsString> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str().to_os_string()),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                out.pop()?;
            }
            Component::Normal(seg) => out.push(seg.to_os_string()),
        }
    }
    Some(out)
}

/// True iff `candidate` is an absolute path that, once lexically cleaned
/// (see `lexically_clean_absolute`), is `root` itself or a descendant of
/// it. The `is_absolute()` guard is load-bearing on its own, not just
/// belt-and-suspenders: without it, a RELATIVE candidate whose components
/// happen to equal root's trailing components (e.g. "fake/AppData/venv"
/// against root "/fake/AppData") would lexically clean to the identical
/// component sequence as a legitimate absolute descendant and wrongly
/// pass. Compares CLEANED COMPONENTS, not raw path strings, for the other
/// direction of the same bug class — a raw `str::starts_with` would
/// wrongly accept a sibling directory whose name merely extends root's
/// own name (e.g. "/fake/AppDataEvil" starts with the string
/// "/fake/AppData" but is not under it). `root` is trusted (always one of
/// resolve_app_paths'/app.path()'s own resolved dirs) and assumed already
/// absolute.
fn is_under(candidate: &Path, root: &Path) -> bool {
    if !candidate.is_absolute() {
        return false;
    }
    match (
        lexically_clean_absolute(candidate),
        lexically_clean_absolute(root),
    ) {
        (Some(candidate_parts), Some(root_parts)) => {
            candidate_parts.len() >= root_parts.len()
                && candidate_parts[..root_parts.len()] == root_parts[..]
        }
        _ => false,
    }
}

/// True for a bare `MAJOR.MINOR` version string (e.g. "3.12", the
/// PINNED_PYTHON_MINOR uvCommands.ts hardcodes) — matches `^\d+\.\d+$`
/// without pulling in the `regex` crate for this one fixed shape.
fn is_pinned_minor_version(s: &str) -> bool {
    let Some((major, minor)) = s.split_once('.') else {
        return false;
    };
    !major.is_empty()
        && !minor.is_empty()
        && major.bytes().all(|b| b.is_ascii_digit())
        && minor.bytes().all(|b| b.is_ascii_digit())
}

/// Full-shape validation against the exact three call shapes
/// uvCommands.ts's builders (pythonInstall/venvCreate/pipInstall) ever
/// produce — exact arg counts and literal positions, not just args[0]: a
/// bare "args[0] is python/venv/pip" check let `pip install --target
/// /anywhere <any-package>` straight through, which would let a
/// compromised/buggy caller write arbitrary files anywhere on disk uv's
/// own process has permissions for.
pub fn validate_uv_args(args: &[String], roots: &UvRoots) -> Result<(), String> {
    match args {
        [] => Err("run_uv: args must not be empty (need a subcommand)".to_string()),
        [sub, install, version] if sub == "python" && install == "install" => {
            if !is_pinned_minor_version(version) {
                return Err(format!(
                    "run_uv: 'python install' version '{version}' must be a bare MAJOR.MINOR version"
                ));
            }
            Ok(())
        }
        [sub, venv_dir, flag, version] if sub == "venv" && flag == "--python" => {
            if !is_under(Path::new(venv_dir), roots.app_data) {
                return Err(format!(
                    "run_uv: 'venv' target '{venv_dir}' must be an absolute path under the app-data dir"
                ));
            }
            if !is_pinned_minor_version(version) {
                return Err(format!(
                    "run_uv: 'venv' python version '{version}' must be a bare MAJOR.MINOR version"
                ));
            }
            Ok(())
        }
        [sub, install, py_flag, venv_python, r_flag, requirements]
            if sub == "pip" && install == "install" && py_flag == "--python" && r_flag == "-r" =>
        {
            if !is_under(Path::new(venv_python), roots.app_data) {
                return Err(format!(
                    "run_uv: 'pip install --python' target '{venv_python}' must be an absolute path under the app-data dir"
                ));
            }
            if !is_under(Path::new(requirements), roots.app_data)
                && !is_under(Path::new(requirements), roots.resource_dir)
            {
                return Err(format!(
                    "run_uv: 'pip install -r' target '{requirements}' must be an absolute path under the app-data dir or the app's resource dir"
                ));
            }
            Ok(())
        }
        [sub, ..] if !ALLOWED_UV_SUBCOMMANDS.contains(&sub.as_str()) => Err(format!(
            "run_uv: '{sub}' is not an allowed uv subcommand (must be one of {ALLOWED_UV_SUBCOMMANDS:?})"
        )),
        _ => Err(format!(
            "run_uv: args {args:?} do not match the one allowed shape for its subcommand \
             (python install <ver> | venv <dir> --python <ver> | pip install --python <py> -r <req>)"
        )),
    }
}

/// How to validate one allowed env var's VALUE — validate_uv_env's
/// per-key allowlist grew from a bare key-prefix check (any `UV_*` key,
/// any value) to this, since the loose version let a caller send e.g.
/// `UV_SYSTEM_PYTHON=1` (defeats UV_PYTHON_PREFERENCE=only-managed's own
/// guarantee of never touching a system Python) or point the path-valued
/// keys anywhere on disk.
enum EnvRule {
    PathUnderAppData,
    ExactValue(&'static str),
}

/// Exactly the five env keys uvEnv() (apps/web/src/lib/desktop/
/// uvCommands.ts) / prewarm_model's own hardcoded HF_HOME (server.rs)
/// ever set — nothing else is on the allowlist regardless of prefix.
fn env_rule(key: &str) -> Option<EnvRule> {
    match key {
        "UV_PYTHON_INSTALL_DIR" | "UV_CACHE_DIR" | "HF_HOME" => Some(EnvRule::PathUnderAppData),
        "UV_PYTHON_PREFERENCE" => Some(EnvRule::ExactValue("only-managed")),
        "UV_NO_MODIFY_PATH" => Some(EnvRule::ExactValue("1")),
        _ => None,
    }
}

pub fn validate_uv_env(env: &HashMap<String, String>, roots: &UvRoots) -> Result<(), String> {
    for (key, value) in env {
        match env_rule(key) {
            Some(EnvRule::PathUnderAppData) => {
                if !is_under(Path::new(value), roots.app_data) {
                    return Err(format!(
                        "run_uv: env var '{key}' must be an absolute path under the app-data dir, got '{value}'"
                    ));
                }
            }
            Some(EnvRule::ExactValue(expected)) => {
                if value != expected {
                    return Err(format!(
                        "run_uv: env var '{key}' must be exactly '{expected}', got '{value}'"
                    ));
                }
            }
            None => {
                return Err(format!(
                    "run_uv: env var '{key}' is not on the allowlist (must be one of \
                     UV_PYTHON_INSTALL_DIR/UV_CACHE_DIR/UV_PYTHON_PREFERENCE/UV_NO_MODIFY_PATH/HF_HOME)"
                ));
            }
        }
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
    // roots are resolved fresh every call (cheap — no I/O beyond path
    // string resolution) rather than cached, so validate_uv_args/
    // validate_uv_env can never validate operands against a stale
    // app-data/resource dir. See UvRoots' own doc comment for why this is
    // just these two paths, not the full `paths::AppPaths`.
    let paths = resolve_app_paths(&app)?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("could not resolve the app resource dir: {e}"))?;
    let roots = UvRoots {
        app_data: &paths.app_data,
        resource_dir: &resource_dir,
    };
    validate_uv_args(&args, &roots)?;
    validate_uv_env(&env, &roots)?;

    // `app.shell().sidecar("binaries/uv")` — matches tauri.conf.json's
    // `bundle.externalBin: ["binaries/uv"]` (chunk 2) exactly; the
    // bundler strips the target-triple suffix at build time, so the
    // sidecar name at runtime is never triple-qualified.
    //
    // This is tauri-plugin-shell's Rust API (Shell::sidecar ->
    // Command::new_sidecar, and below, Command::spawn) — NOT the
    // IPC-exposed `plugin:shell|spawn` command a webview would reach via
    // invoke(). Verified against tauri-plugin-shell 2.3.5's own source:
    // Shell::sidecar/Command::spawn go straight to std::process::Command
    // with no CommandScope/GlobalScope in sight anywhere in process/
    // mod.rs; those extractor types (the ones a capability grant actually
    // populates) appear only in commands.rs's execute/spawn/kill — the
    // #[tauri::command] handlers registered for IPC. So this call is
    // gated by the validation above, NOT by capabilities/default.json —
    // deliberately no shell:allow-spawn grant there (see that file's own
    // description for why one would only ever help an attacker here).
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

    fn fake_roots() -> UvRoots<'static> {
        UvRoots {
            app_data: Path::new("/fake/AppData"),
            resource_dir: Path::new("/fake/Resources"),
        }
    }

    // ---- validate_uv_args: the three legitimate shapes ----

    #[test]
    fn accepts_each_legitimate_call_shape() {
        let roots = fake_roots();
        assert!(validate_uv_args(
            &[
                "python".to_string(),
                "install".to_string(),
                "3.12".to_string(),
            ],
            &roots,
        )
        .is_ok());
        assert!(validate_uv_args(
            &[
                "venv".to_string(),
                "/fake/AppData/venv".to_string(),
                "--python".to_string(),
                "3.12".to_string(),
            ],
            &roots,
        )
        .is_ok());
        assert!(validate_uv_args(
            &[
                "pip".to_string(),
                "install".to_string(),
                "--python".to_string(),
                "/fake/AppData/venv/bin/python".to_string(),
                "-r".to_string(),
                "/fake/Resources/sidecar/requirements-sidecar.txt".to_string(),
            ],
            &roots,
        )
        .is_ok());
    }

    #[test]
    fn accepts_pip_requirements_under_app_data_too_not_only_resource_dir() {
        let roots = fake_roots();
        assert!(validate_uv_args(
            &[
                "pip".to_string(),
                "install".to_string(),
                "--python".to_string(),
                "/fake/AppData/venv/bin/python".to_string(),
                "-r".to_string(),
                "/fake/AppData/requirements.txt".to_string(),
            ],
            &roots,
        )
        .is_ok());
    }

    #[test]
    fn rejects_an_empty_args_list() {
        assert!(validate_uv_args(&[], &fake_roots()).is_err());
    }

    #[test]
    fn rejects_a_disallowed_subcommand() {
        for sub in ["cache", "self", "tool", "run", "--version"] {
            assert!(
                validate_uv_args(&[sub.to_string()], &fake_roots()).is_err(),
                "{sub} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_pip_install_with_target() {
        assert!(validate_uv_args(
            &[
                "pip".to_string(),
                "install".to_string(),
                "--target".to_string(),
                "/anywhere".to_string(),
                "some-package".to_string(),
            ],
            &fake_roots(),
        )
        .is_err());
    }

    #[test]
    fn rejects_pip_install_with_an_extra_positional_package() {
        assert!(validate_uv_args(
            &[
                "pip".to_string(),
                "install".to_string(),
                "--python".to_string(),
                "/fake/AppData/venv/bin/python".to_string(),
                "-r".to_string(),
                "/fake/Resources/sidecar/requirements-sidecar.txt".to_string(),
                "extra-package".to_string(),
            ],
            &fake_roots(),
        )
        .is_err());
    }

    #[test]
    fn rejects_venv_dir_outside_app_data() {
        assert!(validate_uv_args(
            &[
                "venv".to_string(),
                "/etc/evil".to_string(),
                "--python".to_string(),
                "3.12".to_string(),
            ],
            &fake_roots(),
        )
        .is_err());
    }

    #[test]
    fn rejects_venv_dir_that_escapes_app_data_via_dot_dot() {
        assert!(validate_uv_args(
            &[
                "venv".to_string(),
                "/fake/AppData/venv/../../../etc/evil".to_string(),
                "--python".to_string(),
                "3.12".to_string(),
            ],
            &fake_roots(),
        )
        .is_err());
    }

    #[test]
    fn rejects_a_non_minor_version_string() {
        let roots = fake_roots();
        for version in ["3", "3.12.1", "3.x", "", "3."] {
            assert!(
                validate_uv_args(
                    &[
                        "python".to_string(),
                        "install".to_string(),
                        version.to_string(),
                    ],
                    &roots,
                )
                .is_err(),
                "{version} should be rejected"
            );
        }
    }

    // ---- validate_uv_env ----

    #[test]
    fn accepts_the_five_allowed_env_vars_with_legitimate_values() {
        let env = HashMap::from([
            (
                "UV_PYTHON_INSTALL_DIR".to_string(),
                "/fake/AppData/python".to_string(),
            ),
            (
                "UV_CACHE_DIR".to_string(),
                "/fake/AppData/uv-cache".to_string(),
            ),
            (
                "UV_PYTHON_PREFERENCE".to_string(),
                "only-managed".to_string(),
            ),
            ("UV_NO_MODIFY_PATH".to_string(), "1".to_string()),
            ("HF_HOME".to_string(), "/fake/AppData/models".to_string()),
        ]);
        assert!(validate_uv_env(&env, &fake_roots()).is_ok());
    }

    #[test]
    fn empty_env_is_fine() {
        assert!(validate_uv_env(&HashMap::new(), &fake_roots()).is_ok());
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
            assert!(
                validate_uv_env(&env, &fake_roots()).is_err(),
                "{key} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_uv_system_python_even_though_it_shares_the_uv_prefix() {
        let env = HashMap::from([("UV_SYSTEM_PYTHON".to_string(), "1".to_string())]);
        assert!(validate_uv_env(&env, &fake_roots()).is_err());
    }

    #[test]
    fn rejects_a_path_valued_env_var_outside_app_data() {
        let env = HashMap::from([("UV_CACHE_DIR".to_string(), "/etc/evil".to_string())]);
        assert!(validate_uv_env(&env, &fake_roots()).is_err());
    }

    #[test]
    fn rejects_the_wrong_literal_value_for_a_fixed_value_env_var() {
        let roots = fake_roots();
        let bad_preference =
            HashMap::from([("UV_PYTHON_PREFERENCE".to_string(), "system".to_string())]);
        assert!(validate_uv_env(&bad_preference, &roots).is_err());

        let bad_modify_path =
            HashMap::from([("UV_NO_MODIFY_PATH".to_string(), "true".to_string())]);
        assert!(validate_uv_env(&bad_modify_path, &roots).is_err());
    }

    // ---- is_under (the path-containment primitive both validators
    // above build on) ----

    #[test]
    fn is_under_accepts_the_root_itself_and_a_nested_descendant() {
        let root = Path::new("/fake/AppData");
        assert!(is_under(Path::new("/fake/AppData"), root));
        assert!(is_under(Path::new("/fake/AppData/venv/bin/python"), root));
    }

    #[test]
    fn is_under_rejects_a_relative_path_even_if_its_components_match_root() {
        // Without the explicit is_absolute() guard inside is_under, this
        // would lexically clean to the same component sequence as a
        // legitimate absolute descendant and wrongly pass.
        assert!(!is_under(
            Path::new("fake/AppData/venv"),
            Path::new("/fake/AppData")
        ));
    }

    #[test]
    fn is_under_rejects_a_dot_dot_escape_even_though_it_is_lexically_prefixed() {
        assert!(!is_under(
            Path::new("/fake/AppData/venv/../../../etc/evil"),
            Path::new("/fake/AppData")
        ));
    }

    #[test]
    fn is_under_rejects_a_sibling_whose_name_merely_extends_roots_string() {
        // "/fake/AppDataEvil" starts with the STRING "/fake/AppData" but
        // is a different directory entirely — is_under must compare
        // cleaned PATH COMPONENTS, not do a raw string prefix check.
        assert!(!is_under(
            Path::new("/fake/AppDataEvil/venv"),
            Path::new("/fake/AppData")
        ));
    }
}
