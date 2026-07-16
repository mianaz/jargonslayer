// S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C Gating
// F13, fail-CLOSED) — `mlx_capabilities()`: the Parakeet-v3/MLX backend's
// own capability probe, mirroring osspeech.rs's/audiocap.rs's own
// `*_capabilities()` shape (a plain, never-`Err` command — see
// `audiocap_capabilities`'s own doc comment for the precedent this
// follows) one layer over: a DIFFERENT engine, DIFFERENT wire shape
// ({mlxSupported, reason}), and — per §C Gating's explicit call-out —
// the OPPOSITE default direction from those two siblings' fail-OPEN
// posture. This module only computes the Rust-side half of that
// contract; apps/web/src/lib/desktop/mlxCaps.ts (worker A2) owns the
// JS-side fail-closed caching/retry policy on top of whatever this
// command resolves with.
//
// Gate = native arm64 (never Rosetta-translated) + macOS >= 14.0 (mlx-
// metal's own floor — a much lower bar than osspeech.rs's macOS-26
// floor, hence its own is_macos_14_or_later here rather than reusing
// that module's is_macos_26_or_later). "mlx pinned" (§C Gating's third
// clause) is satisfied by construction — requirements-mlx.lock hash-pins
// the resolved mlx version at install time (worker A4/A1's install
// flow) — there is no separate RUNTIME probe for it here.
//
// Every probe step's failure folds into `{mlxSupported: false, reason:
// Some(..)}`, distinguishing the THREE reasons §C's blueprint text pins
// ("Reasons must distinguish intel/rosetta vs os-too-old"): genuine
// Intel hardware, an arm64-capable Mac running this process translated
// under Rosetta, and an Apple-Silicon Mac below the macOS 14 floor.
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlxCapabilities {
    pub mlx_supported: bool,
    pub reason: Option<String>,
}

/// Genuine Intel hardware (no Rosetta layer exists at all) OR this
/// process's own build isn't arm64 to begin with — either way, no
/// Apple-Silicon-native child process (uv's managed Python, mlx-metal)
/// can ever be provisioned from here.
pub const REASON_INTEL: &str = "需要 Apple 芯片（M 系列）";

/// This process IS running on Apple-Silicon hardware, but translated
/// under Rosetta 2 (an x86_64 build, or a universal build launched via
/// "Open using Rosetta") — deliberately gated UNSUPPORTED regardless of
/// the underlying hardware's own real capability (§C Gating's fail-
/// CLOSED posture, conservative direction): a translated parent process
/// cannot be trusted to have uv provision an arm64-native venv/Python
/// for it (uv's own platform detection follows the CALLING process'
/// reported architecture).
pub const REASON_ROSETTA: &str = "需要以原生 Apple 芯片模式运行（当前处于 Rosetta 转译模式）";

/// Native arm64, but below mlx-metal's macOS 14.0 floor.
pub const REASON_OS_TOO_OLD: &str = "需要 macOS 14 或更高版本";

fn unsupported(reason: &str) -> MlxCapabilities {
    MlxCapabilities {
        mlx_supported: false,
        reason: Some(reason.to_string()),
    }
}

fn supported() -> MlxCapabilities {
    MlxCapabilities {
        mlx_supported: true,
        reason: None,
    }
}

// ---- macOS major-version probe — private copy of osspeech.rs's/
// audiocap.rs's own `macos_version` idiom (NSProcessInfo.
// operatingSystemVersion via objc2-foundation, already a direct
// dependency — see Cargo.toml's own comment on audiocap.rs's original
// adoption of it). Only the major version is needed here (mlx-metal's
// floor is a whole-major-version threshold, no in-major minor to also
// check — same simplification osspeech.rs's own is_macos_26_or_later
// makes). ----

#[cfg(target_os = "macos")]
fn macos_major_version() -> i64 {
    use objc2_foundation::NSProcessInfo;
    NSProcessInfo::processInfo().operatingSystemVersion().majorVersion as i64
}

#[cfg(not(target_os = "macos"))]
fn macos_major_version() -> i64 {
    0
}

fn is_macos_14_or_later(major: i64) -> bool {
    major >= 14
}

// ---- Rosetta-translation probe: `sysctl.proc_translated` via
// libc::sysctlbyname (libc is already a macOS-target dependency — see
// Cargo.toml's own comment on audiocap.rs's force_kill_pid). Per this
// module's own header doc: "0 or absent" both mean "not translated" —
// absent (ENOENT, sysctlbyname failing for ANY reason) is the normal/
// expected case on genuine Intel hardware, which has no Rosetta layer
// and therefore no such sysctl key at all. ----

#[cfg(target_os = "macos")]
fn is_rosetta_translated() -> bool {
    use std::ffi::CString;
    use std::os::raw::c_void;

    let Ok(name) = CString::new("sysctl.proc_translated") else {
        return false;
    };
    let mut value: i32 = 0;
    let mut size = std::mem::size_of::<i32>();
    // SAFETY: `name` is a valid NUL-terminated C string; `value`/`size`
    // are a valid i32 out-pointer and its byte size (the standard
    // sysctlbyname read-only query shape); `newp`/`newlen` are null/0
    // since this never WRITES a sysctl value.
    let ret = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            &mut value as *mut i32 as *mut c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    ret == 0 && value == 1
}

#[cfg(not(target_os = "macos"))]
fn is_rosetta_translated() -> bool {
    false
}

/// Pure decision core — the whole gate as one branch over already-probed
/// values (mirrors osspeech.rs's own `is_macos_26_or_later(macos_version
/// ())` split: probe once, decide pure, so every branch is directly
/// unit-testable below without touching a real sysctl/ObjC call).
/// Rosetta is checked FIRST: an x86_64 build translated onto real
/// Apple-Silicon hardware is a materially different, more specific
/// situation than a flat "not arm64" — REASON_ROSETTA is the more useful
/// (and per §C Gating, still fail-closed) answer for it, not REASON_
/// INTEL.
fn capabilities_for(is_aarch64_build: bool, rosetta_translated: bool, macos_major: i64) -> MlxCapabilities {
    if rosetta_translated {
        return unsupported(REASON_ROSETTA);
    }
    if !is_aarch64_build {
        return unsupported(REASON_INTEL);
    }
    if !is_macos_14_or_later(macos_major) {
        return unsupported(REASON_OS_TOO_OLD);
    }
    supported()
}

/// The impure half: wires the three probes above into `capabilities_for`.
/// Reused directly by `mlx_capabilities` (the IPC command) AND by
/// server.rs's own `start_server` belt re-check (§C F14: "Rust start_
/// server re-checks mlx_capabilities before spawning parakeet") — kept
/// as a plain function (not gated behind a `tauri::State`/async command)
/// so a synchronous, non-`.await`-holding caller like start_server's own
/// check-spawn-store critical section (see that fn's own doc comment on
/// why it can never grow an `.await` while its lock is held) can call it
/// directly.
pub fn compute_mlx_capabilities() -> MlxCapabilities {
    capabilities_for(
        cfg!(target_arch = "aarch64"),
        is_rosetta_translated(),
        macos_major_version(),
    )
}

#[tauri::command]
pub fn mlx_capabilities() -> MlxCapabilities {
    compute_mlx_capabilities()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_arm64_on_a_current_macos_is_supported() {
        let caps = capabilities_for(true, false, 14);
        assert_eq!(
            caps,
            MlxCapabilities {
                mlx_supported: true,
                reason: None,
            }
        );
    }

    #[test]
    fn native_arm64_on_a_much_newer_macos_is_still_supported() {
        assert!(capabilities_for(true, false, 26).mlx_supported);
    }

    #[test]
    fn rosetta_translation_is_unsupported_with_the_rosetta_reason_even_though_the_hardware_is_apple_silicon() {
        let caps = capabilities_for(false, true, 14);
        assert!(!caps.mlx_supported);
        assert_eq!(caps.reason, Some(REASON_ROSETTA.to_string()));
    }

    #[test]
    fn rosetta_translation_wins_over_the_intel_reason_when_both_bits_could_apply() {
        // A synthetic combination that can't happen on real hardware
        // (an aarch64-compiled process can never itself be Rosetta-
        // translated) but pins the precedence this function's own doc
        // comment states: rosetta_translated is checked FIRST.
        let caps = capabilities_for(true, true, 14);
        assert_eq!(caps.reason, Some(REASON_ROSETTA.to_string()));
    }

    #[test]
    fn a_non_arm64_build_not_translated_is_unsupported_with_the_intel_reason() {
        let caps = capabilities_for(false, false, 14);
        assert!(!caps.mlx_supported);
        assert_eq!(caps.reason, Some(REASON_INTEL.to_string()));
    }

    #[test]
    fn native_arm64_below_the_macos_14_floor_is_unsupported_with_the_os_too_old_reason() {
        for major in [0, 12, 13] {
            let caps = capabilities_for(true, false, major);
            assert!(!caps.mlx_supported, "major {major} should be unsupported");
            assert_eq!(caps.reason, Some(REASON_OS_TOO_OLD.to_string()));
        }
    }

    #[test]
    fn is_macos_14_or_later_is_a_whole_major_version_threshold() {
        assert!(!is_macos_14_or_later(13));
        assert!(is_macos_14_or_later(14));
        assert!(is_macos_14_or_later(26));
    }

    #[test]
    fn compute_mlx_capabilities_never_panics_and_always_carries_a_reason_when_unsupported() {
        // Smoke test — whatever this actual dev/CI machine's real
        // hardware/OS is, the impure wiring must resolve without
        // panicking, and the {supported, reason} pairing must stay
        // internally consistent.
        let caps = compute_mlx_capabilities();
        assert_eq!(caps.mlx_supported, caps.reason.is_none());
    }
}
