// S13 §D1/§2 (Lane B) — the Rust<->Swift bridge. `OsSpeech<R>` wraps the
// `PluginHandle<R>` `register_ios_plugin` hands back and exposes ONE
// thin method per Swift plugin method (§2's pinned table); the app
// crate's osspeech_ios.rs commands are thin wrappers over THESE (state
// lives here, not in the app crate — §6 amendment: "lib.rs needs NO
// extra `.manage`").
//
// iOS-only in practice (the app crate only path-deps this crate under
// `cfg(target_os = "ios")`, blueprint §3 Lane A), but this file compiles
// for `cfg(mobile)` generally (ios OR android) per the scaffold's own
// convention — the `target_os = "android"` arm below is dead code (never
// built, Android out of scope per the blueprint) kept only because
// removing it would make an eventual Android lane's job strictly harder
// for zero benefit today.
use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_os_speech);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<OsSpeech<R>> {
  #[cfg(target_os = "android")]
  let handle = api.register_android_plugin("", "OsSpeechPlugin")?;
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_os_speech)?;
  Ok(OsSpeech(handle))
}

/// Access to the os-speech APIs — one method per Swift plugin method
/// (§2's pinned table: `startTranscribe`/`stopTranscribe`/
/// `pauseTranscribe`/`resumeTranscribe`/`capabilities`/`preinstall`).
/// Zero-arg Swift methods are called with a `()` payload
/// (`serde_json::to_value(())` -> `null`) — the Swift side never calls
/// `invoke.parseArgs` for those, so the payload shape is irrelevant, see
/// each Swift method's own doc comment.
pub struct OsSpeech<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> OsSpeech<R> {
  pub fn start_transcribe(&self, args: StartArgs) -> crate::Result<()> {
    self.0.run_mobile_plugin("startTranscribe", args).map_err(Into::into)
  }

  pub fn stop_transcribe(&self) -> crate::Result<()> {
    self.0.run_mobile_plugin("stopTranscribe", ()).map_err(Into::into)
  }

  pub fn pause_transcribe(&self) -> crate::Result<()> {
    self.0.run_mobile_plugin("pauseTranscribe", ()).map_err(Into::into)
  }

  pub fn resume_transcribe(&self) -> crate::Result<()> {
    self.0.run_mobile_plugin("resumeTranscribe", ()).map_err(Into::into)
  }

  pub fn capabilities(&self) -> crate::Result<OsSpeechCapabilities> {
    self.0.run_mobile_plugin("capabilities", ()).map_err(Into::into)
  }

  pub fn preinstall(&self, args: PreinstallArgs) -> crate::Result<()> {
    self.0.run_mobile_plugin("preinstall", args).map_err(Into::into)
  }

  // ---- v0.6 iOS translate lane (models.rs's own header comment on this
  // section covers the wire shapes; systranslate_ios.rs's own header
  // comment covers why the command names these back must stay wire-
  // identical to macOS's own systranslate.rs) ----

  pub fn sys_translate_probe(&self, args: SysTranslateArgs) -> crate::Result<SysTranslateProbeResult> {
    self.0.run_mobile_plugin("sysTranslateProbe", args).map_err(Into::into)
  }

  /// Unwraps Swift's `{"generation": u64}` reply envelope (`GenerationResult`'s
  /// own doc comment) down to the bare `u64` desktop's own `system_translate_
  /// prepare` returns.
  pub fn sys_translate_prepare(&self, args: SysTranslateArgs) -> crate::Result<u64> {
    let result = self.0.run_mobile_plugin::<GenerationResult>("sysTranslatePrepare", args).map_err(crate::Error::from)?;
    Ok(result.generation)
  }

  /// Unwraps Swift's `{"items": [...]}` reply envelope (`TranslateItemsResult`'s
  /// own doc comment) down to the bare `Vec<TranslateItem>` desktop's own
  /// `system_translate` returns.
  pub fn sys_translate(&self, args: SysTranslateBatchArgs) -> crate::Result<Vec<TranslateItem>> {
    let result = self.0.run_mobile_plugin::<TranslateItemsResult>("sysTranslate", args).map_err(crate::Error::from)?;
    Ok(result.items)
  }

  pub fn sys_translate_stop(&self, args: SysTranslateStopArgs) -> crate::Result<()> {
    self.0.run_mobile_plugin("sysTranslateStop", args).map_err(Into::into)
  }
}
