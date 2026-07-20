// S13.1 (docs/design-explorations/s13-ios-blueprint.md) — the iOS
// simulator spike harness. There is no tap-automation surface on
// `simctl` (unlike XCUITest), so the only way to get end-to-end evidence
// out of a simulator run is to have the app drive itself and write what
// happened to a file `simctl get_app_container … data` can read back
// afterward. Mirrors audiocap.rs's own S9.1 TCC-attribution spike rig
// (`maybe_spawn_spike`) in spirit — launch-arg-armed, evidence teed to an
// app-data file — but this one is invoked FROM JS (iosSpike.ts drives the
// real osspeech engine through the same code paths the UI uses), not
// spawned at `.setup()`, so it's two plain commands rather than a
// `.setup()` hook.
//
// Included ONLY via lib.rs's `#[cfg(target_os = "ios")] mod
// devspike_ios;` (same inclusion posture as osspeech_ios.rs) — no cfg
// gates needed inside this file itself.
use tauri::{AppHandle, Manager};

/// Returns the running process's own argv verbatim. `xcrun simctl launch
/// <device> <bundle-id> --spike-osspeech` passes everything after the
/// bundle id straight through as the launched process's argv (unlike
/// audiocap.rs's own `open -a`-launched spike, which loses env vars and
/// has to rely on an argv flag for the SAME reason — see that function's
/// doc comment) — this is the one thing iosSpike.ts needs to confirm the
/// flag actually reached the app before it decides to run anything.
#[tauri::command]
pub fn spike_flags() -> Vec<String> {
    std::env::args().collect()
}

/// Pure gate check, factored out of `spike_report` so it's unit-testable
/// without needing a real process argv (`std::env::args()` is fixed for
/// the whole test binary's lifetime, so the command fn itself isn't a
/// useful unit-test target).
fn is_spike_armed(args: &[String]) -> bool {
    args.iter().any(|a| a == "--spike-osspeech")
}

/// RUNTIME-GATED, not `cfg(debug_assertions)`: this command (and
/// `spike_flags` above) sit in the SAME `#[cfg(mobile)]` handler list
/// lib.rs registers for every iOS build, debug or release — one handler
/// list, not a second one forked per build profile. Release builds are
/// safe anyway because a store/TestFlight/normal launch never passes
/// `--spike-osspeech`, so this command is permanently unreachable there;
/// the worst case if that ever stopped being true (a hand-crafted launch
/// on a release build) is an app-data file write, not a capability
/// escalation or a data leak — an acceptable ceiling for a dev-only spike
/// harness, and a much smaller diff than cfg-splitting lib.rs's mobile
/// builder branch by profile for this alone.
///
/// Appends `line` + "\n" to `<app_data_dir>/spike/osspeech-spike.ndjson`
/// (creating the `spike/` dir if needed). `app_data_dir`, not
/// `app_log_dir` (audiocap.rs's own spike-log choice): `xcrun simctl
/// get_app_container <device> <bundle-id> data` is the documented way to
/// reach a simulator app's on-disk container, and there's no simctl
/// verb that targets the log dir specifically.
#[tauri::command]
pub fn spike_report(app: AppHandle, line: String) -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if !is_spike_armed(&args) {
        return Err("spike_report: refused — process was not launched with --spike-osspeech".into());
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data dir: {e}"))?
        .join("spike");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let path = dir.join("osspeech-spike.ndjson");
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    writeln!(file, "{line}").map_err(|e| format!("could not write to {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_spike_armed_requires_the_exact_launch_flag() {
        assert!(is_spike_armed(&["JargonSlayer".to_string(), "--spike-osspeech".to_string()]));
        assert!(!is_spike_armed(&["JargonSlayer".to_string()]));
        assert!(!is_spike_armed(&["JargonSlayer".to_string(), "--spike-audiocap".to_string()]));
    }
}
