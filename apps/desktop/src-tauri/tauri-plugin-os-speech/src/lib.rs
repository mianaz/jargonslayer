// S13 (docs/design-explorations/s13-ios-blueprint.md, §D1/§3 Lane B) —
// the iOS-only native plugin fronting the ported SpeechAnalyzer session
// core (ios/Sources/). Scaffolded via `tauri plugin new os-speech
// --no-api --no-example --ios` (tauri-cli 2.11.4) from the tauri-apps
// geolocation plugin's own template; this file trims the generated
// `ping` example down to the plugin's real surface: NO JS-invokable
// commands of its own (`commands.rs`/`invoke_handler` deleted — the app
// crate's `osspeech_ios.rs` is the only thing that ever calls into this
// plugin, via `OsSpeechExt`/`run_mobile_plugin`, never a direct
// `plugin:os-speech|...` JS invoke) — see permissions/default.toml's own
// header comment for the one exception (register_listener/
// remove_listener, framework-provided, not routed through this file's
// `invoke_handler` at all).
use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::OsSpeech;
#[cfg(mobile)]
use mobile::OsSpeech;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the os-speech APIs.
pub trait OsSpeechExt<R: Runtime> {
  fn os_speech(&self) -> &OsSpeech<R>;
}

impl<R: Runtime, T: Manager<R>> crate::OsSpeechExt<R> for T {
  fn os_speech(&self) -> &OsSpeech<R> {
    self.state::<OsSpeech<R>>().inner()
  }
}

/// Initializes the plugin. No `.invoke_handler(...)` call: this plugin
/// exposes zero JS-invokable commands of its own (the default handler,
/// `Box::new(|_| false)`, is exactly right — see this file's own header
/// comment).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("os-speech")
    .setup(|app, api| {
      #[cfg(mobile)]
      let os_speech = mobile::init(app, api)?;
      #[cfg(desktop)]
      let os_speech = desktop::init(app, api)?;
      app.manage(os_speech);
      Ok(())
    })
    .build()
}
