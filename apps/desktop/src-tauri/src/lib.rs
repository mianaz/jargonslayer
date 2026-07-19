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
//
// S13 (docs/design-explorations/s13-ios-blueprint.md, §D3) — none of the
// modules below are needed on iOS v1 (mic-only 系统识别 via a native
// plugin, no sidecar/uv/provisioning/app-audio-tap/oauth). Gated
// `#[cfg(desktop)]` rather than deleted so the macOS build stays exactly
// as it was; `run()` itself splits into a `#[cfg(desktop)]` builder chain
// (byte-identical to the pre-S13 chain) and a `#[cfg(mobile)]` one below.
#[cfg(desktop)]
mod audiocap;
#[cfg(desktop)]
mod audiocap_batch;
#[cfg(desktop)]
mod audiocap_framing;
#[cfg(desktop)]
mod audiocap_pipeline;
#[cfg(desktop)]
mod audiocap_resample;
#[cfg(desktop)]
mod diskspace;
#[cfg(desktop)]
mod mlxcaps;
#[cfg(desktop)]
mod oauth;
#[cfg(desktop)]
mod osspeech;
// S13 §D1/§2 — Lane B's bridge commands (run_mobile_plugin call sites into
// the tauri-plugin-os-speech crate); same six invoke names as desktop's
// osspeech module above, kept wire-identical per the blueprint's app-
// command bridge (§D2).
#[cfg(target_os = "ios")]
mod osspeech_ios;
#[cfg(desktop)]
mod paths;
#[cfg(desktop)]
mod provision;
#[cfg(desktop)]
mod server;
#[cfg(desktop)]
mod uv;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // S13 §D3 — required fix: tauri-plugin-single-instance is Cargo-gated
    // to cfg(any(macos, windows, linux)) (see Cargo.toml), so its crate is
    // absent on iOS; the old unconditional `.plugin(single_instance::init(
    // ...))` here was the iOS build-breaker Sol's live aarch64-apple-ios
    // compile stopped on (blueprint §6, D3's own prediction). Splitting
    // into two cfg-gated builder chains — rather than cfg-gating individual
    // `.plugin()`/`.manage()` calls inline — keeps the desktop chain's
    // lines byte-identical to the pre-S13 version (same order, same
    // comments), so macOS behavior is provably unchanged.
    #[cfg(desktop)]
    let builder = tauri::Builder::default()
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
        // S10 field-fix, Chunk A — registers `@tauri-apps/plugin-opener`'s
        // `openUrl` for every desktop external link (OAuth authorize URL,
        // update download page, pyannote/HF gated-model links); scoped by
        // capabilities/default.json's own opener:allow-open-url grant.
        .plugin(tauri_plugin_opener::init())
        // Holds the spawned whisper_server.py child, if any — see
        // server::ServerState's own doc comment for who's allowed to
        // touch it.
        .manage(server::ServerState::default())
        // v0.4 S9.2 — single-flight + generation-guard state for the
        // audiocap session (see audiocap::AudiocapState's own doc
        // comment).
        .manage(audiocap::AudiocapState::default())
        // S10 field-fix, Chunk A — single-flight generation guard for the
        // RFC 8252 loopback OAuth listener (see oauth::OauthState's own
        // doc comment).
        .manage(oauth::OauthState::default())
        // v0.4.3 S11 — single-flight + generation-guard state for the
        // osspeech transcribe session (and its own preinstall slot), see
        // osspeech::OsSpeechState's own doc comment.
        .manage(osspeech::OsSpeechState::default())
        // S12a §C F16 — a bounded single-flight guard against an
        // overlapping `run_uv` invocation racing the same venv/pip
        // target (the "stale processes keep mutating the venv"
        // retry-poisoning gap); see uv::UvInstallState's own doc
        // comment.
        .manage(uv::UvInstallState::default())
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
            audiocap::pause_app_audio,
            audiocap::resume_app_audio,
            audiocap::open_privacy_settings,
            oauth::oauth_loopback_start,
            oauth::oauth_loopback_cancel,
            osspeech::os_speech_capabilities,
            osspeech::start_os_speech,
            osspeech::stop_os_speech,
            osspeech::pause_os_speech,
            osspeech::resume_os_speech,
            osspeech::preinstall_os_speech,
            mlxcaps::mlx_capabilities,
            uv::mlx_import_preflight,
            diskspace::app_data_disk_free,
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
        });

    // S13 §D3/§2 + §6 F6 — mobile (iOS v1) shell: the os-speech plugin
    // (Lane B) is the only native-side lane; no single-instance (no
    // second-launch/DBus/mutex concept on iOS), no shell plugin (no
    // sidecar on mobile — D3's shell-plugin note), no `.manage()` state
    // (the plugin crate owns its own session state, blueprint §3 Lane B)
    // and no `.setup()`/exit hooks (nothing to spike/sweep/kill on iOS).
    // http stays registered here too (unconditional Cargo dep, full iOS
    // support per D3) for the client-side BYOK LLM transport; opener is
    // registered here per §6 F6 (iOS-supported, openExternal.ts routes
    // through IS_TAURI) and granted via capabilities/ios.json.
    #[cfg(mobile)]
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os_speech::init())
        .invoke_handler(tauri::generate_handler![
            osspeech_ios::start_os_speech,
            osspeech_ios::stop_os_speech,
            osspeech_ios::pause_os_speech,
            osspeech_ios::resume_os_speech,
            osspeech_ios::os_speech_capabilities,
            osspeech_ios::preinstall_os_speech,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(desktop)]
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
            // v0.4.3 S11 — same best-effort posture, covering the osspeech
            // transcribe session's child and/or an in-flight preinstall's
            // own child; see osspeech::kill_held_session_on_exit's own
            // doc comment.
            osspeech::kill_held_session_on_exit(app_handle);
        }
    });

    // S13 §D3 — mobile v1 has no exit-cleanup child processes to reap
    // (no sidecar, no app-audio-tap, no osspeech CLI helper — the plugin
    // owns its own AVAudioEngine/SpeechAnalyzer lifecycle in-process), so
    // this is a plain run with no RunEvent handling.
    #[cfg(mobile)]
    app.run(|_app_handle, _event| {});
}
