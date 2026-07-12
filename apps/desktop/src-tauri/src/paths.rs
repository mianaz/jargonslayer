// S3 chunk 3 (docs/design-explorations/s3-tauri-uv-blueprint.md, §Chunk 3 +
// §App-data layout) — the single source of truth for every path the
// provisioning/server-lifecycle commands touch. Every other command in this
// crate re-derives its paths through `resolve_app_paths` rather than
// accepting a path argument from its JS caller, so there is exactly one
// place that can ever disagree with the blueprint's app-data layout:
//
//   ~/Library/Application Support/<identifier>/
//     python/    UV_PYTHON_INSTALL_DIR     venv/    (uv venv)
//     uv-cache/  UV_CACHE_DIR              models/  HF_HOME
//     .provisioned.json
//   ~/Library/Logs/<identifier>/whisper_server.log
//
// `compute_app_paths` is the pure half (no Tauri app handle, fully unit-
// testable with a fake base dir — see tests below); `resolve_app_paths`/
// `app_paths` are the thin Tauri-coupled wrapper that feeds it real paths
// resolved through `app.path()`.
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::Manager;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub app_data: PathBuf,
    pub python_install_dir: PathBuf,
    pub uv_cache_dir: PathBuf,
    pub venv_dir: PathBuf,
    pub venv_python: PathBuf,
    pub models_dir: PathBuf,
    pub script_path: PathBuf,
    pub log_path: PathBuf,
    pub marker_path: PathBuf,
}

/// Pure path assembly — given the two Tauri-resolved base directories and
/// the resolved bundled-resource script path, lays out every other path
/// per the blueprint's App-data layout above. No filesystem access, no
/// Tauri handle — fully unit-testable with a fake base dir.
pub fn compute_app_paths(app_data_dir: &Path, log_dir: &Path, script_path: PathBuf) -> AppPaths {
    let venv_dir = app_data_dir.join("venv");
    AppPaths {
        app_data: app_data_dir.to_path_buf(),
        python_install_dir: app_data_dir.join("python"),
        uv_cache_dir: app_data_dir.join("uv-cache"),
        venv_python: venv_python_path(&venv_dir),
        venv_dir,
        models_dir: app_data_dir.join("models"),
        script_path,
        log_path: log_dir.join("whisper_server.log"),
        marker_path: app_data_dir.join(".provisioned.json"),
    }
}

/// venv/bin/python (mac/linux) vs venv\Scripts\python.exe (windows) — the
/// ONE execution tool per architecture decision 3 (uv provisions, the venv
/// python runs everything else) — callers never spawn a bare `python` off
/// $PATH.
fn venv_python_path(venv_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        venv_dir.join("Scripts").join("python.exe")
    } else {
        venv_dir.join("bin").join("python")
    }
}

/// Tauri-coupled half: resolves the app-data dir, the app-log dir, and the
/// bundled `$RESOURCE/sidecar/whisper_server.py` resource (the map-form
/// `bundle.resources` entry in tauri.conf.json — chunk 2's deviation from
/// the blueprint's plain-list form, preserved here) through `app.path()`,
/// then hands off to `compute_app_paths`.
pub fn resolve_app_paths(app: &tauri::AppHandle) -> Result<AppPaths, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data dir: {e}"))?;
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("could not resolve the app log dir: {e}"))?;
    let script_path = app
        .path()
        .resolve("sidecar/whisper_server.py", BaseDirectory::Resource)
        .map_err(|e| format!("could not resolve the bundled whisper_server.py resource: {e}"))?;
    Ok(compute_app_paths(&app_data_dir, &log_dir, script_path))
}

#[tauri::command]
pub fn app_paths(app: tauri::AppHandle) -> Result<AppPaths, String> {
    resolve_app_paths(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lays_out_every_path_under_the_given_base_dirs() {
        let app_data = Path::new("/fake/AppData");
        let log_dir = Path::new("/fake/Logs");
        let script = PathBuf::from("/fake/Resources/sidecar/whisper_server.py");
        let paths = compute_app_paths(app_data, log_dir, script.clone());

        assert_eq!(paths.app_data, app_data);
        assert_eq!(paths.python_install_dir, app_data.join("python"));
        assert_eq!(paths.uv_cache_dir, app_data.join("uv-cache"));
        assert_eq!(paths.venv_dir, app_data.join("venv"));
        assert_eq!(paths.models_dir, app_data.join("models"));
        assert_eq!(paths.marker_path, app_data.join(".provisioned.json"));
        assert_eq!(paths.log_path, log_dir.join("whisper_server.log"));
        assert_eq!(paths.script_path, script);
    }

    #[test]
    fn venv_python_matches_the_current_platform_layout() {
        let paths = compute_app_paths(
            Path::new("/fake"),
            Path::new("/fake/logs"),
            PathBuf::from("/fake/script.py"),
        );
        let expected = if cfg!(windows) {
            Path::new("/fake")
                .join("venv")
                .join("Scripts")
                .join("python.exe")
        } else {
            Path::new("/fake").join("venv").join("bin").join("python")
        };
        assert_eq!(paths.venv_python, expected);
    }
}
