// S13 (docs/design-explorations/s13-ios-blueprint.md, §D1/§2, Lane B) —
// the app crate's iOS bridge: 6 thin `#[tauri::command]` fns, one per
// pinned app-command name (§2's table), each a straight
// `app.os_speech().<method>().map_err(...)` call into the
// tauri-plugin-os-speech crate's own `OsSpeechExt` (that crate's
// mobile.rs, `OsSpeech<R>`) — state/single-flight/generation-guard logic
// lives THERE, not here (§6 amendment: "lib.rs needs NO extra
// `.manage`"; this file needs none either, for the same reason).
//
// D2's "app-command bridge": kept wire-identical (same 6 invoke names,
// same arg names) to macOS's own osspeech.rs commands, so
// `invoke("start_os_speech")` etc. is byte-identical on both platforms —
// osSpeech.ts/osspeechCaps.ts's invoke sites never change per platform.
//
// Included ONLY via lib.rs's `#[cfg(target_os = "ios")] mod
// osspeech_ios;` (Lane A) — no cfg gates needed inside this file itself
// (kept compilable standalone: plain code, no per-item cfg dance).
use tauri_plugin_os_speech::{OsSpeechCapabilities, OsSpeechExt, PreinstallArgs, StartArgs};

/// PINNED CONTRACT (§2): `{ locale: string, contextualJson: string |
/// null }` — JS ALWAYS sends `contextualJson` (never omits it, per
/// osSpeech.ts's own `buildContextualJson`/`start()`), matching
/// `StartArgs.contextual_json: Option<String>`'s own doc comment
/// (required-nullable, not merely optional).
#[tauri::command]
pub fn start_os_speech(app: tauri::AppHandle, locale: String, contextual_json: Option<String>) -> Result<(), String> {
    app.os_speech().start_transcribe(StartArgs { locale, contextual_json }).map_err(|e| e.to_string())
}

/// Idempotent — a no-op when nothing is running (`OsSpeechController`'s
/// own contract, tauri-plugin-os-speech/ios/Sources/OsSpeechController.swift).
#[tauri::command]
pub fn stop_os_speech(app: tauri::AppHandle) -> Result<(), String> {
    app.os_speech().stop_transcribe().map_err(|e| e.to_string())
}

/// PINNED CONTRACT: the JS worker wires `engine.pause()` to exactly this
/// command name (osSpeech.ts). Idempotent, no-op when idle.
#[tauri::command]
pub fn pause_os_speech(app: tauri::AppHandle) -> Result<(), String> {
    app.os_speech().pause_transcribe().map_err(|e| e.to_string())
}

/// PINNED CONTRACT: the JS worker wires `engine.resume()` to exactly
/// this command name.
#[tauri::command]
pub fn resume_os_speech(app: tauri::AppHandle) -> Result<(), String> {
    app.os_speech().resume_transcribe().map_err(|e| e.to_string())
}

/// D9 fail-closed posture, mirrored from the Swift `capabilities` method
/// — never actually rejects in practice (any failure the Swift side hits
/// folds into a `supported:false` value), same "always resolves" contract
/// macOS's own `os_speech_capabilities` has.
#[tauri::command]
pub fn os_speech_capabilities(app: tauri::AppHandle) -> Result<OsSpeechCapabilities, String> {
    app.os_speech().capabilities().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn preinstall_os_speech(app: tauri::AppHandle, locale: String) -> Result<(), String> {
    app.os_speech().preinstall(PreinstallArgs { locale }).map_err(|e| e.to_string())
}
