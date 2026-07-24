// v0.5.1 desktop keychain custody design — API-key material (Settings.
// apiKey/hfToken/sonioxKey/deepgramKey/agentToken, see packages/core/src/
// types.ts's own field docs) moves out of the plaintext IndexedDB
// settings blob into the macOS Keychain. This module owns exactly the
// Rust half of that: three thin app-owned commands (secret_set/
// secret_get/secret_delete) that read/write/delete ONE named secret at a
// time, gated to a fixed allow-list of field names (see ALLOWED below) so
// this can never become an arbitrary-key-value store for whatever a
// compromised renderer decides to name. Migration bookkeeping (deciding
// WHEN to copy a plaintext value up, tracking which names are safely in
// custody, stripping the IDB blob once they are) is entirely lib/desktop/
// secret.ts's job on the TS side — this module never sees a Settings
// object, only (name, value) pairs.
//
// BACKEND SPLIT — real Keychain vs a dev-loop file fallback:
// `tauri dev` builds are ad-hoc signed, and macOS Keychain ACLs are keyed
// off the signing identity's cdhash — every `cargo build`/`tauri dev`
// restart changes that hash, so the OS re-prompts "JargonSlayer wants to
// access your keychain" on EVERY read, and "Always Allow" never sticks
// (there's no stable cdhash for an ad-hoc dev build to remember). That
// prompt storm makes the real Keychain unusable purely as a dev
// inner-loop problem, not a production one (release builds are Developer
// ID signed with a stable identity — see docs/PACKAGING.md). So in debug
// builds only (`cfg!(debug_assertions)`, checked at RUNTIME inside
// backend_set/get/delete below — see those functions' own doc for why
// this is a runtime branch rather than a `#[cfg(debug_assertions)]`
// item-level split: both backends stay independently unit-testable
// regardless of the test binary's own profile), these three commands are
// backed by a 0600 JSON file under the app-data dir instead (reusing
// paths::resolve_app_paths — the SAME app-data root server.rs/
// provision.rs already write into). Release (Developer ID) builds always
// use the real Keychain. Both backends are macOS-only in v1 (the
// `keyring` dependency only enables the `apple-native` feature — see
// Cargo.toml's own pin comment) — every other desktop target compiles
// via the graceful stub at the bottom of this file, mirroring
// diskspace.rs's own "platform-gated, still compiles everywhere" posture.
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::paths::resolve_app_paths;

/// Keychain "service" (macOS calls it the credential's _name_ attribute)
/// every Entry in this module is created under — see keyring::Entry::
/// new's own (service, user) pair; `name` (one of ALLOWED below) is the
/// _user_ (macOS's _account_ attribute), so each of the 5 allowed fields
/// becomes its own distinct Keychain item, all grouped under this one
/// service. Verified directly against keyring 3.6.3's own vendored
/// source (~/.cargo/registry/src/.../keyring-3.6.3/src/macos.rs) before
/// writing this module — see that file's own header for the service/
/// account mapping and the "neither may be empty string" quirk (ALLOWED
/// below has no empty entries, so that quirk never bites here).
#[cfg(target_os = "macos")]
const SERVICE: &str = "com.bioinfospace.jargonslayer";

/// The only secret names this store will ever read/write/delete —
/// mirrors lib/desktop/secret.ts's own SECRET_NAMES byte-for-byte (TS is
/// the source of truth for which Settings fields are secret; kept in
/// sync by hand, same cross-lane-pinned-contract posture as diskspace.
/// rs's own DiskFreeResult shape). Rejecting anything else keeps this
/// from ever becoming an arbitrary keychain-write primitive for a
/// compromised renderer.
const ALLOWED: [&str; 5] = ["apiKey", "hfToken", "sonioxKey", "deepgramKey", "agentToken"];

fn check_allowed(name: &str) -> Result<(), String> {
    if ALLOWED.contains(&name) {
        Ok(())
    } else {
        Err(format!("secret store: unknown field name {name:?}"))
    }
}

#[tauri::command]
pub fn secret_set(app: tauri::AppHandle, name: String, value: String) -> Result<(), String> {
    check_allowed(&name)?;
    backend_set(&app, &name, &value)
}

#[tauri::command]
pub fn secret_get(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    check_allowed(&name)?;
    backend_get(&app, &name)
}

#[tauri::command]
pub fn secret_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    check_allowed(&name)?;
    backend_delete(&app, &name)
}

// ---------------------------------------------------------------------
// Platform dispatch — the ONLY place that picks Keychain vs the dev-file
// fallback vs the non-macOS stub. Mirrors diskspace.rs's free_bytes_at
// shape (one function per platform, cfg-gated at the definition), with a
// second, RUNTIME (not cfg-gated) split for debug-vs-release on macOS —
// see this file's own header doc for why that inner split stays runtime.
// ---------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn backend_set(app: &tauri::AppHandle, name: &str, value: &str) -> Result<(), String> {
    if cfg!(debug_assertions) {
        devfile_set(&devfile_path(app)?, name, value)
    } else {
        keychain_set(SERVICE, name, value)
    }
}

#[cfg(target_os = "macos")]
fn backend_get(app: &tauri::AppHandle, name: &str) -> Result<Option<String>, String> {
    if cfg!(debug_assertions) {
        devfile_get(&devfile_path(app)?, name)
    } else {
        // F2 (review-round fix, Sol HIGH #5 + Opus): a release build
        // reading the Keychain only used to mean a key already migrated
        // into secrets.json by an EARLIER DEBUG-PACKAGED build sharing
        // this app's app-data root (see this file's own header doc) was
        // invisible here — the key appeared to "vanish" across a debug
        // -> release upgrade even though it was sitting right there in
        // the dev-file fallback. On a Keychain miss, promote it in from
        // that same devfile store instead of returning None outright —
        // see promote_devfile_value_on_keychain_miss's own doc comment.
        match keychain_get(SERVICE, name)? {
            Some(value) => Ok(Some(value)),
            None => promote_devfile_value_on_keychain_miss(&devfile_path(app)?, name, |value| {
                keychain_set(SERVICE, name, value)
            }),
        }
    }
}

/// F2 (review-round fix, Sol HIGH #5 + Opus) — called from backend_get's
/// release arm ONLY on a Keychain NoEntry miss (see that fn above).
/// Reads the SAME devfile store the debug backend writes (devfile_path
/// is keyed off the same app-data root regardless of which build wrote
/// it — this file's own header doc) and, if a value is present there,
/// promotes it: writes it to the Keychain FIRST via the injected
/// `write_to_keychain`, and only once THAT succeeds removes the name
/// from secrets.json (Sol's ordering requirement — never delete-then-
/// write: a write failure returns Err immediately, before devfile_
/// delete is ever called, so the file copy stays the one surviving copy
/// of the secret). A missing OR corrupt/unreadable devfile is treated
/// as "nothing to promote" — a plain Ok(None), matching keychain_get's
/// own "never configured" == Ok(None) contract, rather than surfacing a
/// devfile read error as a backend_get failure. The devfile_delete
/// cleanup itself is best-effort (`let _ =`): the value is already
/// safely in the Keychain by that point, so a cleanup failure there
/// only leaves a harmless stale duplicate — the Keychain hit above
/// short-circuits every later read before this function ever runs
/// again for the same name.
///
/// `write_to_keychain` is a closure parameter (rather than this
/// function calling keychain_set directly) purely so the whole
/// promotion — including the ordering guarantee above — is unit-
/// testable with a deterministic mock, never touching a real Keychain
/// (which risks an OS access-prompt in an unattended test run — see
/// this file's own header doc).
#[cfg(target_os = "macos")]
fn promote_devfile_value_on_keychain_miss(
    devfile_path: &Path,
    name: &str,
    write_to_keychain: impl FnOnce(&str) -> Result<(), String>,
) -> Result<Option<String>, String> {
    let value = match devfile_get(devfile_path, name) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let Some(value) = value else {
        return Ok(None);
    };
    write_to_keychain(&value)?;
    let _ = devfile_delete(devfile_path, name);
    Ok(Some(value))
}

#[cfg(target_os = "macos")]
fn backend_delete(app: &tauri::AppHandle, name: &str) -> Result<(), String> {
    if cfg!(debug_assertions) {
        devfile_delete(&devfile_path(app)?, name)
    } else {
        keychain_delete(SERVICE, name)
    }
}

#[cfg(not(target_os = "macos"))]
fn backend_set(_app: &tauri::AppHandle, _name: &str, _value: &str) -> Result<(), String> {
    Err("secret store is macOS-only".to_string())
}

#[cfg(not(target_os = "macos"))]
fn backend_get(_app: &tauri::AppHandle, _name: &str) -> Result<Option<String>, String> {
    Err("secret store is macOS-only".to_string())
}

#[cfg(not(target_os = "macos"))]
fn backend_delete(_app: &tauri::AppHandle, _name: &str) -> Result<(), String> {
    Err("secret store is macOS-only".to_string())
}

// ---------------------------------------------------------------------
// Real Keychain backend (release builds) — thin wrappers around keyring::
// Entry, taking `service` as a parameter (rather than reading the SERVICE
// const directly) so the live-keychain test below can point at a
// TEST-suffixed service without ever touching the app's real credentials.
// ---------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn keychain_set(service: &str, name: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(service, name).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn keychain_get(service: &str, name: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(service, name).map_err(|e| e.to_string())?;
    map_get_result(entry.get_password())
}

#[cfg(target_os = "macos")]
fn keychain_delete(service: &str, name: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(service, name).map_err(|e| e.to_string())?;
    map_delete_result(entry.delete_credential())
}

/// The get-side Result mapping (Ok(v) -> Ok(Some(v)); Err(NoEntry) ->
/// Ok(None) — "never set" is not an error, it's an honest empty answer;
/// any OTHER error is a real failure) — pulled out of keychain_get so the
/// mapping logic itself has deterministic, I/O-free unit test coverage
/// (see the tests module below) without needing a live Keychain round
/// trip for every case.
#[cfg(target_os = "macos")]
fn map_get_result(result: Result<String, keyring::Error>) -> Result<Option<String>, String> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// The delete-side Result mapping — deleting an already-absent entry is
/// success (idempotent: the caller's desired end state, "no credential
/// under this name," already holds), same "pulled out for deterministic
/// unit coverage" reasoning as map_get_result above.
#[cfg(target_os = "macos")]
fn map_delete_result(result: Result<(), keyring::Error>) -> Result<(), String> {
    match result {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------------
// Dev-loop file fallback (debug builds only, see this file's own header
// doc) — a flat name->value JSON map at <app-data>/secrets.json, written
// atomically (temp file + rename, same pattern provision.rs's own
// atomic_write uses for the provision marker) but additionally created
// at 0600 from the FIRST byte on disk — this file holds the same secret
// material the Keychain would, so unlike the provision marker it must
// never exist with default (typically 0644) permissions even
// momentarily.
// ---------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn devfile_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_app_paths(app)?.app_data.join("secrets.json"))
}

#[cfg(target_os = "macos")]
fn devfile_read_all(path: &Path) -> Result<HashMap<String, String>, String> {
    match fs::read(path) {
        Ok(bytes) if bytes.is_empty() => Ok(HashMap::new()),
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("{} is corrupt: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(e) => Err(format!("failed to read {}: {e}", path.display())),
    }
}

#[cfg(target_os = "macos")]
fn devfile_write_all(path: &Path, map: &HashMap<String, String>) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("failed to create {}: {e}", parent.display()))?;

    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp_path = PathBuf::from(tmp_name);

    let json = serde_json::to_vec(map).map_err(|e| format!("failed to serialize secrets.json: {e}"))?;
    // `.mode(0o600)` only governs the permissions the OS assigns AT
    // CREATE time — if a stale tmp file somehow already exists (e.g. a
    // crash between a previous write's create and its rename) opening it
    // with `create(true).truncate(true)` does NOT retroactively chmod it,
    // so every write also re-asserts 0600 explicitly below rather than
    // trusting `.mode()` alone.
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp_path)
        .map_err(|e| format!("failed to create {}: {e}", tmp_path.display()))?;
    file.write_all(&json)
        .map_err(|e| format!("failed to write {}: {e}", tmp_path.display()))?;
    drop(file);
    fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("failed to chmod {}: {e}", tmp_path.display()))?;

    fs::rename(&tmp_path, path).map_err(|e| {
        format!(
            "failed to rename {} -> {}: {e}",
            tmp_path.display(),
            path.display()
        )
    })
}

#[cfg(target_os = "macos")]
fn devfile_set(path: &Path, name: &str, value: &str) -> Result<(), String> {
    let mut map = devfile_read_all(path)?;
    map.insert(name.to_string(), value.to_string());
    devfile_write_all(path, &map)
}

#[cfg(target_os = "macos")]
fn devfile_get(path: &Path, name: &str) -> Result<Option<String>, String> {
    Ok(devfile_read_all(path)?.get(name).cloned())
}

#[cfg(target_os = "macos")]
fn devfile_delete(path: &Path, name: &str) -> Result<(), String> {
    let mut map = devfile_read_all(path)?;
    map.remove(name); // absent is a silent no-op — same idempotent-delete contract as keychain_delete
    devfile_write_all(path, &map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    // Same unique-scratch-path idiom as provision.rs's own test module
    // (scratch_path) — cargo test runs tests in parallel, so every test
    // that touches the filesystem needs its own path.
    fn scratch_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("jargonslayer-secret-test-{name}-{unique}.json"))
    }

    #[test]
    fn check_allowed_accepts_every_pinned_secret_name() {
        for name in ALLOWED {
            assert!(check_allowed(name).is_ok(), "{name} should be allowed");
        }
    }

    #[test]
    fn check_allowed_rejects_an_unknown_name() {
        assert!(check_allowed("whisperUrl").is_err());
        assert!(check_allowed("").is_err());
        assert!(check_allowed("__proto__").is_err());
    }

    // ---- dev-file backend (deterministic, no live Keychain needed) ----

    #[cfg(target_os = "macos")]
    #[test]
    fn devfile_get_is_none_when_the_file_does_not_exist_yet() {
        let path = scratch_path("absent");
        assert_eq!(devfile_get(&path, "apiKey").unwrap(), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn devfile_set_then_get_round_trips() {
        let path = scratch_path("roundtrip");
        devfile_set(&path, "apiKey", "sk-secret").unwrap();
        assert_eq!(devfile_get(&path, "apiKey").unwrap().as_deref(), Some("sk-secret"));
        let _ = fs::remove_file(&path);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn devfile_set_preserves_other_names_already_in_the_file() {
        let path = scratch_path("multi");
        devfile_set(&path, "apiKey", "sk-secret").unwrap();
        devfile_set(&path, "hfToken", "hf-secret").unwrap();
        assert_eq!(devfile_get(&path, "apiKey").unwrap().as_deref(), Some("sk-secret"));
        assert_eq!(devfile_get(&path, "hfToken").unwrap().as_deref(), Some("hf-secret"));
        let _ = fs::remove_file(&path);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn devfile_delete_then_get_is_none() {
        let path = scratch_path("delete");
        devfile_set(&path, "apiKey", "sk-secret").unwrap();
        devfile_delete(&path, "apiKey").unwrap();
        assert_eq!(devfile_get(&path, "apiKey").unwrap(), None);
        let _ = fs::remove_file(&path);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn devfile_delete_on_an_absent_file_is_ok_idempotent() {
        let path = scratch_path("delete-absent");
        assert_eq!(devfile_delete(&path, "apiKey"), Ok(()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn devfile_write_leaves_no_tmp_file_behind_and_is_0600() {
        use std::os::unix::fs::PermissionsExt;

        let path = scratch_path("perms");
        devfile_set(&path, "apiKey", "sk-secret").unwrap();

        let mut tmp_name = path.as_os_str().to_owned();
        tmp_name.push(".tmp");
        assert!(
            !PathBuf::from(tmp_name).exists(),
            "the temp file should have been renamed away, not left behind"
        );

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "secrets.json must be created 0600, got {mode:o}");
        let _ = fs::remove_file(&path);
    }

    // ---- F2 (review-round fix, Sol HIGH #5 + Opus): promote_devfile_
    // value_on_keychain_miss — deterministic throughout via the injected
    // write_to_keychain closure (a mock), never a live Keychain round
    // trip (see this file's own header doc for why that would risk an
    // OS access-prompt in an unattended run). ----

    #[cfg(target_os = "macos")]
    #[test]
    fn promote_devfile_value_on_keychain_miss_promotes_and_removes_the_file_entry_on_success() {
        let path = scratch_path("promote-success");
        devfile_set(&path, "apiKey", "sk-secret").unwrap();

        let result = promote_devfile_value_on_keychain_miss(&path, "apiKey", |value| {
            assert_eq!(value, "sk-secret", "the exact file value must be handed to the keychain write");
            Ok(())
        });

        assert_eq!(result, Ok(Some("sk-secret".to_string())));
        assert_eq!(
            devfile_get(&path, "apiKey").unwrap(),
            None,
            "the file copy must be removed once successfully promoted into the keychain"
        );
        let _ = fs::remove_file(&path);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn promote_devfile_value_on_keychain_miss_leaves_the_file_entry_intact_when_the_keychain_write_fails() {
        // Sol's ordering requirement, red/green: never delete-then-write
        // — a failed keychain write must leave secrets.json as the one
        // surviving copy of the secret, not an empty file with the value
        // gone from both places.
        let path = scratch_path("promote-write-failure");
        devfile_set(&path, "apiKey", "sk-secret").unwrap();

        let result = promote_devfile_value_on_keychain_miss(&path, "apiKey", |_value| {
            Err("simulated keychain write failure".to_string())
        });

        assert!(result.is_err(), "a keychain write failure must surface as an Err, never a silent Ok(None)");
        assert_eq!(
            devfile_get(&path, "apiKey").unwrap().as_deref(),
            Some("sk-secret"),
            "the file copy must survive a failed promotion attempt"
        );
        let _ = fs::remove_file(&path);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn promote_devfile_value_on_keychain_miss_is_ok_none_and_never_writes_when_the_file_has_no_entry() {
        let path = scratch_path("promote-absent");
        let mut write_attempted = false;

        let result = promote_devfile_value_on_keychain_miss(&path, "apiKey", |_value| {
            write_attempted = true;
            Ok(())
        });

        assert_eq!(result, Ok(None));
        assert!(!write_attempted, "nothing to promote must never attempt a keychain write");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn promote_devfile_value_on_keychain_miss_is_ok_none_when_the_file_is_corrupt() {
        let path = scratch_path("promote-corrupt");
        fs::write(&path, b"not valid json").unwrap();

        let result = promote_devfile_value_on_keychain_miss(&path, "apiKey", |_value| Ok(()));

        assert_eq!(result, Ok(None), "an unreadable/corrupt devfile is 'nothing to promote', not a backend_get failure");
        let _ = fs::remove_file(&path);
    }

    // ---- keychain Result-mapping (shape-only, no live I/O) ----

    #[cfg(target_os = "macos")]
    #[test]
    fn map_get_result_maps_no_entry_to_ok_none_and_a_value_to_ok_some() {
        assert_eq!(map_get_result(Ok("v".to_string())), Ok(Some("v".to_string())));
        assert_eq!(map_get_result(Err(keyring::Error::NoEntry)), Ok(None));
        assert!(map_get_result(Err(keyring::Error::TooLong("x".into(), 1))).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn map_delete_result_treats_no_entry_as_success_idempotent_delete() {
        assert_eq!(map_delete_result(Ok(())), Ok(()));
        assert_eq!(map_delete_result(Err(keyring::Error::NoEntry)), Ok(()));
        assert!(map_delete_result(Err(keyring::Error::TooLong("x".into(), 1))).is_err());
    }

    // ---- live Keychain round trip — opt-in only ----
    //
    // A real Keychain access can prompt the OS's own "JargonSlayer wants
    // to access your keychain" dialog if a STALE item happens to already
    // exist under this exact (service, name) from an earlier, differently
    // -hashed test binary (this file's own header doc's cdhash-churn
    // problem, not just a `tauri dev` thing — a rebuilt `cargo test`
    // binary is a fresh hash too). An unattended run (CI, or this being
    // driven by an agent with no one at the keyboard to click "Allow")
    // must never block on that, so this test is a no-op unless a human
    // explicitly opts in: `JARGONSLAYER_TEST_KEYCHAIN=1 cargo test
    // keychain_backend_live_roundtrip_when_opted_in -- --nocapture`. The
    // deterministic coverage above (map_get_result/map_delete_result +
    // the full devfile suite) is what actually runs in every normal
    // `cargo test`.
    #[cfg(target_os = "macos")]
    #[test]
    fn keychain_backend_live_roundtrip_when_opted_in() {
        if std::env::var_os("JARGONSLAYER_TEST_KEYCHAIN").is_none() {
            eprintln!(
                "skipping keychain_backend_live_roundtrip_when_opted_in \
                 (set JARGONSLAYER_TEST_KEYCHAIN=1 to run against the real Keychain)"
            );
            return;
        }
        const TEST_SERVICE: &str = "com.bioinfospace.jargonslayer.test";
        let name = format!("rust-test-{}", std::process::id());
        // Best-effort pre-clean in case an earlier crashed run left this
        // exact (pid-derived, so collision is astronomically unlikely)
        // name behind.
        let _ = keychain_delete(TEST_SERVICE, &name);

        assert_eq!(keychain_get(TEST_SERVICE, &name), Ok(None));
        keychain_set(TEST_SERVICE, &name, "s3cr3t").expect("set should succeed");
        assert_eq!(
            keychain_get(TEST_SERVICE, &name),
            Ok(Some("s3cr3t".to_string()))
        );
        keychain_delete(TEST_SERVICE, &name).expect("delete should succeed");
        assert_eq!(keychain_get(TEST_SERVICE, &name), Ok(None));
        assert_eq!(keychain_delete(TEST_SERVICE, &name), Ok(())); // delete-absent, idempotent
    }
}
