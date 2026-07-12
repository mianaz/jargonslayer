// JargonSlayer desktop shell — S3 chunk 2 scaffold (docs/design-
// explorations/s3-tauri-uv-blueprint.md). This is intentionally a bare
// plugin-registration shell: uv provisioning, sidecar lifecycle, and
// the app_paths()/run_uv()/start_server() commands are chunk 3's job,
// not this one's.
//
// Plugin registration order is deliberate: single-instance FIRST, then
// shell, then http (blueprint chunk 2 spec) — single-instance's own
// exclusivity check should run before anything else does real work.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance publishes its exclusivity lock (a named
        // mutex/DBus service/equivalent, platform-dependent) as soon as
        // this plugin initializes — registering it first means a second
        // launch attempt is caught before any other plugin's own setup
        // work runs. The callback fires in the FIRST instance when a
        // second launch is blocked; chunk 6 will use it to focus the
        // existing window (see tauri-plugin-single-instance's own docs
        // for that pattern) — left a no-op here since window management
        // isn't in this chunk's scope.
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        // Rust owns all process spawning (architecture decision 2): the
        // uv sidecar is spawned via this plugin in chunk 3, using
        // shell:allow-spawn (see capabilities/default.json) — no
        // @tauri-apps/plugin-shell import ever reaches the JS side.
        .plugin(tauri_plugin_shell::init())
        // Registers `@tauri-apps/plugin-http`'s `fetch` for the client-
        // side LLM transport seam (S2's setTransport()) — native fetch,
        // bypasses CORS uniformly for BYOK provider calls.
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
