// v0.6 iOS lane — the app crate's iOS bridge for the on-device translate
// commands, same shape as osspeech_ios.rs one file over: 4 thin
// `#[tauri::command]` fns, one per pinned app-command name, each a
// straight `app.os_speech().sys_translate_*(...)` call into the
// tauri-plugin-os-speech crate's own `OsSpeechExt` (that crate's
// mobile.rs, `OsSpeech<R>`) — state/single-flight/generation-guard logic
// lives THERE, not here, same as osspeech_ios.rs's own posture (this file
// needs no `.manage()` either).
//
// The wire-identical-command-name design osspeech_ios.rs's own header
// comment lays out for transcription applies unchanged here: these 4
// names (`system_translate_probe`/`_prepare`/`system_translate`/`_stop`)
// are byte-identical to macOS's own desktop child, systranslate.rs's
// commands of the same names — providers.ts's invoke sites never change
// per platform. systranslate.rs is this module's macOS analog; the
// plugin's Swift translate controller (tauri-plugin-os-speech/ios/
// Sources/) is its iOS one, the same relationship osspeech_ios.rs has to
// OsSpeechController.swift.
//
// Included ONLY via lib.rs's `#[cfg(target_os = "ios")] mod
// systranslate_ios;` — no cfg gates needed inside this file itself (kept
// compilable standalone, same convention osspeech_ios.rs follows).
//
// DELIBERATE DELTA from osspeech_ios.rs (Sol BLOCKER, translate fix
// round): these four are `async fn` + `spawn_blocking`, NOT the sync
// thin fns osspeech_ios.rs uses. `run_mobile_plugin` blocks its calling
// thread until the Swift side resolves — fine for the osspeech methods,
// whose Swift @objc bodies resolve synchronously before any actor hop,
// but the translate methods resolve from inside a `Task { @MainActor
// ... }`: a sync command executed on the main thread would deadlock
// (main blocked in run_mobile_plugin ⇄ resolve waiting for MainActor).
// spawn_blocking parks the wait on a blocking-pool thread instead, so
// the main run loop stays free to run the Swift controller.
use tauri_plugin_os_speech::{OsSpeechExt, SysTranslateArgs, SysTranslateBatchArgs, SysTranslateProbeResult, SysTranslateStopArgs, TranslateItem};

/// PINNED CONTRACT: wire-identical to desktop's own `system_translate_probe`
/// (systranslate.rs) — `{osSupported: bool, status: "installed"|
/// "supported"|"unsupported"}` (`SysTranslateProbeResult`'s own doc
/// comment covers the camelCase requirement).
#[tauri::command]
pub async fn system_translate_probe(app: tauri::AppHandle, source: String, target: String) -> Result<SysTranslateProbeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.os_speech().sys_translate_probe(SysTranslateArgs { source, target }).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("system_translate_probe join failed: {e}"))?
}

/// PINNED CONTRACT: wire-identical to desktop's own `system_translate_prepare`
/// — resolves the bare `u64` generation the caller stashes and later hands
/// back to `system_translate_stop` (see that command's own doc comment).
#[tauri::command]
pub async fn system_translate_prepare(app: tauri::AppHandle, source: String, target: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.os_speech().sys_translate_prepare(SysTranslateArgs { source, target }).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("system_translate_prepare join failed: {e}"))?
}

/// PINNED CONTRACT: wire-identical to desktop's own `system_translate` —
/// error strings from the plugin pass through unmodified (`e.to_string()`
/// on `Error::PluginInvoke`/`Error::Unsupported` is `#[error(transparent)]`/
/// a plain passthrough, never a prefix that would eat a substring like
/// "not-installed" the JS side string-matches on).
#[tauri::command]
pub async fn system_translate(app: tauri::AppHandle, items: Vec<TranslateItem>, source: String, target: String) -> Result<Vec<TranslateItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.os_speech().sys_translate(SysTranslateBatchArgs { items, source, target }).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("system_translate join failed: {e}"))?
}

/// PINNED CONTRACT: wire-identical to desktop's own `system_translate_stop`
/// — `generation` optional for the same reason that command's own doc
/// comment gives.
#[tauri::command]
pub async fn system_translate_stop(app: tauri::AppHandle, generation: Option<u64>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.os_speech().sys_translate_stop(SysTranslateStopArgs { generation }).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("system_translate_stop join failed: {e}"))?
}
