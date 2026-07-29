// S3 chunk 3 — provision-marker + sidecar-log file I/O. Deliberately dumb
// on the Rust side: the marker is stored/returned as an OPAQUE JSON
// string — schema validation is chunk 4's provisionMachine.ts's job (pure
// TS state machine: "marker schema validation (bad marker ->
// NEEDS_PROVISION)"), not this crate's. Rust's only responsibility here is
// "read the file if it exists" / "write it atomically" / "tail the log."
use std::fs;
use std::path::Path;

use tauri::Manager;

use crate::paths::resolve_app_paths;

#[tauri::command]
pub fn read_provision_marker(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let paths = resolve_app_paths(&app)?;
    read_marker_file(&paths.marker_path)
}

fn read_marker_file(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read {}: {e}", path.display())),
    }
}

#[tauri::command]
pub fn write_provision_marker(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let paths = resolve_app_paths(&app)?;
    atomic_write(&paths.marker_path, json.as_bytes())
}

/// Atomic write: write to a same-directory temp file, then rename over
/// the target — rename(2)/MoveFileExW are atomic within one filesystem,
/// so a reader (including read_provision_marker running concurrently)
/// never observes a half-written marker.
fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;

    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp_path = std::path::PathBuf::from(tmp_name);

    fs::write(&tmp_path, contents)
        .map_err(|e| format!("failed to write {}: {e}", tmp_path.display()))?;
    fs::rename(&tmp_path, path).map_err(|e| {
        format!(
            "failed to rename {} -> {}: {e}",
            tmp_path.display(),
            path.display()
        )
    })?;
    Ok(())
}

/// Beta-phase diagnostics audit item 1 — generalizes the old single-file
/// `read_sidecar_log` (whisper_server.log only) to any of the THREE log
/// files this app's app-log dir ever holds: whisper_server.log
/// (paths.rs's own `log_path`, written by server.rs's sidecar spawn),
/// audiocap.log (audiocap.rs's `open_normal_session_log_file`), and
/// osspeech.log (osspeech.rs's `open_osspeech_log_file`) — all three
/// already write into the SAME `app.path().app_log_dir()`, so this
/// command resolves that directory directly rather than going through
/// `resolve_app_paths` (which also resolves bundled sidecar resources
/// this read-only command has no use for).
///
/// `source` is checked against LOG_SOURCES, an ALLOWLIST of exact
/// filenames — deliberately never accepted as (or joined onto) a
/// caller-supplied path: the one design risk this command exists to
/// guard against is a JS caller passing something like "../../etc/passwd"
/// and this command obligingly reading it. An unrecognized source
/// rejects outright rather than falling back to any default file.
const LOG_SOURCES: [&str; 3] = ["whisper_server.log", "audiocap.log", "osspeech.log"];

fn is_allowed_log_source(source: &str) -> bool {
    LOG_SOURCES.contains(&source)
}

/// Defense-in-depth (adjudicated review, F4): `source` is filename-
/// allowlisted (`is_allowed_log_source` above), but nothing stops
/// something ELSE from planting a symlink INSIDE app_log_dir under one
/// of those exact allowlisted names — pointing anywhere on disk this
/// process can read. `fs::read_to_string` (and plain `fs::metadata`)
/// follow symlinks transparently, so the allowlist alone can't catch
/// this. Checked here via `fs::symlink_metadata`, which reports the
/// path's OWN type without following it: refuses anything that isn't a
/// regular file (a symlink, a directory, a FIFO, …). A path that simply
/// doesn't exist yet is NOT refused here — read_app_log's own
/// `fs::read_to_string` call already turns that into an empty-string
/// result (a log file not yet created is normal), so this only needs to
/// gate the case where something IS there and isn't safe to read.
/// Pure/no-AppHandle so it's unit-testable without spinning up tauri.
fn refuse_unless_regular_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(()),
        Ok(_) => Err(format!("{} is not a regular file, refusing to read", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("failed to stat {}: {e}", path.display())),
    }
}

#[tauri::command]
pub fn read_app_log(app: tauri::AppHandle, source: String, tail_lines: u32) -> Result<String, String> {
    if !is_allowed_log_source(&source) {
        return Err(format!("unknown log source: {source}"));
    }
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("could not resolve the app log dir: {e}"))?;
    let path = log_dir.join(&source);
    refuse_unless_regular_file(&path)?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(tail_lines_of(&contents, tail_lines as usize)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("failed to read {}: {e}", path.display())),
    }
}

/// Pure — the last `n` lines of `contents` (empty when the file doesn't
/// exist yet, per read_app_log above). Reads/holds the whole file in
/// memory rather than a reverse-seek tail; fine at today's log sizes,
/// worth revisiting if whisper_server.log grows unbounded over very long
/// sessions.
pub fn tail_lines_of(contents: &str, n: usize) -> String {
    if n == 0 || contents.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = contents.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch_path(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("jargonslayer-provision-test-{name}-{unique}"))
    }

    #[test]
    fn read_marker_file_is_none_when_absent() {
        let path = scratch_path("absent");
        assert_eq!(read_marker_file(&path).unwrap(), None);
    }

    #[test]
    fn atomic_write_then_read_round_trips_and_leaves_no_tmp_file_behind() {
        let dir = scratch_path("dir");
        let path = dir.join("nested").join(".provisioned.json");

        atomic_write(&path, b"{\"schema\":1}").unwrap();
        atomic_write(&path, b"{\"schema\":2}").unwrap(); // overwrite

        assert_eq!(
            read_marker_file(&path).unwrap().as_deref(),
            Some("{\"schema\":2}")
        );

        let entries: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from(".provisioned.json")]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_lines_of_returns_only_the_last_n_lines() {
        let contents = "a\nb\nc\nd\ne";
        assert_eq!(tail_lines_of(contents, 2), "d\ne");
        assert_eq!(tail_lines_of(contents, 0), "");
        assert_eq!(tail_lines_of(contents, 100), "a\nb\nc\nd\ne");
        assert_eq!(tail_lines_of("", 5), "");
    }

    #[test]
    fn is_allowed_log_source_accepts_exactly_the_three_known_filenames() {
        assert!(is_allowed_log_source("whisper_server.log"));
        assert!(is_allowed_log_source("audiocap.log"));
        assert!(is_allowed_log_source("osspeech.log"));
    }

    #[test]
    fn is_allowed_log_source_rejects_anything_else_including_a_path_traversal_attempt() {
        assert!(!is_allowed_log_source("../../etc/passwd"));
        assert!(!is_allowed_log_source("/etc/passwd"));
        assert!(!is_allowed_log_source("whisper_server.log/../../etc/passwd"));
        assert!(!is_allowed_log_source("WHISPER_SERVER.LOG"));
        assert!(!is_allowed_log_source(""));
        assert!(!is_allowed_log_source("audiocap-spike.log")); // real file, but not in the allowlist
    }

    #[test]
    fn refuse_unless_regular_file_is_ok_for_a_plain_file() {
        let dir = scratch_path("regular-file-dir");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audiocap.log");
        fs::write(&path, "normal log content").unwrap();

        assert!(refuse_unless_regular_file(&path).is_ok());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuse_unless_regular_file_is_ok_when_the_path_does_not_exist_yet() {
        let path = scratch_path("nonexistent").join("audiocap.log");
        assert!(refuse_unless_regular_file(&path).is_ok());
    }

    #[test]
    fn refuse_unless_regular_file_refuses_a_symlink_named_like_an_allowlisted_log() {
        let dir = scratch_path("symlink-dir");
        fs::create_dir_all(&dir).unwrap();

        // The sentinel: a file OUTSIDE app_log_dir a malicious/planted
        // symlink might try to redirect a read toward.
        let sentinel = dir.join("sentinel.txt");
        fs::write(&sentinel, "SENTINEL: must never be reachable via read_app_log").unwrap();

        // The symlink itself: same name read_app_log would join onto
        // app_log_dir for the "audiocap.log" source.
        let link_path = dir.join("audiocap.log");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&sentinel, &link_path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&sentinel, &link_path).unwrap();

        let result = refuse_unless_regular_file(&link_path);
        assert!(result.is_err(), "a symlinked log source must be refused, got {result:?}");

        let _ = fs::remove_dir_all(&dir);
    }
}
