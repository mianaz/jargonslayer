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
//     mlx-venv/  (uv venv, separate — see mlx_venv_dir below)
//     .provisioned.json
//   ~/Library/Logs/<identifier>/whisper_server.log
//
// `compute_app_paths` is the pure half (no Tauri app handle, fully unit-
// testable with a fake base dir — see tests below); `resolve_app_paths`/
// `app_paths` are the thin Tauri-coupled wrapper that feeds it real paths
// resolved through `app.path()`.
//
// S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C R1) —
// `mlx_venv_dir`/`mlx_venv_python`/`mlx_requirements_lock_path` are the
// separate, hash-locked MLX venv's own paths (parakeet-mlx's isolated
// venv, airtight from the base `venv_dir` above — §C R1's numba-conflict
// note is exactly why this is a SECOND venv, not an extras group in the
// base one). `mlx_venv_dir` lives beside the base `venv_dir`, same
// app-data root, same `venv_python_path` layout helper; `mlx_requirements
// _lock_path` is a third bundled `$RESOURCE/sidecar/*` resource, resolved
// the same way `diar_requirements_path` is below (S5 chunk 0's own
// precedent for a second bundled requirements file).
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
    pub requirements_path: PathBuf,
    pub diar_requirements_path: PathBuf,
    pub log_path: PathBuf,
    pub marker_path: PathBuf,
    /// S12a §C R1 — the separate, hash-locked MLX venv's own dir, beside
    /// `venv_dir` above (never inside it — airtight isolation from the
    /// base whisper venv, see this module's own header comment).
    pub mlx_venv_dir: PathBuf,
    /// `mlx_venv_dir`'s own venv/bin/python (mac) / venv\Scripts\
    /// python.exe (windows) — same `venv_python_path` layout helper
    /// `venv_python` above uses, applied to the mlx venv dir instead.
    pub mlx_venv_python: PathBuf,
    /// The bundled, hash-pinned `requirements-mlx.lock` resource path
    /// (§C R1's lock strategy — `uv pip compile --generate-hashes`, the
    /// lockfile IS the SBOM) — same bundled-resource shape as
    /// `requirements_path`/`diar_requirements_path` above.
    pub mlx_requirements_lock_path: PathBuf,
}

/// Pure path assembly — given the two Tauri-resolved base directories and
/// the four resolved bundled-resource paths (whisper_server.py,
/// requirements-sidecar.txt — chunk 2's bundle.resources map-form
/// entries — plus requirements-diar.txt (v0.4 S5 chunk 0's optional
/// diarization add-on) and requirements-mlx.lock (S12a §C R1's optional
/// MLX add-on)), lays out every other path per the blueprint's App-data
/// layout above. No filesystem access, no Tauri handle — fully
/// unit-testable with a fake base dir.
pub fn compute_app_paths(
    app_data_dir: &Path,
    log_dir: &Path,
    script_path: PathBuf,
    requirements_path: PathBuf,
    diar_requirements_path: PathBuf,
    mlx_requirements_lock_path: PathBuf,
) -> AppPaths {
    let venv_dir = app_data_dir.join("venv");
    let mlx_venv_dir = app_data_dir.join("mlx-venv");
    AppPaths {
        app_data: app_data_dir.to_path_buf(),
        python_install_dir: app_data_dir.join("python"),
        uv_cache_dir: app_data_dir.join("uv-cache"),
        venv_python: venv_python_path(&venv_dir),
        venv_dir,
        models_dir: app_data_dir.join("models"),
        script_path,
        requirements_path,
        diar_requirements_path,
        log_path: log_dir.join("whisper_server.log"),
        marker_path: app_data_dir.join(".provisioned.json"),
        mlx_venv_python: venv_python_path(&mlx_venv_dir),
        mlx_venv_dir,
        mlx_requirements_lock_path,
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
/// four bundled `$RESOURCE/sidecar/*` resources (the map-form
/// `bundle.resources` entries in tauri.conf.json — chunk 2's deviation
/// from the blueprint's plain-list form, preserved here; requirements-
/// diar.txt is S5 chunk 0's addition, requirements-mlx.lock is S12a §C
/// R1's addition — bundled by worker A4, see tauri.conf.json's own
/// resources map) through `app.path()`, then hands off to
/// `compute_app_paths`.
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
    let requirements_path = app
        .path()
        .resolve("sidecar/requirements-sidecar.txt", BaseDirectory::Resource)
        .map_err(|e| {
            format!("could not resolve the bundled requirements-sidecar.txt resource: {e}")
        })?;
    let diar_requirements_path = app
        .path()
        .resolve("sidecar/requirements-diar.txt", BaseDirectory::Resource)
        .map_err(|e| {
            format!("could not resolve the bundled requirements-diar.txt resource: {e}")
        })?;
    let mlx_requirements_lock_path = app
        .path()
        .resolve("sidecar/requirements-mlx.lock", BaseDirectory::Resource)
        .map_err(|e| {
            format!("could not resolve the bundled requirements-mlx.lock resource: {e}")
        })?;
    Ok(compute_app_paths(
        &app_data_dir,
        &log_dir,
        script_path,
        requirements_path,
        diar_requirements_path,
        mlx_requirements_lock_path,
    ))
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
        let requirements = PathBuf::from("/fake/Resources/sidecar/requirements-sidecar.txt");
        let diar_requirements = PathBuf::from("/fake/Resources/sidecar/requirements-diar.txt");
        let mlx_requirements_lock = PathBuf::from("/fake/Resources/sidecar/requirements-mlx.lock");
        let paths = compute_app_paths(
            app_data,
            log_dir,
            script.clone(),
            requirements.clone(),
            diar_requirements.clone(),
            mlx_requirements_lock.clone(),
        );

        assert_eq!(paths.app_data, app_data);
        assert_eq!(paths.python_install_dir, app_data.join("python"));
        assert_eq!(paths.uv_cache_dir, app_data.join("uv-cache"));
        assert_eq!(paths.venv_dir, app_data.join("venv"));
        assert_eq!(paths.models_dir, app_data.join("models"));
        assert_eq!(paths.marker_path, app_data.join(".provisioned.json"));
        assert_eq!(paths.log_path, log_dir.join("whisper_server.log"));
        assert_eq!(paths.script_path, script);
        assert_eq!(paths.requirements_path, requirements);
        assert_eq!(paths.diar_requirements_path, diar_requirements);
        assert_eq!(paths.mlx_venv_dir, app_data.join("mlx-venv"));
        assert_eq!(paths.mlx_requirements_lock_path, mlx_requirements_lock);
    }

    #[test]
    fn mlx_venv_dir_sits_beside_the_base_venv_dir_never_inside_it() {
        // §C R1's isolation invariant, pinned at the path-layout level:
        // the mlx venv is a SIBLING of the base venv under app-data, not
        // nested under it — nesting would make a naive `rm -rf venv_dir`
        // (or a future base-venv `--clear`) accidentally destroy the mlx
        // venv too.
        let paths = compute_app_paths(
            Path::new("/fake"),
            Path::new("/fake/logs"),
            PathBuf::from("/fake/script.py"),
            PathBuf::from("/fake/requirements-sidecar.txt"),
            PathBuf::from("/fake/requirements-diar.txt"),
            PathBuf::from("/fake/requirements-mlx.lock"),
        );
        assert!(!paths.mlx_venv_dir.starts_with(&paths.venv_dir));
        assert!(!paths.venv_dir.starts_with(&paths.mlx_venv_dir));
        assert_eq!(paths.mlx_venv_dir.parent(), paths.venv_dir.parent());
    }

    #[test]
    fn venv_python_matches_the_current_platform_layout() {
        let paths = compute_app_paths(
            Path::new("/fake"),
            Path::new("/fake/logs"),
            PathBuf::from("/fake/script.py"),
            PathBuf::from("/fake/requirements-sidecar.txt"),
            PathBuf::from("/fake/requirements-diar.txt"),
            PathBuf::from("/fake/requirements-mlx.lock"),
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

    #[test]
    fn mlx_venv_python_matches_the_current_platform_layout_under_the_mlx_venv_dir() {
        let paths = compute_app_paths(
            Path::new("/fake"),
            Path::new("/fake/logs"),
            PathBuf::from("/fake/script.py"),
            PathBuf::from("/fake/requirements-sidecar.txt"),
            PathBuf::from("/fake/requirements-diar.txt"),
            PathBuf::from("/fake/requirements-mlx.lock"),
        );
        let expected = if cfg!(windows) {
            Path::new("/fake")
                .join("mlx-venv")
                .join("Scripts")
                .join("python.exe")
        } else {
            Path::new("/fake")
                .join("mlx-venv")
                .join("bin")
                .join("python")
        };
        assert_eq!(paths.mlx_venv_python, expected);
    }
}
