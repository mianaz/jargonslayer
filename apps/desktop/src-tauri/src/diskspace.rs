// S12a fix round (docs/design-explorations/s12-mlx-blueprint.md, §D,
// F6) — the combined pre-Phase-1 disk check both adversarial reviewers
// flagged as unbuilt (Sol6=Opus2, MED): before ensureMlxExtras (worker
// A2) ever mutates the mlx venv (venv create -> pip install -> pip
// check), it needs ONE honest "will this actually fit" precheck against
// the mlx-venv (~1GB) + uv cache + 2.51GB model + headroom reserve
// (~5GB total, §C R1's own sizing section) — replacing the old model-
// only ×1.2 check. This module owns exactly the Rust half of that: how
// much free space is actually left on the volume the app-data dir
// lives on. The JS-side reserve/threshold math is worker A2's own
// concern; this command only ever reports a number.
//
// PINNED CROSS-LANE CONTRACT (§D F6): `app_data_disk_free` ->
// `{freeBytes: number}` (u64, JSON-number-safe — disk sizes never
// approach f64's ~9e15 safe-integer ceiling). A2 mocks this exact
// name/shape in its own tests; this module's own shape must match it
// byte-for-byte.
use std::path::Path;

use serde::Serialize;

use crate::paths::resolve_app_paths;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskFreeResult {
    pub free_bytes: u64,
}

/// Climbs from `path` up through its own ancestors until it finds one
/// that actually exists on disk, returning that ancestor. Needed
/// because `app_data` (the path this command is always asked about) may
/// not exist yet the very first time this runs — S3's own base
/// provisioning creates it, but THIS command has to answer honestly
/// even if called before that ever happened (e.g. a fresh install's
/// very first wizard screen) — `statvfs`/`statfs` require an existing
/// path to resolve the underlying mount, and free space on the nearest
/// existing ancestor is the same volume `app_data` will actually land
/// on once created (mirrors what `df`'s own path resolution does).
/// Terminates at the root if nothing along the way exists (which itself
/// always exists on any real filesystem) — never loops forever.
fn nearest_existing_ancestor(path: &Path) -> &Path {
    let mut candidate = path;
    loop {
        if candidate.exists() {
            return candidate;
        }
        match candidate.parent() {
            Some(parent) => candidate = parent,
            None => return candidate,
        }
    }
}

/// The actual `statvfs` syscall wrapper — macOS-only (this crate's
/// `libc` dependency is itself `[target.'cfg(target_os = "macos")']`-
/// scoped, see Cargo.toml's own comment on audiocap.rs's `force_kill_
/// pid`/mlxcaps.rs's `is_rosetta_translated`, the same precedent this
/// follows). A graceful, always-compiling `Err` on every other target
/// keeps this module (and `app_data_disk_free`) buildable on the
/// Windows/Linux triples this crate's own paths.rs already supports the
/// layout for — MLX/parakeet itself is Apple-Silicon-only regardless
/// (mlxcaps.rs's own gate), so this command is never actually exercised
/// off macOS in production; the fallback exists purely so the crate
/// still compiles there.
#[cfg(target_os = "macos")]
fn free_bytes_at(path: &Path) -> Result<u64, String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let existing = nearest_existing_ancestor(path);
    let c_path = CString::new(existing.as_os_str().as_bytes())
        .map_err(|e| format!("app-data path contains an embedded NUL byte: {e}"))?;

    // SAFETY: `c_path` is a valid NUL-terminated C string naming a path
    // that `nearest_existing_ancestor` just confirmed exists; `stat` is
    // a valid out-pointer for `libc::statvfs`'s own struct, zero-
    // initialized and only ever read back AFTER a successful (ret == 0)
    // call fills it — the same "zeroed-then-syscall-fills-it" pattern
    // this crate has no prior direct precedent for, but is the standard
    // safe use of this FFI shape.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if ret != 0 {
        return Err(format!(
            "statvfs({}) failed: {}",
            existing.display(),
            std::io::Error::last_os_error()
        ));
    }
    // f_bavail (blocks available to an UNPRIVILEGED process) rather than
    // f_bfree (which includes root-reserved blocks a non-root process —
    // this app — would still get ENOSPC writing into): the honest
    // "how much can this app actually still write" number. f_bavail is
    // `fsblkcnt_t` (u32 on Darwin) so it needs the explicit widen;
    // f_frsize is already `c_ulong` == u64 under both macOS target
    // triples' own LP64 data model, so multiplying it in directly (no
    // redundant same-type conversion) still can't overflow the product.
    Ok(u64::from(stat.f_bavail) * stat.f_frsize)
}

#[cfg(not(target_os = "macos"))]
fn free_bytes_at(_path: &Path) -> Result<u64, String> {
    Err("app_data_disk_free is only implemented on macOS".to_string())
}

#[tauri::command]
pub fn app_data_disk_free(app: tauri::AppHandle) -> Result<DiskFreeResult, String> {
    let paths = resolve_app_paths(&app)?;
    let free_bytes = free_bytes_at(&paths.app_data)?;
    Ok(DiskFreeResult { free_bytes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_existing_ancestor_returns_the_path_itself_when_it_already_exists() {
        let existing = std::env::temp_dir();
        assert_eq!(nearest_existing_ancestor(&existing), existing.as_path());
    }

    #[test]
    fn nearest_existing_ancestor_climbs_past_a_deep_nonexistent_chain() {
        let nonexistent = std::env::temp_dir().join("s12a-f6-does-not-exist/deeper/still-deeper");
        let result = nearest_existing_ancestor(&nonexistent);
        assert!(result.exists());
        assert!(nonexistent.starts_with(result));
    }

    #[test]
    fn nearest_existing_ancestor_terminates_at_the_root_when_nothing_along_the_way_exists() {
        let result = nearest_existing_ancestor(Path::new(
            "/s12a-f6-nothing-here/at/all/whatsoever/deeply/nested",
        ));
        assert_eq!(result, Path::new("/"));
    }

    #[test]
    fn free_bytes_at_root_is_implemented_on_macos_and_a_graceful_error_elsewhere() {
        // Live syscall against a path guaranteed to exist on any
        // machine this test runs on ("/") — there's no portable way to
        // pin an exact free-space NUMBER in a unit test, so this only
        // asserts the platform-appropriate outcome shape.
        let result = free_bytes_at(Path::new("/"));
        if cfg!(target_os = "macos") {
            assert!(result.is_ok_and(|free| free > 0), "expected a positive free-byte count on macOS");
        } else {
            assert!(result.is_err(), "expected a graceful error off macOS");
        }
    }

    #[test]
    fn disk_free_result_serializes_free_bytes_as_a_camel_case_json_number() {
        // Pins the §D F6 cross-lane wire contract byte-for-byte:
        // `{freeBytes: number}` — A2 mocks exactly this shape.
        let result = DiskFreeResult { free_bytes: 5_368_709_120 };
        let json = serde_json::to_value(result).expect("DiskFreeResult serializes");
        assert_eq!(json, serde_json::json!({ "freeBytes": 5_368_709_120u64 }));
    }
}
