// JargonSlayer desktop shell — S3 chunks 2-3 (docs/design-explorations/
// s3-tauri-uv-blueprint.md). Chunk 2 scaffolded the plugin registration;
// chunk 3 (this file's invoke_handler + the paths/uv/server/provision
// modules) adds Rust-owned uv provisioning + sidecar process lifecycle.
//
// Plugin registration order is deliberate: single-instance FIRST, then
// shell, then http (blueprint chunk 2 spec) — single-instance's own
// exclusivity check should run before anything else does real work (it
// also means we never get a chance to double-provision from two
// concurrently-running instances, blueprint §Critical details).
mod audiocap;
mod audiocap_batch;
mod audiocap_framing;
mod audiocap_pipeline;
mod audiocap_resample;
mod paths;
mod provision;
mod server;
mod uv;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
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
        // uv sidecar is spawned via this plugin's Command builder from
        // uv::run_uv, using shell:allow-spawn (see capabilities/
        // default.json) — no @tauri-apps/plugin-shell import ever
        // reaches the JS side.
        .plugin(tauri_plugin_shell::init())
        // Registers `@tauri-apps/plugin-http`'s `fetch` for the client-
        // side LLM transport seam (S2's setTransport()) — native fetch,
        // bypasses CORS uniformly for BYOK provider calls.
        .plugin(tauri_plugin_http::init())
        // Holds the spawned whisper_server.py child, if any — see
        // server::ServerState's own doc comment for who's allowed to
        // touch it.
        .manage(server::ServerState::default())
        // v0.4 S9.2 — single-flight + generation-guard state for the
        // audiocap session (see audiocap::AudiocapState's own doc
        // comment).
        .manage(audiocap::AudiocapState::default())
        // App-owned commands (not plugin commands) need no capability/
        // permission entry: Tauri's ACL only gates a command when it's a
        // plugin command, the app declares its OWN acl manifest under
        // tauri_utils::acl::APP_ACL_KEY, or the request is non-local —
        // none of which apply here (verified against tauri 2.11.5's
        // webview::Webview::on_message / has_app_manifest gate; this
        // crate has no permissions/ directory of its own). core:default
        // in capabilities/default.json is unrelated (it's the built-in
        // "core" plugin's own commands, e.g. app/window lifecycle) and
        // needed no changes for chunk 3.
        .invoke_handler(tauri::generate_handler![
            paths::app_paths,
            uv::run_uv,
            server::prewarm_model,
            server::start_server,
            server::stop_server,
            provision::read_provision_marker,
            provision::write_provision_marker,
            provision::read_sidecar_log,
            audiocap::audiocap_capabilities,
            audiocap::start_app_audio,
            audiocap::stop_app_audio,
        ])
        // v0.4 S9.1 (docs/design-explorations/s9-app-audio-tap-blueprint.md)
        // — the audiocap TCC-attribution spike rig: inert unless
        // JARGONSLAYER_SPIKE_AUDIOCAP=1 (see audiocap::maybe_spawn_spike's
        // own doc comment). Lives in `.setup()`, not behind any command/UI
        // affordance, because the spike's whole point is that the PACKAGED
        // APP ITSELF has to be the one spawning the helper for D2's TCC
        // responsible-process question to mean anything.
        .setup(|app| {
            audiocap::maybe_spawn_spike(app.handle());
            // v0.4 S9.2 — best-effort startup backstop for aggregate
            // devices orphaned by an earlier run's uncatchable SIGKILL
            // (risk register item 4); no-ops below the macOS version
            // floor. See audiocap::sweep_orphans_best_effort's own doc
            // comment.
            audiocap::sweep_orphans_best_effort(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Best-effort orphan-prevention on a graceful exit — see
        // server::kill_held_child_on_exit's own doc comment for the
        // force-quit case this can't catch (accepted for v1, self-heals
        // via adoption on next launch per the blueprint's risk register
        // item 4).
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            server::kill_held_child_on_exit(app_handle);
            // v0.4 S9.2 — same best-effort posture as the whisper_server.py
            // cleanup above, see audiocap::kill_held_session_on_exit's own
            // doc comment.
            audiocap::kill_held_session_on_exit(app_handle);
        }
    });
}
